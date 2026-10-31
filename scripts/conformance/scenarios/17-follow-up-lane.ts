import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';

/**
 * The two lanes and the daily cap (F1, F2).
 *
 * Which lane a contact is in is decided by HISTORY: whether anybody has ever
 * answered. The scenario is built so that the two lanes' clocks and budgets
 * can never be confused for each other — every campaign here sets a retry
 * ladder and a follow-up wait that are different numbers, so an engine reading
 * one where it should read the other lands somewhere no band accepts.
 *
 * - **`silent`** — nobody answers. The retry ladder times it, `retryCount`
 *   bounds it, and it settles FAILED. Unchanged by this wave, and here to
 *   prove the retry lane still exists at all.
 * - **`reached`** — the first call is a conversation the bot says is not
 *   finished. The follow-up lane takes it from there: `followUpDelayHours`
 *   times the next call, `maxGoalFollowUps` bounds it, and the retries the
 *   campaign still has are UNSPENDABLE. That forfeit is the row worth reading
 *   twice: `retryCount: 5` on a contact that gets exactly two more calls.
 * - **`missed`** — the same, and then the follow-up itself goes unanswered.
 *   That spends a FOLLOW-UP, not a retry: `followUpCount` moves, `attempts`
 *   does not, and the wait is the follow-up wait again rather than the ladder.
 *   This is the row the old engine got wrong — it put such a contact back on
 *   the minutes ladder alongside a number that had never picked up.
 * - **`settles`** — `maxGoalFollowUps: 0`. An unfinished conversation settles
 *   at once, COMPLETED and not achieved. There is no on/off switch; zero IS
 *   the off position.
 * - **`capped`** — `maxDialsPerDay: 1` on a one-minute retry ladder. The
 *   second dial is due within a minute and is refused all day, then placed
 *   after the next campaign-local midnight. The cap SETTLES NOTHING: the
 *   contact stays PENDING throughout, which is what tells a cap apart from a
 *   budget.
 *
 * The daily cap is counted in the campaign's own zone, so `capped` names one.
 * A cap read in UTC would turn over 5½ hours early and place the second dial
 * on the same local day.
 */
const P = {
  silent: '+919877720011',
  reached: '+919877720012',
  missed: '+919877720013',
  settles: '+919877720014',
  capped: '+919877720015',
};

const HOUR = 60 * MINUTE;

const conversation = (note: Record<string, unknown>) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: 20,
  delays_secs: { ringing: 1, hold: 2, talk: 20, post_call: 3 },
  extraction: note,
});

