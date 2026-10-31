import { Prisma, type ContactArmKind, type PrismaClient } from '@prisma/client';
import { neverPlacedSql } from '../lib/dialBudget.js';
import {
  sweepContactsOverDialBudget,
  sweepContactsOverFollowUpBudget,
} from '../lib/campaignLifecycle.js';

/**
 * Taking contacts out of a campaign's queue.
 *
 * **One statement.** The rows are selected, locked and flipped `PENDING →
 * QUEUED` by a single `UPDATE … FROM (CTE)`, so there is no window between
 * reading a contact and claiming it. Split into a read and a write, two
 * dispatchers — or two overlapping passes of one — both see the same PENDING
 * row and both dial it, and the person on the other end takes two calls from
 * the same campaign within a second of each other.
 *
 * `FOR UPDATE OF cc SKIP LOCKED` is the other half: a row another transaction
 * already holds is passed over rather than waited for, so a second dispatcher
 * fills its batch from further down the queue instead of blocking behind the
 * first. The `LIMIT` is what keeps those row locks short-lived.
 *
 * Written as raw SQL rather than through the query builder because none of
 * that is expressible in it: neither `SKIP LOCKED`, nor select-and-update as
 * one statement, nor an `ORDER BY` over a boolean expression, which is what
 * the lane priorities are.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Which part of the queue to draw from. Every lane but `any` is one value of
 * `armKind` — the column each re-arm path writes to say why this row's clock
 * is set — so the lanes partition the PENDING rows rather than overlapping.
 *
 * - `fresh` — `FRESH`: nobody has been called yet, or nothing more specific
 *   than its turn is being waited for.
 * - `retry` — `RETRY` and `FOLLOW_UP` together: everything already dialled
 *   once, with the follow-ups ordered first inside it.
 * - `resume` — `RESUME`: a conversation that dropped mid-call, which the
 *   engine chose to go back to. Bounded by the retry reservation, which it
 *   shares with `retry`; see `claimLanes`.
 * - `callback` — `CALLBACK`: a promise made to a person on the phone is due.
 *   Cuts across every other lane and is exempt from the retry budget.
 * - `urgent` — `CALLBACK` and `RESUME` together, for the give-back pass that
 *   offers one side's unused slots to the other. Ordered promise-first, so
 *   bounding the two jointly does not reorder them. The one lane that
 *   deliberately overlaps its neighbours: it is the same rows `callback` and
 *   `resume` draw, asked for in one claim so neither is arbitrarily preferred.
 * - `routine` — `FRESH`, `RETRY` and `FOLLOW_UP`: every dial nobody is sitting
 *   on the line waiting for. The complement of `urgent`, and the lane the
 *   passes below the urgent bound contest in — so retries and the fresh list
 *   settle between themselves by age exactly as they always have, once the
 *   urgent lanes have taken the share the split allows them.
 * - `any` — every arm at once. **No caller in the dispatcher.** It was the
 *   shared pool a campaign reserving nothing dialled in, and the borrow pass
 *   that lent one lane's idle slots to the others; both are now `drainSplit`,
 *   which divides those slots rather than handing them to whichever arm sorts
 *   first. It stays because the suite claims through it to exercise the
 *   predicates that belong to no lane — the dial cap, the do-not-call list,
 *   the eligibility window, the retry budget — and an unfiltered claim is the
 *   honest way to ask about those. Its ordering is kept in step with the
 *   priorities beside it so that what it proves stays true of the lanes that
 *   run.
 */
export type ClaimLane =
  | 'fresh'
  | 'retry'
  | 'resume'
  | 'callback'
  | 'urgent'
  | 'routine'
  | 'any';

