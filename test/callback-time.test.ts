import { describe, expect, it } from 'vitest';

const { parseCallbackAt, rollIntoDialWindow, MAX_CALLBACK_DAYS_AHEAD } = await import(
  '../src/lib/callbackTime.js'
);

const NOW = new Date('2026-09-01T06:00:00Z');
const IST = 'Asia/Kolkata';

/** The parsed instant, or a failure naming the reason we did not get one. */
function at(raw: unknown, timezone: string | null = IST, now: Date = NOW): Date {
  const parsed = parseCallbackAt(raw, timezone, now);

  if (!parsed.ok) throw new Error(`expected an instant, got ${parsed.reason}`);

  return parsed.at;
}

function reason(raw: unknown, timezone: string | null = IST, now: Date = NOW): string {
  const parsed = parseCallbackAt(raw, timezone, now);

  if (parsed.ok) throw new Error(`expected a rejection, got ${parsed.at.toISOString()}`);

  return parsed.reason;
}

describe('nothing to parse', () => {
  it('reads null and undefined as no callback having been asked for', () => {
    expect(reason(null)).toBe('absent');
    expect(reason(undefined)).toBe('absent');
  });

  /**
   * An empty string is the same fact as null — the model found no time — and
   * reading it as a broken value would put a rejection line in the log for
   * every call in a campaign nobody asked a callback of.
   */
  it('reads an empty or blank string as absent rather than broken', () => {
    expect(reason('')).toBe('absent');
    expect(reason('   ')).toBe('absent');
  });

  /**
   * The call-note key's description tells the model to write the literal word
   * "null" when no time was requested. That word is the same fact as null, not
   * a datetime that failed to parse.
   */
  it('reads the literal string "null" as absent', () => {
    expect(reason('null')).toBe('absent');
    expect(reason(' NULL ')).toBe('absent');
  });

  it('refuses a value that is not text', () => {
    expect(reason(1_756_000_000)).toBe('not_a_string');
    expect(reason({ at: '2026-09-02T10:00:00Z' })).toBe('not_a_string');
    expect(reason(true)).toBe('not_a_string');
  });
});

describe('what a datetime has to look like', () => {
  it('refuses prose', () => {
    expect(reason('tomorrow afternoon')).toBe('unparseable');
    expect(reason('next tuesday at 4')).toBe('unparseable');
  });

  /**
   * A bare date is "some day", and some day must never place a call. There is
   * deliberately no noon default: nobody agreed to noon.
   */
  it('refuses a date with no time on it', () => {
    expect(reason('2026-09-02')).toBe('unparseable');
    expect(reason('02/09/2026')).toBe('unparseable');
  });

  it('refuses a datetime whose fields are out of range', () => {
    expect(reason('2026-13-02T10:00:00')).toBe('unparseable');
    expect(reason('2026-09-31T10:00:00')).toBe('unparseable');
    expect(reason('2026-09-02T25:00:00')).toBe('unparseable');
    expect(reason('2026-09-02T10:61:00')).toBe('unparseable');
  });
});

