/**
 * When a campaign is allowed to dial.
 *
 * The campaigns slice validated `fromTime`, `toTime` and `timezone` in
 * isolation and deliberately enforced **no cross-field rule**, on the grounds
 * that what a window *means* belongs to the component that will finally have
 * an opinion about it. This is that component, and this module is that
 * opinion.
 *
 * Three states rather than a boolean, because there are three situations and
 * a boolean can only describe two:
 *
 * - **open** — dial.
 * - **closed** — do not dial, and say when it next will. The campaign is
 *   working exactly as configured; nothing is wrong and nothing is paused.
 * - **incomplete** — this is not a window. Fail closed and pause.
 *
 * The third is the one worth arguing about. An operator who set
 * `fromTime: "09:00"` and nothing else was expressing a restriction. Reading
 * that as "dial at any hour" is how a campaign calls somebody at 3am, and it
 * would be this module's fault rather than the API's. Reading it as "never
 * dial" is silently wrong in the other direction, and looks identical to a
 * campaign with nothing left to call. Saying "that is not a window" is the
 * only honest answer, and it is one edit away from being fixed.
 */

export interface DialingWindow {
  fromTime: string | null;
  toTime: string | null;
  timezone: string | null;
  /**
   * Weekdays this campaign may dial on, 0 = Sunday … 6 = Saturday.
   *
   * **Required, deliberately.** The column is `NOT NULL` with a default, so
   * every campaign row has one, and an optional field here would let a Prisma
   * `select` that forgot it compile — reading as "no day restriction", which
   * fails OPEN. Every other absence in this module fails closed, and a gate
   * that silently stops gating is the one bug this file exists to prevent. Two
   * services read the window through an explicit `select`; making this
   * required is what turns forgetting one into a compile error.
   */
  dialDays: readonly number[] | null;
}

export const EVERY_DAY = 7;

/**
 * The set of days a window actually restricts to, or `null` for "every day".
 *
 * Empty and all-seven are both `null` — they are the same restriction, namely
 * none, and collapsing them here means every caller downstream has one case
 * for "unrestricted" instead of three. Out-of-range and duplicate entries are
 * dropped rather than refused: this is the read path, the API refuses them on
 * the way in, and a stored row that somehow holds one must not be able to
 * throw inside the dispatcher's sweep.
 */
export function restrictedDays(dialDays: readonly number[] | null | undefined): Set<number> | null {
  if (!dialDays || dialDays.length === 0) return null;

  const days = readableDays(dialDays);

  if (days.size === 0 || days.size >= EVERY_DAY) return null;

  return days;
}