/** `incomplete` with no time asked for: call again at the campaign's own wait. */
const callAgain = (note: string, reason: string) =>
  conversation({
    call_outcome_vocobaseplatform: 'incomplete',
    call_outcome_reason_vocobaseplatform: reason,
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

const noAnswer = { status: 'no_answer', delays_secs: { ringing: 20, hold: 0 } };

export const followUpLane: Scenario = {
  name: 'follow-up-lane',
  rows: ['F1', 'F2'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `lane${d.seed}` });

    // Two dials on a one-minute ladder, and no follow-ups to fall back on.
    const silent = await d.seedCampaign(ws, {
      name: 'silent',
      retryCount: 1,
      retryDelaysMinutes: [1],
      maxGoalFollowUps: 0,
      contacts: [P.silent],
    });

    // The forfeit, twice over: five retries the contact can never spend, and
    // a ladder of one minute it can never wait. Its clock is the six-hour
    // follow-up wait and its budget is two.
    const reached = await d.seedCampaign(ws, {
      name: 'reached',
      retryCount: 5,
      retryDelaysMinutes: [1, 1, 1, 1, 1],
      cooldownMinutes: 1,
      maxGoalFollowUps: 2,
      followUpDelayHours: 6,
      contacts: [P.reached],
    });

    const missed = await d.seedCampaign(ws, {
      name: 'missed',
      retryCount: 5,
      retryDelaysMinutes: [1, 1, 1, 1, 1],
      cooldownMinutes: 1,
      maxGoalFollowUps: 2,
      followUpDelayHours: 6,
      contacts: [P.missed],
    });

    // Zero follow-ups: an unfinished conversation is finished with.
    const settles = await d.seedCampaign(ws, {
      name: 'settles',
      retryCount: 5,
      retryDelaysMinutes: [1, 1, 1, 1, 1],
      maxGoalFollowUps: 0,
      contacts: [P.settles],
    });

    // One dial a day, in IST. The ladder would place the second within a
    // minute; the cap is the only thing that can hold it.
    const capped = await d.seedCampaign(ws, {
      name: 'capped',
      retryCount: 3,
      retryDelaysMinutes: [1, 1, 1],
      maxGoalFollowUps: 0,
      maxDialsPerDay: 1,
      window: { fromTime: null, toTime: null, timezone: 'Asia/Kolkata' },
      contacts: [P.capped],
    });

    await d.script({
      numbers: [
        { to_number: P.silent, rules: [noAnswer, noAnswer] },
        {
          to_number: P.reached,
          rules: [
            callAgain('Ask Neha about the timeline.', 'she had to run'),
            callAgain('Ask Neha about the timeline.', 'still busy'),
            callAgain('Ask Neha about the timeline.', 'still busy'),
          ],
        },
        // A conversation, then silence: the missed follow-up.
        {
          to_number: P.missed,
          rules: [callAgain('Ask Vikram about the budget.', 'he was driving'), noAnswer, noAnswer],
        },
        { to_number: P.settles, rules: [callAgain('Ask about the area.', 'bad line')] },
        { to_number: P.capped, rules: [noAnswer, noAnswer, noAnswer] },
      ],
    });

    for (const c of [silent, reached, missed, settles, capped]) await d.start(ws, c.campaignId);

    // The first wave, plus the one-minute ladders.
    for (let i = 0; i < 6; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    const contact = async (campaign: { contactByPhone: Map<string, string> }, phone: string) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({
        where: { id: campaign.contactByPhone.get(phone)! },
      });
    const dialsTo = (phone: string) => d.trace.filter((e) => e.kind === 'dial' && e.phone === phone);

    /** F1 (a) — the retry lane, untouched by any of this. */
    {
      const c = await contact(silent, P.silent);
      d.check('F1', c.status === 'FAILED' && c.attempts === 1 && c.followUpCount === 0,
        `silent contact ended ${c.status} attempts=${c.attempts} followUpCount=${c.followUpCount}, expected FAILED/1/0`);
      d.check('F1', dialsTo(P.silent).length === 2,
        `silent contact dialed ${dialsTo(P.silent).length} times, retry budget is 2`);
    }

    /**
     * F1 (b) — a conversation goes to the follow-up lane, and the one-minute
     * ladder beside it buys nothing. Six hours out, not one minute, and armed
     * FOLLOW_UP rather than RETRY.
     */
    {
      const c = await contact(reached, P.reached);
      const next = c.nextEligibleAt?.getTime() ?? 0;
      d.check('F1', c.status === 'PENDING' && c.armKind === 'FOLLOW_UP',
        `reached contact is ${c.status}/${c.armKind}, expected PENDING/FOLLOW_UP`);
      d.check('F1', c.followUpCount === 1 && c.attempts === 0,
        `reached contact followUpCount=${c.followUpCount} attempts=${c.attempts}, expected 1/0 — a follow-up spends no retry`);
      d.check('F1', next >= T0 + 6 * HOUR - MINUTE && next <= T0 + 6 * HOUR + 15 * MINUTE,
        `reached contact armed at ${c.nextEligibleAt?.toISOString()}, expected ≈ T0+6h (followUpDelayHours, not the 1-minute ladder)`);
      d.check('F1', dialsTo(P.reached).length === 1,
        `reached contact dialed ${dialsTo(P.reached).length} times inside the follow-up wait, expected 1`);
    }

    /**
     * F1 (c) — the missed follow-up. Its second dial went unanswered, and that
     * spent a FOLLOW-UP rather than putting the contact back on the ladder.
     */
    {
      const c = await contact(missed, P.missed);
      const next = c.nextEligibleAt?.getTime() ?? 0;
      d.check('F1', c.armKind === 'FOLLOW_UP' && c.attempts === 0,
        `missed contact is armed ${c.armKind} attempts=${c.attempts}, expected FOLLOW_UP/0 — a missed follow-up is not a retry`);
      d.check('F1', c.followUpCount === 1,
        `missed contact followUpCount=${c.followUpCount}, expected 1`);
      d.check('F1', next >= T0 + 6 * HOUR - MINUTE && next <= T0 + 6 * HOUR + 15 * MINUTE,
        `missed contact armed at ${c.nextEligibleAt?.toISOString()}, expected ≈ T0+6h`);
    }

    /** F1 (d) — zero follow-ups settles at once, and not as a failure. */
    {
      const c = await contact(settles, P.settles);
      d.check('F1', c.status === 'COMPLETED' && c.goalAchieved === false,
        `settles contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/false`);
      d.check('F1', c.followUpCount === 0 && dialsTo(P.settles).length === 1,
        `settles contact followUpCount=${c.followUpCount} dials=${dialsTo(P.settles).length}, expected 0/1`);
    }

    /**
     * F2 — the daily cap holds the second dial, and settles nothing. The
     * ladder made it due four minutes ago; only the cap can be what is holding
     * it, and the contact is still PENDING rather than SKIPPED.
     */
    {
      const c = await contact(capped, P.capped);
      d.check('F2', dialsTo(P.capped).length === 1,
        `capped contact dialed ${dialsTo(P.capped).length} times today, cap is 1`);
      d.check('F2', c.status === 'PENDING',
        `capped contact is ${c.status}; the daily cap must settle nothing`);
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({
        where: { id: capped.campaignId },
      });
      d.check('F2', row.skippedCount === 0 && row.status === 'RUNNING',
        `capped campaign ${row.status} skipped=${row.skippedCount}, expected RUNNING/0`);
    }

    // Still capped hours later, on the same local day.
    d.advanceBy(6 * HOUR - (d.nowMs - T0));
    await d.tick();
    d.check('F2', dialsTo(P.capped).length === 1,
      'the daily cap let a second dial through on the same local day');

    /**
     * Past the next IST midnight. T0 is the harness's own instant, so the walk
     * is bounded rather than computed: ticking hourly for a day and a half is
     * certain to cross one local midnight whenever T0 falls, and the assertion
     * is that the contact is dialled again once it has.
     */
    for (let i = 0; i < 36; i++) {
      d.advanceBy(HOUR);
      await d.tick();
    }

    d.check('F2', dialsTo(P.capped).length >= 2,
      `capped contact was never dialled again after the local day turned (${dialsTo(P.capped).length} dials)`);

    /** And the follow-up lane's second call landed once its six hours passed. */
    {
      const c = await contact(reached, P.reached);
      d.check('F1', dialsTo(P.reached).length >= 2,
        `reached contact was never followed up (${dialsTo(P.reached).length} dials)`);
      d.check('F1', c.followUpCount <= 2,
        `reached contact took ${c.followUpCount} follow-ups, budget is 2`);
    }
  },
};
