import { describe, expect, it } from 'vitest';
import { evaluateWindow, localDayStart } from '../src/lib/dialingWindow.js';
import type { DialingWindow } from '../src/lib/dialingWindow.js';

/**
 * The campaigns slice validated `fromTime`, `toTime` and `timezone` in
 * isolation and deliberately asserted no cross-field rule, saying the
 * dispatcher would decide what a window *means*. This is that decision, so
 * these cases are the specification rather than a regression net.
 */

const IST = 'Asia/Kolkata';

/** 10:00 IST is 04:30 UTC — the offset that catches a server-clock reading. */
const at = (iso: string) => new Date(iso);

describe('a campaign with no window', () => {
  it('dials at any hour', () => {
    const campaign = { fromTime: null, toTime: null, timezone: null };

    expect(evaluateWindow(campaign, at('2026-08-30T02:00:00Z')).state).toBe('open');
    expect(evaluateWindow(campaign, at('2026-08-30T14:00:00Z')).state).toBe('open');
  });

  it('dials at any hour even when a timezone is set but no hours are', () => {
    // A timezone alone restricts nothing — it only says how hours would be
    // read, and there are no hours. This is not the incomplete case.
    const campaign = { fromTime: null, toTime: null, timezone: IST };

    expect(evaluateWindow(campaign, at('2026-08-30T20:00:00Z')).state).toBe('open');
  });
});

describe('a daytime window', () => {
  const campaign = { fromTime: '09:00', toTime: '17:00', timezone: IST };

  it('is open inside its own hours', () => {
    // 10:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T04:30:00Z')).state).toBe('open');
  });

  it('is closed before it opens', () => {
    // 08:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T02:30:00Z')).state).toBe('closed');
  });

  /**
   * The end is exclusive. A window advertised as ending at 17:00 that places a
   * call at 17:00 has broken its own promise, and the operator who set it is
   * the one who hears about it.
   */
  it('is closed at exactly its end time', () => {
    // 17:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T11:30:00Z')).state).toBe('closed');
  });

  it('is open at exactly its start time', () => {
    // 09:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T03:30:00Z')).state).toBe('open');
  });

  /**
   * The case that fails if the implementation reads the server's clock rather
   * than the campaign's zone. 04:30 UTC is outside 09:00–17:00 read as UTC and
   * inside it read as IST, so a server-clock implementation answers "closed"
   * here and passes every other case in this file.
   */
  it('reads the hours in the campaign zone, not the server zone', () => {
    const utcCampaign = { fromTime: '09:00', toTime: '17:00', timezone: 'UTC' };
    const moment = at('2026-08-30T04:30:00Z');

    expect(evaluateWindow(campaign, moment).state).toBe('open');
    expect(evaluateWindow(utcCampaign, moment).state).toBe('closed');
  });
});

describe('an overnight window', () => {
  const campaign = { fromTime: '21:00', toTime: '06:00', timezone: IST };

  /**
   * `from > to` wraps midnight. Read as a plain `from <= now < to` it is an
   * empty window, and a campaign configured for evening calling would never
   * dial at all while looking perfectly configured.
   */
  it('is open late in the evening', () => {
    // 23:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T17:30:00Z')).state).toBe('open');
  });

  it('is open in the small hours', () => {
    // 02:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T20:30:00Z')).state).toBe('open');
  });

  it('is closed in the middle of the day', () => {
    // 12:00 IST
    expect(evaluateWindow(campaign, at('2026-08-30T06:30:00Z')).state).toBe('closed');
  });
});

/**
 * The fail-closed cases, and the reason this function returns three states
 * rather than a boolean.
 *
 * An operator who set `fromTime: "09:00"` and nothing else was expressing a
 * restriction. Reading that as "dial at any hour" is how a campaign calls
 * somebody at 3am, and it would be this module's fault rather than the API's.
 * Reading it as "never dial" is silently wrong in the other direction. Saying
 * "this is not a window" is the only honest answer, and the sweep pauses the
 * campaign so a person fixes it.
 */
