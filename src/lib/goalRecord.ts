import type { Prisma } from '@prisma/client';
import { isAttemptKind, type AttemptKind } from './attemptKind.js';
import { classifyOutcome, reachedAPerson } from './dialOutcome.js';
import {
  CALLBACK_REQUESTED_TIME_KEY,
  CALLBACK_TYPES,
  CALL_OUTCOMES,
  CALL_OUTCOME_KEY,
  CALL_OUTCOME_REASON_KEY,
  IMMEDIATE_CALLBACK_NEEDED_KEY,
  LEGACY_CALLBACK_TYPE_KEY,
  IMMEDIATE_CALLBACK_NEEDED_REASON_KEY,
  NEXT_CALL_INSTRUCTIONS_KEY,
  CALL_END_TIMESTAMP_KEY,
  type CallOutcome,
  type CallbackType,
  type NextAction,
} from './extractionConfig.js';
import { parseCallbackInstant } from './callbackTime.js';

/**
 * The pure shape of the goal context record: what "empty" means, how the bot's
 * call note reads back out of a call's extraction, how the last-call note is
 * derived, and how the stored Json log reads back. No queries and no clock —
 * the write path (`services/goalContext`) and every read surface (the variable
 * renderer, the journey, the routes) consume these same definitions, which is
 * what keeps a settle, a dial's variables and a stats tile from ever
 * disagreeing about what a call decided.
 */

/**
 * What a language model writes when it has nothing to write.
 *
 * A small, exact list rather than a pattern: matched on the trimmed,
 * case-folded value in full, so a real answer that merely CONTAINS one of
 * these words ("none of the above", "unknown caller policy", "Nadia") is
 * still an answer. Kept short deliberately — every entry here is an answer
 * some campaign could legitimately want, and the list earns its place only
 * because these particular strings are what a model returns for a question
 * nobody answered.
 *
 * Exported so the list itself can be asserted against. Nothing outside this
 * module re-implements the predicate any more: the goal is prose and the bot
 * judges it, so there is no longer a stats query translating this rule into
 * SQL that could drift out of step with the settle.
 */
export const EMPTY_VALUE_FILLERS: readonly string[] = [
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  'unknown',
  'undefined',
  'not provided',
  'not specified',
  'not available',
];

const FILLER_SET: ReadonlySet<string> = new Set(EMPTY_VALUE_FILLERS);

/**
 * Empty, as a goal key's answer: null, undefined, a string of nothing but
 * whitespace — the bucket readout's `NULLIF(BTRIM(...), '')` in JavaScript —
 * one of the filler words above, or a container with nothing in it.
 *
 * `false` and `0` are answers. So is `"0"`: only a whole value matching a
 * filler word reads as absence.
 *
 * The asymmetry is deliberate and is the decision this rule turns on. Read as
 * an answer, an "N/A" in the reason goes verbatim onto a do-not-call row, and
 * an "Unknown" in the note becomes the line the next call is told to open
 * with. Read as empty, the cost is a null field: the outcome still decides,
 * the last-call line drops its "why", and the next dial carries no note —
 * which is an opening call, bounded as every follow-up is by the campaign's
 * dial budget.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;

  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();

    return normalised === '' || FILLER_SET.has(normalised);
  }

  // A container the model opened and put nothing in. `[]` and `{}` are what a
  // list-valued or object-valued key comes back as when it found nothing, and
  // neither is an answer to the question the key asks.
  if (Array.isArray(value)) return value.length === 0;

  if (typeof value === 'object') return Object.keys(value as object).length === 0;

  return false;
}

/**
 * The note's ceiling. The note carries instructions for the next call and the
 * exact lines to open with, not a paragraph of facts, so it is given more
 * room than an account of the call would need. Cut here as well as asked for
 * in the key description, so a model that ignores the instruction cannot grow
 * the record — or the next call's prompt — without bound.
 */
export const MAX_CALL_NOTE_CHARS = 1200;

/**
 * The end timestamp's ceiling. The key asks for one `YYYY-MM-DDTHH:mm±HH`
 * value, 22 characters; 60 is room for a model that writes a zone name after
 * it and a wall against one that writes a sentence, since the value goes
 * verbatim into the next dial's prompt. Named for the field it bounds
 * (`CallNote.callTimestamp`), which keeps the name the attempt log has
 * written into a `Json` column since the timestamp shipped.
 */
export const MAX_CALL_TIMESTAMP_CHARS = 60;

