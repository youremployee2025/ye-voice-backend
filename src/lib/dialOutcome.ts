/**
 * What a call's ending means for the contact: whether anybody was spoken to,
 * and whether the number may ever be dialled again.
 *
 * This is the dialer's rule, and it is deliberately not `callOutcome.ts`'s.
 * That one files a call for the reports — `user_hangup_no_speech` is
 * `answered` there, because the phone was picked up — while this one decides
 * whether the phone rings again, and a pick-up in which nobody said anything
 * is a silence worth another call. Two questions, two rules; what matters is
 * that each question has exactly one. The retry decision in
 * `services/dialerOutcome` and the goal record's "was there ever a
 * conversation" in `lib/goalRecord` both ask this one, which is why it lives
 * in lib where both can reach it.
 */

import { isNumberVerdict, isPlatformFault } from './endCallReason.js';

/**
 * Outcomes that mean nobody was actually spoken to.
 *
 * Three independent fields, because the platform reports the same fact through
 * whichever of them the carrier populated: a call that reached voicemail can
 * arrive as `status: completed` with `disposition: voicemail`, or with nothing
 * but `answered_by: machine`. Any one of them is enough.
 */
const RETRYABLE_STATUS = new Set(['no_answer', 'busy']);
/**
 * `failed` is here because a call the carrier could not put through is a call
 * in which nobody was spoken to — the same silence a voicemail is, and worth
 * another attempt for the same reason.
 */
const RETRYABLE_DISPOSITION = new Set(['voicemail', 'user_hangup_no_speech', 'failed']);
const RETRYABLE_ANSWERED_BY = new Set(['machine', 'not_answered']);

/**
 * Outcomes that are never dialled again, whatever else the call said about
 * itself. `blocked` is a number that refused us, and re-dialling it is calling
 * a wall somebody asked us to stop calling.
 *
 * **`failed` used to sit here beside it, and that was wrong.** The reasoning
 * was that `failed` meant a number the carrier could not complete — a property
 * of the number, so never worth dialling again. It is not: the platform
 * reports `failed` for its *own* trouble as readily as for the callee's, and
 * during an upstream incident it arrives in bursts with `hangup_cause` either
 * absent or set to Q.850 **16 (normal call clearing)** or **32 (normal,
 * unspecified)** — neither of which says anything is wrong with the number.
 * Filed as permanent, one such burst settled fifteen contacts at attempt 1 of
 * 21 and took them off the list for good, in a campaign where not one contact
 * had ever reached the end of its retry ladder.
 *
 * So a `failed` disposition is permanent only when the carrier names a cause
 * that is about the **number** rather than the moment. Everything else is a
 * transient silence and goes back on the ladder, which is the direction to err
 * in: dialling a dead number a few more times costs a few seconds of carrier
 * time, and writing a live lead off costs the lead.
 */
const PERMANENT_DISPOSITION = new Set(['blocked']);

/**
 * Q.850 causes that describe the number, not the call.
 *
 * 1 unallocated (unassigned) number · 3 no route to destination · 22 number
 * changed · 28 invalid number format. Each says this number will not complete
 * on any later attempt either.
 *
 * Deliberately **not** 21 (call rejected) or 17 (user busy): those are the
 * callee's answer on one occasion, not a fact about the line. And deliberately
 * not 16 or 32, which are how a normal hangup is reported and are exactly what
 * an upstream incident emits.
 */
const UNREACHABLE_HANGUP_CAUSES = new Set([1, 3, 22, 28]);

/**
 * The Q.850 cause number, when the carrier reported one.
 *
 * The field arrives in three shapes across providers — `"16"`, `"16 - Normal
 * Clearing"`, and absent — so the leading integer is read and anything else,
 * including a cause with no number in it at all, reads as "not stated". An
 * unstated cause can never make an outcome permanent: it is the shape the
 * incident produced.
 */
function namesAnUnreachableNumber(hangupCause: string | null | undefined): boolean {
  return unreachableCause(hangupCause) !== null;
}

/** The Q.850 cause number when it names the NUMBER, else null. Read by the
 *  attempt-reason sentence as well as the settle, so the two agree on which
 *  causes are permanent. */
export function unreachableCause(hangupCause: string | null | undefined): number | null {
  const leadingDigits = /^\s*(\d+)/.exec(hangupCause ?? '');
  if (leadingDigits === null) return null;

  const cause = Number(leadingDigits[1]);

  return UNREACHABLE_HANGUP_CAUSES.has(cause) ? cause : null;
}

