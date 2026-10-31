/**
 * What a re-extracted call note says should happen to its contact.
 *
 * The decision only, never the write. `applyRearm` turns a plan into rows;
 * everything about *which* plan a note earns lives here, where it can be
 * enumerated in a test rather than inferred from a transaction.
 *
 * ## Why this is not `resolveContact`
 *
 * The live resolution answers a different question. It runs seconds after a
 * hang-up, inside a budget, on a contact the dispatcher has claimed: an
 * `immediate` there means "in `IMMEDIATE_CALLBACK_MINUTES`", a `flexible`
 * means "on the retry ladder", and both are gaps measured from a call that has
 * just ended.
 *
 * This runs weeks later on a paused campaign. Those gaps have long since
 * elapsed, and re-applying them would park a thousand contacts at
 * now-plus-a-delay for a conversation that ended in August. So every arm here
 * is "the next sweep": `now`, rolled into the campaign's dialing window. The
 * arm *kinds* are still the live ones, because the lanes they name — resume
 * ahead of retries, follow-ups behind them — are how the dispatcher budgets
 * the queue, and a re-armed contact has to queue like every other.
 *
 * The one thing that keeps its own instant is a promise: a requested time
 * still in the future is a time a person was told, and it is booked at that
 * time rather than at the next sweep.
 *
 * ## Why the dispatcher's budgets are asked here
 *
 * `resolveContact` arms a contact the claim is about to consider again, so it
 * can leave the budgets to `claimContacts`. This arms contacts that settled
 * weeks ago, some of which have spent every retry the campaign allows or hold a
 * placed attempt at the dial ceiling. The claim would silently never take those
 * — `attempts <= retryCount OR armKind = 'CALLBACK'`, and no placed attempt at
 * or past the dial budget — leaving a PENDING row with a time in the past that
 * nothing dials and nothing settles, which also stops `completeIfDone` finishing
 * the campaign. So the same two questions are asked here, and a contact that
 * fails them is left exactly as it is and reported.
 */
import { parseCallbackAt, rollIntoDialWindow } from '../callbackTime.js';
import { wantsResume } from '../immediateResume.js';
import type { DialingWindow } from '../dialingWindow.js';
import type { CallNote } from '../goalRecord.js';

export type RearmPlan =
  /** Do not call again, and write the do-not-call row. */
  | { kind: 'stop'; reason: string | null }
  /** The note wants another call and the dispatcher would never place it:
   *  the contact is left exactly as it is. */
  | { kind: 'over_budget'; reason: 'follow_up_budget' | 'dial_budget' }
  /** The goal was met; the contact settles. */
  | { kind: 'completed' }
  /** A promise still in the future, booked at the time it was made for. */
  | { kind: 'callback'; at: Date }
  /** A dropped conversation, back at the front of the queue. */
  | { kind: 'resume'; at: Date }
  /** Everything else worth another call. */
  | { kind: 'follow_up'; at: Date }
  /** No outcome in the reply: the contact is left exactly as it is. */
  | { kind: 'no_verdict' };

/**
 * What the dispatcher's claim would make of this contact, in the two numbers it
 * would make it of.
 *
 * The campaign's halves are read once per run; the contact's halves are its
 * own. `latestPlacedAttemptNo` is the highest attempt number the contact has
 * that actually reached the platform — `dialBudget.ts` says which attempts
 * those are, and a launch failure that never rang a telephone is not one.
 */
export interface RearmBudget {
  /** `Campaign.retryCount`: dials AFTER the first, not a count of dials. Kept
   *  because it is half of the ceiling below; nothing here refuses on it. */
  retryCount: number;
  /** `Campaign.maxGoalFollowUps`: the FOLLOW-UP lane's budget, and the one
   *  this planner refuses on. Every conversation it re-arms belongs to a
   *  contact somebody answered, which is precisely the contact whose retries
   *  were forfeited and whose only remaining budget is this one. */
  maxGoalFollowUps: number;
  /** The dial budget, `totalDialsFor` (`retryCount + maxGoalFollowUps + 1`) —
   *  exactly as `dialer.ts` hands it to the claim. Every campaign has one. */
  maxTotalDials: number;
  /** `CampaignContact.attempts`, the retry counter. Carried for the report and
   *  not compared: the claim exempts a FOLLOW_UP row from the retry clause. */
  attempts: number;
  /** `CampaignContact.followUpCount` as it stands BEFORE the apply resets it
   *  to 0 — the number the claim would compare, on the row as it is now. */
  followUpCount: number;
  latestPlacedAttemptNo: number | null;
}

/**
 * There is deliberately no `maxDialsPerDay` here. A contact at its daily cap
 * has run out of nothing: the claim holds it until the next campaign-local
 * midnight and then dials it. Refusing to arm it would throw away a re-judged
 * verdict over a clock that resets in hours, and settle nothing in exchange.
 */

