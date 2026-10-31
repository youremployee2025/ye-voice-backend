import { Prisma, type CampaignContactStatus, type ContactArmKind } from '@prisma/client';

/**
 * The arming predicates, and the queue views built on them.
 *
 * ## What decides the lane
 *
 * **`armKind` is why this row's clock is set, right now.** It is written
 * outright by every re-arm path — the retry ladder, the goal follow-up, the
 * `immediate` resume, the callback booking — so the question "what is this
 * contact waiting for" is answered by a column that was written to answer it,
 * rather than reconstructed from counters and timestamps that were each
 * recording something else.
 *
 * Two reconstructions used to stand in for it, and both were wrong in ways
 * that only showed up as a campaign dialing the wrong people first:
 *
 * - **`nextEligibleAt == callbackAt`, both non-null,** meant "a promise
 *   somebody is still owed". Then the `immediate` resume of a dropped
 *   conversation started arming the same pair to reach the callback lane, and
 *   a call the engine chose to place became indistinguishable from a time a
 *   person named out loud. `callbackAt` now keeps its narrow meaning — a real
 *   promise, and nothing else writes it — and a resume is `RESUME`.
 * - **`followUpCount > 0`** meant "this contact is on a follow-up". It is a
 *   lifetime tally whose only writer is an increment, so a plain retry of a
 *   contact that was followed up once kept follow-up priority for the rest of
 *   its life — surviving the goal being cleared and a follow-up budget of 0.
 *
 * ## Only meaningful while the row is waiting
 *
 * A settled row keeps whatever arm it last carried: `COMPLETED` and `FAILED`
 * are done, `SKIPPED` was swept out by a stop, `EXCLUDED` was removed by an
 * operator, and `QUEUED` is on the telephone right now. None of them is going
 * to be dialled at the instant its arm describes, so every predicate here
 * carries `status: 'PENDING'` beside the arm — and the in-memory helpers take
 * the status as a required argument for the same reason, so a new reader
 * cannot silently opt out of half the question.
 *
 * The dispatcher's claim carries the same lane predicates in raw SQL
 * (`dialerClaim.ts`) because none of the claim is expressible through the
 * query builder; the retry-lowering sweep carries the callback exemption, for
 * the same reason (`campaignLifecycle.ts`). Everything that reads rather than
 * claims goes through this module.
 */

/** Armed: a promise somebody is still owed. */
export const ARMED_FOR_CALLBACK: Prisma.CampaignContactWhereInput = {
  status: 'PENDING',
  armKind: 'CALLBACK',
};

/**
 * Not armed for a callback — every other reason a row's clock is set.
 *
 * One inequality, where the timestamp pair needed three clauses to survive
 * SQL's three-valued logic: `NOT (a = b)` is NULL when either side is NULL and
 * a NULL predicate excludes the row, so the short form silently dropped every
 * contact nobody had ever promised a call. `armKind` is `NOT NULL` with a
 * default, so there is no null arm to spell out and no row that falls out of
 * both sides.
 */
export const NOT_ARMED_FOR_CALLBACK: Prisma.CampaignContactWhereInput = {
  armKind: { not: 'CALLBACK' },
};

/**
 * Has anybody ever dialled this contact?
 *
 * **One column: `lastAttemptAt`.** The claim stamps it in the same `UPDATE`
 * that flips a contact `PENDING → QUEUED` (`dialerClaim.ts`), out of every
 * lane, and nothing ever clears it — so it is written before anything else a
 * dial can leave behind, and it survives every path back to PENDING.
 *
 * **Deliberately not the three dial counters**, which spelled the same English
 * sentence and answered a narrower question. `attempts` counts retries
 * CONSUMED, `callbackCount` moves only on a booked callback, `followUpCount`
 * only on a goal re-arm — so a contact can be dialled with all three at zero,
 * and four paths leave exactly that row behind: the attempt-row insert failing
 * and `rollbackLaunch` (`dialer.ts`), `releaseStaleClaims`
 * (`dialerReaper.ts`), and the placement worker's `giveBack`
 * (`dialerPlacement.ts`). Each hands a claimed contact back to PENDING with
 * `lastAttemptAt` already stamped and no counter moved. Read off the counters,
 * every contact a rate-limited sweep gave back reported as somebody nobody had
 * ever rung — while the analytics funnel's `attempted` and the bucket panel's
 * `unreached`, which are this same column, counted them as dialled. Two panels
 * of one dashboard disagreeing about one row.
 *
 * So this is now **the** spelling: `/stats`' `waiting` split, the list's
 * `outcomes` bar (`campaignOutcomes.ts`), the analytics funnel
 * (`analytics.ts`) and the bucket report (`campaignBucketReport.ts`) all ask
 * one question of one column, and cannot disagree.
 *
 * It over-counts in the safe direction: a claim whose placement job never ran
 * is stamped with no dial behind it, which is the population `releaseStaleClaims`
 * exists to clean up. "Dialling was attempted on this contact" is the honest
 * reading of the column, and it is the reading every one of those four
 * surfaces wants.
 *
 * **Deliberately NOT the same evidence as `campaignLaneInFlight`'s in
 * `concurrency.ts`** — that is not an oversight to be tidied up. That one
 * splits the dispatcher's claim *lanes*, which are defined by which arm spent
 * which budget, so it reads the lane each live attempt was stamped with. This
 * one asks a reporting question with no lanes in it, so it asks only whether a
 * dial happened.
 *
 * **Unlike its predecessor this is exact campaign-wide, not only under
 * `PENDING`.** Its callers still scope it — `/stats` and the list read it off
 * the PENDING groups, because "waiting after a dial" is the sentence those two
 * bars draw — but the predicate no longer depends on that scope to be true.
 *
 * `campaignJourney.ts`'s `hasEverDialed` is the other spelling, over a row
 * already in hand rather than a query. Its docstring holds the table of which
 * reader takes which evidence.
 *
 * **Assumes the `CampaignContact` table is aliased `cc`**, the convention every
 * raw statement in this codebase already follows (`dialerClaim.ts`,
 * `concurrency.ts`). SQL only: the query-builder form this module used to
 * export beside it had no caller — both readers need one statement, which
 * Prisma's `groupBy` cannot express — and a second dialect nobody runs is how
 * the two drift apart.
 */
