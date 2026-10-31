import { prisma } from '../lib/prisma.js';
import { chargePriceOf } from './didRental.js';

/**
 * What a workspace's rented numbers will cost over the coming window, and
 * whether the balance that has to pay for it will stretch.
 *
 * Computed here rather than in the browser for three reasons, in order of
 * weight. It is a money claim, and both telling a customer they are short when
 * they are not and staying quiet when they are do real damage — so the
 * assertion belongs where it can be tested against a database. It is the same
 * sum `didRenewal.ts` will actually perform, so a second implementation would
 * eventually disagree with the one that takes the money. And doing it
 * client-side means adding credit values in JavaScript, which is exactly what
 * the internal multiplier exists to prevent.
 *
 * Reads only. Nothing here moves a balance or writes a ledger row —
 * `didRental.ts` remains the only module that does either.
 */

/**
 * The window, fixed in this slice and reported in the payload so no consumer
 * has to assume it. A later slice that widens it must not silently relabel a
 * number the dashboard is already printing a heading over.
 *
 * It is a fixed 30 days while the renewal date itself is a calendar month
 * (`addOneMonth`), so the two do not line up: a number rented during a 31-day
 * month renews one day past this horizon and is outside the window from the
 * moment it is rented. That is deliberate for now — the window is a
 * conservative "what is definitely coming", not a billing period — but it
 * means the total can under-report, and any surface that lists the underlying
 * rows must filter them to this same horizon or its rows will not sum to it.
 */
export const PROJECTION_WINDOW_DAYS = 30;

export interface UpcomingRenewals {
  windowDays: number;
  /** Held numbers *in this workspace* whose renewal falls inside the window. */
  renewalCount: number;
  /**
   * Held numbers with no `nextRenewalAt` at all — staff assigned one without
   * starting a billing cycle, or the row predates the column. Reported rather
   * than folded into the total: we do not know when they will next be billed,
   * and adding an unknown to a sum presents a guess as arithmetic.
   */
  unscheduledCount: number;
  /** This workspace's share, which is what the dashboard's table lists. */
  totalCredits: bigint;
  /**
   * The same sum across **every workspace the owner account owns**, which is
   * what the balance actually has to cover.
   *
   * `covers` is judged against this and not against `totalCredits`. One
   * account funds all of its workspaces from one balance, so a per-workspace
   * comparison answers a question nobody asked: with 1000 credits and two
   * workspaces each renewing 800 next week, both pages would report `covers:
   * true` while the account is 600 short and the sweep is about to decline one
   * of them. Equal to `totalCredits` when the account owns one workspace.
   */
  accountTotalCredits: bigint;
  covers: boolean;
  /** Present only when `covers` is false. Measured against the account total. */
  shortfallCredits: bigint | null;
}

export async function projectUpcomingRenewals(
  workspaceId: string,
  ownerAccountId: string,
  balance: bigint,
  now: Date = new Date(),
): Promise<UpcomingRenewals> {
  const horizon = new Date(now.getTime() + PROJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Every number the owner account is paying for, in one read, then split by
  // workspace below. The account-wide half is not an extra query: the balance
  // is account-wide, so the set that has a claim on it is the set to fetch.
  //
  // The whole row rather than a partial select: `chargePriceOf` reads the
  // snapshot with the catalog price behind it, and a hand-picked column list
  // here would silently drift from that helper's signature the next time it
  // gains a fallback.
  //
  // The `status` filter mirrors `didRenewal.ts`'s sweep exactly. Filtering on
  // the workspace relation alone happens to select the same rows today — every
  // release path nulls `workspaceId` in the same statement that sets a
  // terminal status — but that is an invariant no column enforces, and this is
  // the module whose docstring claims to perform the sum the sweep performs.
  const held = await prisma.phoneNumber.findMany({
    where: {
      status: { in: ['ASSIGNED', 'PAST_DUE'] },
      workspace: { ownerAccountId },
    },
  });

  let total = 0n;
  let accountTotal = 0n;
  let renewalCount = 0;
  let unscheduledCount = 0;

  for (const number of held) {
    const mine = number.workspaceId === workspaceId;

    if (number.nextRenewalAt === null) {
      if (mine) unscheduledCount += 1;
      continue;
    }

    // No lower bound on purpose. A renewal already past due sits *behind* now,
    // because a declined charge leaves `nextRenewalAt` where it was so the
    // sweep retries the same month. Those are the numbers most likely to be
    // short, so a `gte: now` here would drop precisely the case this exists
    // to warn about.
    //
    // Counted once even when it is several months overdue. The sweep charges
    // one month per pass on an hourly timer, so a three-month backlog is
    // charged three times within three hours and this under-reports it; and a
    // number past the end of its grace window is released rather than charged,
    // where this over-reports. Both are bounded by one month of one number's
    // price, and both are cases where the honest headline — the balance is
    // short — is the one this already gives.
    if (number.nextRenewalAt > horizon) continue;

    const price = chargePriceOf(number);
    accountTotal += price;

    if (mine) {
      renewalCount += 1;
      total += price;
    }
  }

  const covers = balance >= accountTotal;

  return {
    windowDays: PROJECTION_WINDOW_DAYS,
    renewalCount,
    unscheduledCount,
    totalCredits: total,
    accountTotalCredits: accountTotal,
    covers,
    shortfallCredits: covers ? null : accountTotal - balance,
  };
}
