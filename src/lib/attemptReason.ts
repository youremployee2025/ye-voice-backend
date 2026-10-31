import { normaliseErrorCode, platformFaultOnRow, PLATFORM_CREDIT_EXHAUSTED, unreachableCause } from './dialOutcome.js';
import { isNumberVerdict, normaliseEndCallReason } from './endCallReason.js';

/**
 * Why a dial produced nothing, in the words a customer reads.
 *
 * One sentence, or null when the disposition already says everything a
 * reader needs (a voicemail is a voicemail). Written HERE and not on the
 * dashboard, for the rule every notification body follows: the customer-facing
 * wording lives in this service, names the supplier as "the voice platform",
 * and a code never reaches a screen. The dashboard prints the sentence and
 * nothing else about the cause.
 *
 * Read off the attempt row alone, so the journey and the attempts feed cannot
 * disagree about the same dial. Precedence follows the settle's own:
 *
 * 1. The reaper closed it without ever learning the outcome (`ABANDONED`, or
 *    its two stamps on a row it resolved as a silence) — because that path
 *    consumed a retry and a code beside it must not say otherwise.
 * 2. The platform ended it before the number was tested — an `errorCode`, or
 *    an `end_call_reason` of `SYSTEM_ERROR` — and the call was neither
 *    answered nor heard: the contact lost no retry, and the sentence says so.
 *    Either signal beside an answered call is a conversation; the disposition
 *    speaks. `platformFaultOnRow` is the settle's own predicate.
 * 3. The launch was refused before a call existed (`launchError` with no
 *    platform call id) — the failure is ours or the platform's, never the
 *    contact's, except a 400, which is the number.
 * 4. The number is blocked (`blocked` disposition).
 * 5. The number itself is bad, on a dial that reached nobody: the
 *    `end_call_reason` number verdicts (`INVALID_NUMBER`, `BLOCKED`) or the
 *    carrier's Q.850 cause (1, 3, 22, 28). It will not be called again. The
 *    cause is read LIVE, not as a legacy fallback: the platform maps only
 *    Q.850 1 to a verdict and reports 3/22/28 as `NOT_CONNECTED`, so the
 *    cause is the only thing that retires those three while it still ships.
 * 6. The `end_call_reason` names a carrier moment on a dial that reached
 *    nobody (`NETWORK_ERROR`, `REJECTED`, `CANCELED`, `NOT_CONNECTED`): one
 *    sentence. The rest of the vocabulary is already said by the disposition.
 */
export interface AttemptReasonInput {
  status: string;
  disposition: string | null;
  answeredBy: string | null;
  hangupCause: string | null;
  launchError: string | null;
  errorCode: string | null;
  /** The platform's `end_call_reason`, one vocabulary for how the call ended. */
  endCallReason: string | null;
  /** The telephony answer stamp. An answered call was tested, whatever
   *  `answeredBy` says; see `platformFaultOnRow`. */
  answeredAt: Date | null;
  upstreamCallId: string | null;
}

const NOT_COUNTED = ' It was not counted against this contact’s retries.';

const PLATFORM_ENDED = 'The voice platform ended this call before the number was tested.' + NOT_COUNTED;

const PLATFORM_REASON: Record<string, string> = {
  PENDING_TIMEOUT: 'The voice platform gave up on this call before it connected.' + NOT_COUNTED,
  DIAL_TRANSPORT_FAILURE: 'The voice platform could not reach the carrier for this call.' + NOT_COUNTED,
  ADMIN_DISMISSED: 'The voice platform closed this call before it connected.' + NOT_COUNTED,
  [PLATFORM_CREDIT_EXHAUSTED]:
    'The voice platform could not place this call: its own calling account is out of credit. The campaign was paused.' +
    NOT_COUNTED,
};

const NUMBER_REASON: Record<number, string> = {
  1: 'This number is not in service.',
  3: 'The carrier has no route to this number.',
  22: 'This number has changed.',
  28: 'This is not a valid phone number.',
};

/**
 * Sentences keyed on the platform's `end_call_reason`. Only the values that
 * add something the disposition does not already say; the rest return null
 * below. The number verdicts are not here: they are `isNumberVerdict`'s set,
 * read through it so the sentence and the settle retire the same numbers.
 */
const NUMBER_VERDICT_SENTENCE: Record<string, string> = {
  INVALID_NUMBER: 'This is not a valid phone number. It will not be called again.',
  BLOCKED: 'This number is blocked. It will not be called again.',
};

