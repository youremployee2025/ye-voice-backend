import {
  instantOf,
  nextDay,
  nextOpening,
  parseTimeOfDay,
  restrictedDays,
  weekdayOf,
  zonedParts,
} from './dialingWindow.js';
import type { DialingWindow } from './dialingWindow.js';

/**
 * Turning "call me back on Tuesday at four" into an instant this dialer will
 * honour.
 *
 * The raw value arrives as an extracted string on a finished call. A model
 * wrote it, so everything here is defensive: the shapes it may take are
 * enumerated rather than handed to `new Date()`, and every refusal has its own
 * name so the log line says which one happened.
 *
 * Two functions, deliberately separate. `parseCallbackAt` answers "is this an
 * instant we can act on at all", and `rollIntoDialWindow` answers "when may we
 * actually dial it" — the first is about the promise, the second about the
 * campaign, and only the second can move a time a person was told.
 *
 * Nothing here touches the database or the clock beyond what it is given.
 */

/** The floor. Extraction runs seconds after the hang-up, and a lead who says
 *  "call me right back" must not be redialled mid-goodbye. */
export const MIN_CALLBACK_LEAD_SECONDS = 60;

/** The horizon. Models fabricate years, and a promise for 2126 is not one. */
export const MAX_CALLBACK_DAYS_AHEAD = 90;

/**
 * The zone a naive datetime is read in when the campaign names none.
 *
 * A campaign with no window has no timezone either, and the alternative —
 * reading wall-clock times in whatever zone this process happens to run in — is
 * a promise honoured at the wrong hour whenever the deployment moves.
 */
export const DEFAULT_CALLBACK_TIMYENE = 'Asia/Kolkata';

export type CallbackRejection =
  | 'absent'
  | 'not_a_string'
  | 'unparseable'
  | 'too_soon'
  | 'too_far_ahead';

export type ParsedCallback = { ok: true; at: Date } | { ok: false; reason: CallbackRejection };

/**
 * A trailing offset, and the `T` it must sit behind.
 *
 * The `T` is the whole point of this pattern. `2026-09-02` ends in two digits
 * behind a hyphen, which is the exact shape of `-02` — a bare negative offset —
 * so an offset test that did not demand a time in front of it would read a date
 * with no time on it as an instant, and place a call at midnight UTC on a day
 * nobody agreed an hour for.
 *
 * The minutes on the TIME side are optional. Both
 * `callback_requested_time_vocobaseplatform` and
 * `call_end_timestamp_vocobaseplatform` ask for `YYYY-MM-DDTHH:mm±HH`, but an
 * early draft of contender I's callback description read `YYYY-MM-DDTHH±HH`,
 * and a model that still emits that shape must book on the hour rather than
 * fail; a missing minute reads as `:00` (`withMinutes`, below).
 */
const HAS_OFFSET = /T\d{2}(?::\d{2})?(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** A datetime carrying no offset at all: wall-clock time, zone unstated.
 *  Minutes optional for the same reason as `HAS_OFFSET`. */
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(?::(\d{2}))?(?::(\d{2}))?(?:\.\d+)?$/;

/** `T14` (no minutes) becomes `T14:00`; anything that already names minutes
 *  is left alone. Applied to the OFFSET form before it reaches `new Date`,
 *  whose ISO parser requires minutes even though the platform's own format
 *  string no longer does. */
function withMinutes(body: string): string {
  return /T\d{2}$/.test(body) ? `${body}:00` : body;
}

/** Normalises `+05` to `+05:00` and `+0530` to `+05:30`, and leaves `Z` alone.
 *
 *  Written out rather than left to `new Date`, whose handling of the compact
 *  forms is implementation-defined — the language only requires `±HH:MM`. */
function normaliseOffset(value: string, offset: string): string {
  const body = withMinutes(value.slice(0, value.length - offset.length));

  if (offset.toUpperCase() === 'Z') return `${body}Z`;

  const sign = offset[0]!;
  const digits = offset.slice(1).replace(':', '');
  const hours = digits.slice(0, 2);
  const minutes = digits.length > 2 ? digits.slice(2, 4) : '00';

  return `${body}${sign}${hours}:${minutes}`;
}

/** Whether a `YYYY-MM-DD hh:mm:ss` really names a day and a time on the
 *  calendar. `Date.UTC` silently rolls 2026-09-31 into October and 25:00 into
 *  the next morning, so the fields are checked before they are trusted. */
function fieldsAreReal(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (h > 23 || mi > 59 || s > 59) return false;

  const probe = new Date(Date.UTC(y, mo - 1, d));

  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * The UTC instant of a wall-clock datetime in a named zone.
 *
 * Delegates to the dialing window's own guess-and-correct arithmetic so the two
 * cannot disagree about what a local time means, and adds the seconds back
 * afterwards — offsets are whole minutes everywhere the IANA database still
 * uses, so a correction computed in minutes cannot lose them.
 */
export function wallClockToUtc(
  ymd: string,
  hours: number,
  minutes: number,
  seconds: number,
  timeZone: string,
): Date {
  const base = instantOf(ymd, hours * 60 + minutes, timeZone);

  return new Date(base.getTime() + seconds * 1000);
}

/**
 * The instant a raw extracted value names, with no lead-time or horizon bound
 * applied — just "does this parse at all".
 *
 * Split out of `parseCallbackAt` so `readCallNote`'s derivation of
 * `CallbackType` (contender I: `callback_requested_time` is "a real time" or
 * it isn't) can ask this question without a clock. The bounds below
 * (`too_soon`, `too_far_ahead`) are about whether a promise is still
 * bookable, which only means something at the moment of booking; whether the
 * model wrote something parseable at all is a fact about the value alone.
 *
 * `null` for anything that is not a non-empty, non-"null" string, or that does
 * not parse.
 */
export function parseCallbackInstant(raw: unknown, timezone: string | null): Date | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();

  // The same fact as null: the model found no time. The literal word "null"
  // is the same fact again — the key's description tells the model to write
  // it when no time was requested, so it arrives on most calls.
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;

  // A space where ISO 8601 wants a `T` is the one deviation models make often
  // enough to be worth accepting, and normalising it here means the offset
  // pattern below has a single shape to look for.
  const value = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2})/, '$1T$2');

  const offset = HAS_OFFSET.exec(value)?.[1];
  const at = offset ? new Date(normaliseOffset(value, offset)) : naiveToInstant(value, timezone);

  return at !== null && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * Reads an extracted callback time.
 *
 * `timezone` is the campaign's own — the best available proxy for the clock the
 * conversation was held on, since nothing here has a per-agent or per-contact
 * one. It is used only for values that carry no offset of their own.
 */