describe('an offset the value carries itself', () => {
  it('takes Z at face value', () => {
    expect(at('2026-09-02T10:00:00Z').toISOString()).toBe('2026-09-02T10:00:00.000Z');
  });

  it('reads ±HH:MM, ±HHMM and a bare ±HH as the same offset', () => {
    const expected = '2026-09-02T04:30:00.000Z';

    expect(at('2026-09-02T10:00:00+05:30').toISOString()).toBe(expected);
    expect(at('2026-09-02T10:00:00+0530').toISOString()).toBe(expected);
    expect(at('2026-09-02T15:00:00+10').toISOString()).toBe('2026-09-02T05:00:00.000Z');
    expect(at('2026-09-02T00:00:00-04:30').toISOString()).toBe('2026-09-02T04:30:00.000Z');
  });

  /**
   * The whole reason the offset pattern demands a `T` in front of it: the day
   * digits of a bare date are two digits behind a `-`, which is exactly the
   * shape of a negative offset.
   */
  it('does not read a bare date’s day as an offset', () => {
    expect(reason('2026-09-02')).toBe('unparseable');
  });

  it('ignores the campaign timezone when the value carries an offset', () => {
    expect(at('2026-09-02T10:00:00Z', 'America/New_York').toISOString()).toBe(
      '2026-09-02T10:00:00.000Z',
    );
  });

  /**
   * Both timestamp keys ask for `YYYY-MM-DDTHH:mm±HH`, but an early draft of
   * contender I's `callback_requested_time_vocobaseplatform` read
   * `YYYY-MM-DDTHH±HH` (no minutes), so the parser accepts the minute-less
   * form as well — a model that follows the older wording books on the hour
   * rather than failing.
   */
  it('accepts the minute-less "HH±HH" form, reading the missing minutes as :00', () => {
    expect(at('2026-09-02T10+05:30').toISOString()).toBe('2026-09-02T04:30:00.000Z');
    expect(at('2026-09-02T10+05').toISOString()).toBe('2026-09-02T05:00:00.000Z');
    expect(at('2026-09-02T10Z').toISOString()).toBe('2026-09-02T10:00:00.000Z');
  });

  it('still accepts the full "HH:mm±HH" form beside the minute-less one', () => {
    expect(at('2026-09-02T10:15+05:30').toISOString()).toBe('2026-09-02T04:45:00.000Z');
  });

  /** The `±HH:MM` offset spelling, on top of the minute-less time — the
   *  combination a model following the new format string literally, but
   *  naming a half-hour zone, would produce. */
  it('accepts a minute-less time with a ±HH:MM offset', () => {
    expect(at('2026-09-02T10+05:30').toISOString()).toBe('2026-09-02T04:30:00.000Z');
    expect(at('2026-09-02T18-04:30').toISOString()).toBe('2026-09-02T22:30:00.000Z');
  });

  /** The space-for-`T` tolerance must not demand the minutes the time
   *  tolerance lets go of: both deviations at once still read. A bare date
   *  stays refused — the replace needs the space and two digits. */
  it('accepts a minute-less time behind a space instead of a T', () => {
    expect(at('2026-09-02 10+05:30').toISOString()).toBe('2026-09-02T04:30:00.000Z');
    expect(at('2026-09-02 10:15+05:30').toISOString()).toBe('2026-09-02T04:45:00.000Z');
    expect(parseCallbackAt('2026-09-02', IST, NOW)).toEqual({ ok: false, reason: 'unparseable' });
  });
});

describe('a datetime with no offset', () => {
  it('reads wall-clock time in the campaign’s timezone', () => {
    expect(at('2026-09-02T15:00:00', IST).toISOString()).toBe('2026-09-02T09:30:00.000Z');
  });

  it('accepts a space instead of a T, and seconds being left off', () => {
    expect(at('2026-09-02 15:00', IST).toISOString()).toBe('2026-09-02T09:30:00.000Z');
  });

  /** Both sides of a daylight-saving boundary, with the offset computed at the
   *  target instant rather than at the moment of parsing. */
  it('is daylight-saving correct in both directions', () => {
    const summer = at('2026-07-01T09:00:00', 'America/New_York', new Date('2026-06-01T00:00:00Z'));
    expect(summer.toISOString()).toBe('2026-07-01T13:00:00.000Z');

    const winter = at('2027-01-15T09:00:00', 'America/New_York', new Date('2026-12-01T00:00:00Z'));
    expect(winter.toISOString()).toBe('2027-01-15T14:00:00.000Z');
  });

  it('falls back to a default zone rather than the host’s when the campaign has none', () => {
    expect(at('2026-09-02T15:00:00', null).toISOString()).toBe('2026-09-02T09:30:00.000Z');
  });
});

describe('bounds', () => {
  /**
   * Extraction runs seconds after the hang-up. Without this floor a lead who
   * says "call me right back" is redialled mid-goodbye.
   */
  it('refuses an instant inside the next minute', () => {
    expect(reason(new Date(NOW.getTime() + 30_000).toISOString())).toBe('too_soon');
    expect(reason(new Date(NOW.getTime() + 60_000).toISOString())).toBe('too_soon');
    expect(reason(new Date(NOW.getTime() - 3_600_000).toISOString())).toBe('too_soon');
  });

  it('accepts an instant just past the floor', () => {
    const soon = new Date(NOW.getTime() + 61_000);
    expect(at(soon.toISOString()).toISOString()).toBe(soon.toISOString());
  });

  /** Models fabricate years. */
  it('refuses an instant further ahead than the horizon', () => {
    const day = 86_400_000;
    expect(reason(new Date(NOW.getTime() + (MAX_CALLBACK_DAYS_AHEAD + 1) * day).toISOString())).toBe(
      'too_far_ahead',
    );
    expect(reason('2126-09-02T10:00:00Z')).toBe('too_far_ahead');
  });

  it('accepts an instant on the horizon itself', () => {
    const edge = new Date(NOW.getTime() + MAX_CALLBACK_DAYS_AHEAD * 86_400_000);
    expect(at(edge.toISOString()).toISOString()).toBe(edge.toISOString());
  });
});

