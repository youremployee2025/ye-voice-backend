import { prisma } from '../lib/prisma.js';
import { addDays, addOneMonth } from '../lib/billingCycle.js';
import { chargePriceOf } from './didRental.js';
import { env } from '../lib/env.js';

/**
 * Monthly rental renewals.
 *
 * A sweep charges every DID whose renewal date has arrived, and eventually
 * releases the ones the owner cannot pay for. It is **idempotent**: the claim
 * below compares-and-sets on `nextRenewalAt`, so running it twice, or on two
 * processes, charges once. The brief only asks for it to be safe on one
 * process; being safe on N costs a single `where` clause and removes a class
 * of incident that is otherwise invisible until somebody is double-billed.
 *
 * **A declined charge does not take the number away.** It marks the DID
 * `PAST_DUE` and leaves it with the workspace — still theirs, still ringing —
 * and every later pass retries. Only when the grace window measured from the
 * *first* decline runs out is the number released. Releasing on the first miss
 * meant a customer one credit short at the instant the sweep ran lost a
 * published business number, and could not get it back: the pool relists it
 * immediately and there is no reclaim path.
 *
 * The price charged is the one the workspace agreed to when it rented
 * (`chargePriceOf`), never the catalog price. See `didRental.ts`.
 */

/** Sentinel: the owner could not cover the charge. Thrown to roll the claim
 *  back, caught immediately outside the transaction. */
class ChargeDeclined extends Error {}

/**
 * Most DIDs one pass will look at.
 *
 * The due set used to be unbounded, with a workspace joined onto every row —
 * on the first of the month that is the whole rented estate in memory, and as
 * many sequential transactions, inside one interval tick. A bounded pass that
 * runs again next hour is the same throughput with a ceiling on the blast
 * radius of any single run.
 */
const BATCH = 500;

export interface RenewalSweepResult {
  renewed: number;
  /** Charges declined inside the grace window: marked, not taken away. */
  pastDue: number;
  released: number;
  /** DIDs that errored for some other reason. Non-zero means the run is partial. */
  failed: number;
  /** True when the release cap stopped the pass early. Always worth an alert. */
  haltedOnReleaseCap: boolean;
}

export interface RenewalSweepOptions {
  /** Injected so the tests are deterministic rather than dependent on the clock. */
  now?: Date;
  /** Injected so a test does not have to reconfigure the environment. */
  graceDays?: number;
  maxReleases?: number;
}

/**
 * One pass over the DIDs that are due.
 *
 * Each DID is its own transaction: one workspace's failure must not roll back
 * another's charge, and a single transaction over the whole platform would
 * hold locks for the length of the run.
 */