const END_REASON_SENTENCE: Record<string, string> = {
  NETWORK_ERROR: 'The carrier could not connect this call.',
  REJECTED: 'The call was declined before it connected.',
  CANCELED: 'The call was canceled before it connected.',
  NOT_CONNECTED: 'The call did not connect.',
};

/**
 * The two sentences the reaper stamps on an attempt it closed without an
 * outcome. Defined here, and imported by the reaper, so the reading below
 * matches the writing by construction rather than by string.
 */
export const REAPER_NO_OUTCOME = 'No outcome was ever reported for this call.';
export const REAPER_NO_CLASSIFIED_OUTCOME = 'No classified outcome was ever reported for this call.';

const OUTCOME_UNKNOWN = 'We never heard back about this call, so its outcome is unknown.';

/**
 * Keyed on the `ApiError` code `rollbackLaunch` writes at the head of
 * `launchError` (`<code>: <message>`). The codes are the adapter's own:
 * `VALIDATION_ERROR` is a 400 and the only launch failure that settles the
 * contact; `RESOURCE_NOT_FOUND` is a 404, the agent gone upstream, which
 * pauses the campaign; the two `UPSTREAM_*` are account-wide and transient.
 * Anything else is an outage, and the contact went back on the queue.
 */
const LAUNCH_REASON: [prefix: string, sentence: string][] = [
  [
    'UPSTREAM_WRITE_UNCONFIRMED',
    'We could not confirm whether the voice platform placed this call. It is being reconciled against the platform’s own record.',
  ],
  ['VALIDATION_ERROR', 'The voice platform would not accept this number. It will not be called again.'],
  [
    'RESOURCE_NOT_FOUND',
    'The agent this campaign dials with was missing on the voice platform, so the campaign was paused. This contact went back on the queue.',
  ],
  [
    'UPSTREAM_RATE_LIMITED',
    'The voice platform was too busy to take this call. It will be tried again after a short wait, at no cost to this contact’s retries.',
  ],
  ['UPSTREAM_FORBIDDEN', 'The voice platform refused this call for this account, so the campaign was paused. This contact went back on the queue.'],
];

function heardAPerson(answeredBy: string | null): boolean {
  return answeredBy?.trim().toLowerCase() === 'human';
}

export function attemptReason(attempt: AttemptReasonInput): string | null {
  // The reaper's verdict first: it consumed a retry as an ordinary silence,
  // so a code beside it must not claim otherwise.
  if (
    attempt.status === 'ABANDONED' ||
    attempt.launchError === REAPER_NO_OUTCOME ||
    attempt.launchError === REAPER_NO_CLASSIFIED_OUTCOME
  ) {
    return OUTCOME_UNKNOWN;
  }

  // The platform's own SYSTEM_ERROR is the same fact as a code — it, not the
  // number, ended the dial — and the settle handed the contact back for it.
  // One predicate for both, shared with the settle and the budget, so the
  // sentence cannot say "not counted" about a dial that was.
  if (platformFaultOnRow(attempt)) {
    const code = normaliseErrorCode(attempt.errorCode);
    return (code !== null ? PLATFORM_REASON[code] : undefined) ?? PLATFORM_ENDED;
  }

  if (attempt.launchError !== null && attempt.upstreamCallId === null) {
    const known = LAUNCH_REASON.find(([prefix]) => attempt.launchError!.startsWith(prefix));
    if (known) return known[1];

    return 'The voice platform could not place this call. This contact went back on the queue.';
  }

  const disposition = attempt.disposition?.trim().toLowerCase() ?? null;

  if (disposition === 'blocked') {
    return 'This number is blocked. It will not be called again.';
  }

  const reason = normaliseEndCallReason(attempt.endCallReason);
  const nobodyHeard = !heardAPerson(attempt.answeredBy);

  // A verdict on the NUMBER, from either field, before any sentence about the
  // moment: the platform reports Q.850 22 as `NOT_CONNECTED`, and "did not
  // connect" beside a settle that retired the number would be the two halves
  // of this service disagreeing about the same dial.
  if (nobodyHeard && isNumberVerdict(reason)) {
    return NUMBER_VERDICT_SENTENCE[reason!]!;
  }

  const cause = unreachableCause(attempt.hangupCause);
  if (cause !== null && nobodyHeard) {
    return `${NUMBER_REASON[cause]} It will not be called again.`;
  }

  if (reason !== null && nobodyHeard) {
    const sentence = END_REASON_SENTENCE[reason];
    if (sentence) return sentence;
  }

  return null;
}
