import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallNote } from '../src/lib/goalRecord.js';
import type { DialingWindow } from '../src/lib/dialingWindow.js';
import { planRearm } from '../src/lib/reextraction/plan.js';
import type { RearmBudget } from '../src/lib/reextraction/plan.js';
import { env } from '../src/lib/env.js';

// The resume lane is off by default (`IMMEDIATE_RESUME_ENABLED`), because the
// model over-reports drops. Every test in this file that expects a RESUME is
// exercising the lane as designed, so it is switched on here; the block at
// the bottom pins what the default does instead.
env.immediateResumeEnabled = true;

const IST = 'Asia/Kolkata';

/** A weekday campaign, 10:00–18:00 IST. */
const WEEKDAYS: DialingWindow = {
  fromTime: '10:00',
  toTime: '18:00',
  timezone: IST,
  dialDays: [1, 2, 3, 4, 5],
};

/** A campaign with no restriction at all: every rolled instant is `now`. */
const ALWAYS: DialingWindow = { fromTime: null, toTime: null, timezone: IST, dialDays: null };

/** Friday 2026-09-04, 11:30 IST — inside the weekday window. */
const FRIDAY = new Date('2026-09-04T06:00:00Z');
/** Saturday 2026-09-05, 11:30 IST — a day the weekday campaign never dials. */
const SATURDAY = new Date('2026-09-05T06:00:00Z');
/** The next opening after that Saturday: Monday 2026-09-07 at 10:00 IST. */
const MONDAY_OPEN = new Date('2026-09-07T04:30:00.000Z');

function note(fields: Partial<CallNote>): CallNote {
  return {
    outcome: null,
    reason: null,
    callbackType: null,
    callbackRequestedTime: null,
    note: null,
    callTimestamp: null,
    ...fields,
  };
}

/** A contact well inside both budgets: follow-ups left, no dial ceiling near. */
const ROOMY: RearmBudget = {
  retryCount: 2,
  maxGoalFollowUps: 3,
  maxTotalDials: 8,
  attempts: 0,
  followUpCount: 0,
  latestPlacedAttemptNo: 2,
};

function plan(
  fields: Partial<CallNote>,
  now = FRIDAY,
  window = WEEKDAYS,
  budget: RearmBudget = ROOMY,
) {
  return planRearm(note(fields), { now, window, timezone: IST, budget });
}

/**
 * The two budgets the dispatcher's claim enforces, asked here instead.
 *
 * A contact re-armed past either of them is armed for a dial that will never
 * be placed: `claimContacts` refuses a FOLLOW_UP row past `maxGoalFollowUps`
 * and any row with a placed attempt at or past `maxTotalDials`, so the row
 * sits PENDING with a `nextEligibleAt` in the past for ever — and it is not
 * settled either, so `completeIfDone` never finishes the campaign. Refusing to
 * arm it is the only honest answer this run can give, and it is one an
 * operator can read in the report.
 *
 * **It is the FOLLOW-UP budget and not the retry one**, since 2026-09-09.
 * `selectConversations` skips a contact nobody ever reached, so every re-arm
 * this planner writes is for a contact somebody ANSWERED — which is exactly
 * the contact whose retries were forfeited and whose only remaining budget is
 * `maxGoalFollowUps`. Asking the retry budget here would refuse a contact the
 * claim would happily take, and take one it would refuse.
 */
