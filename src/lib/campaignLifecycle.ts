import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { CAMPAIGN_INCLUDE, type CampaignWithAgent } from './campaign.js';
import { neverPlacedSql } from './dialBudget.js';
import {
  MAX_CONCURRENCY_LIMIT,
  MAX_GOAL_FOLLOW_UPS_CEILING,
  MAX_MAX_DIALS_PER_DAY,
  MIN_CONCURRENCY_LIMIT,
  MIN_MAX_DIALS_PER_DAY,
} from './campaignConfig.js';

/**
 * The ends of a campaign's life: stopping it, and relabelling a stopped one.
 *
 * Both live here rather than in the route because both are transactions with
 * an order other writers depend on, and a transaction spelled out inline in a
 * handler is one nobody finds when they go looking for who takes the lock.
 */

/** The statuses that mean a telephone is ringing right now. */
export const LIVE_CONTACT_STATUSES = ['QUEUED', 'CALLING'] as const;

/**
 * Stops a campaign and empties its queue.
 *
 * ## The lock, and why it is first
 *
 * The campaign row is locked `FOR UPDATE` before a single contact is touched —
 * the same order the dispatcher's completion pass, the callback re-arm and the
 * top-up take. Without it a callback booked mid-stop slips between the sweep
 * and the status write, leaving one contact PENDING on a campaign that reports
 * itself stopped: a call nobody expects, placed by a campaign an operator
 * believes they killed.
 *
 * ## What is swept, and what is not
 *
 * `PENDING` is everything still waiting — fresh, cooling down, or armed for a
 * promised callback — and all of it becomes `SKIPPED`, because the operator's
 * decision is that these calls are not going to be made. Leaving them PENDING
 * would let a later top-up or re-start resume dialing a list somebody stopped.
 *
 * `QUEUED` and `CALLING` are deliberately untouched. Those calls are already
 * connected; sweeping them would make the contact list disagree with a
 * telephone that is ringing, and the outcome webhook resolves them normally.
 *
 * `stoppedAt` and `completedAt` are stamped with one instant. `completedAt` is
 * when the campaign stopped running, which is exactly now; `stoppedAt` is the
 * column top-up and callback booking key their refusals on, and it is never
 * cleared — that is what stops `complete`'s relabel being a two-click bypass
 * of them.
 */
export async function stopCampaign(
  campaignId: string,
  now: Date,
  /** Who pressed stop; the campaign page names them. */
  actor: string,
): Promise<CampaignWithAgent> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;

    const swept = await tx.campaignContact.updateMany({
      where: { campaignId, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });

    return tx.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'STOPPED',
        stoppedAt: now,
        completedAt: now,
        haltReason: `Stopped by ${actor}.`,
        skippedCount: { increment: swept.count },
      },
      ...CAMPAIGN_INCLUDE,
    });
  });
}

/**
 * Takes the contacts that a lowered retry budget has left stranded out of the
 * queue, and reports how many.
 *
 * ## Why this exists at all
 *
 * The claim re-reads `retryCount` every pass and will not take a contact whose
 * `attempts` already exceeds it. Without this sweep those rows sit `PENDING`
 * forever: never dialed, never finished, and counted as remaining work by the
 * completion pass — so the campaign can never complete either. The setting
 * would be a control that quietly strands the list it was applied to.
 *
 * ## Run on every supply, not only on a lowering
 *
 * A no-op UPDATE is cheaper than reasoning about drift, and running it
 * unconditionally also heals rows left behind by an earlier lowering.
 *
 * ## The callback exemption, and why it is only a callback
 *
 * A contact armed for a promised callback is never swept: a callback spends no
 * retry, so a budget it was not spending must not cancel it. `armKind =
 * 'CALLBACK'` is that fact, written by the booking and by nothing else, so the
 * exemption is one inequality — where the timestamp pair it replaces needed
 * its null arms spelled out, because SQL's `NOT (a = b)` is NULL when either
 * side is NULL and a NULL predicate excludes the row, so a contact carrying a
 * *stale* `callbackAt` beside a null `nextEligibleAt` was silently exempted by
 * the short form.
 *
 * A `RESUME` is deliberately NOT exempt, and that is the case the pair got
 * wrong. It armed those same two columns to reach the callback lane, so a
 * dropped conversation on a contact that had already spent every retry it was
 * allowed came out exempt from a budget it had very much spent — and lowering
 * `retryCount` could not reach it at all. The engine chose that instant;
 * nobody was promised it.
 *
 * **The caller must already hold the campaign row `FOR UPDATE`**, and must
 * apply the returned count to `skippedCount` in the same transaction. A status
 * change without its counter leaves the stats page disagreeing with the contact
 * list permanently.
 */