function readableDays(dialDays: readonly number[]): Set<number> {
  return new Set(dialDays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
}

/**
 * A stored day list that names days and yet restricts to none — `[7]`, `[-1]`,
 * a list of floats.
 *
 * `restrictedDays` answers `null` for it, which every caller reads as "no
 * restriction", and that is the one direction this module never fails in: the
 * operator expressed a restriction and we cannot tell which, so dialing every
 * day is how a campaign rings somebody on a day they said not to. Named
 * separately rather than folded into `restrictedDays` because it is not a set
 * of days — it is the absence of a readable one, and `evaluateWindow` turns it
 * into the same `incomplete` every other unreadable window becomes: paused,
 * and visible to whoever can fix it.
 *
 * A list with *some* readable entries is not this case. `[1, 7]` is a Monday
 * campaign with a stray number in it, the API refuses the list on the way in,
 * and honouring the day it can read is narrower than every alternative.
 */
export function hasUnreadableDays(dialDays: readonly number[] | null | undefined): boolean {
  return Boolean(dialDays) && dialDays!.length > 0 && readableDays(dialDays!).size === 0;
}

/** The weekday of a `YYYY-MM-DD`, 0 = Sunday. Read off the date the zone has
 *  already been applied to, so no second timezone conversion happens here —
 *  asking `Intl` for a weekday name would make this locale-dependent. */
export function weekdayOf(ymd: string): number {
  const [year, month, day] = ymd.split('-').map(Number);

  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

export type WindowState =
  | { state: 'open' }
  | { state: 'closed'; opensAt: Date }
  | { state: 'incomplete'; reason: string };

/**
 * Minutes since midnight, or null for anything that is not `HH:MM`.
 *
 * Exported for the callback engine, which rolls a promised instant into this
 * same window and has to read the same strings the same way. A second parser
 * would eventually disagree with this one about what `09:00` means, and the
 * disagreement would show up as a call placed outside the window.
 */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/**
 * The wall-clock time in a named zone, as minutes since midnight.
 *
 * `Intl` rather than a date library: the platform already ships the IANA
 * database, the whole requirement is "what hour is it there", and a dependency
 * added for one arithmetic operation is a dependency to keep patched forever.
 *
 * Returns null for a zone `Intl` does not recognise, so an unknown zone is an
 * incomplete window rather than a throw inside the sweep.
 */
/**
 * One formatter per zone, built on first use. Constructing an
 * `Intl.DateTimeFormat` is the expensive half of reading a zoned clock — it
 * loads the zone's rules — and `nextOpening` reads that clock up to three
 * times per candidate, two candidates per day, for a week of days. The
 * formatter is stateless once built, so sharing it changes nothing but the
 * cost. A zone `Intl` refuses is remembered as `null`, so an unknown zone is
 * asked once and refused thereafter without a throw.
 */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;

  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    formatter = null;
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

export function zonedParts(now: Date, timeZone: string): { minutes: number; ymd: string } | null {
  try {
    const formatter = formatterFor(timeZone);
    if (formatter === null) return null;
    const parts = formatter.formatToParts(now);

    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';

    // `hour12: false` yields "24" for midnight in some runtimes rather than
    // "00". Left alone that is 1440 minutes — past every window's end — so a
    // campaign dialing through midnight would stop for exactly one hour.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));

    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;

    return {
      minutes: hour * 60 + minute,
      ymd: `${get('year')}-${get('month')}-${get('day')}`,
    };
  } catch {
    return null;
  }
}

/**
 * The UTC instant of a given wall-clock time on a given day in a named zone.
 *
 * There is no direct API for this, so it is solved by guess-and-correct: guess
 * that the local time is the UTC time, measure how far the guess lands from the
 * target in that zone, and shift by the difference.
 *
 * **Corrected up to three times.** A single pass is right whenever the zone's
 * offset is the same at the guess and at the answer, which is every instant
 * except those within a day's offset of a DST boundary — and "09:00 on the
 * morning the clocks changed" is exactly the case the callback engine feeds
 * this. The second pass re-measures at the corrected instant, which is the one
 * whose offset actually applies. The third only ever runs when the first two
 * disagree, which is the signature of the case below.
 *
 * ## The hour a spring-forward skips
 *
 * A wall-clock time inside the gap answers to no instant at all: 01:59:59 EST
 * is followed by 03:00:00 EDT, so "02:00" is a reading the clocks never show.
 * Guess-and-correct oscillates over it — one pass lands after the gap and
 * measures itself an hour late, the next steps back an hour and lands *before*
 * the gap — and the second of those is a lie in the dangerous direction: it
 * reads as a time the window has not opened at yet, so a caller checking it
 * against the gate throws the candidate away and skips the whole day.
 *
 * So a correction is never allowed to move back across an instant that already
 * read at or after what was asked for. `after` remembers the first such
 * instant, and it is what comes back: a real instant, on the right day, whose
 * clock reads no earlier than the request. For a window opening exactly on the
 * gap's first minute — the ordinary case, since operators set whole hours —
 * that instant is precisely the one the clocks jumped to.
 */
export function instantOf(ymd: string, minutes: number, timeZone: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  const guess = Date.UTC(year!, month! - 1, day!, Math.floor(minutes / 60), minutes % 60);

  let instant = guess;
  /** The earliest instant seen whose local clock read at or after the target. */
  let after: number | null = null;

  for (let pass = 0; pass < 3; pass += 1) {
    const landed = zonedParts(new Date(instant), timeZone);
    if (!landed) return new Date(guess);

    // How far this instant actually sits from the wall-clock time we wanted, in
    // minutes, accounting for it landing on the previous or next day.
    const dayShift = landed.ymd < ymd ? -1440 : landed.ymd > ymd ? 1440 : 0;
    const drift = landed.minutes + dayShift - minutes;

    if (drift === 0) return new Date(instant);

    if (drift > 0 && (after === null || instant < after)) after = instant;

    instant -= drift * 60_000;
  }

  // Still disagreeing after three passes: the requested reading does not exist.
  // The instant that overshot it is the answer; the one that undershot is the
  // one this must never hand back.
  return new Date(after ?? instant);
}

/**
 * Midnight of `now`'s calendar day in the campaign's zone — the instant the
 * per-contact daily dial count starts from.
 *
 * The zone is not decoration. "No more than two calls a day" is a promise
 * about the CALLEE's day, and counted in UTC a campaign dialing India would
 * roll its cap over at 05:30 local, in the middle of a working morning: a
 * contact called twice before breakfast would be callable twice more before
 * lunch, on a campaign whose operator set the cap to two.
 *
 * A campaign with no zone counts UTC days, and so does one whose zone `Intl`
 * cannot read. It has no dialing hours either, so there is no local day to
 * prefer — and inventing one would be a guess about somebody's morning.
 */
export function localDayStart(now: Date, timeZone: string | null): Date {
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  if (timeZone === null) return utcMidnight;

  const local = zonedParts(now, timeZone);

  return local === null ? utcMidnight : instantOf(local.ymd, 0, timeZone);
}

/** The day after `ymd`, as `YYYY-MM-DD`. */
export function nextDay(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));

  return next.toISOString().slice(0, 10);
}