export const HAS_BEEN_DIALED_SQL = Prisma.sql`cc."lastAttemptAt" IS NOT NULL`;

/**
 * `ARMED_FOR_CALLBACK` in memory, for a row already in hand.
 *
 * See that constant for why the status is part of the question and why it is
 * required: a promise is owed by a contact that is still **waiting**, and a
 * settled row carrying a stale arm must not be able to promise anybody a call.
 */
export function isArmedForCallback(
  contact: { armKind: ContactArmKind },
  status: CampaignContactStatus,
): boolean {
  return status === 'PENDING' && contact.armKind === 'CALLBACK';
}

/**
 * The engine's own re-arm of a conversation that dropped mid-call, which is
 * **not** a promise.
 *
 * Kept beside the callback predicate rather than folded into it, because the
 * whole point of the split is that nothing customer-facing may describe a
 * resume as something the lead asked for. The journey draws it as its own
 * event; the contacts list labels it from `armKind` directly.
 */
export function isArmedForResume(
  contact: { armKind: ContactArmKind },
  status: CampaignContactStatus,
): boolean {
  return status === 'PENDING' && contact.armKind === 'RESUME';
}

/**
 * The queues an operator can ask for.
 *
 * Five, because they are five different questions about a campaign that is not
 * moving: who is owed a call later, who was owed one already, whose
 * conversation dropped mid-call and is being resumed, who is merely cooling
 * down between attempts, and who had a real conversation that did not finish
 * the goal.
 *
 * `resume` is its own tab rather than part of `callback` for the reason
 * `armKind` exists at all: the engine chose that time and no lead named it, so
 * an operator reading "who am I about to ring back" must be able to tell the
 * two apart.
 *
 * `follow_up` is not a nicety either. The goal re-arm deliberately touches
 * neither `attempts` (which counts retries consumed) nor `callbackAt` (which
 * is history of a promise) — so before the arm existed, a followed-up contact
 * whose first dial connected carried `attempts = 0` and matched NO queue at
 * all, on the tab whose whole job is saying what each waiting contact is
 * waiting for. That is the ordinary case for a goal campaign, not an edge of
 * one.
 */
export const CONTACT_QUEUES = [
  'callback',
  'callback_overdue',
  'resume',
  'retry',
  'follow_up',
] as const;

export type ContactQueue = (typeof CONTACT_QUEUES)[number];

/**
 * One queue, as a `where` fragment to be **ANDed** with whatever else the
 * request asked for.
 *
 * Never merged into the caller's `where`: each of these already implies
 * `status: 'PENDING'`, and an explicit `?status=` must be able to narrow
 * further rather than silently overwrite.
 *
 * The five partition the PENDING rows by `armKind`, so a contact appears under
 * exactly one of them — which is what makes a tab an answer rather than an
 * overlap, and what the two counter-based filters here could never manage.
 * `FRESH` is the one arm with no tab: a contact waiting for nothing more
 * specific than its turn is not waiting for anything this page has a name for.
 */
export function contactQueueFilter(queue: ContactQueue, now: Date): Prisma.CampaignContactWhereInput {
  // A conversation that did not finish the goal, waiting for the next one.
  if (queue === 'follow_up') return { status: 'PENDING', armKind: 'FOLLOW_UP' };

  // A conversation that dropped mid-call, waiting out
  // `IMMEDIATE_CALLBACK_MINUTES`. Nobody asked for this call; the engine did.
  if (queue === 'resume') return { status: 'PENDING', armKind: 'RESUME' };

  // A dial already made and no promise outstanding: the retry ladder is what
  // set this contact's clock.
  if (queue === 'retry') return { status: 'PENDING', armKind: 'RETRY' };

  return {
    ...ARMED_FOR_CALLBACK,
    // A promise still ahead, or one whose time has already passed and which
    // the dispatcher has not reached — a paused campaign, a closed window.
    callbackAt: queue === 'callback' ? { gt: now } : { lte: now },
  };
}

/** The order rows leave each queue in: the clock that queue is about. */
export function contactQueueOrder(
  queue: ContactQueue | undefined,
): Prisma.CampaignContactOrderByWithRelationInput[] {
  // All three turn on `nextEligibleAt`: it is the clock a cooldown, a
  // follow-up delay and a resume gap are all written to, and the only one any
  // of them is about.
  if (queue === 'retry' || queue === 'follow_up' || queue === 'resume') {
    return [{ nextEligibleAt: 'asc' }, { id: 'asc' }];
  }
  if (queue !== undefined) return [{ callbackAt: 'asc' }, { id: 'asc' }];

  // The contacts table untouched. `createdAt` defaults to the transaction
  // timestamp, so a bulk import stamps one identical value across every row of
  // it — the id rides along as the tiebreaker, or paging shows a row twice.
  return [{ createdAt: 'asc' }, { id: 'asc' }];
}