/**
 * The reason's ceiling. The key asks for five words; 300 characters is room
 * for a model that answers in a sentence and a wall against one that answers
 * in a paragraph, since the reason goes verbatim onto the do-not-call row and
 * into the last-call line the next dial's record carries.
 */
export const MAX_REASON_CHARS = 300;

/**
 * What the bot said about a call, read out of the seven call-note keys.
 *
 * Every field is nullable and null means "not said": the resolution treats a
 * null outcome as "worth calling again at the default delay", never as a
 * judgement about the person. The memory and the end timestamp are the two
 * fields the next call sees.
 *
 * `callbackType` is DERIVED, not read off an extraction key — contender I
 * retired the callback-type key in favour of two plain questions,
 * `immediateCallbackNeeded` and `callbackRequestedTime`. Kept on this type,
 * on `attemptLog` and on every wire that already carried it (the journey API,
 * the dashboard's `JourneyGoal` type) so nothing downstream — the engine's
 * three branches, the dashboard's labels — has to change shape for the
 * contract underneath it to change. See `deriveCallbackType` for the rule.
 */
export interface CallNote {
  outcome: CallOutcome | null;
  reason: string | null;
  callbackType: CallbackType | null;
  /** Raw, as the model wrote it (trimmed); the booking parses it. `"null"` → null. */
  callbackRequestedTime: string | null;
  /** `immediate_callback_needed_vocobaseplatform`: whether the call ended
   *  abruptly mid-conversation and should be resumed right away. Read
   *  case-insensitively from `"yes"`/`"no"` (the key is shipped as a pinned
   *  string, matching its own description) and also from a JSON `true`/
   *  `false`, in case the platform type is ever changed to `boolean`. */
  immediateCallbackNeeded: boolean | null;
  immediateCallbackReason: string | null;
  /** `memory_for_next_call`, at most `MAX_CALL_NOTE_CHARS` characters. */
  note: string | null;
  /** `call_end_timestamp`, raw as the model wrote it (trimmed). Not parsed:
   *  it is played back to the next call as a sentence, never as an instant,
   *  so YE has no reason to have an opinion about its shape. */
  callTimestamp: string | null;
}

const NO_NOTE: CallNote = {
  outcome: null,
  reason: null,
  callbackType: null,
  callbackRequestedTime: null,
  immediateCallbackNeeded: null,
  immediateCallbackReason: null,
  note: null,
  callTimestamp: null,
};

/**
 * The literal word the key descriptions tell the model to answer when there
 * is nothing to say. Matched on the trimmed, case-folded value in full, for
 * every key: a model's `"Null"` or `"null\n"` is the same answer, and read as
 * a value it becomes an opening line the next call recites or a time the
 * booking tries to parse.
 */
function isNullWord(value: string): boolean {
  return value.trim().toLowerCase() === 'null';
}

/**
 * One of a pinned list, or null. Case-folded and trimmed because the value
 * is model output; strict on everything else because a decision that is
 * guessed is worse than one that is missing. The null word is refused ahead
 * of the list, so a pinned vocabulary that happened to contain "null" (the
 * callback type's description does) still reads it as an absence.
 */
function readPinned<T extends string>(value: unknown, pinned: readonly T[]): T | null {
  if (typeof value !== 'string' || isNullWord(value)) return null;
  const s = value.trim().toLowerCase();
  return (pinned as readonly string[]).includes(s) ? (s as T) : null;
}

/**
 * A text field, or null. The null word is an absence here as for every key;
 * so is the wider filler list (`None`, `Unknown`, `N/A`, …), because a text
 * field is where a model writes those when it has nothing to say, and a
 * reason of "Unknown" on a do-not-call row is not a reason.
 *
 * Cut in characters (code points), not UTF-16 units. `String#slice` counts
 * units, and an emoji is two of them: cut between the pair, the note ends
 * in a lone surrogate — not text, and exactly the kind of thing that arrives
 * in a model's account of a call and would go back out in the next dial's
 * prompt.
 */
function readText(value: unknown, max: number): string | null {
  // `isNullWord` is redundant here — "null" is in `EMPTY_VALUE_FILLERS` —
  // and stated anyway, so the rule every key shares is visible at each
  // reader rather than hidden inside a list somebody may one day trim.
  if (typeof value !== 'string' || isNullWord(value) || isEmptyValue(value)) return null;
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/** The raw callback time: trimmed, and null for blank or the null word. Not
 *  parsed here — `parseCallbackAt` owns what a datetime may look like. */
function readRawTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || isNullWord(trimmed) ? null : trimmed;
}