/** The hours a window runs between, once both have been read. `null` is a
 *  window with no hours at all: the whole of an allowed day. */
type Hours = { start: number; end: number } | null;

/**
 * Whether a window is open at one local reading. The single rule — the gate
 * and the walk that answers "when next" both ask this and nothing else, so
 * there is no way for the two to come to disagree about what "open" is.
 *
 * The day is the campaign-local calendar day of THIS instant, which is the
 * only reading that stays simple across an overnight window: a 22:00–02:00
 * window with Monday allowed dials Monday's small hours and Monday's evening,
 * and Tuesday's small hours only if Tuesday is allowed too.
 *
 * Start inclusive, end exclusive. A window advertised as ending at 17:00 that
 * places a call at 17:00 has broken its own promise.
 */
function isOpenAt(local: { minutes: number; ymd: string }, hours: Hours, days: Set<number> | null): boolean {
  if (days !== null && !days.has(weekdayOf(local.ymd))) return false;
  if (hours === null) return true;

  const { start, end } = hours;

  // `start > end` wraps midnight. Read as a plain `start <= now < end` this is
  // an empty set, and a campaign configured for evening calling would never
  // dial while looking perfectly configured.
  return start <= end
    ? local.minutes >= start && local.minutes < end
    : local.minutes >= start || local.minutes < end;
}

/** The hours of a window, or `null` when it has none this can read as a pair.
 *  One unreadable half makes both unreadable: a window with an end and no
 *  start is not a half-window, and `evaluateWindow` refuses it long before
 *  this is asked. */
function hoursOf(window: DialingWindow): Hours {
  if (window.fromTime === null || window.toTime === null) return null;

  const start = parseTimeOfDay(window.fromTime);
  const end = parseTimeOfDay(window.toTime);

  return start === null || end === null ? null : { start, end };
}

/**
 * The first instant strictly after `now` that the window is open.
 *
 * Shared by `evaluateWindow` and the callback engine's `rollIntoDialWindow`,
 * deliberately: the two have always had to agree about what "the next opening"
 * means, and with days in the picture that is a day walk rather than a
 * one-line ternary. Two copies of a day walk is two chances to disagree, and
 * the disagreement is a promised call placed on a day the campaign does not
 * dial on.
 *
 * **Each allowed day contributes every moment the window can begin on it, not
 * just `fromTime`.** An overnight window is open twice on a day it is allowed
 * on — the tail from midnight to `toTime`, and the evening from `fromTime`
 * onwards — and proposing only the second overshot the first: "22:00–02:00 on
 * weekdays", asked on a Sunday afternoon, answered Monday 22:00 while the
 * campaign was in fact already dialing at Monday 00:00.
 *
 * Every candidate is then **verified** against `isOpenAt` rather than trusted.
 * The candidate list is a claim about where openings can start and the gate is
 * the rule about what open means; checking one against the other is what makes
 * an overshoot impossible rather than merely unlikely, and it is why a
 * wall-clock time a DST jump swallowed cannot be handed back as an opening.
 *
 * Bounded at eight iterations — today plus a full week — because
 * `restrictedDays` guarantees at least one allowed day, and an unbounded
 * search here is a hang inside the dispatcher's sweep.
 *
 * **`null` when there is no opening to name**, rather than a best guess. A
 * window nobody can read has no next opening, and inventing one hands the
 * dispatcher an instant it will refuse to dial at and the callback engine a
 * promise that will never be kept — both silently, for ever. Every caller
 * turns it into the state it already has for a window like that: `incomplete`
 * for the gate, "leave the promise where it is" for the roll.
 */