describe('a contact the dispatcher would never dial', () => {
  it('refuses a follow-up for a contact that has spent its follow-ups', () => {
    expect(
      plan({ outcome: 'incomplete', callbackType: 'flexible' }, FRIDAY, ALWAYS, {
        ...ROOMY,
        maxGoalFollowUps: 2,
        followUpCount: 2,
      }),
    ).toEqual({ kind: 'over_budget', reason: 'follow_up_budget' });
  });

  it('refuses a resume for the same reason', () => {
    expect(
      plan({ outcome: 'incomplete', callbackType: 'immediate' }, FRIDAY, ALWAYS, {
        ...ROOMY,
        maxGoalFollowUps: 1,
        followUpCount: 1,
      }),
    ).toEqual({ kind: 'over_budget', reason: 'follow_up_budget' });
  });

  it('arms a follow-up with one left in the budget', () => {
    expect(
      plan({ outcome: 'incomplete', callbackType: 'flexible' }, FRIDAY, ALWAYS, {
        ...ROOMY,
        maxGoalFollowUps: 2,
        followUpCount: 1,
      }),
    ).toMatchObject({ kind: 'follow_up' });
  });

  /**
   * The RETRY budget refuses nothing here any more. A reached contact's
   * `attempts` is frozen at whatever it had reached when somebody answered —
   * those retries were forfeited, not overspent — and the claim exempts a
   * FOLLOW_UP row from the retry clause for exactly that reason.
   */
  it('no longer refuses a follow-up for a contact that has spent its retries', () => {
    expect(
      plan({ outcome: 'incomplete', callbackType: 'flexible' }, FRIDAY, ALWAYS, {
        ...ROOMY,
        retryCount: 1,
        attempts: 9,
      }),
    ).toMatchObject({ kind: 'follow_up' });
  });

  /** A promise spends neither budget — `ARMED_FOR_CALLBACK` is the claim's own
   *  exemption, and a lowered budget must not cancel a call somebody was told
   *  to expect. */
  it('books a promise even for a contact that has spent its follow-ups', () => {
    expect(
      plan(
        {
          outcome: 'incomplete',
          callbackType: 'requested',
          callbackRequestedTime: '2026-09-08T10:00+05:30',
        },
        FRIDAY,
        ALWAYS,
        { ...ROOMY, maxGoalFollowUps: 1, followUpCount: 4, retryCount: 1, attempts: 9 },
      ),
    ).toMatchObject({ kind: 'callback' });
  });

  /**
   * The DAILY CAP is deliberately not a refusal, and `RearmBudget` carries no
   * field for it. A contact at its cap has run out of nothing — the claim
   * simply holds it until the next local midnight and then dials it — so
   * refusing to arm it here would settle nothing and lose the re-judged
   * verdict over a clock that resets in hours.
   */
  it('has no field for the daily cap, which is not a refusal', () => {
    expect(Object.keys(ROOMY).sort()).toEqual([
      'attempts',
      'followUpCount',
      'latestPlacedAttemptNo',
      'maxGoalFollowUps',
      'maxTotalDials',
      'retryCount',
    ]);
  });

  /** The dial ceiling has no exemption: the claim's `NOT EXISTS` runs before
   *  the retry clause and a promise does not escape it either. */
  it.each([
    ['flexible', undefined],
    ['immediate', undefined],
    ['requested', '2026-09-08T10:00+05:30'],
  ] as const)('refuses a %s arm at the dial ceiling', (callbackType, time) => {
    expect(
      plan(
        { outcome: 'incomplete', callbackType, callbackRequestedTime: time ?? null },
        FRIDAY,
        ALWAYS,
        { ...ROOMY, maxTotalDials: 4, latestPlacedAttemptNo: 4 },
      ),
    ).toEqual({ kind: 'over_budget', reason: 'dial_budget' });
  });

  /** The ceiling is `retryCount + maxGoalFollowUps + 1`, exactly as the dialer passes it — every
   *  campaign has one, and a contact below it is armed like any other. */
  it('arms a contact below the ceiling', () => {
    expect(
      plan({ outcome: 'incomplete', callbackType: 'flexible' }, FRIDAY, ALWAYS, {
        ...ROOMY,
        maxTotalDials: 100,
        latestPlacedAttemptNo: 99,
      }),
    ).toMatchObject({ kind: 'follow_up' });
  });

  /** Settling is never over budget: a contact that stops or completes is
   *  waiting for no dial at all. */
  it.each([
    ['stop', 'stop'],
    ['completed', 'completed'],
  ] as const)('still settles a %s', (outcome, kind) => {
    expect(
      plan({ outcome }, FRIDAY, ALWAYS, {
        ...ROOMY,
        attempts: 9,
        maxTotalDials: 1,
        latestPlacedAttemptNo: 9,
      }),
    ).toMatchObject({ kind });
  });
});