/**
 * `immediate_callback_needed_vocobaseplatform`, or null when the model said
 * nothing readable.
 *
 * Ship it as a string pinned to `yes`/`no` — matching the key's own
 * description — but also accept a JSON `true`/`false`, in case the operator
 * ever changes the platform type to `boolean`; see the operator note in the
 * PR body. Case-folded and trimmed like every other pinned field, so `"YES"`
 * and `"Yes"` are the same answer as `"yes"`.
 */
function readYesNo(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || isNullWord(value)) return null;

  const s = value.trim().toLowerCase();
  if (s === 'yes' || s === 'true') return true;
  if (s === 'no' || s === 'false') return false;

  return null;
}

/**
 * `CallNote.callbackType`, derived rather than read: contender I retired the
 * callback-type key and asks two plain questions instead.
 *
 * The rule, precisely:
 *
 * 1. `call_outcome` is `stop`, `completed`, or unreadable → `null`. The
 *    first two need no callback, exactly as when a `callback_type` key
 *    existed; the third is no outcome, and null there is "no outcome", never
 *    a judgement — the same reading a silence gets, so an extraction that
 *    came back empty and one that never came back log the same note, and
 *    the re-extract report's "old" column prints `none` for both.
 * 2. A PARSEABLE `callback_requested_time` → `requested`, whatever the
 *    immediate flag says. This is the precedence rule and it is deliberately
 *    NOT the order the two questions are asked in: an explicit time is a
 *    concrete promise a human can act on, while `immediate_callback_needed`
 *    is a judgement call, and `callback_requested_time`'s own description
 *    tells the model to null it out when immediate is "yes" — so a real time
 *    arriving anyway means the model disobeyed that instruction, and the
 *    explicit time should win over the flag it was told to defer to. This
 *    matches H's own precedence, where an explicit callback request always
 *    took priority over `immediate` or `flexible`.
 * 3. Otherwise, `immediate_callback_needed == yes` → `immediate`.
 * 4. Otherwise → `flexible`.
 *
 * The time is checked for parseability only — `parseCallbackInstant`, with no
 * lower or upper bound — never for whether it is still bookable. Whether a
 * promise has already lapsed is the booking's question, asked later with the
 * campaign's own clock; whether the model wrote a real time at all is a fact
 * about the value alone, which is what this derivation needs to stay pure.
 */
function deriveCallbackType(
  outcome: CallOutcome | null,
  immediateCallbackNeeded: boolean | null,
  callbackRequestedTime: string | null,
  legacyCallbackType: CallbackType | null,
): CallbackType | null {
  if (outcome === null || outcome === 'stop' || outcome === 'completed') return null;

  /**
   * A note written under contender H or G — live for the calls in flight
   * across a deploy until `campaignAgentSweep` reaches their agent, for a
   * reaper reconciliation hours late, and for ever in the re-extract
   * report's "old" column, where the stored extraction never changes
   * shape — carries the retired callback-type key and none of I's. It is
   * judged by the contract it was written under: H's type was the gate and
   * the time beside it was ignored. Derived instead, an H `immediate` read
   * `flexible`, and a dropped conversation waited the retry ladder rather
   * than `IMMEDIATE_CALLBACK_MINUTES`.
   */
  if (legacyCallbackType !== null) return legacyCallbackType;

  const parsedTime =
    callbackRequestedTime !== null ? parseCallbackInstant(callbackRequestedTime, null) : null;

  if (parsedTime !== null) return 'requested';
  if (immediateCallbackNeeded === true) return 'immediate';

  return 'flexible';
}

/**
 * The call note out of a call's extraction values. Total: anything that is
 * not an object, or any field that is not readable, is the null arm.
 */
export function readCallNote(extraction: unknown): CallNote {
  if (typeof extraction !== 'object' || extraction === null || Array.isArray(extraction)) {
    return { ...NO_NOTE };
  }
  const values = extraction as Record<string, unknown>;

  const outcome = readPinned(values[CALL_OUTCOME_KEY], CALL_OUTCOMES);
  const callbackRequestedTime = readRawTime(values[CALLBACK_REQUESTED_TIME_KEY]);
  const immediateCallbackNeeded = readYesNo(values[IMMEDIATE_CALLBACK_NEEDED_KEY]);
  // Gated on the KEY's presence, not on a readable value: an I-shaped note
  // that answered the flag unreadably stays on I's derivation rather than
  // falling back to a key it does not carry.
  const legacyCallbackType =
    IMMEDIATE_CALLBACK_NEEDED_KEY in values
      ? null
      : readPinned(values[LEGACY_CALLBACK_TYPE_KEY], CALLBACK_TYPES);

  return {
    outcome,
    reason: readText(values[CALL_OUTCOME_REASON_KEY], MAX_REASON_CHARS),
    callbackType: deriveCallbackType(
      outcome,
      immediateCallbackNeeded,
      callbackRequestedTime,
      legacyCallbackType,
    ),
    callbackRequestedTime,
    immediateCallbackNeeded,
    immediateCallbackReason: readText(
      values[IMMEDIATE_CALLBACK_NEEDED_REASON_KEY],
      MAX_REASON_CHARS,
    ),
    note: readText(values[NEXT_CALL_INSTRUCTIONS_KEY], MAX_CALL_NOTE_CHARS),
    callTimestamp: readText(values[CALL_END_TIMESTAMP_KEY], MAX_CALL_TIMESTAMP_CHARS),
  };
}