describe('rolling into the campaign’s dialing window', () => {
  const window = { fromTime: '09:00', toTime: '21:00', timezone: IST };

  /** 09:00 IST is 03:30 UTC. */
  const ist = (iso: string) => new Date(iso);

  it('leaves an instant inside the window alone', () => {
    const inside = ist('2026-09-02T10:00:00Z'); // 15:30 IST
    expect(rollIntoDialWindow(inside, window)).toEqual(inside);
  });

  it('leaves the opening instant itself alone', () => {
    const open = ist('2026-09-02T03:30:00Z'); // 09:00 IST
    expect(rollIntoDialWindow(open, window)).toEqual(open);
  });

  it('moves a promise made before opening to the same day’s opening', () => {
    const early = ist('2026-09-02T03:29:00Z'); // 08:59 IST
    expect(rollIntoDialWindow(early, window).toISOString()).toBe('2026-09-02T03:30:00.000Z');
  });

  /** The end of a window is exclusive: a call placed at 21:00 has broken the
   *  promise the window makes. */
  it('moves the closing instant to the next day’s opening', () => {
    const close = ist('2026-09-02T15:30:00Z'); // 21:00 IST
    expect(rollIntoDialWindow(close, window).toISOString()).toBe('2026-09-03T03:30:00.000Z');
  });

  it('rolls over the end of a month and the end of a year', () => {
    expect(rollIntoDialWindow(ist('2026-09-30T18:00:00Z'), window).toISOString()).toBe(
      '2026-10-01T03:30:00.000Z',
    );
    expect(rollIntoDialWindow(ist('2026-12-31T18:00:00Z'), window).toISOString()).toBe(
      '2027-01-01T03:30:00.000Z',
    );
  });

  it('does nothing for a campaign whose window is always open', () => {
    const any = ist('2026-09-02T22:00:00Z');
    expect(rollIntoDialWindow(any, { fromTime: null, toTime: null, timezone: IST })).toEqual(any);
  });

  describe('a window that wraps midnight', () => {
    const overnight = { fromTime: '20:00', toTime: '06:00', timezone: IST };

    it('leaves an instant on either side of midnight alone', () => {
      const evening = ist('2026-09-02T17:00:00Z'); // 22:30 IST
      const smallHours = ist('2026-09-02T20:30:00Z'); // 02:00 IST next day
      expect(rollIntoDialWindow(evening, overnight)).toEqual(evening);
      expect(rollIntoDialWindow(smallHours, overnight)).toEqual(smallHours);
    });

    it('moves a daytime promise forward to the evening opening', () => {
      const midday = ist('2026-09-02T09:00:00Z'); // 14:30 IST
      expect(rollIntoDialWindow(midday, overnight).toISOString()).toBe('2026-09-02T14:30:00.000Z');
    });
  });

  /**
   * A roll that cannot be computed hands back the instant unrolled. The claim
   * gate still refuses to dial outside the window, so the worst case is a
   * callback that waits — never one that rings at 3am.
   */
  it('hands back the instant unrolled when the zone is unusable', () => {
    const any = ist('2026-09-02T22:00:00Z');
    expect(rollIntoDialWindow(any, { ...window, timezone: 'Mars/Olympus' })).toEqual(any);
    expect(rollIntoDialWindow(any, { ...window, fromTime: '9am' })).toEqual(any);
    expect(rollIntoDialWindow(any, { ...window, timezone: null })).toEqual(any);
  });

  it('only ever moves forward', () => {
    const cases = [
      '2026-09-02T03:29:00Z',
      '2026-09-02T15:30:00Z',
      '2026-09-02T22:00:00Z',
      '2026-09-02T00:10:00Z',
    ];

    for (const iso of cases) {
      const from = new Date(iso);
      expect(rollIntoDialWindow(from, window).getTime()).toBeGreaterThanOrEqual(from.getTime());
    }
  });
});

/**
 * A promise landing on a day the campaign does not dial on.
 *
 * The whole reason this walk is shared with `evaluateWindow` rather than
 * written twice: an instant this function calls "inside" has to be one the
 * dispatcher's gate will actually dial at. If the two disagreed about days, a
 * callback would be booked for Saturday and then sit unclaimed until Monday,
 * with `callbackAt` claiming a promise was kept at a time it was not.
 *
 *   2026-09-04 Fri   2026-09-05 Sat   2026-09-06 Sun   2026-09-07 Mon
 */