describe('an incomplete window', () => {
  it('is incomplete with a start and no end', () => {
    const result = evaluateWindow({ fromTime: '09:00', toTime: null, timezone: IST }, new Date());

    expect(result.state).toBe('incomplete');
  });

  it('is incomplete with an end and no start', () => {
    const result = evaluateWindow({ fromTime: null, toTime: '17:00', timezone: IST }, new Date());

    expect(result.state).toBe('incomplete');
  });

  it('is incomplete with hours and no timezone', () => {
    // Hours with no zone are hours in *somebody's* day and we do not know
    // whose. Defaulting to UTC would shift an Indian campaign's evening window
    // into its own afternoon.
    const result = evaluateWindow({ fromTime: '09:00', toTime: '17:00', timezone: null }, new Date());

    expect(result.state).toBe('incomplete');
  });

  it('is incomplete rather than throwing on a zone nothing recognises', () => {
    const result = evaluateWindow(
      { fromTime: '09:00', toTime: '17:00', timezone: 'Mars/Olympus_Mons' },
      new Date(),
    );

    expect(result.state).toBe('incomplete');
  });

  it('is incomplete rather than throwing on a malformed time', () => {
    const result = evaluateWindow({ fromTime: '9am', toTime: '17:00', timezone: IST }, new Date());

    expect(result.state).toBe('incomplete');
  });

  it('names what is wrong, so the notification can repeat it', () => {
    const result = evaluateWindow({ fromTime: '09:00', toTime: null, timezone: IST }, new Date());

    expect(result.state).toBe('incomplete');
    if (result.state === 'incomplete') {
      expect(result.reason).toMatch(/end/i);
    }
  });
});

describe('when a closed window next opens', () => {
  it('reports the next start in the campaign zone, later the same day', () => {
    // 08:00 IST, window opens at 09:00 IST = 03:30 UTC.
    const result = evaluateWindow(
      { fromTime: '09:00', toTime: '17:00', timezone: IST },
      at('2026-08-30T02:30:00Z'),
    );

    expect(result.state).toBe('closed');
    if (result.state === 'closed') {
      expect(result.opensAt.toISOString()).toBe('2026-08-30T03:30:00.000Z');
    }
  });

  it('reports tomorrow when the window has already closed today', () => {
    // 18:00 IST, next open is 09:00 IST tomorrow = 03:30 UTC on the 31st.
    const result = evaluateWindow(
      { fromTime: '09:00', toTime: '17:00', timezone: IST },
      at('2026-08-30T12:30:00Z'),
    );

    expect(result.state).toBe('closed');
    if (result.state === 'closed') {
      expect(result.opensAt.toISOString()).toBe('2026-08-31T03:30:00.000Z');
    }
  });
});

/**
 * Which weekdays a campaign dials on.
 *
 * 2026-08-30 is a **Sunday**, so every date in here is stated with its weekday
 * — a day-of-week test whose dates are only correct by accident is worse than
 * no test, because it goes on passing when the rule inverts.
 *
 *   2026-08-28 Fri   2026-08-29 Sat   2026-08-30 Sun   2026-08-31 Mon
 */