export interface ClaimOptions {
  /**
   * The campaign whose queue this draws from — and, because the do-not-call
   * list is keyed by campaign + phone, the same id is what the opt-out check
   * joins against. The claim refuses a listed number in every lane: an opt-out
   * is always on, never a knob, and beats even an armed callback.
   *
   * This campaign's list only, deliberately. Somebody who says "stop calling
   * me about this" has opted out of *this* campaign; a second campaign in the
   * same workspace, run by the same people for a different reason, may still
   * have a legitimate reason to dial the number and asks its own list.
   */
  campaignId: string;
  /** How many to take. Zero or less short-circuits without a round trip. */
  limit: number;
  lane: ClaimLane;
  /**
   * The campaign's retry budget, **re-read every pass**. Lowering it
   * mid-campaign has to stop a retry that is already waiting, or the setting is
   * a control that lies.
   */
  retryCount: number;
  /**
   * The absolute dial cap: `retryCount + maxGoalFollowUps + 1`, derived by
   * `totalDialsFor` and passed like `retryCount` — re-read from the campaign
   * every pass, so lowering EITHER lane budget mid-campaign stops a dial that
   * is already waiting.
   *
   * A contact whose `MAX(attemptNo)` has reached it is not claimable in ANY
   * lane: the cap beats an armed callback, because it counts dials of every
   * kind. That is the one place a promise is not exempt, and it is why the
   * cap and the retry reservation below are two clauses rather than one — the
   * reservation a `CALLBACK` escapes, the cap it does not.
   */
  maxTotalDials: number;
  /**
   * The FOLLOW-UP budget, **re-read every pass** exactly as `retryCount` is,
   * and for the identical reason: lowering it mid-campaign has to stop a
   * follow-up that is already waiting, or the setting is a control that lies.
   *
   * It bounds only the arm that spends it. A `RETRY` row is unaffected by it,
   * and a `FOLLOW_UP` row is unaffected by `retryCount` — the two budgets
   * belong to two different contacts, since the first answer moves a contact
   * into the follow-up lane and forfeits whatever retries it had left.
   */
  maxGoalFollowUps: number;
  /**
   * The most PLACED dials one contact may take in one campaign-local calendar
   * day. Counted from `dayStart` below, excluding a callback the person asked
   * for.
   *
   * A cap this refuses on settles NOTHING. A contact at it has not run out of
   * anything — it is simply not their turn again today — so unlike the two
   * budgets above there is no sweep beside it, and the row waits for the next
   * local midnight and is claimable again.
   */
  maxDialsPerDay: number;
  /**
   * The campaign-local midnight the daily count starts from, computed once per
   * pass by `localDayStart` and injected exactly like `now`.
   *
   * Injected rather than computed here for the reason `now` is: the whole
   * sweep runs off one instant, and a claim deriving its own day boundary
   * would count against a different day from the window check that let it get
   * this far.
   */
  dayStart: Date;
  /**
   * The pass's clock, injected rather than `NOW()`.
   *
   * The whole sweep already runs off one instant, and a claim that read the
   * database's clock instead would evaluate eligibility against a different
   * moment from the window check that let it get this far.
   */
  now: Date;
  /**
   * The test allowlist, when one is configured. Applied **inside** the claim
   * rather than after it: a contact filtered out afterwards would already be
   * QUEUED, and a test switch must not leave permanent marks on a customer's
   * own list.
   */
  onlyPhones?: readonly string[];
}

/** Everything the launcher needs about one claimed contact, in one round trip. */
export interface ClaimedContact {
  id: string;
  contactId: string;
  /** Retries consumed, not dials made. */
  attempts: number;
  phone: string;
  /**
   * The four columns `contacts-csv.ts` lifts OUT of `metadata` onto the
   * contact, carried because a campaign's `variableMap` may name any of them.
   * Resolving a map against `metadata` alone would make exactly the columns
   * every spreadsheet carries the ones that cannot be mapped.
   */
  name: string | null;
  email: string | null;
  tags: string[];
  metadata: Prisma.JsonValue;
  /**
   * Why this row's clock was set, as the claiming statement itself read it —
   * which is the only reading a later booking, re-arm or settle cannot move.
   * The attempt row's `kind` is stamped from it, so the order a batch was
   * chosen in and the label it carries months later cannot disagree, and a
   * webhook replay reads the same answer as the claim did.
   */
  armKind: ContactArmKind;
}