/**
 * The one `error_code` that is not about this call at all.
 *
 * The platform's own telephony account is dry. That is account-wide and it
 * never clears on its own, so the first occurrence is the moment to stop the
 * campaign rather than re-queue a contact into the same wall a minute later.
 */
export const PLATFORM_CREDIT_EXHAUSTED = 'TELEPHONY_CREDIT_EXHAUSTED';

/** Whether an `error_code` says the platform can place no call for anybody. */
/**
 * The supplier's own telephony wallet, reported as free text rather than a code.
 *
 * On 2026-09-07 the provider began refusing every dial with
 * `VoiceLink add_lead error (402): {"message":"Insufficient wallet balance…"}`,
 * and the platform surfaced it as `error_message` with **`error_code: null`** —
 * 2,593 attempts across 1,407 contacts, not one carrying a code. Keyed on the
 * code alone, none of it read as a platform fault: each refusal settled as an
 * ordinary `failed`, spent a retry the number never deserved, and the campaigns
 * went on dialing into a dead wallet.
 *
 * Matched **narrowly**, because a match pauses a customer's campaign. Both
 * halves must be present: the provider's `402`, and its wording. A 402 is the
 * one status that means "you have no money", so it cannot be confused with a
 * number that did not answer — while `401` from the same endpoint is a
 * different fault with a different remedy and must not pause anything.
 *
 * Free text is a poor contract and this is not the preferred fix. The right
 * one is upstream sending `TELEPHONY_CREDIT_EXHAUSTED` in `error_code`, which
 * is asked for in `docs/2026-09-08-vocobase-hangup-source-voicelink.md`; the
 * code branch below stays first so this becomes dead weight the day it lands.
 */
const WALLET_EMPTY = /\(402\)|insufficient wallet balance/i;

export function exhaustsPlatformCredit(
  errorCode: string | null | undefined,
  errorMessage?: string | null,
): boolean {
  if (normaliseErrorCode(errorCode) === PLATFORM_CREDIT_EXHAUSTED) return true;

  return typeof errorMessage === 'string' && WALLET_EMPTY.test(errorMessage);
}

/**
 * Whether the detector's verdict says a person was on the line. Case-folded
 * and trimmed HERE, not only by the callers: the two live callers normalise
 * before they classify, but `hasSpokenAttempt` reads a stored goal log that
 * re-extraction writes verbatim off the attempt row, and every report
 * classifier already folds the case. `Human` must not be a conversation to
 * the reports and a silence to the settle.
 */
function heardAPersonOn(answeredBy: string | null | undefined): boolean {
  return answeredBy?.trim().toLowerCase() === CONNECTED_ANSWERED_BY;
}

/**
 * The labels a person on the line overrules: the ones that assert the call
 * never landed. Deliberately not `voicemail` or `user_hangup_no_speech` (the
 * detector disagreeing with itself, or a pick-up nobody spoke on — both still
 * silences to the ladder) and not `blocked` (a verdict on the number, which
 * `classifyOutcome` settles permanent whatever the detector heard).
 */
const NEVER_CONNECTED_LABEL: ReadonlySet<string> = new Set(['no_answer', 'busy', 'failed']);

/**
 * The disposition the CONTACT carries once this dial is settled: the
 * platform's label, unless the label says nobody was reached and the
 * detector heard a person — then `completed`, which is what the settle made
 * of it. Read by the resolution; `classifyAttempt` in `callOutcome.ts` and
 * `REACHED_ATTEMPT` in `campaignOutcomes.ts` apply the same override to the
 * attempt row on read, so the three cannot disagree about which calls were
 * conversations.
 */
export function settledDisposition(
  disposition: string | null,
  answeredBy: string | null,
): string | null {
  const overruled = disposition === null || NEVER_CONNECTED_LABEL.has(disposition);

  return overruled && heardAPersonOn(answeredBy) ? 'completed' : disposition;
}

/** Trimmed and upper-cased, or null: a blank code is no code. */
/** The telephony clock says the call connected. `undefined` is "not carried". */
export function wasAnswered(answeredAt: Date | string | null | undefined): boolean {
  return answeredAt !== null && answeredAt !== undefined && answeredAt !== '';
}