describe('a campaign that dials on some days only', () => {
  const WEEKDAYS = [1, 2, 3, 4, 5];
  const hours = { fromTime: '09:00', toTime: '17:00', timezone: IST };

  it('dials inside the hours on a day it calls on', () => {
    // Monday 2026-08-31, 10:00 IST = 04:30 UTC.
    const result = evaluateWindow(
      { ...hours, dialDays: WEEKDAYS },
      at('2026-08-31T04:30:00Z'),
    );

    expect(result.state).toBe('open');
  });

  /** The case the whole feature exists for: perfectly inside the hours, and
   *  still closed, because it is the weekend. */
  it('does not dial inside the hours on a day it does not call on', () => {
    // Sunday 2026-08-30, 10:00 IST.
    const result = evaluateWindow(
      { ...hours, dialDays: WEEKDAYS },
      at('2026-08-30T04:30:00Z'),
    );

    expect(result.state).toBe('closed');
    // Monday 09:00 IST = 03:30 UTC on the 31st.
    if (result.state === 'closed') {
      expect(result.opensAt.toISOString()).toBe('2026-08-31T03:30:00.000Z');
    }
  });

  /** The walk has to cross more than one closed day, which a today/tomorrow
   *  ternary cannot do — this is what `nextOpening` is for. */
  it('skips a whole weekend from Friday evening', () => {
    // Friday 2026-08-28, 18:00 IST = 12:30 UTC. Hours are spent and the next
    // two days are closed, so the next opening is Monday.
    const result = evaluateWindow(
      { ...hours, dialDays: WEEKDAYS },
      at('2026-08-28T12:30:00Z'),
    );

    expect(result.state).toBe('closed');
    if (result.state === 'closed') {
      expect(result.opensAt.toISOString()).toBe('2026-08-31T03:30:00.000Z');
    }
  });

  it('opens later the same day when the day is allowed and the hours have not started', () => {
    // Monday 2026-08-31, 07:00 IST = 01:30 UTC.
    const result = evaluateWindow(
      { ...hours, dialDays: WEEKDAYS },
      at('2026-08-31T01:30:00Z'),
    );

    expect(result.state).toBe('closed');
    if (result.state === 'closed') {
      expect(result.opensAt.toISOString()).toBe('2026-08-31T03:30:00.000Z');
    }
  });

  /** Days with no hours: the whole day is the window, and the next opening is
   *  midnight rather than an hour nobody chose. */
  it('treats an allowed day as open all day when no hours are set', () => {
    const saturdays = { fromTime: null, toTime: null, timezone: IST, dialDays: [6] };

    // Saturday 2026-08-29, 03:00 IST = 2026-08-28T21:30Z.
    expect(evaluateWindow(saturdays, at('2026-08-28T21:30:00Z')).state).toBe('open');

    // Sunday 2026-08-30, 03:00 IST. Next Saturday is 2026-09-05, 00:00 IST
    // = 2026-09-04T18:30Z.
    const closed = evaluateWindow(saturdays, at('2026-08-29T21:30:00Z'));
    expect(closed.state).toBe('closed');
    if (closed.state === 'closed') {
      expect(closed.opensAt.toISOString()).toBe('2026-09-04T18:30:00.000Z');
    }
  });

  /**
   * An overnight window belongs to the calendar day of the instant, not to the
   * day it opened on. Stated here because it is the one rule a reader will
   * otherwise guess at, and both halves have to be pinned or the guess passes.
   */
  it('reads an overnight window by the day the clock is on', () => {
    // Monday only, 22:00–02:00 IST.
    const overnight = { fromTime: '22:00', toTime: '02:00', timezone: IST, dialDays: [1] };

    // Monday 2026-08-31, 23:00 IST = 17:30 UTC. Monday's evening: open.
    expect(evaluateWindow(overnight, at('2026-08-31T17:30:00Z')).state).toBe('open');

    // Tuesday 2026-09-01, 01:00 IST = 2026-08-31T19:30Z. Inside the hours, but
    // the clock says Tuesday and Tuesday is not allowed.
    expect(evaluateWindow(overnight, at('2026-08-31T19:30:00Z')).state).toBe('closed');
  });

  /** Both spellings of "no restriction" behave as the column never existed. */
  it('treats an empty list and a full week as no restriction at all', () => {
    // Sunday 2026-08-30, 10:00 IST — closed under WEEKDAYS above.
    const sunday = at('2026-08-30T04:30:00Z');

    expect(evaluateWindow({ ...hours, dialDays: [] }, sunday).state).toBe('open');
    expect(evaluateWindow({ ...hours, dialDays: [0, 1, 2, 3, 4, 5, 6] }, sunday).state).toBe('open');
    expect(evaluateWindow(hours, sunday).state).toBe('open');
  });

  /** Fail closed, exactly as hours with no zone do: "not on Sunday" is a claim
   *  about somebody's calendar and we do not know whose. */
  it('is incomplete when it restricts days with no timezone', () => {
    const result = evaluateWindow(
      { fromTime: null, toTime: null, timezone: null, dialDays: WEEKDAYS },
      at('2026-08-30T04:30:00Z'),
    );

    expect(result.state).toBe('incomplete');
    if (result.state === 'incomplete') {
      expect(result.reason).toMatch(/timezone/);
      expect(result.reason).toMatch(/days/);
    }
  });
});

/**
 * An overnight window is open TWICE on each day it is allowed on — the tail
 * that runs from midnight to `toTime`, and the evening that runs from
 * `fromTime` to midnight — and the next opening can be either.
 *
 * The walk used to propose only `fromTime`, so a Sunday afternoon under
 * "22:00–02:00, weekdays" answered "Monday 22:00" while the campaign was in
 * fact already dialing at Monday 00:00: nine hours of a promised callback
 * pushed past an opening that had already happened.
 */