describe('rolling a promise onto a day the campaign dials on', () => {
  const IST_ZONE = 'Asia/Kolkata';
  const weekdays = {
    fromTime: '09:00',
    toTime: '21:00',
    timezone: IST_ZONE,
    dialDays: [1, 2, 3, 4, 5],
  };

  it('leaves a promise inside the hours on a working day alone', () => {
    // Friday 2026-09-04, 15:30 IST = 10:00 UTC.
    const inside = new Date('2026-09-04T10:00:00Z');

    expect(rollIntoDialWindow(inside, weekdays)).toEqual(inside);
  });

  it('moves a Saturday promise to Monday morning', () => {
    // Saturday 2026-09-05, 15:30 IST = 10:00 UTC — inside the hours, closed day.
    const saturday = new Date('2026-09-05T10:00:00Z');

    // Monday 2026-09-07, 09:00 IST = 03:30 UTC.
    expect(rollIntoDialWindow(saturday, weekdays).toISOString()).toBe(
      '2026-09-07T03:30:00.000Z',
    );
  });

  /** Forward only, always — the rule the whole module is built on. A promise
   *  is a time a person was told, and a call before it is one they did not
   *  agree to. Days can only ever push it later. */
  it('never moves a promise earlier', () => {
    // Sunday 2026-09-06, 23:00 IST = 17:30 UTC.
    const sunday = new Date('2026-09-06T17:30:00Z');
    const rolled = rollIntoDialWindow(sunday, weekdays);

    expect(rolled.getTime()).toBeGreaterThan(sunday.getTime());
    expect(rolled.toISOString()).toBe('2026-09-07T03:30:00.000Z');
  });

  it('honours days on a campaign that set no hours', () => {
    const saturdaysOnly = {
      fromTime: null,
      toTime: null,
      timezone: IST_ZONE,
      dialDays: [6],
    };

    // Saturday 2026-09-05, 15:30 IST — an allowed day, no hours to be outside.
    const onDay = new Date('2026-09-05T10:00:00Z');
    expect(rollIntoDialWindow(onDay, saturdaysOnly)).toEqual(onDay);

    // Sunday 2026-09-06, 15:30 IST → the next Saturday, 2026-09-12 00:00 IST
    // = 2026-09-11T18:30Z.
    expect(rollIntoDialWindow(new Date('2026-09-06T10:00:00Z'), saturdaysOnly).toISOString()).toBe(
      '2026-09-11T18:30:00.000Z',
    );
  });

  /**
   * The overnight case, which is the one the day walk used to overshoot. A
   * promise made on a Sunday afternoon under "22:00–02:00 on weekdays" must
   * roll to Monday 00:00 — the tail of the window, which is when the campaign
   * genuinely starts dialing again — not to Monday 22:00, twenty-two hours
   * later than the person could have been called.
   *
   * The booking and the dispatcher's gate read the same walk, so this is also
   * the assertion that a callback is never booked for a moment the gate would
   * refuse to dial at.
   */
  it('rolls a promise into an overnight window’s small hours', () => {
    const nights = { ...weekdays, fromTime: '22:00', toTime: '02:00' };

    // Sunday 2026-09-06, 13:21 IST = 07:51 UTC.
    // Monday 2026-09-07, 00:00 IST = 2026-09-06T18:30Z.
    expect(rollIntoDialWindow(new Date('2026-09-06T07:51:00Z'), nights).toISOString()).toBe(
      '2026-09-06T18:30:00.000Z',
    );

    // Monday 2026-09-07, 10:00 IST = 04:30 UTC — that day's tail is spent, so
    // the evening is the answer: Monday 22:00 IST = 16:30Z.
    expect(rollIntoDialWindow(new Date('2026-09-07T04:30:00Z'), nights).toISOString()).toBe(
      '2026-09-07T16:30:00.000Z',
    );
  });

  /**
   * The morning the clocks go forward, in the zone the campaign named.
   *
   * A promise for a window that opens at 02:00 America/New_York on 2026-03-08
   * is a promise for a wall-clock time that does not exist: 01:59:59 EST is
   * followed by 03:00:00 EDT. The booking has to land on the instant the
   * clocks jumped to — the same instant the dispatcher's gate calls open — and
   * never on an instant before the gap, which reads as closed and pushes the
   * whole thing a day out.
   */
  it('rolls a promise onto the instant a spring-forward jumped to', () => {
    const nyc = {
      fromTime: '02:00',
      toTime: '06:00',
      timezone: 'America/New_York',
      dialDays: [],
    };

    // 2026-03-08T05:30Z is 00:30 EST — before the window and before the jump.
    const rolled = rollIntoDialWindow(new Date('2026-03-08T05:30:00Z'), nyc);

    expect(rolled.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('is unchanged by an empty or full day list', () => {
    // Saturday, inside the hours: unrestricted, so nothing moves.
    const saturday = new Date('2026-09-05T10:00:00Z');

    expect(rollIntoDialWindow(saturday, { ...weekdays, dialDays: [] })).toEqual(saturday);
    expect(
      rollIntoDialWindow(saturday, { ...weekdays, dialDays: [0, 1, 2, 3, 4, 5, 6] }),
    ).toEqual(saturday);
  });
});