/**
 * The compatibility mapping the journey and the contacts list use: the
 * five-key decision folded onto the dashboard's four words, so its labels
 * need not change in the same release as the contract. `completed` → done,
 * `stop` → stop, `incomplete` + `requested` → call_back_at, any other
 * `incomplete` → call_again, and no outcome → null.
 */
export function nextActionOf(note: CallNote): NextAction | null {
  switch (note.outcome) {
    case 'completed': return 'done';
    case 'stop': return 'stop';
    case 'incomplete': return note.callbackType === 'requested' ? 'call_back_at' : 'call_again';
    default: return null;
  }
}

interface LastCallNoteFields {
  /** The platform's terminal status, verbatim and normalised. Read after the
   *  disposition and `answered_by`, for the outcomes only it reports. */
  status: string | null;
  disposition: string | null;
  answeredBy: string | null;
  callbackNote: string | null;
}

/** The decision arm: the call note this call left, as `readCallNote` read
 *  it. A silence passes the null note, and falls through every arm below. */
export type LastCallNoteInput = LastCallNoteFields & { note: CallNote };

/**
 * The one-liner the next call is told about the last one. YE's own render,
 * never the model's: a silence has no extraction, and the note must exist
 * for every attempt or the variable would say "first call" on the fourth.
 *
 * The silence vocabulary mirrors `dialerOutcome.ts`'s decision sets plus the
 * two terminal statuses a carrier may report through the disposition field.
 *
 * The status is read too, after the other two, because `no_answer`, `busy`
 * and `failed` classify by status alone: the platform sends them with no
 * disposition and no `answered_by` at all. A note that read only those two
 * fields fell through every silence arm to "spoke, but no outcome was
 * recorded" — a conversation claimed on a phone nobody picked up, and fed to
 * the model as the truth about the last call on the next dial.
 */
export function deriveLastCallNote(input: LastCallNoteInput): string {
  switch (input.disposition) {
    case 'voicemail': return 'reached voicemail';
    case 'user_hangup_no_speech': return 'call dropped with no conversation';
    case 'blocked': return 'the call was blocked';
    case 'failed': return 'the call could not be connected';
    case 'no_answer': return 'the call was not answered';
    case 'busy': return 'the line was busy';
    default: break;
  }
  if (input.answeredBy === 'machine') return 'reached voicemail';
  if (input.answeredBy === 'not_answered') return 'the call was not answered';
  switch (input.status) {
    case 'no_answer': return 'the call was not answered';
    case 'busy': return 'the line was busy';
    case 'failed': return 'the call could not be connected';
    default: break;
  }

  // A booked promise beats the note: whatever else was said, they said when
  // to call, and the booking already read and honoured it.
  if (input.callbackNote !== null && input.callbackNote.trim() !== '') {
    return `spoke, asked to be called back: ${input.callbackNote.trim()}`;
  }

  const { note } = input;
  const why = note.reason ? `: ${note.reason}` : '';
  switch (note.outcome) {
    case 'completed': return `spoke, completed${why}`;
    case 'stop': return `spoke, asked not to be called${why}`;
    case 'incomplete':
      if (note.callbackType === 'requested') {
        return `spoke, asked to be called back: ${note.callbackRequestedTime ?? 'time not given'}`;
      }
      if (note.callbackType === 'immediate') return `spoke, call dropped mid-conversation${why}`;
      return `spoke, worth calling again${why}`;
    default:
      // Nothing from the platform and nothing from the bot: an attempt the
      // reaper abandoned because no outcome was ever reported. "Spoke" would
      // be a claim about a conversation nobody can vouch for.
      return input.status === null && input.disposition === null && input.answeredBy === null
        ? 'no outcome was reported for the call'
        : 'spoke, but no outcome was recorded';
  }
}

