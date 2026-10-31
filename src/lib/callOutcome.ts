/**
 * What a call came to, reduced to one of six buckets.
 *
 * Here and nowhere else. Three surfaces read this rule — the overview's answer
 * rate, a campaign's outcome breakdown, the CSV's outcome column — and three
 * copies of a classification rule eventually say three different things, which
 * on this surface means two charts on one screen disagreeing about the same
 * calls.
 *
 * The input is free text. `status` and `disposition` follow whichever carrier
 * placed the call, and their published sets grow without this service
 * deploying anything, so nothing here validates against an enum or refuses a
 * value it does not know.
 */

export type CallOutcome =
  | 'answered'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'abandoned'
  | 'other';

/** Reporting order, and the order a breakdown is rendered in. */
export const OUTCOMES: readonly CallOutcome[] = [
  'answered',
  'voicemail',
  'no_answer',
  'busy',
  'failed',
  'abandoned',
  'other',
];

/**
 * Today's published values, and only those.
 *
 * `user_hangup_no_speech` is `answered` because it is: somebody picked up and
 * said nothing, which is a connection with a disappointing outcome rather than
 * a call that never landed. `transferred` likewise — a call cannot be handed
 * on without having been answered first.
 *
 * `canceled` and `blocked` sit with `failed` because all three mean no
 * conversation happened for a reason on our side of the call rather than the
 * far end's, and separating them would give the breakdown three one-row
 * buckets that are read and acted on identically.
 */
const DISPOSITIONS: Record<string, CallOutcome> = {
  completed: 'answered',
  transferred: 'answered',
  user_hangup_no_speech: 'answered',
  voicemail: 'voicemail',
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'failed',
  blocked: 'failed',
  canceled: 'failed',
};

/**
 * The lifecycle states, for rows that carry no disposition yet.
 *
 * `in_progress` is `answered` because a call that is talking has connected —
 * the disposition simply has not been written. `pending` and `ringing` are
 * absent on purpose: a call that has not resolved is not an outcome, and
 * filing it under `failed` would report every live call as one.
 */
const STATUSES: Record<string, CallOutcome> = {
  completed: 'answered',
  in_progress: 'answered',
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'failed',
  canceled: 'failed',
  /**
   * The reaper closed the attempt without ever learning what became of the
   * call. Its own bucket, and deliberately **not** `failed`: the schema is
   * emphatic that "we never found out" and "the callee did not answer" are
   * different facts, and a report that conflates them misstates the campaign's
   * own results. It is not `other` either — `other` means a value this service
   * does not recognise, while this one is recognised precisely.
   */
  abandoned: 'abandoned',
};

/**
 * The buckets that assert the call never landed. Contradicted by the platform's
 * own answer detection hearing a person, the label loses: the platform has said
 * Q.850 cause 16 — normal clearing, which is how a real conversation usually
 * ends — will map to `no_answer`, and thousands of ninety-second human calls a
 * week end with cause 16. A label describes the ending; the detector heard the
 * connection. Deliberately not `voicemail`: `answered_by: human` beside a
 * voicemail is the detector disagreeing with itself, and the disposition is the
 * later, more specific verdict.
 */
const NEVER_CONNECTED: ReadonlySet<CallOutcome> = new Set(['no_answer', 'busy', 'failed']);
/**
 * On the RAW disposition, when there is one: `blocked` and `canceled` collapse
 * into `failed` for the breakdown, but they are verdicts on the number, which
 * the dialer settles permanent whatever the detector heard, and the report
 * must not call them conversations. With no disposition the collapsed status
 * decides, so a bare `status: no_answer` with a human on the line is still
 * overruled.
 */
const NEVER_CONNECTED_LABEL: ReadonlySet<string> = new Set(['no_answer', 'busy', 'failed']);
const CONNECTED_ANSWERED_BY = 'human';

/** Trimmed and case-folded, or null for anything that is not a usable value. */
function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * The bucket this call belongs in.
 *
 * The disposition wins where both are present: a voicemail's *status* is
 * `completed`, so reading the status first would report every voicemail on the
 * platform as a human answering.
 *
 * An unrecognised value is `other` — never `failed`, which would report a
 * carrier's new outcome as a failure, and never dropped, which would quietly
 * shrink the denominator of every rate on the page. `other` is a real bucket
 * and every surface here reports it.
 */
export function classifyOutcome(
  disposition: string | null | undefined,
  status: string | null | undefined,
): CallOutcome {
  const byDisposition = normalize(disposition);
  if (byDisposition) return DISPOSITIONS[byDisposition] ?? 'other';

  const byStatus = normalize(status);
  if (byStatus) return STATUSES[byStatus] ?? 'other';

  return 'other';
}

/**
 * Whether the call reached the far end at all.
 *
 * Answered and voicemail both did — a machine picking up is still the call
 * arriving somewhere. They stay separate in the breakdown, because "a person
 * answered" and "an answering machine answered" are different results that a
 * reader acts on differently; they are added together only for the rate.
 *
 * `other` is deliberately not connected. An outcome we cannot classify is not
 * evidence of a connection, and counting it as one would inflate the answer
 * rate every time a carrier introduced a value.
 */
export function isConnected(outcome: CallOutcome): boolean {
  return outcome === 'answered' || outcome === 'voicemail';
}

/**
 * Whether this outcome is a statement about the call or about our knowledge
 * of it.
 *
 * `abandoned` and `other` are the second kind, and a surface that reports a
 * rate should be able to say how much of its denominator it could not read.
 */
export function isUnresolved(outcome: CallOutcome): boolean {
  return outcome === 'abandoned' || outcome === 'other';
}

/**
 * The same rule for a campaign call attempt, which carries three fields.
 *
 * `CallAttempt` records the carrier's `disposition` and `upstreamStatus` — both
 * free text — beside its own `status`, which is this platform's enum.
 *
 * **`ABANDONED` outranks both carrier fields.** It is our reaper's verdict that
 * the outcome was never learned, and it is written over whatever the carrier
 * last said, which is typically a stale `ringing`. Classifying that as `other`
 * would file a definite statement under "unrecognised value"; classifying it
 * from the stale value would report a call we know nothing about as one we do.
 *
 * Otherwise the carrier's own fields win, in the usual order — they describe
 * the call, while the enum describes our tracking of it.
 */
export function classifyAttempt(
  disposition: string | null | undefined,
  upstreamStatus: string | null | undefined,
  status: string | null | undefined,
  /**
   * The platform's answer detection. Optional because only `CallAttempt` rows
   * carry it — `CallRecord` has no such column, so the two-field
   * `classifyOutcome` above cannot apply this rule and a non-campaign call
   * mislabelled `no_answer` stays `no_answer` there. That is a known gap, not
   * a second rule: the column would have to be ingested first.
   */
  answeredBy?: string | null,
): CallOutcome {
  if (normalize(status) === 'abandoned') return 'abandoned';

  const outcome = classifyOutcome(disposition, upstreamStatus ?? status);

  const label = normalize(disposition);
  const labelSaysSilence =
    label === null ? NEVER_CONNECTED.has(outcome) : NEVER_CONNECTED_LABEL.has(label);

  if (labelSaysSilence && normalize(answeredBy) === CONNECTED_ANSWERED_BY) {
    return 'answered';
  }

  return outcome;
}