describe('when an overnight window next opens', () => {
  const nights = { fromTime: '22:00', toTime: '02:00', timezone: IST, dialDays: [1, 2, 3, 4, 5] };

  const opensAt = (window: DialingWindow, now: string): string => {
    const result = evaluateWindow(window, at(now));
    expect(result.state).toBe('closed');

    return result.state === 'closed' ? result.opensAt.toISOString() : 'open';
  };

  /** The tail is the answer: Sunday afternoon, and Monday's small hours come
   *  before Monday evening. */
  it('opens at midnight on the first allowed day', () => {
    // Sunday 2026-08-30, 13:21 IST = 07:51 UTC.
    // Monday 2026-08-31, 00:00 IST = 2026-08-30T18:30Z.
    expect(opensAt(nights, '2026-08-30T07:51:00Z')).toBe('2026-08-30T18:30:00.000Z');
  });

  /** And `fromTime` is the answer once that day's tail is spent: Monday
   *  midday is past Monday 00:00 and short of Monday 22:00. */
  it('opens at the start time once the day’s tail has passed', () => {
    // Monday 2026-08-31, 10:00 IST = 04:30 UTC.
    // Monday 2026-08-31, 22:00 IST = 16:30Z.
    expect(opensAt(nights, '2026-08-31T04:30:00Z')).toBe('2026-08-31T16:30:00.000Z');
  });

  /** A second zone, because the bug was invisible in one: the answer has to be
   *  midnight *there*, not midnight anywhere else. */
  it('opens at midnight in the campaign’s own zone', () => {
    const nyc = { ...nights, timezone: 'America/New_York' };

    // Sunday 2026-08-30, 13:21 EDT = 17:21 UTC.
    // Monday 2026-08-31, 00:00 EDT = 04:00 UTC.
    expect(opensAt(nyc, '2026-08-30T17:21:00Z')).toBe('2026-08-31T04:00:00.000Z');

    // Monday 2026-08-31, 10:00 EDT = 14:00 UTC → Monday 22:00 EDT = 2026-09-01T02:00Z.
    expect(opensAt(nyc, '2026-08-31T14:00:00Z')).toBe('2026-09-01T02:00:00.000Z');
  });

  /**
   * A single-day overnight window is two spans on that one day, not one span
   * that spills into the next: Friday 22:00–02:00 dials Friday 00:00–02:00
   * and Friday 22:00–24:00, and nothing at all on Saturday. That is the
   * behaviour, deliberately — the day of a call is the day the clock is on —
   * and this pins it so the dashboard can word its copy against something.
   */
  it('reads a single-day overnight window as two spans on that day', () => {
    const fridays = { fromTime: '22:00', toTime: '02:00', timezone: IST, dialDays: [5] };

    // Friday 2026-08-28, 23:00 IST = 17:30Z — the evening span.
    expect(evaluateWindow(fridays, at('2026-08-28T17:30:00Z')).state).toBe('open');
    // Friday 2026-08-28, 01:00 IST = 2026-08-27T19:30Z — the same Friday's tail.
    expect(evaluateWindow(fridays, at('2026-08-27T19:30:00Z')).state).toBe('open');
    // Saturday 2026-08-29, 01:00 IST = 2026-08-28T19:30Z — NOT a continuation
    // of Friday evening. The next opening is the following Friday's midnight.
    expect(opensAt(fridays, '2026-08-28T19:30:00Z')).toBe('2026-09-03T18:30:00.000Z');
  });

  /** With no day restriction the tail is still an opening: 03:00 under
   *  22:00–02:00 waits for tonight, but 20:00 does not wait for tomorrow. */
  it('opens tonight rather than tomorrow when every day is allowed', () => {
    const every = { fromTime: '22:00', toTime: '02:00', timezone: IST, dialDays: [] };

    // Sunday 2026-08-30, 20:00 IST = 14:30 UTC → 22:00 IST = 16:30Z.
    expect(opensAt(every, '2026-08-30T14:30:00Z')).toBe('2026-08-30T16:30:00.000Z');
  });
});

/**
 * The gate and the answer it gives, checked against each other over a spread
 * of instants rather than at the handful of moments somebody thought of.
 *
 * Two claims, and the second is the one a hand-written case keeps missing:
 * `opensAt` must BE open, and nothing between now and it may be. A walk that
 * overshoots satisfies the first perfectly.
 */