export function nextOpening(window: DialingWindow, now: Date): Date | null {
  const timeZone = window.timezone;

  // Unreachable from either caller: both establish a readable zone before
  // asking. Answered rather than thrown, because a window this module cannot
  // read must never become an exception inside the dispatcher's sweep.
  if (timeZone === null) return null;

  const local = zonedParts(now, timeZone);
  if (!local) return null;

  // The same two refusals `evaluateWindow` makes, asked here as well so this
  // is total on its own: a caller that reached it another way cannot be handed
  // an opening for a window that has none.
  if (hasUnreadableDays(window.dialDays)) return null;

  const days = restrictedDays(window.dialDays);
  const hours = hoursOf(window);

  // A window that starts and ends at the same time is the empty set, so no
  // candidate this proposes can ever be open and the loop below would run out
  // and return an unverified instant.
  if (hours !== null && hours.start === hours.end) return null;

  // Ascending within the day, so the first candidate that answers is the
  // earliest one: midnight is only proposed for a window that actually wraps,
  // because for any other window midnight is not a moment it begins at.
  const times = hours !== null && hours.end < hours.start ? [0, hours.start] : [hours?.start ?? 0];

  let ymd = local.ymd;

  for (let ahead = 0; ahead <= EVERY_DAY; ahead += 1) {
    if (days === null || days.has(weekdayOf(ymd))) {
      for (const minutes of times) {
        const candidate = instantOf(ymd, minutes, timeZone);

        // Strictly after: the gate has just answered "closed" for this very
        // instant, so an opening of now is not an opening.
        if (candidate.getTime() <= now.getTime()) continue;

        const there = zonedParts(candidate, timeZone);

        if (there && isOpenAt(there, hours, days)) return candidate;
      }
    }

    ymd = nextDay(ymd);
  }

  // A full week walked with nothing the gate would call open. `restrictedDays`
  // guarantees an allowed day, so this is unreachable for a window the two
  // refusals above let through — and if a later edit makes it reachable, the
  // honest answer is "no opening" rather than an instant nothing will dial at.
  return null;
}

/**
 * Whether this campaign may dial right now.
 *
 * A window with **neither** end set and no day restriction dials at any hour —
 * including one that names a timezone, since a zone alone only says how hours
 * would be read and there are no hours to read.
 */
export function evaluateWindow(window: DialingWindow, now: Date): WindowState {
  const { fromTime, toTime, timezone } = window;
  const days = restrictedDays(window.dialDays);

  // Asked first, because every door below it reads "no days" as "every day".
  // A list that names days and restricts to none is not that: it is a window
  // nobody can read, and reading it as unrestricted would dial on the days it
  // was written to exclude.
  if (hasUnreadableDays(window.dialDays)) {
    return { state: 'incomplete', reason: 'dialing days it can read, from 0 (Sunday) to 6' };
  }

  if (fromTime === null && toTime === null && days === null) return { state: 'open' };

  if (fromTime === null && toTime !== null) {
    return { state: 'incomplete', reason: 'a start time, because it has an end time' };
  }

  if (toTime === null && fromTime !== null) {
    return { state: 'incomplete', reason: 'an end time, because it has a start time' };
  }

  if (timezone === null) {
    // Hours with no zone are hours in *somebody's* day and we do not know
    // whose. Defaulting to UTC would shift an Indian campaign's evening window
    // into its own afternoon, which is a wrong call at a wrong hour rather
    // than a configuration error somebody can see. Days have the same problem
    // in a coarser form — "not on Sunday" is a claim about somebody's calendar
    // — so both fail closed, and the reason names whichever was configured.
    return {
      state: 'incomplete',
      reason:
        fromTime === null
          ? 'a timezone, because it restricts which days it calls on'
          : 'a timezone, because it has dialing hours',
    };
  }

  const local = zonedParts(now, timezone);
  if (!local) {
    return { state: 'incomplete', reason: 'a timezone this platform recognises' };
  }

  // Days with no hours: the whole of an allowed day is the window. The next
  // opening is midnight on the next allowed day, which is when it becomes
  // true again rather than an hour anybody chose.
  const hours = fromTime === null ? null : hoursOf(window);

  if (fromTime !== null && hours === null) {
    return { state: 'incomplete', reason: 'dialing hours in HH:MM form' };
  }

  // Start inclusive, end exclusive — so a window whose two ends are the same
  // time is the empty set, and the campaign never dials while every screen
  // shows hours somebody chose. Named rather than left to be discovered as a
  // campaign that quietly calls nobody.
  if (hours !== null && hours.start === hours.end) {
    return { state: 'incomplete', reason: 'an end time that differs from its start time' };
  }

  // One rule, asked here and asked again by the walk below — see `isOpenAt`.
  if (isOpenAt(local, hours, days)) return { state: 'open' };

  const opensAt = nextOpening(window, now);

  // No opening this walk could verify. Everything that produces one is already
  // refused above, so this is a window a later edit made unreadable — and the
  // state for that is the one every other unreadable window gets.
  if (opensAt === null) {
    return { state: 'incomplete', reason: 'a dialing window that ever opens' };
  }

  return { state: 'closed', opensAt };
}