/**
 * A promise somebody is still owed.
 *
 * One column, because one column is now what records it: the callback booking
 * is the only writer of `armKind = 'CALLBACK'`, and it is the only writer of
 * `callbackAt`. The predicate used to be `callbackAt IS NOT NULL AND
 * nextEligibleAt = callbackAt`, which stopped meaning "a promise" the day the
 * `immediate` resume began arming the same pair to reach this lane.
 *
 * Used twice: as the callback lane's own filter, and as the retry budget's
 * exemption — a callback spends no retry, so a lowered budget must not cancel
 * a call somebody was told to expect. A RESUME is deliberately NOT exempt: the
 * contact spent its retries getting to where it is, and the retry-lowering
 * sweep has to be able to reach it.
 */
const ARMED_FOR_CALLBACK = Prisma.sql`cc."armKind" = 'CALLBACK'`;

/**
 * The four lanes that are one arm each, and the shared lane that is none.
 *
 * `fresh` and `retry` are exact complements *within the arms they name*, and
 * the resume lane sits beside them rather than inside either: the borrow pass
 * is skipped only when every reserved lane came back proven dry, so a contact
 * belonging to no reserved lane would otherwise never be claimed at all.
 */
function laneFilter(lane: ClaimLane): Prisma.Sql {
  if (lane === 'retry') return Prisma.sql`AND cc."armKind" IN ('RETRY', 'FOLLOW_UP')`;
  if (lane === 'fresh') return Prisma.sql`AND cc."armKind" = 'FRESH'`;
  if (lane === 'resume') return Prisma.sql`AND cc."armKind" = 'RESUME'`;
  if (lane === 'callback') return Prisma.sql`AND ${ARMED_FOR_CALLBACK}`;
  if (lane === 'urgent') return Prisma.sql`AND cc."armKind" IN ('CALLBACK', 'RESUME')`;
  if (lane === 'routine') return Prisma.sql`AND cc."armKind" IN ('FRESH', 'RETRY', 'FOLLOW_UP')`;

  return Prisma.empty;
}

/**
 * The order rows leave the queue in.
 *
 * **Every lane ends in `id ASC`**, and none of them may stop being allowed to.
 * Not one of the sort columns is unique: `createdAt` defaults to the
 * transaction timestamp, so a bulk import stamps one identical value across
 * the whole list; `callbackAt` and `nextEligibleAt` are built through
 * `instantOf`, which zeroes seconds and milliseconds, so a batch rolled out of
 * a closed window lands on one minute together. At an identical key SQL leaves
 * the order undefined, and undefined here is a page of the queue that
 * reshuffles between reads and a rotation paired against the wrong contacts.
 *
 * Written twice, against two different aliases: once to decide *which* rows the
 * CTE takes, and once on the way out. `UPDATE … RETURNING` has no defined row
 * order, so a batch selected soonest-promise-first came back in whatever order
 * the update happened to write it — and the dispatcher pairs the i-th claimed
 * contact with the i-th number in the rotation, so an unordered batch is a
 * rotation that is not a rotation.
 */
