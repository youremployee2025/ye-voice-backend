import { endReasonLabel } from './endCallReason.js';
import { toDisplayCredits } from './credits.js';

/**
 * A call's own history, assembled from the attempt this platform recorded.
 *
 * **There is no webhook event log to build this from.** `WebhookEvent` is a
 * dedupe ledger — an event key, a name and a received-at — and it carries no
 * call id, no payload and no status, so no per-call sequence can be recovered
 * from it. The one durable record of a call's progression is `CallAttempt`,
 * which the dialer stamps as the call moves.
 *
 * That has a consequence stated rather than hidden: an attempt exists only for
 * a call **this platform dialled for a campaign**. An inbound call, a call
 * placed by hand, or one on an agent whose traffic never came through the
 * dialer has no attempt row and therefore no timeline. The caller is told which
 * case it is (`timelineSource`) so the surface can say the timeline was not
 * recorded, rather than render an empty list that reads as a fault.
 *
 * Everything here is pure over a narrow input, so neither function needs a
 * database to test and neither can accidentally widen what a caller may see —
 * the visibility check has already run by the time an attempt is fetched.
 */

/** Only the columns these two functions read. Narrow on purpose: a wider type
 *  would invite this file to start making decisions that are not its own. */
export interface TimelineAttempt {
  attemptNo: number;
  status: string;
  upstreamStatus: string | null;
  disposition: string | null;
  hangupCause: string | null;
  endCallReason: string | null;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  resolvedAt: Date | null;
  chargedAt: Date | null;
  durationSecs: number | null;
  billedSecs: number | null;
  costCredits: bigint | null;
  shortfall: boolean;
}

export type TimelineEventKind = 'dialed' | 'answered' | 'ended' | 'resolved' | 'charged';

export interface TimelineEvent {
  kind: TimelineEventKind;
  /** ISO instant. Never absent — an event with no stamp is not emitted. */
  at: string;
  /** The one fact worth carrying beside the event, or null when it is unset. */
  detail: string | null;
}

export interface CallBilling {
  /** Display units, as a string. Null when nothing was charged — never "0",
   *  which asserts a charge that came to nothing. */
  creditsCharged: string | null;
  /** Null on every attempt settled before pulse billing existed. Null is not
   *  zero and not "the same as the duration"; the figure was not recorded. */
  billedSeconds: number | null;
  /** The balance could not cover this call: nothing was debited and the amount
   *  above is what was owed. */
  shortfall: boolean;
}

/**
 * The events this attempt actually stamped, oldest first.
 *
 * A null stamp emits **no event**. Defaulting one to the epoch would put a
 * 1970 row at the head of every live call's timeline, and defaulting it to
 * `now` would invent an event that has not happened — an unanswered call would
 * show as answered the moment somebody opened it.
 *
 * Sorted by instant rather than by the order the branches are written. A
 * reconciled attempt can be charged before its outcome is applied, and a
 * timeline that renders in field order would show the charge landing after a
 * resolution it preceded.
 */
export function buildTimeline(attempt: TimelineAttempt | null): TimelineEvent[] {
  if (!attempt) return [];

  const candidates: Array<[TimelineEventKind, Date | null, string | null]> = [
    ['dialed', attempt.startedAt, null],
    ['answered', attempt.answeredAt, null],
    // The reason's WORDS, never its token: the dashboard's timeline prints
    // `detail` verbatim, so this is a customer-facing string. The raw cause
    // stays as the fallback for rows settled before the column existed, and
    // for a reason this service has no words for yet.
    ['ended', attempt.endedAt, endReasonLabel(attempt.endCallReason) ?? attempt.hangupCause],
    ['resolved', attempt.resolvedAt, attempt.disposition],
    // A charge that could not be taken is still an event — the attempt was
    // metered — but it must not read as a payment.
    ['charged', attempt.chargedAt, attempt.shortfall ? 'shortfall' : null],
  ];

  return candidates
    .filter((candidate): candidate is [TimelineEventKind, Date, string | null] =>
      candidate[1] !== null,
    )
    .map(([kind, at, detail]) => ({ kind, at: at.toISOString(), detail: detail ?? null }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * What this workspace was charged, or null when it was not charged at all.
 *
 * `costCredits` and **not** upstream's `credits_used`: the latter is what this
 * platform was billed by its supplier, and putting it on a customer's screen
 * publishes the margin. The calls surface already refuses to emit it.
 *
 * Null rather than a zeroed block when there is no attempt. A zeroed block
 * asserts this workspace was charged nothing for the call; the truth is that
 * an inbound or hand-placed call on the shared account is not charged to the
 * workspace at all, and those are different claims.
 */
export function buildBilling(attempt: TimelineAttempt | null): CallBilling | null {
  if (!attempt) return null;

  return {
    creditsCharged: attempt.costCredits === null ? null : toDisplayCredits(attempt.costCredits),
    billedSeconds: attempt.billedSecs,
    shortfall: attempt.shortfall,
  };
}