describe('every closed window agrees with its own opensAt', () => {
  const ZONES = ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Sydney'];

  const WINDOWS: Pick<DialingWindow, 'fromTime' | 'toTime' | 'dialDays'>[] = [
    { fromTime: '22:00', toTime: '02:00', dialDays: [1, 2, 3, 4, 5] },
    { fromTime: '22:00', toTime: '02:00', dialDays: [5] },
    { fromTime: '23:30', toTime: '00:30', dialDays: [] },
    { fromTime: '09:00', toTime: '17:00', dialDays: [1, 3, 5] },
    { fromTime: '09:00', toTime: '17:00', dialDays: [] },
    // Starts inside the hour a northern spring-forward skips. There is no
    // 02:00 that morning in either zone below, so the window's own start time
    // is a wall-clock reading that does not exist — the case `instantOf` has
    // to answer with the instant the clocks jumped to.
    { fromTime: '02:00', toTime: '06:00', dialDays: [] },
    { fromTime: '02:00', toTime: '06:00', dialDays: [1, 2, 3, 4, 5] },
    { fromTime: null, toTime: null, dialDays: [6, 0] },
  ];

  const STEP = 15 * 60_000;

  it('opens when it says it opens, and not before', () => {
    // Spread across a year from a fixed epoch, at an offset that is not a
    // whole hour: an aligned sample would never test a window whose opening
    // falls between two samples.
    const EPOCH = Date.parse('2026-01-04T03:07:00Z');
    const SPAN = 366 * 24 * 60 * 60_000;

    for (const timezone of ZONES) {
      for (const shape of WINDOWS) {
        for (let i = 0; i < 8; i += 1) {
          const now = new Date(EPOCH + Math.round((SPAN * (i * 7 + 3)) / 61));
          const window = { ...shape, timezone };
          const result = evaluateWindow(window, now);

          expect(result.state, `${timezone} ${JSON.stringify(shape)} @ ${now.toISOString()}`)
            .not.toBe('incomplete');

          if (result.state !== 'closed') continue;

          const label = `${timezone} ${JSON.stringify(shape)} from ${now.toISOString()}`;

          expect(evaluateWindow(window, result.opensAt).state, `${label} at opensAt`).toBe('open');
          expect(result.opensAt.getTime(), `${label} is ahead`)
            .toBeGreaterThan(now.getTime());

          for (let t = now.getTime() + STEP; t < result.opensAt.getTime(); t += STEP) {
            expect(
              evaluateWindow(window, new Date(t)).state,
              `${label}: open at ${new Date(t).toISOString()}, before opensAt ${result.opensAt.toISOString()}`,
            ).not.toBe('open');
          }
        }
      }
    }
    // A weekday-only window closed on Friday evening is walked at 15-minute
    // steps to Monday morning: thousands of zoned reads per case. Well inside
    // a second here; the budget is for a CI runner under load.
  }, 30_000);
});

/**
 * A stored day list holding nothing this platform can read.
 *
 * `[7]` is not a weekday, so the set of days it restricts to is empty — and an
 * empty set read as "no restriction" is the one direction this module refuses
 * everywhere else: the operator expressed a restriction, and dialing every day
 * because we cannot tell which is how a campaign rings somebody on a day they
 * said not to. Fails closed and is visible, like every other unreadable
 * window.
 */
describe('a day list this platform cannot read', () => {
  it('is incomplete rather than unrestricted', () => {
    const sunday = at('2026-08-30T04:30:00Z');

    for (const dialDays of [[7], [-1], [7, 9], [1.5]]) {
      const result = evaluateWindow(
        { fromTime: '09:00', toTime: '17:00', timezone: IST, dialDays },
        sunday,
      );

      expect(result.state, JSON.stringify(dialDays)).toBe('incomplete');
      if (result.state === 'incomplete') expect(result.reason).toMatch(/day/i);
    }
  });

  /** With no hours either — the case that would otherwise fall straight
   *  through the "nothing is set" door and dial around the clock. */
  it('is incomplete even when nothing else is set', () => {
    const result = evaluateWindow(
      { fromTime: null, toTime: null, timezone: IST, dialDays: [7] },
      at('2026-08-30T04:30:00Z'),
    );

    expect(result.state).toBe('incomplete');
  });

  /** One unreadable entry beside a readable one is still a restriction this
   *  can honour, and the API refuses the list on the way in anyway. */
  it('keeps the days it can read when only some are unreadable', () => {
    // Sunday: Monday-only, so closed rather than incomplete.
    expect(
      evaluateWindow(
        { fromTime: null, toTime: null, timezone: IST, dialDays: [1, 7] },
        at('2026-08-30T04:30:00Z'),
      ).state,
    ).toBe('closed');
  });
});