/**
 * A reply the model gave with no outcome in it is not a verdict, and the
 * contact keeps whatever it has. This is the one branch that leaves a row
 * alone in `--apply` mode, so it is judged on the outcome and on nothing
 * else — a callback type beside a missing outcome is an answer to a question
 * that was never settled.
 */
describe('no outcome', () => {
  it('leaves the contact alone', () => {
    expect(plan({})).toEqual({ kind: 'no_verdict' });
  });

  it('is still no verdict when the model answered the other keys', () => {
    expect(
      plan({ callbackType: 'requested', callbackRequestedTime: '2026-09-08T10:00+05:30' }),
    ).toEqual({ kind: 'no_verdict' });
  });
});

describe('a settled outcome', () => {
  /** The reason travels with the plan because it becomes the do-not-call
   *  row's reason, and a DNC row nobody can explain is one nobody will lift. */
  it('carries the reason onto a stop', () => {
    expect(plan({ outcome: 'stop', reason: 'wrong number' })).toEqual({
      kind: 'stop',
      reason: 'wrong number',
    });
  });

  it('accepts a stop the model gave no reason for', () => {
    expect(plan({ outcome: 'stop' })).toEqual({ kind: 'stop', reason: null });
  });

  it('settles a completed call with no time on it', () => {
    expect(plan({ outcome: 'completed', callbackRequestedTime: '2026-09-08T10:00+05:30' })).toEqual({
      kind: 'completed',
    });
  });
});

describe('an incomplete call that asked for a time', () => {
  it('books a parseable future time, rolled into the window', () => {
    expect(
      plan({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-09-08T10:00+05:30',
      }),
    ).toEqual({ kind: 'callback', at: new Date('2026-09-08T04:30:00.000Z') });
  });

  /** Forward-only: a promise for 22:00 on a campaign that stops at 18:00 is
   *  kept the next morning, never the same morning. */
  it('rolls a promise outside the hours forward to the next opening', () => {
    expect(
      plan({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-09-08T22:00+05:30',
      }),
    ).toEqual({ kind: 'callback', at: new Date('2026-09-09T04:30:00.000Z') });
  });

  /**
   * The case this whole run exists inside: every one of these conversations
   * happened weeks ago, so most requested times are in the past. A past
   * promise cannot be kept, and arming for the next sweep is the only honest
   * reading — the contact is called again, at the front of the queue, rather
   * than booked into a moment that has been and gone.
   */
  it('arms a past promise for the next sweep instead of booking it', () => {
    expect(
      plan({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-08-20T10:00+05:30',
      }),
    ).toEqual({ kind: 'follow_up', at: FRIDAY });
  });

  /** The same unkept promise beside `immediate_callback_needed = yes` falls
   *  back to the flag: the time outranked it only while it looked bookable. */
  it('resumes a past promise the note also flagged as immediate', () => {
    expect(
      plan({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-08-20T10:00+05:30',
        immediateCallbackNeeded: true,
      }),
    ).toEqual({ kind: 'resume', at: FRIDAY });
  });

  it('does the same with a time it cannot read, or one the model invented', () => {
    const unreadable = plan({
      outcome: 'incomplete',
      callbackType: 'requested',
      callbackRequestedTime: 'next tuesday afternoon',
    });
    const fabricated = plan({
      outcome: 'incomplete',
      callbackType: 'requested',
      callbackRequestedTime: '2027-09-08T10:00+05:30',
    });

    expect(unreadable).toEqual({ kind: 'follow_up', at: FRIDAY });
    expect(fabricated).toEqual({ kind: 'follow_up', at: FRIDAY });
  });

  it('does the same when it asked for a callback and named no time at all', () => {
    expect(plan({ outcome: 'incomplete', callbackType: 'requested' })).toEqual({
      kind: 'follow_up',
      at: FRIDAY,
    });
  });
});