function claimOrder(lane: ClaimLane, alias: 'cc.' | ''): Prisma.Sql {
  const prefix = Prisma.raw(alias);

  /**
   * Soonest promise first — and then the id, which is not decoration.
   *
   * `rollIntoDialWindow` builds every booked instant through `instantOf`,
   * which zeroes seconds and milliseconds, so one bad carrier hour rolls a
   * whole batch of promises onto the identical minute. At an identical sort
   * key SQL leaves the order undefined, and the batch is paired positionally
   * with the number rotation on the way out — so an undefined order is a
   * rotation that is not a rotation, and a page of the queue that shuffles
   * between reads.
   */
  if (lane === 'callback') {
    return Prisma.sql`ORDER BY ${prefix}"callbackAt" ASC, ${prefix}id ASC`;
  }

  /**
   * A resume is ordered by the clock the resume itself wrote. It carries no
   * `callbackAt` — nothing but a real promise writes that column — and
   * `createdAt` would sort a dropped conversation by when its contact was
   * imported, which is the one fact about it that does not matter.
   */
  if (lane === 'resume') {
    return Prisma.sql`ORDER BY ${prefix}"nextEligibleAt" ASC, ${prefix}id ASC`;
  }

  /**
   * The two urgent arms together, a promise ahead of a resume.
   *
   * `COALESCE` is what makes the second key readable across both: a resume
   * writes no `callbackAt` — nothing but a real promise writes that column —
   * so ordering this lane on `callbackAt` alone would leave every resume in an
   * undefined order among themselves. The dispatcher pairs the i-th claimed
   * contact with the i-th number in the dial rotation, so an undefined order is
   * a rotation that is not a rotation.
   *
   * The trailing `id ASC` is required for that same reason, and for the one
   * this file already gives: none of the sort columns is unique, because
   * `instantOf` zeroes seconds and a batch rolled out of a closed dial window
   * lands on one identical minute.
   */
  if (lane === 'urgent') {
    return Prisma.sql`ORDER BY (${prefix}"armKind" = 'CALLBACK') DESC,
                               COALESCE(${prefix}"callbackAt", ${prefix}"nextEligibleAt") ASC,
                               ${prefix}id ASC`;
  }

  /**
   * In the retry lane, the contact dialled the fewest times goes first.
   *
   * The lane is "everything already dialled once", and ordered by age it
   * re-dialled whatever the import stamped first. A bulk import stamps the
   * whole list at once, so the head of it took every retry slot, pass after
   * pass, and a campaign ended with one contact on its seventh dial while the
   * tail sat at one or two. The first key is the dials the engine has already
   * spent on a contact beyond its first: `attempts` is retries consumed,
   * `followUpCount` goal follow-ups consumed — the resume re-arm bumps this
   * same counter, so a dropped call picked back up is counted too — and
   * `callbackCount` callbacks booked. Three counters over four re-arm paths,
   * and each re-arm is a dial. Summed, they are the one number the operator
   * is comparing when the complaint is "why this one again".
   *
   * "Dials so far" is a tally, not the attempt history. Re-extraction resets
   * `followUpCount` to 0 on every plan it writes, so a re-judged contact
   * re-enters this lane counting only its retries and callbacks and sorts
   * ahead of a contact that has in fact been dialled as often. The attempt
   * rows are the ground truth the dial cap in `claimContacts` reads, but a
   * correlated `MAX(attemptNo)` in a sort key is a per-row probe on every
   * pass; the tally is accepted as close enough for an ordering.
   *
   * Among contacts dialled the same number of times, a goal follow-up goes
   * before a plain retry. A retry is a number that did not pick up; a
   * follow-up is a conversation that happened and left the goal unmet, so
   * somebody is waiting on the second half of it. Keyed on `armKind` and not
   * on `followUpCount > 0`, which is what this used to read: that counter is a
   * lifetime tally with no writer but an increment, so a plain retry of a
   * contact that was followed up once kept follow-up priority for every
   * remaining dial of its life. The arm is rewritten by whichever path
   * re-armed the row last, so it answers about now.
   *
   * Then age, then the id, for the reason the file gives above.
   *
   * The routine lane — the one that runs when `retryConcurrency = 0` folds
   * retries in with fresh dials — deliberately does not get this ordering
   * yet: there the count would also rank retries against never-dialled
   * contacts, which is a different decision than this one.
   */
  if (lane === 'retry') {
    return Prisma.sql`ORDER BY (${prefix}"attempts" + ${prefix}"followUpCount" + ${prefix}"callbackCount") ASC,
                               (${prefix}"armKind" = 'FOLLOW_UP') DESC,
                               ${prefix}"createdAt" ASC,
                               ${prefix}id ASC`;
  }

  /**
   * The unfiltered lane, ordered by the whole priority.
   *
   * It no longer decides anything the dispatcher does — `drainSplit` divides
   * those slots instead of ordering them — but the suite claims through it to
   * reach the predicates that belong to no lane, and an ordering here that
   * disagreed with the lanes that do run would make what it proves untrue of
   * them.
   */
  /**
   * The routine lane is `any` with the urgent arms removed, so it carries what
   * is left of that priority: a goal follow-up ahead of a plain retry, and
   * then age. Written out rather than shared with `any` because the two are
   * one edit apart today and would not stay that way — and a lane whose order
   * silently followed another's is how the follow-up priority became a setting
   * with no effect the last time.
   */
  if (lane === 'routine') {
    return Prisma.sql`ORDER BY (${prefix}"armKind" = 'FOLLOW_UP') DESC, ${prefix}"createdAt" ASC, ${prefix}id ASC`;
  }

  if (lane === 'any') {
    return Prisma.sql`ORDER BY (${prefix}"armKind" = 'CALLBACK') DESC, (${prefix}"armKind" = 'RESUME') DESC, (${prefix}"armKind" = 'FOLLOW_UP') DESC, ${prefix}"createdAt" ASC, ${prefix}id ASC`;
  }

  return Prisma.sql`ORDER BY ${prefix}"createdAt" ASC, ${prefix}id ASC`;
}