/** One attempt-log entry as the read surfaces consume it: the shape
 *  `recordAttempt` writes, with every field re-judged on the way back in. */
export interface LoggedAttempt {
  attemptNo: number;
  /** Validated against the vocabulary — a stamp another release wrote reads
   *  as null rather than as a kind nothing else recognises. */
  kind: AttemptKind | null;
  /** The platform's terminal status. Read beside the two fields below, because
   *  a `no_answer` or a `busy` arrives with neither of them. */
  status: string | null;
  disposition: string | null;
  answeredBy: string | null;
  /** What the bot decided about this call, re-judged against the vocabulary
   *  the same way `kind` is: an entry written by another release, or by a
   *  model that answered outside the pinned list, reads as no outcome. */
  outcome: CallOutcome | null;
  callbackType: CallbackType | null;
  /** Raw, as the model wrote it; the booking's reading of it is not stored. */
  callbackRequestedTime: string | null;
  /** `immediate_callback_needed_vocobaseplatform`, re-judged the same way
   *  `outcome` is: an entry from another release, or a value outside
   *  `yes`/`no`/`true`/`false`, reads as not answered. */
  immediateCallbackNeeded: boolean | null;
  immediateCallbackReason: string | null;
  reason: string | null;
  callbackNote?: string;
  durationSecs?: number;
}

/**
 * The canonical defensive parser for the stored `attemptLog`.
 *
 * The column is Json, so every read surface must survive a malformed entry —
 * a migration's leavings, another release's shape — by dropping it rather
 * than throwing inside a dial or a page load. Entries come back in stored
 * order, which `recordAttempt` keeps sorted by `attemptNo`.
 */
export function readGoalLog(stored: Prisma.JsonValue | null | undefined): LoggedAttempt[] {
  if (!Array.isArray(stored)) return [];

  const entries: LoggedAttempt[] = [];

  for (const raw of stored) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;

    const entry = raw as Record<string, unknown>;
    if (typeof entry.attemptNo !== 'number') continue;

    const outcome = readPinned(entry.outcome, CALL_OUTCOMES);
    const callbackType = readPinned(entry.callbackType, CALLBACK_TYPES);

    entries.push({
      attemptNo: entry.attemptNo,
      kind: typeof entry.kind === 'string' && isAttemptKind(entry.kind) ? entry.kind : null,
      status: typeof entry.status === 'string' ? entry.status : null,
      disposition: typeof entry.disposition === 'string' ? entry.disposition : null,
      answeredBy: typeof entry.answeredBy === 'string' ? entry.answeredBy : null,
      outcome,
      callbackType,
      callbackRequestedTime: readRawTime(entry.callbackRequestedTime),
      immediateCallbackNeeded: readYesNo(entry.immediateCallbackNeeded),
      immediateCallbackReason:
        typeof entry.immediateCallbackReason === 'string' ? entry.immediateCallbackReason : null,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      ...(typeof entry.callbackNote === 'string' && entry.callbackNote.trim() !== ''
        ? { callbackNote: entry.callbackNote }
        : {}),
      ...(typeof entry.durationSecs === 'number' ? { durationSecs: entry.durationSecs } : {}),
    });
  }

  return entries;
}

/**
 * Whether any recorded attempt actually reached a person.
 *
 * NOT "whether any attempt was recorded": `recordAttempt` logs every
 * attempt-naming result, silences included, so a contact whose retries were
 * two busy signals has a context record full of entries and was never spoken
 * to. The distinction is what keeps a FAILED settle's outcome off somebody
 * nobody reached — counted, that contact reads as a goal not achieved, which
 * is a claim about a conversation that never happened.
 *
 * Judged by the DIALER's rule (`lib/dialOutcome`), the one that decides
 * whether a phone rings again, and deliberately not by the reporting rule in
 * `lib/callOutcome`: that one files `user_hangup_no_speech` under `answered`
 * because the phone was picked up, while the dialer retries it as a silence
 * because nobody said anything. The settle that reads this must agree with
 * the retry decision about what a conversation is, or a contact whose every
 * dial was a wordless pick-up gets an outcome on a conversation that never
 * happened. All three fields go in, the same three the dialer reads, so a
 * `no_answer` reported by status alone is a silence here too.
 */
export function hasSpokenAttempt(log: readonly LoggedAttempt[]): boolean {
  return log.some((entry) =>
    reachedAPerson(
      classifyOutcome({
        status: entry.status,
        disposition: entry.disposition,
        answeredBy: entry.answeredBy,
      }),
    ),
  );
}