/**
 * The hour a spring-forward skips.
 *
 * A window that opens at 02:00 in America/New_York has no 02:00 at all on the
 * morning the clocks go forward: 01:59:59 EST is followed by 03:00:00 EDT. The
 * honest answer is the instant the clocks jumped to — the earliest real time
 * that answers to "02:00" — and the campaign starts dialing then.
 *
 * What it must NOT be is the day after. `nextOpening` verifies every candidate
 * against the gate, so a wall-clock time resolved to an instant *before* the
 * gap reads as closed, the candidate is thrown away, and the whole day is
 * skipped — twenty-four hours of a campaign not dialing, once a year, in every
 * zone that changes its clocks.
 */
describe('the hour a spring-forward skips', () => {
  // 2026-03-08 is the second Sunday in March: 02:00 EST becomes 03:00 EDT.
  const NYC = 'America/New_York';
  const nyc = { fromTime: '02:00', toTime: '06:00', timezone: NYC, dialDays: [] };

  it('opens at the instant the clocks jumped to', () => {
    // 2026-03-08T05:30Z is 00:30 EST — before the window and before the jump.
    const result = evaluateWindow(nyc, at('2026-03-08T05:30:00Z'));

    expect(result.state).toBe('closed');
    if (result.state === 'closed') {
      // 03:00 EDT, the first real instant answering to "02:00".
      expect(result.opensAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
      expect(evaluateWindow(nyc, result.opensAt).state).toBe('open');
    }
  });

  /** Europe/London jumps a different week and by a different offset, so the
   *  arithmetic cannot be right by coincidence: 2026-03-29, 01:00 GMT becomes
   *  02:00 BST. */
  it('does the same in a zone that jumps on another date', () => {
    const london = { fromTime: '01:00', toTime: '05:00', timezone: 'Europe/London', dialDays: [] };
    // 2026-03-29T00:30Z is 00:30 GMT — half an hour before the jump.
    const result = evaluateWindow(london, at('2026-03-29T00:30:00Z'));

    expect(result.state).toBe('closed');
    if (result.state === 'closed') {
      expect(result.opensAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');
      expect(evaluateWindow(london, result.opensAt).state).toBe('open');
    }
  });

  /** And the day is not skipped: the answer is that morning, not the next. */
  it('does not push the opening to the following day', () => {
    const result = evaluateWindow(nyc, at('2026-03-08T05:30:00Z'));

    if (result.state === 'closed') {
      expect(result.opensAt.getTime()).toBeLessThan(Date.parse('2026-03-09T00:00:00Z'));
    }
  });
});

/**
 * The same two claims as the property test above, over the weeks the clocks
 * actually change — the instants a spread across a whole year samples only by
 * luck, and the ones every offset assumption in this file is wrong on.
 */
describe('every closed window agrees with its own opensAt across a DST change', () => {
  const WEEKS: { timezone: string; from: string }[] = [
    // Spring forward: 02:00 → 03:00 local.
    { timezone: 'America/New_York', from: '2026-03-06T00:00:00Z' },
    { timezone: 'Europe/London', from: '2026-03-27T00:00:00Z' },
    // And back again, where an hour happens twice.
    { timezone: 'America/New_York', from: '2026-10-30T00:00:00Z' },
    { timezone: 'Europe/London', from: '2026-10-23T00:00:00Z' },
  ];

  const WINDOWS: Pick<DialingWindow, 'fromTime' | 'toTime' | 'dialDays'>[] = [
    { fromTime: '02:00', toTime: '06:00', dialDays: [] },
    { fromTime: '01:00', toTime: '05:00', dialDays: [1, 2, 3, 4, 5] },
    { fromTime: '22:00', toTime: '02:00', dialDays: [] },
    { fromTime: '09:00', toTime: '17:00', dialDays: [0, 6] },
  ];

  const STEP = 15 * 60_000;

  /**
   * The "nothing open before it" walk is bounded at 36 hours rather than run to
   * `opensAt`, which for a weekend-only window is five days of 15-minute steps
   * per sample. The overshoot this test exists to catch is an hour long and
   * sits at the transition, so the first day and a half is where it would be
   * — and the unbounded version of the same claim is asserted over a whole
   * year by the property test above.
   */
  const LOOK_AHEAD = 36 * 60 * 60_000;

  it('opens when it says it opens, and not before', () => {
    for (const { timezone, from } of WEEKS) {
      const start = Date.parse(from);

      for (const shape of WINDOWS) {
        const window = { ...shape, timezone };

        // Every 53 minutes for three days, so the samples walk across the
        // transition instant rather than stepping over it on the hour.
        for (let now = start; now < start + 3 * 24 * 60 * 60_000; now += 53 * 60_000) {
          const result = evaluateWindow(window, new Date(now));
          const label = `${timezone} ${JSON.stringify(shape)} from ${new Date(now).toISOString()}`;

          expect(result.state, label).not.toBe('incomplete');
          if (result.state !== 'closed') continue;

          expect(evaluateWindow(window, result.opensAt).state, `${label} at opensAt`).toBe('open');
          expect(result.opensAt.getTime(), `${label} is ahead`).toBeGreaterThan(now);

          const until = Math.min(result.opensAt.getTime(), now + LOOK_AHEAD);

          for (let t = now + STEP; t < until; t += STEP) {
            expect(
              evaluateWindow(window, new Date(t)).state,
              `${label}: open at ${new Date(t).toISOString()}, before opensAt ${result.opensAt.toISOString()}`,
            ).not.toBe('open');
          }
        }
      }
    }
  }, 60_000);
});

/**
 * A window whose start and end are the same time.
 *
 * Read as `start <= now < end` it is the empty set, so the campaign never
 * dials — while every screen shows a window that looks configured. Worse, the
 * walk that answers "when does it next open" has no answer to give: every
 * candidate it proposes is refused by the gate, and it would otherwise hand
 * back an unverified instant that the dispatcher then declines to dial at,
 * for ever.
 *
 * "That is not a window" is the honest answer, and it is the one every other
 * unreadable window here already gets.
 */
describe('a window that starts and ends at the same time', () => {
  it('is incomplete rather than silently empty', () => {
    const result = evaluateWindow(
      { fromTime: '09:00', toTime: '09:00', timezone: IST, dialDays: [] },
      at('2026-08-30T04:30:00Z'),
    );

    expect(result.state).toBe('incomplete');
    if (result.state === 'incomplete') expect(result.reason).toMatch(/start|end|same/i);
  });

  it('is incomplete at every hour, including its own', () => {
    for (const iso of ['2026-08-30T03:30:00Z', '2026-08-30T04:30:00Z', '2026-08-30T20:00:00Z']) {
      expect(
        evaluateWindow(
          { fromTime: '09:00', toTime: '09:00', timezone: IST, dialDays: [1, 2, 3] },
          at(iso),
        ).state,
      ).toBe('incomplete');
    }
  });
});

/**
 * The instant the per-contact daily dial count starts from. It is the campaign
 * TIMYENE's midnight and not UTC's, because "two calls a day" is a promise
 * about the callee's day: counted in UTC, a campaign dialing India would roll
 * its cap over at 05:30 local, in the middle of a working morning.
 */
describe('localDayStart', () => {
  it('is local midnight in the campaign zone', () => {
    // 2026-09-09T20:30Z is already 2026-09-10 02:00 IST, so the day it belongs
    // to began at 18:30Z the evening before.
    expect(localDayStart(new Date('2026-09-09T20:30:00Z'), 'Asia/Kolkata')).toEqual(
      new Date('2026-09-09T18:30:00Z'),
    );
  });

  it('handles a zone west of UTC', () => {
    // 2026-09-10T02:00Z is still 2026-09-09 22:00 in New York (EDT, -4), so
    // the day started at 04:00Z that morning — a boundary a UTC reading puts
    // two hours in the past instead of twenty-two.
    expect(localDayStart(new Date('2026-09-10T02:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-09-09T04:00:00Z'),
    );
  });

  it('falls back to UTC midnight with no zone', () => {
    // A campaign with no zone has no dialing hours either, so there is no
    // local day to prefer and nothing to guess at.
    expect(localDayStart(new Date('2026-09-09T20:30:00Z'), null)).toEqual(
      new Date('2026-09-09T00:00:00Z'),
    );
  });

  it('falls back to UTC midnight on a zone nothing can read', () => {
    expect(localDayStart(new Date('2026-09-09T20:30:00Z'), 'Mars/Olympus')).toEqual(
      new Date('2026-09-09T00:00:00Z'),
    );
  });
});