/**
 * The platform, not the carrier, ended this dial before the number was tested
 * — read off a settled ATTEMPT ROW, for the readers that judge rows rather
 * than payloads (the journey's ordinal rule, the failure sentence). It is the
 * same predicate `classifyOutcome` applies at settle time and the same one
 * `dialBudget.ts` spells in SQL and Prisma: either signal the platform sends
 * for "I ended it" (`errorCode`, or `endCallReason = SYSTEM_ERROR`), beside no
 * human detected and no answer stamped. Keep the three in step.
 */
export function platformFaultOnRow(row: {
  errorCode: string | null;
  endCallReason: string | null;
  answeredBy: string | null;
  answeredAt: Date | null;
}): boolean {
  return (
    (normaliseErrorCode(row.errorCode) !== null || isPlatformFault(row.endCallReason)) &&
    !heardAPersonOn(row.answeredBy) &&
    !wasAnswered(row.answeredAt)
  );
}

export function normaliseErrorCode(errorCode: string | null | undefined): string | null {
  const trimmed = errorCode?.trim().toUpperCase();

  return trimmed ? trimmed : null;
}

/**
 * The platform's answer-detection verdict that a person was on the line.
 *
 * The one field that is evidence of a CONNECTION rather than a label for the
 * ending. The platform has said Q.850 cause 16 — normal clearing, which is
 * how a real conversation usually ends — will map to `no_answer`; if that
 * mapping is not gated on whether the call connected, thousands of answered
 * calls a week arrive labelled as silences. A label can be wrong about
 * whether anybody was reached; the detector heard them.
 */
const CONNECTED_ANSWERED_BY = 'human';

/**
 * Labels that assert nobody picked up. Contradicted by `answered_by: human`,
 * the label loses: `user_hangup_no_speech` is deliberately NOT here — that
 * one is a pick-up in which nobody spoke, and it says so itself.
 */
const NEVER_CONNECTED = new Set(['no_answer', 'busy', 'failed']);

export interface OutcomeClass {
  /** Nobody was spoken to. Worth another call, if the budget allows one. */
  retryable: boolean;
  /** Never worth another call, whatever else the outcome said. */
  permanent: boolean;
  /**
   * The platform, not the carrier, ended this — reaped pre-connect, never
   * handed to the carrier, dismissed by an operator, out of telephony
   * credit, or a `SYSTEM_ERROR` (a server restart, the bot process torn
   * down). The number was never tested, so the outcome is not the
   * contact's: it goes back on the queue at no cost to the retry ladder,
   * exactly as a launch that never left does.
   */
  platformFault: boolean;
}

/**
 * What kind of ending this was.
 *
 * `permanent` deliberately overrides `retryable` at the point of use rather
 * than being folded into it here: the two are separate facts, and a `blocked`
 * number that also reports `answered_by: machine` is both "nobody was spoken
 * to" and "do not call this again".
 */