describe('an incomplete call that asked for no time', () => {
  /**
   * A dropped conversation. Live, this is the most time-sensitive dial the
   * engine places; here the campaign has been paused for weeks, so "as soon
   * as possible" means the next sweep. It stays its own arm kind because the
   * resume lane is drawn and budgeted differently from a follow-up.
   */
  it('resumes an immediate at the next sweep', () => {
    expect(plan({ outcome: 'incomplete', callbackType: 'immediate' })).toEqual({
      kind: 'resume',
      at: FRIDAY,
    });
  });

  it('follows up a flexible', () => {
    expect(plan({ outcome: 'incomplete', callbackType: 'flexible' })).toEqual({
      kind: 'follow_up',
      at: FRIDAY,
    });
  });

  /** No callback type beside a real outcome is a follow-up, never a guess —
   *  the same reading the live resolution gives it. */
  it('follows up an incomplete with no callback type', () => {
    expect(plan({ outcome: 'incomplete' })).toEqual({ kind: 'follow_up', at: FRIDAY });
  });
});

describe('the dial window', () => {
  /**
   * A run on a Saturday against a weekday campaign must not arm a thousand
   * contacts for an instant the dispatcher will refuse. Every "next sweep"
   * arm goes through the same walk the dispatcher's own gate takes.
   */
  it('rolls a Saturday re-arm to Monday morning', () => {
    expect(plan({ outcome: 'incomplete', callbackType: 'flexible' }, SATURDAY)).toEqual({
      kind: 'follow_up',
      at: MONDAY_OPEN,
    });
    expect(plan({ outcome: 'incomplete', callbackType: 'immediate' }, SATURDAY)).toEqual({
      kind: 'resume',
      at: MONDAY_OPEN,
    });
  });

  it('leaves the instant alone for a campaign that restricts nothing', () => {
    expect(plan({ outcome: 'incomplete', callbackType: 'flexible' }, SATURDAY, ALWAYS)).toEqual({
      kind: 'follow_up',
      at: SATURDAY,
    });
  });

  /** A settled contact is armed for nothing, so no window arithmetic runs on
   *  it — a Saturday stop is a stop. */
  it('has nothing to say about a settled contact', () => {
    expect(plan({ outcome: 'stop', reason: 'not interested' }, SATURDAY)).toEqual({
      kind: 'stop',
      reason: 'not interested',
    });
    expect(plan({ outcome: 'completed' }, SATURDAY)).toEqual({ kind: 'completed' });
  });
});

/**
 * The zone is the campaign's, and it is what a naive time in the transcript
 * is read in. The same wall-clock promise in two zones is two instants, and
 * booking the wrong one calls somebody at an hour they did not agree to.
 */
describe('the campaign zone', () => {
  it('reads a promise with no offset as wall-clock time in the campaign zone', () => {
    const ist = planRearm(
      note({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-09-08T14:00',
      }),
      { now: FRIDAY, window: ALWAYS, timezone: IST, budget: ROOMY },
    );
    const utc = planRearm(
      note({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-09-08T14:00',
      }),
      { now: FRIDAY, window: ALWAYS, timezone: 'UTC', budget: ROOMY },
    );

    expect(ist).toEqual({ kind: 'callback', at: new Date('2026-09-08T08:30:00.000Z') });
    expect(utc).toEqual({ kind: 'callback', at: new Date('2026-09-08T14:00:00.000Z') });
  });
});

describe('with IMMEDIATE_RESUME_ENABLED off, the default', () => {
  beforeEach(() => {
    env.immediateResumeEnabled = false;
  });
  afterEach(() => {
    env.immediateResumeEnabled = true;
  });

  it('follows up an immediate instead of resuming it', () => {
    expect(plan({ outcome: 'incomplete', callbackType: 'immediate' })).toEqual({
      kind: 'follow_up',
      at: FRIDAY,
    });
  });

  it('follows up a past promise the note also flagged as immediate', () => {
    expect(
      plan({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-08-20T10:00+05:30',
        immediateCallbackNeeded: true,
      }),
    ).toEqual({ kind: 'follow_up', at: FRIDAY });
  });
});