export async function runRenewalSweep({
  now = new Date(),
  graceDays = env.didGraceDays,
  maxReleases = env.didMaxReleasesPerSweep,
}: RenewalSweepOptions = {}): Promise<RenewalSweepResult> {
  const result: RenewalSweepResult = {
    renewed: 0,
    pastDue: 0,
    released: 0,
    failed: 0,
    haltedOnReleaseCap: false,
  };

  const due = await prisma.phoneNumber.findMany({
    // PAST_DUE is included: those are the retries, and leaving them out would
    // mark a DID once and then never charge it again.
    where: {
      status: { in: ['ASSIGNED', 'PAST_DUE'] },
      nextRenewalAt: { lte: now },
      workspaceId: { not: null },
    },
    orderBy: { nextRenewalAt: 'asc' },
    take: BATCH,
  });

  for (const number of due) {
    const heldBy = number.workspaceId;
    const dueAt = number.nextRenewalAt;

    // Both are non-null by the query above; the guard is for the type, and for
    // the day somebody widens that `where`.
    if (!heldBy || !dueAt) continue;

    const price = chargePriceOf(number);
    let declined = false;

    try {
      await prisma.$transaction(async (tx) => {
        // Claim: compare-and-set on the exact due date. A second runner — or a
        // second pass of this one — finds `nextRenewalAt` already advanced,
        // matches nothing, and skips. This is the whole of the idempotency
        // guarantee.
        //
        // The next date advances from `dueAt`, NOT from `now`. A sweep that
        // was down for three months finds a DID three months overdue, charges
        // one month, and leaves it still due — so the next pass charges the
        // next month, in order. Advancing from `now` would silently forgive
        // the gap; charging the backlog in one pass would empty an account
        // without warning. One charge per DID per sweep is the bounded,
        // self-healing middle.
        //
        // A successful charge also clears `PAST_DUE`: a customer who topped up
        // is not past due any more, and the window must not carry over to the
        // next time they are short.
        const claimed = await tx.phoneNumber.updateMany({
          where: {
            id: number.id,
            status: { in: ['ASSIGNED', 'PAST_DUE'] },
            nextRenewalAt: dueAt,
          },
          data: {
            nextRenewalAt: addOneMonth(dueAt),
            status: 'ASSIGNED',
            pastDueSince: null,
          },
        });

        if (claimed.count === 0) return;

        // Re-read the owner inside the transaction. Reading it with the due
        // set would debit whoever owned the workspace when the pass started,
        // and an ownership transfer mid-sweep would bill the previous owner
        // and file the ledger row under them. The claim above locks the DID,
        // not the workspace.
        const workspace = await tx.workspace.findUnique({
          where: { id: heldBy },
          select: { id: true, ownerAccountId: true },
        });

        if (!workspace) throw new Error(`Workspace ${heldBy} is missing for DID ${number.did}`);

        // Same conditional debit renting uses: no window between checking the
        // balance and spending it, so a negative balance is unreachable.
        const debited = await tx.account.updateMany({
          where: { id: workspace.ownerAccountId, credits: { gte: price } },
          data: { credits: { decrement: price } },
        });

        if (debited.count === 0) throw new ChargeDeclined();

        await tx.creditTransaction.create({
          data: {
            accountId: workspace.ownerAccountId,
            workspaceId: workspace.id,
            phoneNumberId: number.id,
            amount: -price,
            type: 'DID_RENEWAL',
          },
        });
      });
    } catch (err) {
      if (!(err instanceof ChargeDeclined)) {
        // One bad row must not stop the platform's billing — but the shortfall
        // is counted, never swallowed.
        console.error(`Could not renew DID ${number.did}:`, err);
        result.failed += 1;
        continue;
      }
      declined = true;
    }

    // Counted out here, not inside the callback. Incrementing within the
    // transaction body credits work that a failed COMMIT then undoes, and the
    // outer catch counts the same DID again — one number reported as both
    // renewed and failed, and neither true.
    if (!declined) {
      result.renewed += 1;
      continue;
    }

    // The transaction rolled back: nothing charged, `nextRenewalAt` unmoved,
    // so the next pass retries this same due date.
    const pastDueSince = number.pastDueSince ?? now;
    const deadline = addDays(pastDueSince, graceDays);

    if (now < deadline) {
      try {
        await prisma.phoneNumber.updateMany({
          where: { id: number.id, workspaceId: heldBy },
          data: { status: 'PAST_DUE', pastDueSince },
        });
        result.pastDue += 1;
      } catch (markErr) {
        console.error(`Could not mark DID ${number.did} past due:`, markErr);
        result.failed += 1;
      }
      continue;
    }

    // The grace window is spent. Before taking anything away, check the pass
    // has not started doing this wholesale: the realistic cause of a mass
    // release is a pricing mistake that made every workspace insolvent at
    // once, and in that case stopping and being noticed is worth far more than
    // finishing the run correctly.
    if (result.released >= maxReleases) {
      result.haltedOnReleaseCap = true;
      console.error(
        `Renewal sweep halted: ${result.released} DIDs released for non-payment in one pass ` +
          `(cap ${maxReleases}). Remaining overdue numbers were left untouched. ` +
          `Check DID pricing and account balances before the next pass.`,
      );
      break;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const released = await tx.phoneNumber.updateMany({
          where: { id: number.id, workspaceId: heldBy },
          data: {
            workspaceId: null,
            status: 'RELEASED_NONPAYMENT',
            rentedPriceCredits: null,
            rentedAt: null,
            nextRenewalAt: null,
            pastDueSince: null,
          },
        });

        if (released.count === 0) return;

        const workspace = await tx.workspace.findUnique({
          where: { id: heldBy },
          select: { ownerAccountId: true },
        });

        if (!workspace) return;

        // The only durable record that this workspace ever held this number
        // and how it lost it. It carries the workspace, so it survives on
        // that workspace's ledger after the DID is gone from it — and it is
        // its own type rather than a zero-amount adjustment, because "they
        // gave it back" and "we took it away" are different facts.
        await tx.creditTransaction.create({
          data: {
            accountId: workspace.ownerAccountId,
            workspaceId: heldBy,
            phoneNumberId: number.id,
            amount: 0n,
            type: 'DID_RELEASE_NONPAYMENT',
          },
        });
      });

      result.released += 1;
    } catch (releaseErr) {
      console.error(`Could not release DID ${number.did} after a declined charge:`, releaseErr);
      result.failed += 1;
    }
  }

  return result;
}