export function classifyOutcome(outcome: {
  status: string | null;
  disposition: string | null;
  answeredBy: string | null;
  failureReason?: string | null;
  /**
   * The carrier's Q.850 cause, when one was reported. Optional because two
   * callers legitimately have no access to it — `hasSpokenAttempt` reads a
   * stored attempt log that never carried the column — and absent is the
   * safe reading: it can only ever withhold `permanent`, never grant it.
   */
  hangupCause?: string | null;
  /**
   * The platform's own `error_code`. Non-null means the platform decided
   * this outcome and the carrier never gave a verdict, whatever else the
   * payload carries — the contract is that `hangup_cause` and `error_code`
   * are exclusive, and this takes precedence when a payload breaks it. An
   * UNRECOGNISED code is a platform fault too: every code on the list is
   * "not the number", and a new one is far likelier to be another of those
   * than a carrier verdict in disguise.
   */
  errorCode?: string | null;
  /**
   * The platform's `error_message`. Read only to recognise the supplier's
   * wallet running dry, which arrives as text with no code beside it — see
   * `exhaustsPlatformCredit`. Everything else in this message is upstream's
   * prose and nothing branches on it.
   */
  errorMessage?: string | null;
  /**
   * The platform's `end_call_reason`. Two readings only, both additive:
   * `INVALID_NUMBER` / `BLOCKED` on a silence is permanent, the same verdict
   * the Q.850 rule below draws from the raw cause (which the platform stops
   * sending next release); `SYSTEM_ERROR` with nobody heard is a platform
   * fault, the same handling as an `error_code`. Everything else in the
   * vocabulary restates the disposition, which stays the retry driver.
   * "Nobody heard" is the detector's verdict, not the disposition: a
   * `completed` label with no `answered_by: human` is still handed back,
   * because a redial is cheap and a burned lead is not.
   */
  endCallReason?: string | null;
  /**
   * The telephony answer timestamp, from the attempt row (stamped by the
   * IN_PROGRESS status event) or the completion's `answered_at`. Read for one
   * thing only: a platform fault is "the number was never tested", and a call
   * that was ANSWERED was tested whatever `answered_by` says — on voicelink
   * the platform sets `answered_by: human` only when the bot's session-queue
   * worker completes normally, so the very teardown that produces
   * `SYSTEM_ERROR` also leaves it null. Gating on `answered_by` alone handed
   * back, at no ladder cost and with no cap, a person who had talked to the
   * agent for minutes.
   */
  answeredAt?: Date | string | null;
}): OutcomeClass {
  const { status, disposition, answeredBy } = outcome;

  /**
   * A human on the line is a connection, and nothing the platform says about
   * the ending — a `no_answer` label off cause 16, an `ADMIN_DISMISSED` on a
   * session that hung after the conversation — can make it a number that was
   * never tested. Read before either rule below, because both would otherwise
   * hand a person who spoke to the agent straight back to the dialler.
   */
  const heardAPerson = heardAPersonOn(answeredBy);

  // The supplier's wallet is the same fact as a platform error code — the
  // number was never tested — and arrives without one, so it is read here
  // rather than left to settle as an ordinary carrier failure. A
  // `SYSTEM_ERROR` reason is the same fact again in the new vocabulary.
  const decidedByPlatform =
    normaliseErrorCode(outcome.errorCode) !== null ||
    exhaustsPlatformCredit(null, outcome.errorMessage) ||
    isPlatformFault(outcome.endCallReason);

  // "Nobody heard" is the detector's verdict AND the carrier's clock: a call
  // that connected was tested, whether or not anything detected who answered.
  if (decidedByPlatform && !heardAPerson && !wasAnswered(outcome.answeredAt)) {
    return { retryable: true, permanent: false, platformFault: true };
  }

  const retryable =
    Boolean(outcome.failureReason) ||
    (status !== null && RETRYABLE_STATUS.has(status) && !heardAPerson) ||
    (disposition !== null &&
      RETRYABLE_DISPOSITION.has(disposition) &&
      !(heardAPerson && NEVER_CONNECTED.has(disposition))) ||
    (answeredBy !== null && RETRYABLE_ANSWERED_BY.has(answeredBy));

  return {
    retryable,
    platformFault: false,
    permanent:
      (disposition !== null && PERMANENT_DISPOSITION.has(disposition)) ||
      /**
       * **The cause is read on every silence, not only on a `failed` one.**
       *
       * The platform's own cause-to-disposition mapping does not read the
       * Q.850 code, so an unallocated number arrives labelled `no_answer` —
       * which is retryable, and which therefore had this contact redialled
       * for its entire ladder against a number that cannot exist. Gating this
       * on `disposition === 'failed'`, as it first was, missed every one of
       * them.
       *
       * Gated on `retryable` instead: the carrier says the number is bad AND
       * nobody was spoken to. That keeps a stray or mis-emitted cause from
       * ever settling a real conversation — a call answered by a human is not
       * retryable, so it can never reach this branch however the cause reads.
       *
       * The platform's `end_call_reason` is read beside the cause, under the
       * same gate, because it is the cause's successor: the raw Q.850 text
       * stops arriving next release, and `INVALID_NUMBER` / `BLOCKED` is the
       * same verdict on the number in the new vocabulary. The gate is what
       * makes it safe to read at all — a reason mis-emitted on a call that
       * reached a person can withhold nothing and retire nobody.
       */
      (retryable &&
        (namesAnUnreachableNumber(outcome.hangupCause) || isNumberVerdict(outcome.endCallReason))),
  };
}

/**
 * Whether a person was reached: neither a silence nor a wall. The one
 * reading of `OutcomeClass` that means "a conversation happened", named so
 * that the callers asking that question do not each re-derive it.
 */
export function reachedAPerson(outcome: OutcomeClass): boolean {
  return !outcome.retryable && !outcome.permanent;
}
