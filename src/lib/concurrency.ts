import type { CallAttemptStatus, Prisma, PrismaClient } from '@prisma/client';
import { env } from './env.js';

/**
 * How many calls may be in flight, and how many currently are.
 *
 * YE buys a pool of simultaneous calls from the voice platform and sells
 * slices of it to accounts. That is structurally the same thing this codebase
 * already does with DIDs (platform inventory, rented to a workspace) and tiers
 * (platform catalogue, assigned to an account), so it follows the same shape
 * rather than inventing a third one: **staff own the allotment, an env value
 * is the default for accounts they have not touched, and the rule lives in one
 * module.**
 *
 * Three copies of an allotment rule eventually say three different things, and
 * here the disagreement is a customer dialing more lines than they bought — or
 * an account staff deliberately stopped quietly starting again.
 */

/**
 * The attempt statuses that occupy a line.
 *
 * Deliberately identical in meaning to the voice platform's own
 * `statuses_counted` on `GET /calls/concurrency` — "PENDING, RINGING,
 * IN_PROGRESS". Our `QUEUED` is their `PENDING`: claimed and launched, no
 * progress reported yet.
 *
 * If these two sets ever diverge, the local cap and the remote ceiling are
 * counting different calls, and the sweep paces against a number that is not
 * the one being enforced. That failure is invisible until the platform starts
 * answering 429 to a dialer that believes it has headroom.
 */
export const NON_TERMINAL_ATTEMPT_STATUSES = [
  'QUEUED',
  'RINGING',
  'IN_PROGRESS',
] as const satisfies readonly CallAttemptStatus[];

/** The `where` fragment for "still occupying a line". */
export const IN_FLIGHT = {
  status: { in: [...NON_TERMINAL_ATTEMPT_STATUSES] },
} satisfies Prisma.CallAttemptWhereInput;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * How many simultaneous calls this account may place, across every workspace
 * it owns.
 *
 * The chain is two links and it is the whole rule:
 *
 *   1. `Account.concurrencyLimit` — the number staff sold this account.
 *   2. `DIALER_DEFAULT_ACCOUNT_CONCURRENCY` — the platform default.
 *
 * **`??`, never `||`.** Zero is a limit somebody set, and means this account
 * may not dial; absence is not a limit at all. `||` is falsy on `0` and would
 * step over a deliberate stop straight onto the default, silently returning an
 * account to service after staff had halted it. `tierPricing.ts` documents the
 * identical trap for a `0n` price. It is worse here, because a wrong price is
 * discovered on an invoice and this one is discovered by a phone ringing.
 *
 * Null never means unlimited. There is no unlimited: the platform's own
 * ceiling is the last word, and this number is YE's slice of it.
 */
export function resolveAccountConcurrency(account: { concurrencyLimit: number | null }): number {
  return account.concurrencyLimit ?? env.dialerDefaultAccountConcurrency;
}

/**
 * How many of this campaign's calls are live.
 *
 * **Counted, never stored.** A column decremented on completion is a column
 * that eventually misses a decrement — a crash between webhook and update, a
 * delivery the platform retried, an attempt the reaper closed — and a campaign
 * whose counter is one too high is pinned below its cap permanently, with
 * nothing to show for it: it simply stops dialing and looks idle. There is no
 * repair path short of somebody noticing and recomputing by hand.
 *
 * A count over `@@index([campaignId, status])` reads a handful of rows, cannot
 * drift, and is correct after any crash at any point.
 */
export function campaignInFlight(db: Db, campaignId: string): Promise<number> {
  return db.callAttempt.count({ where: { campaignId, ...IN_FLIGHT } });
}

/**
 * Which lane each of this campaign's live calls is occupying.
 *
 * **Read off `CallAttempt.kind`, the arm the claim actually spent**, and not
 * off the contact. This used to ask the contact's lifetime counters — has this
 * contact ever been dialled — which answers a different question and answers
 * it yes for nearly every row on a campaign whose fresh queue is exhausted. On
 * such a campaign every live call of every kind counted against the
 * reservation, the non-fresh budget came out at zero, and the reserved lane
 * was never queried at all: the reservation was a setting that did nothing,
 * with hundreds of eligible retries and a dialer that placed none of them for
 * whole quarter-hours. The kind is stamped at claim time, is a bijection over
 * the five arms (`attemptKind.ts`), and is the only column that records which
 * budget a slot was spent from.
 *
 * **One `groupBy` rather than two counts**, so this is a round trip cheaper per
 * campaign per pass as well as correct — and the parts cannot disagree with the
 * total, because `all` is summed from the same rows rather than counted
 * separately. An attempt whose contact pointer was nulled by a campaign delete
 * is still counted here: it holds a line, and the cap it holds it against is
 * built on `all`.
 *
 * **A kind this release does not know is credited to `retry`.** It counts
 * toward `all` either way, so the campaign cap holds whatever the value is;
 * the choice only decides which budget it narrows. Narrowing the non-fresh
 * side is the direction that cannot over-dial — the alternative, calling it
 * fresh, would hand the same slot to the reserved lanes a second time. That
 * also covers a legacy row with no stamp at all, which is the same fact from
 * an older release.
 */