export interface RearmContext {
  now: Date;
  window: DialingWindow;
  /** The campaign's zone, for a requested time that carries no offset of its
   *  own. Null falls back to `parseCallbackAt`'s own default. */
  timezone: string | null;
  budget: RearmBudget;
}

/**
 * Whether the dispatcher would refuse this arm, and on which budget.
 *
 * Both clauses are `claimContacts`' own, in its own order. The dial ceiling
 * first, because it has no exemption: the claim's `NOT EXISTS` on a placed
 * attempt at or past the dial budget sits outside every lane clause and a
 * promise does not escape it. Then the FOLLOW-UP budget, which a `CALLBACK` IS
 * exempt from — `ARMED_FOR_CALLBACK`, because a promise spends no budget at
 * all and a lowered one must not cancel a call somebody was told to expect.
 *
 * **The retry budget is not asked, and that is the 2026-09-09 change.**
 * `selectConversations` skips a contact nobody ever reached, so every re-arm
 * that reaches here belongs to a contact somebody ANSWERED — whose retries
 * were forfeited by that answer, whose `attempts` is frozen wherever it
 * stopped, and whom the claim exempts from the retry clause outright. Asking
 * `attempts > retryCount` here would refuse a contact the claim would take.
 *
 * Getting this wrong in the generous direction is the expensive way: the
 * contact is armed PENDING with a time in the past, the claim never takes it,
 * nothing ever settles it, and `completeIfDone` cannot finish the campaign.
 * Nothing in the system would report that; it just never rings.
 */
function refusedBy(
  kind: 'callback' | 'resume' | 'follow_up',
  budget: RearmBudget,
): 'follow_up_budget' | 'dial_budget' | null {
  const { maxTotalDials, latestPlacedAttemptNo } = budget;

  if (latestPlacedAttemptNo !== null && latestPlacedAttemptNo >= maxTotalDials) {
    return 'dial_budget';
  }

  return kind !== 'callback' && budget.followUpCount >= budget.maxGoalFollowUps
    ? 'follow_up_budget'
    : null;
}

/** The arm, or the refusal the dispatcher would answer it with. */
function armed(plan: RearmPlan & { kind: 'callback' | 'resume' | 'follow_up' }, budget: RearmBudget): RearmPlan {
  const refused = refusedBy(plan.kind, budget);

  return refused === null ? plan : { kind: 'over_budget', reason: refused };
}

/**
 * The plan a note earns.
 *
 * Judged on the outcome first and on nothing else, so a callback type beside
 * a missing outcome cannot arm a contact: the outcome is the question the
 * re-extraction was run to re-answer, and a note that does not answer it has
 * not re-judged the call.
 */
export function planRearm(note: CallNote, input: RearmContext): RearmPlan {
  if (note.outcome === 'stop') return { kind: 'stop', reason: note.reason };
  if (note.outcome === 'completed') return { kind: 'completed' };
  if (note.outcome !== 'incomplete') return { kind: 'no_verdict' };

  // Every arm below that is not a kept promise lands here: the next sweep,
  // inside the hours the campaign dials. `rollIntoDialWindow` walks the same
  // openings the dispatcher's own gate walks, so an instant armed here is one
  // that gate will actually dial at.
  const nextSweep = rollIntoDialWindow(input.now, input.window);

  if (note.callbackType === 'requested') {
    const parsed = parseCallbackAt(note.callbackRequestedTime, input.timezone, input.now);

    // A promise that cannot be kept — past, unreadable, or a year the model
    // invented — becomes a follow-up rather than a booking. Booking it would
    // put a contact on an instant the dispatcher has already walked past, or
    // one it will not reach this decade. When the note also answered
    // `immediate_callback_needed = yes`, the unkept promise falls back to the
    // flag: the derived `requested` only outranked it on the strength of a
    // time that turned out to be worthless.
    return armed(
      parsed.ok
        ? { kind: 'callback', at: rollIntoDialWindow(parsed.at, input.window) }
        : wantsResume(note, parsed.ok)
          ? { kind: 'resume', at: nextSweep }
          : { kind: 'follow_up', at: nextSweep },
      input.budget,
    );
  }

  // No callback type is a follow-up and never a guess: it is one more call,
  // bounded by the campaign's dial budget, rather than a judgement about a
  // conversation the model declined to classify.
  // No time to book, so the flag alone decides — and only while the resume
  // lane is switched on.
  return armed(
    wantsResume(note, false)
      ? { kind: 'resume', at: nextSweep }
      : { kind: 'follow_up', at: nextSweep },
    input.budget,
  );
}