export function parseCallbackAt(
  raw: unknown,
  timezone: string | null,
  now: Date,
): ParsedCallback {
  if (raw === null || raw === undefined) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };

  const trimmed = raw.trim();

  // The same fact as null: the model found no time. Reading it as a broken
  // value would put a rejection in the log for every call in a campaign nobody
  // asked a callback of. The literal word "null" is the same fact again: the
  // call-note key's description tells the model to write it when no time was
  // requested, so it arrives on most calls of a note campaign.
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return { ok: false, reason: 'absent' };

  const at = parseCallbackInstant(raw, timezone);

  if (at === null) return { ok: false, reason: 'unparseable' };

  if (at.getTime() <= now.getTime() + MIN_CALLBACK_LEAD_SECONDS * 1000) {
    return { ok: false, reason: 'too_soon' };
  }

  if (at.getTime() > now.getTime() + MAX_CALLBACK_DAYS_AHEAD * 86_400_000) {
    return { ok: false, reason: 'too_far_ahead' };
  }

  return { ok: true, at };
}

/**
 * A datetime with no offset, read as wall-clock time in the campaign's zone.
 *
 * Anything that is not exactly this shape is refused rather than handed to
 * `new Date()`. That parser accepts a great deal of prose and reads all of it
 * in the **host's** timezone, so "Sep 2 2026 3:00 PM" would silently become an
 * instant three hours from the one the lead agreed to whenever the deployment
 * moved region — and a bare date would become midnight, which is a call at
 * midnight.
 */
function naiveToInstant(value: string, timezone: string | null): Date | null {
  const match = NAIVE.exec(value);
  if (!match) return null;

  // `Number(undefined)` is NaN rather than 0, so the optional minutes and
  // seconds groups are defaulted before they are converted — mapping the
  // whole match through `Number` would turn a value missing either one into
  // an instant of NaN.
  const [, year, month, day, hours, minutes = '0', seconds = '0'] = match;

  const parts = [year, month, day, hours, minutes, seconds].map(Number) as [
    number, number, number, number, number, number,
  ];

  if (!fieldsAreReal(...parts)) return null;

  return wallClockToUtc(
    value.slice(0, 10),
    parts[3],
    parts[4],
    parts[5],
    timezone ?? DEFAULT_CALLBACK_TIMYENE,
  );
}

/**
 * Moves a promised instant into the campaign's own dialing hours.
 *
 * **Forward only.** A promise is a time a person was told, so the one thing
 * this may never do is bring it earlier — a call that arrives before the hour
 * somebody agreed to is a call they did not agree to.
 *
 * A window with no hours is not a restriction and this is a no-op. Anything it
 * cannot compute — an unknown zone, hours that are not `HH:MM` — hands the
 * instant back unrolled: the dispatcher's own window gate still refuses to dial
 * outside the window, so the worst case is a callback that waits rather than
 * one that rings at 3am.
 */
export function rollIntoDialWindow(at: Date, window: DialingWindow): Date {
  const { fromTime, toTime, timezone } = window;
  const days = restrictedDays(window.dialDays);

  if (timezone === null) return at;

  const local = zonedParts(at, timezone);
  if (!local) return at;

  // Days with no hours: any time on an allowed day is inside. Handled before
  // the hours branch, which would otherwise return early on the null times and
  // book a promise onto a day the campaign does not dial on.
  if (fromTime === null || toTime === null) {
    if (days === null) return at;
    if (days.has(weekdayOf(local.ymd))) return at;

    const rolled = nextOpening(window, at);

    // `null` is a window with no opening to move into. Forward-only means the
    // promise stays exactly where it was: the dispatcher's gate refuses to
    // dial outside a window it cannot read anyway, so the promise waits rather
    // than being moved to an instant nothing would ever call at.
    if (rolled === null) return at;

    return rolled.getTime() > at.getTime() ? rolled : at;
  }

  const start = parseTimeOfDay(fromTime);
  const end = parseTimeOfDay(toTime);

  if (start === null || end === null) return at;

  // Start inclusive, end exclusive — the same reading the dispatcher's gate
  // uses, so an instant this function calls "inside" is one that gate will dial.
  const insideSameDay = start <= end && local.minutes >= start && local.minutes < end;
  const insideOvernight = start > end && (local.minutes >= start || local.minutes < end);
  const dayAllowed = days === null || days.has(weekdayOf(local.ymd));

  if ((insideSameDay || insideOvernight) && dayAllowed) return at;

  // `nextOpening` rather than a ternary over today/tomorrow: with days in play
  // the next opening can be several days out, and this is the same walk the
  // dispatcher's gate takes — which is the point. An instant this function
  // moves to must be one that gate will actually dial at.
  const rolled = nextOpening(window, at);

  if (rolled === null) return at;

  return rolled.getTime() > at.getTime() ? rolled : at;
}