export interface LaneOccupancy {
  /** Every non-terminal attempt. `totalSlots` is built on this. */
  all: number;
  fresh: number;
  /** Callback and resume: the two lanes carrying a time somebody is owed. */
  urgent: number;
  /** Retry, follow-up, and any kind this release does not recognise. */
  retry: number;
}

export async function campaignLaneInFlight(db: Db, campaignId: string): Promise<LaneOccupancy> {
  const rows = await db.callAttempt.groupBy({
    by: ['kind'],
    where: { campaignId, ...IN_FLIGHT },
    _count: { _all: true },
  });

  const occupancy: LaneOccupancy = { all: 0, fresh: 0, urgent: 0, retry: 0 };

  for (const row of rows) {
    const count = row._count._all;

    occupancy.all += count;

    if (row.kind === 'fresh') occupancy.fresh += count;
    else if (row.kind === 'callback' || row.kind === 'resume') occupancy.urgent += count;
    else occupancy.retry += count;
  }

  return occupancy;
}

/**
 * The same question for a whole account's allotment.
 *
 * Spans every workspace and campaign the account owns, which is what makes the
 * allotment YE's unit of sale rather than a per-campaign setting a customer
 * could raise for themselves.
 */
export function accountInFlight(db: Db, accountId: string): Promise<number> {
  return db.callAttempt.count({ where: { accountId, ...IN_FLIGHT } });
}

/**
 * Claims an earlier tick posted that no attempt row records yet.
 *
 * A claim flips the contact to `QUEUED` and hands the dial to Redis; the
 * attempt row — the thing every count above reads — is written later, by the
 * placement worker. Within one pass the tick carries its own claims forward,
 * but a backlog that outlives the tick period (placement is concurrency 1)
 * was counted by nothing, and the next pass re-spent the same headroom. So a
 * `QUEUED` contact claimed **before this tick** with no attempt started since
 * its claim is a committed dial and counts as in-flight.
 *
 * `claimedAt < now` and not `<= now`, deliberately: the current pass's own
 * claims are stamped with the tick's clock and are already carried forward in
 * memory — counting them here too would double them. Rows claimed before the
 * column existed carry `NULL` and cannot be counted; they are the release
 * sweep's to reap, not this count's to guess at.
 */
export async function campaignPendingPlacement(
  db: Db,
  campaignId: string,
  now: Date,
): Promise<{ fresh: number; retry: number }> {
  const rows = await db.$queryRaw<Array<{ fresh: bigint; retry: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE cc.attempts = 0) AS fresh,
           COUNT(*) FILTER (WHERE cc.attempts > 0) AS retry
    FROM "CampaignContact" cc
    WHERE cc."campaignId" = ${campaignId}
      AND cc.status = 'QUEUED'
      AND cc."claimedAt" IS NOT NULL
      AND cc."claimedAt" < ${now}
      AND NOT EXISTS (
        SELECT 1 FROM "CallAttempt" ca
        WHERE ca."campaignContactId" = cc.id
          AND ca."startedAt" >= cc."claimedAt"
      )`;

  const row = rows[0];

  return { fresh: Number(row?.fresh ?? 0n), retry: Number(row?.retry ?? 0n) };
}

/** The same backlog, across every campaign the account's workspaces own. */
export async function accountPendingPlacement(
  db: Db,
  accountId: string,
  now: Date,
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ pending: bigint }>>`
    SELECT COUNT(*) AS pending
    FROM "CampaignContact" cc
    INNER JOIN "Campaign" c ON c.id = cc."campaignId"
    INNER JOIN "Workspace" w ON w.id = c."workspaceId"
    WHERE w."ownerAccountId" = ${accountId}
      AND cc.status = 'QUEUED'
      AND cc."claimedAt" IS NOT NULL
      AND cc."claimedAt" < ${now}
      AND NOT EXISTS (
        SELECT 1 FROM "CallAttempt" ca
        WHERE ca."campaignContactId" = cc.id
          AND ca."startedAt" >= cc."claimedAt"
      )`;

  return Number(rows[0]?.pending ?? 0n);
}