/**
 * Contacts the absolute dial cap has put out of reach, settled out of the
 * queue.
 *
 * The claim refusing them is only half an answer. Refused and left PENDING, a
 * contact is never dialled, never settles, is counted as remaining work by the
 * completion pass, and holds its campaign open for ever — and nothing else
 * settles it: the do-not-call sweep touches only listed numbers and
 * `releaseStaleClaims` only QUEUED rows.
 *
 * Two things put a contact past the cap, and this heals both: an operator
 * lowering `retryCount` mid-campaign (the exact analogue of the
 * retry-budget sweep above, which is why they are written the same way), and
 * upstream weather spending the contact's ordinals on launches that never
 * placed a call — which is why the count is of PLACED attempts, exactly as the
 * claim counts them.
 *
 * `SKIPPED`, like the retry sweep: this is something the campaign did to the
 * contact, not something a person did, so it leaves the denominator alone.
 *
 * **No armed-callback exemption**, and that is the one line where this differs
 * from its sibling. A callback is exempt from the RETRY budget because it
 * spends none; it is not exempt from this cap, which counts dials of every
 * kind — so an armed callback past the cap is refused by the claim in its own
 * lane and would sit PENDING for ever exactly like the rest.
 */
export async function sweepContactsOverDialBudget(
  tx: Prisma.TransactionClient,
  campaignId: string,
  maxTotalDials: number,
  now: Date = new Date(),
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "CampaignContact" cc
    SET status = 'SKIPPED', "updatedAt" = ${now}
    WHERE cc."campaignId" = ${campaignId}
      AND cc.status = 'PENDING'
      AND EXISTS (
        SELECT 1 FROM "CallAttempt" ca
        WHERE ca."campaignContactId" = cc.id
          AND ca."attemptNo" >= ${maxTotalDials}
          AND NOT ${neverPlacedSql('ca')})`;
}

export async function sweepContactsOverRetryBudget(
  tx: Prisma.TransactionClient,
  campaignId: string,
  retryCount: number,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "CampaignContact"
    SET status = 'SKIPPED', "updatedAt" = NOW()
    WHERE "campaignId" = ${campaignId}
      AND status = 'PENDING'
      AND attempts > ${retryCount}
      AND "armKind" NOT IN ('CALLBACK', 'FOLLOW_UP')`;
}

/**
 * The follow-up budget's analogue of the retry sweep: a reached contact
 * waiting on a follow-up the lowered budget no longer covers.
 *
 * It exists for the reason the retry sweep does. The claim refuses such a row,
 * and a refusal alone leaves it PENDING for ever — never dialled, never
 * settled, counted as remaining work by the completion pass, so the campaign
 * can never complete either.
 *
 * Two exemptions, matching the sweep above. `CALLBACK` because a promise
 * spends neither budget and so neither may cancel it; and every arm that is
 * not `FOLLOW_UP`, because `followUpCount` is a LIFETIME tally that nothing
 * ever brings down — a contact once followed up and since re-armed as a plain
 * retry carries a number from a lane it has left, and sweeping on it would
 * settle a contact inside the budget it is actually spending. That is the same
 * reasoning that put `armKind` on the row in the first place.
 */