export async function claimContacts(
  db: Db,
  {
    campaignId,
    limit,
    lane,
    retryCount,
    maxTotalDials,
    maxGoalFollowUps,
    maxDialsPerDay,
    dayStart,
    now,
    onlyPhones,
  }: ClaimOptions,
): Promise<ClaimedContact[]> {
  // No budget, no query. The sweep asks this several times per campaign per
  // pass and most of those asks are for nothing.
  if (limit <= 0) return [];

  // "MAX(attemptNo) < cap", spelled as the absence of any PLACED attempt at or
  // past it — one probe of the per-contact attempt unique. Always in the SQL
  // now: every campaign has a dial budget, because the budget is the retry
  // panel's own number.
  //
  // Rows a launch failure closed without ever reaching the platform are not
  // dials and do not spend the budget; `dialBudget.ts` says which those are,
  // and why an unconfirmed write is not among them.
  const dialCap = Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "CallAttempt" ca
          WHERE ca."campaignContactId" = cc.id
            AND ca."attemptNo" >= ${maxTotalDials}
            AND NOT ${neverPlacedSql('ca')})`;

  /**
   * The follow-up budget, on the rows that spend it. `<=` rather than `<`
   * because `followUpCount` is the number ALREADY spent and the row is armed
   * for the next one: a contact that has taken two follow-ups is inside a
   * budget of two only while a third is still allowed — which is the same
   * off-by-one the retry clause resolves with `attempts <= retryCount`.
   */
  const followUpBudget = Prisma.sql`AND (cc."armKind" <> 'FOLLOW_UP' OR cc."followUpCount" <= ${maxGoalFollowUps})`;

  /**
   * The daily cap: placed dials since the campaign-local midnight, excluding a
   * callback the person asked for. An armed CALLBACK is exempt outright — a
   * promise is a time a person named, and a cap on how often the campaign
   * chooses to ring them is not a reason to break it.
   *
   * A correlated count rather than an index: the match set is one contact's
   * attempts, reached through the `(campaignContactId, attemptNo)` unique, and
   * bounded in practice by the dial ceiling.
   */
  const dailyCap = Prisma.sql`AND (${ARMED_FOR_CALLBACK} OR (
          SELECT COUNT(*) FROM "CallAttempt" ca
          WHERE ca."campaignContactId" = cc.id
            AND ca."startedAt" >= ${dayStart}
            AND COALESCE(ca.kind, '') <> 'callback'
            AND NOT ${neverPlacedSql('ca')}) < ${maxDialsPerDay})`;

  // An allowlist that is configured but empty would match no contact. That is
  // the caller's business — an unset allowlist means no restriction and never
  // reaches here — but the SQL must still be well-formed.
  const allowlist =
    onlyPhones === undefined
      ? Prisma.empty
      : Prisma.sql`AND c.phone IN (${Prisma.join(onlyPhones.length > 0 ? [...onlyPhones] : [''])})`;

  return db.$queryRaw<ClaimedContact[]>`
    WITH selected AS (
      -- Every column a lane's ORDER BY reads has to be projected here: the
      -- outer SELECT sorts "claimed", which is RETURNING selected.*
      SELECT cc.id, cc."contactId", cc.attempts, cc."followUpCount", cc."callbackCount",
             cc."armKind", cc."callbackAt", cc."nextEligibleAt", cc."createdAt",
             c.phone, c.name, c.email, c.tags, c.metadata
      FROM "CampaignContact" cc
      INNER JOIN "Contact" c ON c.id = cc."contactId"
      WHERE cc."campaignId" = ${campaignId}
        AND cc.status = 'PENDING'
        AND (cc."nextEligibleAt" IS NULL OR cc."nextEligibleAt" <= ${now})
        -- The retry budget, and its two exemptions. A promise is exempt
        -- because it spends no retry; a RESUME is deliberately not, because
        -- the contact it re-arms spent every retry that got it here. A
        -- FOLLOW_UP is exempt because it is in the OTHER lane: its retries
        -- were forfeited when somebody answered, so cc.attempts is frozen at
        -- whatever it had reached and reading it as a budget would refuse a
        -- contact that is inside the only budget it still spends.
        AND (cc.attempts <= ${retryCount} OR ${ARMED_FOR_CALLBACK} OR cc."armKind" = 'FOLLOW_UP')
        AND NOT EXISTS (
          SELECT 1 FROM "DoNotCall" dnc
          WHERE dnc."campaignId" = ${campaignId} AND dnc.phone = c.phone)
        ${dialCap}
        ${followUpBudget}
        ${dailyCap}
        ${allowlist}
        ${laneFilter(lane)}
      ${claimOrder(lane, 'cc.')}
      LIMIT ${limit}
      FOR UPDATE OF cc SKIP LOCKED
    ), claimed AS (
      UPDATE "CampaignContact"
      SET status = 'QUEUED', "claimedAt" = ${now}, "lastAttemptAt" = ${now}, "updatedAt" = ${now}
      FROM selected
      WHERE "CampaignContact".id = selected.id
      RETURNING selected.*
    )
    SELECT id, "contactId", attempts, phone, name, email, tags, metadata, "armKind"
    FROM claimed
    ${claimOrder(lane, '')}`;
}

/**
 * Settles this campaign's do-not-call contacts out of the queue.
 *
 * The claim above refuses a listed number, which keeps the phone from ringing
 * — but a refusal alone leaves the contact PENDING forever, holding its
 * campaign open against the completion pass. So the sweep settles them
 * `EXCLUDED` before it claims: the same status an operator's remove writes,
 * with the same counter move (`totalContacts` down, floored), taken under the
 * same campaign lock in the same lock order. Guarded on `PENDING`, so a
 * contact mid-call settles through the ordinary resolution instead and a
 * repeated pass moves nothing twice.
 *
 * The list read is **this campaign's own**, keyed by campaign + phone: an
 * opt-out belongs to the campaign it was said on, and a second campaign in the
 * same workspace neither inherits it nor is settled by it.
 *
 * No reason column exists on the contact and none is invented: the DoNotCall
 * row itself — campaign, phone, reason, source contact — is the queryable
 * record of why, and the journey reads it from there.
 *
 * One indexed existence probe when the campaign's list is empty, which is
 * almost every campaign on every pass.
 */
export async function excludeDoNotCallContacts(
  db: PrismaClient,
  { campaignId, now }: { campaignId: string; now: Date },
): Promise<number> {
  const listed = await db.doNotCall.findFirst({ where: { campaignId }, select: { id: true } });

  if (listed === null) return 0;

  return db.$transaction(async (tx) => {
    // The campaign row first — the shared lock order of every writer that
    // touches a campaign and its contacts in one transaction.
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;

    // Raw for the join: the list is keyed by phone, which lives on Contact,
    // and no relation connects the two models. `updatedAt` is stamped by hand
    // because Prisma's @updatedAt is client-side — and from the pass's own
    // injected clock, never the database's.
    const excluded = await tx.$executeRaw`
      UPDATE "CampaignContact" cc
      SET status = 'EXCLUDED', "updatedAt" = ${now}
      FROM "Contact" c
      WHERE cc."campaignId" = ${campaignId}
        AND cc.status = 'PENDING'
        AND c.id = cc."contactId"
        AND EXISTS (
          SELECT 1 FROM "DoNotCall" dnc
          WHERE dnc."campaignId" = ${campaignId} AND dnc.phone = c.phone)`;

    if (excluded > 0) {
      // The operator-exclude's counter move: excluded contacts leave the
      // denominator. A true floor rather than a guard — a counter that has
      // drifted below the batch size still takes the correction it can, down
      // to zero, instead of skipping it and preserving the drift.
      await tx.$executeRaw`
        UPDATE "Campaign"
        SET "totalContacts" = GREATEST(0, "totalContacts" - ${excluded}), "updatedAt" = ${now}
        WHERE id = ${campaignId}`;
    }

    return excluded;
  });
}

/**
 * Settles this campaign's out-of-reach contacts, the way the do-not-call sweep
 * above settles its listed ones.
 *
 * Same shape and the same reason: a contact the claim refuses in every lane
 * would otherwise sit PENDING for ever, counted as remaining work by the
 * completion pass, and its campaign could never complete. Taken under the
 * campaign lock in the shared lock order, with the counter moved in the same
 * transaction as the rows it describes.
 *
 * `SKIPPED` and `skippedCount`, not `EXCLUDED` and `totalContacts`: the
 * campaign put this contact out of reach, no person did, so it stays in the
 * denominator. That is the retry-budget sweep's rule and this is its analogue.
 *
 * Called for every campaign: the dial ceiling is
 * `retryCount + maxGoalFollowUps + 1` and bounds every contact of every
 * campaign, so a ceiling either lowered budget dragged down strands rows here
 * exactly as they are stranded in `sweepContactsOverRetryBudget`. The
 * follow-up sweep runs alongside, for the reason the body gives.
 */
export async function settleContactsOverDialBudget(
  db: PrismaClient,
  {
    campaignId,
    maxTotalDials,
    maxGoalFollowUps,
    now,
  }: { campaignId: string; maxTotalDials: number; maxGoalFollowUps: number; now: Date },
): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;

    /**
     * Two sweeps under the one lock, because the claim refuses on two budgets
     * and a refusal alone strands a row.
     *
     * The follow-up sweep runs here and not only on the PATCH that lowers the
     * budget, because rows past the budget do not only come from a lowering.
     * Before the lanes were split the resolver spent follow-ups bounded by
     * nothing but the dial ceiling, so a RUNNING campaign carries contacts at
     * three, four, five follow-ups against a stored budget of two — and the
     * ceiling, now `retryCount + maxGoalFollowUps + 1`, sits ABOVE where those
     * rows stopped, so the sweep above never reaches them. Left to the PATCH
     * alone, they would wait PENDING until somebody happened to edit the
     * budget, holding the campaign open the whole time.
     */
    const swept =
      (await sweepContactsOverDialBudget(tx, campaignId, maxTotalDials, now)) +
      (await sweepContactsOverFollowUpBudget(tx, campaignId, maxGoalFollowUps));

    if (swept > 0) {
      await tx.campaign.update({
        where: { id: campaignId },
        data: { skippedCount: { increment: swept }, updatedAt: now },
      });
    }

    return swept;
  });
}