export async function sweepContactsOverFollowUpBudget(
  tx: Prisma.TransactionClient,
  campaignId: string,
  maxGoalFollowUps: number,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "CampaignContact"
    SET status = 'SKIPPED', "updatedAt" = NOW()
    WHERE "campaignId" = ${campaignId}
      AND status = 'PENDING'
      AND "armKind" = 'FOLLOW_UP'
      AND "followUpCount" > ${maxGoalFollowUps}`;
}

/**
 * The columns a duplicate must not carry over.
 *
 * Everything **not** listed here is copied, which is the point: a column added
 * next month is duplicated automatically, where a hand-written select would
 * silently reset it on every clone and nobody would notice until a customer
 * asked why their copy dials differently.
 *
 * The list is identity (`id`, `workspaceId`, `name`), the row's own clocks, the
 * live state (`status`, every counter, the rotation cursor) and the three
 * schedule columns — a clone is a fresh DRAFT that has run nothing and is
 * scheduled for nothing. `phoneNumberId` is here because the rotation is
 * re-attached explicitly and the legacy pointer is derived from it.
 */
export const NON_COPYABLE_CAMPAIGN_COLUMNS = [
  'id',
  'workspaceId',
  'name',
  'createdAt',
  'updatedAt',
  'phoneNumberId',
  'status',
  'rrCursor',
  'totalContacts',
  'completedCount',
  'failedCount',
  'skippedCount',
  'startedAt',
  'pausedAt',
  'completedAt',
  'stoppedAt',
  'scheduledStartAt',
  'scheduleError',
] as const;

export interface ClampedCampaignConfig {
  concurrencyLimit: number;
  retryConcurrency: number;
  retrySharePercent: number;
  retryCount: number;
  cooldownMinutes: number;
  retryDelaysMinutes: number[];
  maxGoalFollowUps: number;
  maxDialsPerDay: number;
}

/**
 * The dialing policy, clamped rather than refused.
 *
 * The write paths reject an out-of-range value, and rightly: a caller who
 * asked for fifty retries and silently got twenty was billed for a campaign
 * they did not describe. A **copy** is the one place that trade reverses.
 * Nobody typed these numbers into this request — they were typed months ago,
 * possibly before a bound existed — and refusing the duplicate would leave the
 * operator with no way to make one at all, over a value they cannot see and did
 * not choose. Clamping copies the campaign they can see.
 */
export function clampCampaignConfig(source: ClampedCampaignConfig): ClampedCampaignConfig {
  // The constants, never the literals they held. Spelled out a second time,
  // this bound silently disagreed with the one the API enforces the moment
  // either moved — a duplicate that `tsc` cannot see and no route test reaches.
  const concurrencyLimit = Math.max(
    MIN_CONCURRENCY_LIMIT,
    Math.min(source.concurrencyLimit, MAX_CONCURRENCY_LIMIT),
  );

  return {
    concurrencyLimit,
    retryConcurrency: Math.max(0, Math.min(source.retryConcurrency, concurrencyLimit)),
    // A percentage, so its bounds do not move with the limit beside it.
    retrySharePercent: Math.max(0, Math.min(source.retrySharePercent, 100)),
    retryCount: Math.max(0, Math.min(source.retryCount, 20)),
    cooldownMinutes: Math.max(1, Math.min(source.cooldownMinutes, 10080)),
    // Sliced first: a ladder longer than the retry cap describes waits that
    // never happen. The per-entry floor is 1 rather than the validator's 0
    // because a copied 0 is a dispatcher re-dialing the instant a call hangs
    // up, and a clone is not the place to discover that setting.
    retryDelaysMinutes: source.retryDelaysMinutes
      .slice(0, 20)
      .map((delay) => Math.max(1, Math.min(delay, 10080))),
    // The follow-up ceiling came down from fifty to ten on 2026-09-09 and no
    // migration rewrote the column, so a source written under the old bound
    // can still hold a value the PATCH refuses. Copied verbatim, the first
    // edit of the duplicate would 400 on a field nobody touched.
    maxGoalFollowUps: Math.max(0, Math.min(source.maxGoalFollowUps, MAX_GOAL_FOLLOW_UPS_CEILING)),
    maxDialsPerDay: Math.max(
      MIN_MAX_DIALS_PER_DAY,
      Math.min(source.maxDialsPerDay, MAX_MAX_DIALS_PER_DAY),
    ),
  };
}

/**
 * `"<name> (Copy)"`, then `"(Copy 2)"`, `"(Copy 3)"`…
 *
 * Found by listing the names already taken rather than by counting copies: a
 * count goes wrong the moment one of them is renamed or deleted, and produces a
 * name that already exists. Two duplicates racing here can still collide, which
 * is harmless — campaign names are not unique, and a customer who makes two
 * copies in the same second can rename one.
 */
export async function nextCopyName(workspaceId: string, sourceName: string): Promise<string> {
  const prefix = `${sourceName} (Copy`;

  const taken = new Set(
    (
      await prisma.campaign.findMany({
        where: { workspaceId, name: { startsWith: prefix } },
        select: { name: true },
      })
    ).map((row) => row.name),
  );

  if (!taken.has(`${prefix})`)) return `${prefix})`;

  // Bounded by what is actually taken: with n names in hand, one of the first
  // n + 2 candidates is free.
  for (let copy = 2; copy <= taken.size + 2; copy += 1) {
    const candidate = `${prefix} ${copy})`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${prefix} ${taken.size + 2})`;
}
