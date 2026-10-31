import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';
import {
  YE_CONTEXT_VARIABLE_NAMES,
  isReservedVariableName,
} from '../../../src/lib/contextVariables.js';
import { FOLLOW_UP_NOTE, GOAL_VARIABLE_NAMES } from '../../../src/lib/goalVariables.js';

/**
 * Goal-driven follow-ups (G1, G2, G3): a conversation the bot says is not
 * finished re-arms the contact instead of settling it, the note the bot writes
 * for the next call is carried onto the next dial (and only the next dial's
 * note is ever carried — the record holds the LAST one), and the FOLLOW-UP
 * budget — `maxGoalFollowUps`, spent by every dial after the first
 * conversation — ends the journey as a COMPLETED conversation, never as a
 * failure.
 *
 * What is scripted here is the **call note**, not a set of collected fields:
 * the bot says whether the call was `completed`, should `stop`, or is
 * `incomplete`, and what kind of callback (if any) that needs, and YE
 * enforces the caps on top of that. So a call worth repeating is one whose
 * `call_outcome_vocobaseplatform` says `incomplete` with a `flexible`
 * callback, and a finished one says `completed` — no counting of keys
 * anywhere, which is the whole point of the change these rows grade.
 *
 * The follow-up waits `followUpDelayHours` — its own clock, NOT the retry
 * ladder, which times a number nobody answered — so these campaigns set a
 * 24-hour follow-up wait beside a deliberately different `cooldownMinutes`,
 * and the virtual clock is what makes that testable: interim ticks inside the
 * wait prove the engine HOLDS the contact, one advance past it proves the
 * re-arm was real, and an engine still reading the ladder lands 17 minutes
 * out instead of a day. A wait of a day is what the scenario needs, not what
 * an operator would set.
 */
const P = {
  converge: '+919877710011', // three conversations, a note on each, then completed
  budget: '+919877710012', // maxGoalFollowUps 1 (two dials): incomplete, incomplete, settled
  cap: '+919877710013', // retryCount 2, no follow-ups: busy, busy, a conversation that settles
  silent: '+919877710014', // retryCount 1 (two dials): busy, busy — silences hit the cap
};

const HOUR = 60 * MINUTE;

/**
 * The three notes the converge contact's calls leave, in order. Named so the
 * dial-variable assertions below can say "dial three carried the SECOND
 * call's note" in those words.
 */
const NOTES = {
  first: 'Priya had to run. Open with: "Hi Priya, you mentioned a flat earlier — is now a good time?" Then ask the size and budget.',
  second: 'Priya wants a 2BHK, checking the budget with her husband. Open with: "Hi Priya, did you get a chance to talk it over?" Then ask the budget.',
  third: 'Priya: 2BHK, budget 50L. Nothing left to ask.',
};

/** The one variable YE adds to a dial, and only once a note exists. */
const NOTE_VARIABLE = GOAL_VARIABLE_NAMES[0];

/**
 * What that variable must hold: a JSON object YE assembles, carrying its own
 * standing continuation order and the memory the previous call wrote.
 *
 * Asserted by content rather than by an exact string, because the exact
 * string is `goalVariables`' own output and comparing a harness's copy of it
 * to itself grades nothing. What matters on the wire is that the previous
 * call's memory reached this dial and that the order telling the model it has
 * spoken to this person before came with it.
 */
const carriesNote = (value: string | undefined, note: string): boolean =>
  typeof value === 'string' && value.includes('THIS IS A FOLLOW-UP CALL') && (() => {
    try {
      const parsed = JSON.parse(value) as { note?: unknown; instructions?: unknown };
      return parsed.note === FOLLOW_UP_NOTE && parsed.instructions === note;
    } catch {
      return false;
    }
  })();

/**
 * All seven variables the previous contract rendered on every goal dial. None
 * of them may appear any more: a dial still carrying one is an engine that
 * kept the old overlay alongside the new one.
 *
 * `follow_up_instruction` is listed first because it is the one worth naming.
 * It was the previous contract's whole answer to "tell the model this is a
 * continuation" — the answer the note's own frame replaced — so an engine
 * still rendering it would be sending two standing orders that do not agree,
 * and the list was written without it.
 */
const CONTEXT_NAMES = new Set<string>(YE_CONTEXT_VARIABLE_NAMES);

/**
 * The campaign context, asserted on the variables the mock really received.
 *
 * Nothing in `test/` observes this: the unit tests assert what the dialer
 * assembles, and this asserts what arrived. A dial that reaches the platform
 * without `ezo_campaign_id` is a post-call sheet row that cannot say which
 * campaign wrote it.
 *
 * The prefix half is the other reason this lives here. `ezo_` is reserved
 * across the agent's declared list and the campaign's column map, and the
 * only way to catch a projection that smuggled one through anyway is to look
 * at a real dial and refuse any `ezo_` key that is not one of the four.
 */
const contextProblem = (v: Record<string, string>): string | null => {
  for (const name of YE_CONTEXT_VARIABLE_NAMES) {
    if (typeof v[name] !== 'string' || v[name]!.length === 0) return `missing ${name}`;
  }
  const stray = Object.keys(v).filter((k) => isReservedVariableName(k) && !CONTEXT_NAMES.has(k));
  return stray.length > 0 ? `reserved-prefix variable YE does not supply: ${stray.join(', ')}` : null;
};

const RETIRED_VARIABLES = [
  'follow_up_instruction',
  'campaign_goal',
  'call_number',
  'previous_attempts',
  'memory',
  'last_call_note',
  'goal_missing',
] as const;

/**
 * One conversation, and the call note the bot came back with.
 *
 * `post_call` is pinned rather than drawn so the terminal status event and the
 * `session.completed` that carries the note land at known virtual instants.
 * They are still two events three seconds apart — the platform's own ordering,
 * which G6 grades directly; here it only has to be deterministic.
 */
const conversation = (note: Record<string, unknown>) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: 20,
  delays_secs: { ringing: 1, hold: 2, talk: 20, post_call: 3 },
  extraction: note,
});

/**
 * `incomplete` with a `flexible` callback: the conversation barely started,
 * nobody asked for a specific time, call again at the campaign's own delay.
 * The `"null"` time is what the platform's description asks the model to
 * write when there is no requested time — sent as the literal string, so the
 * engine's reading of it as "no time" is under test on every one of these.
 */
const callAgain = (note: string, reason: string) =>
  conversation({
    call_outcome_vocobaseplatform: 'incomplete',
    call_outcome_reason_vocobaseplatform: reason,
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

const done = (note: string) =>
  conversation({
    call_outcome_vocobaseplatform: 'completed',
    call_outcome_reason_vocobaseplatform: 'they told me everything',
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

const busy = { status: 'busy', delays_secs: { ringing: 1, hold: 2 } };

export const goalFollowUps: Scenario = {
  name: 'goal-followups',
  rows: ['G1', 'G2', 'G3'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `goal${d.seed}` });

    // One campaign per contact: the dial policy under test is per campaign.
    //
    // `converge` and `budget` want a long wait between conversations so the
    // hold can be probed from inside it, and the wait is `followUpDelayHours`
    // — so that is a day, and the ladder beside it is seventeen minutes so an
    // engine reading the wrong clock is unmistakable. `cap` and `silent` want
    // the opposite: a ladder of one-minute rungs, so the whole journey fits in
    // the first wave of ticks.
    //
    // The retries on `converge` and `budget` are there and UNSPENDABLE: both
    // contacts answer their first call, which forfeits them.
    const converge = await d.seedCampaign(ws, {
      name: 'converge',
      retryCount: 5,
      maxGoalFollowUps: 5,
      followUpDelayHours: 24,
      cooldownMinutes: 17,
      contacts: [P.converge],
    });
    // Two dials: one call, one follow-up, then the follow-up budget is spent.
    // `retryCount: 5` beside it buys nothing — this contact answered.
    const budget = await d.seedCampaign(ws, {
      name: 'budget',
      retryCount: 5,
      maxGoalFollowUps: 1,
      followUpDelayHours: 24,
      cooldownMinutes: 17,
      contacts: [P.budget],
    });
    // Three dials, on a one-minute ladder: two silences on the retry ladder,
    // then a conversation that settles at once because there are no follow-ups
    // to spend.
    const cap = await d.seedCampaign(ws, {
      name: 'cap',
      retryCount: 2,
      maxGoalFollowUps: 0,
      retryDelaysMinutes: [1, 1],
      contacts: [P.cap],
    });
    // Two dials, same ladder.
    const silent = await d.seedCampaign(ws, {
      name: 'silent',
      retryCount: 1,
      retryDelaysMinutes: [1],
      contacts: [P.silent],
    });

    await d.script({
      numbers: [
        {
          to_number: P.converge,
          // The note the bot writes for the next call after every
          // conversation — instructions, not a fact sheet, and each one
          // written fresh with what that call learned.
          rules: [
            callAgain(NOTES.first, 'she had to run'),
            callAgain(NOTES.second, 'she wanted to check with her husband'),
            done(NOTES.third),
          ],
        },
        {
          to_number: P.budget,
          rules: [
            callAgain('Rohit is buying in west Pune; ask which area.', 'he was driving'),
            callAgain('Rohit is buying in west Pune; ask which area.', 'still deciding'),
          ],
        },
        { to_number: P.cap, rules: [busy, busy, callAgain('Sana; ask for the budget.', 'bad line')] },
        { to_number: P.silent, rules: [busy, busy] },
      ],
    });

    for (const c of [converge, budget, cap, silent]) await d.start(ws, c.campaignId);

    // First wave plus the one-minute retry ladder of the cap contacts.
    for (let i = 0; i < 8; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    const contact = async (campaign: { contactByPhone: Map<string, string> }, phone: string) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({
        where: { id: campaign.contactByPhone.get(phone)! },
      });
    const dialsTo = (phone: string) => d.trace.filter((e) => e.kind === 'dial' && e.phone === phone);
    const kindsOf = async (campaignContactId: string) =>
      (
        await d.backend.prisma.callAttempt.findMany({
          where: { campaignContactId },
          orderBy: { attemptNo: 'asc' },
          select: { kind: true },
        })
      ).map((a) => a.kind);

    /**
     * G3 — the two lanes meeting. The `cap` contact spends its retry budget on
     * two silences and its third dial IS a conversation; the bot asked for
     * another call, and with `maxGoalFollowUps: 0` it settles COMPLETED/false
     * rather than re-arming — the follow-up budget beats the note, exactly as
     * the decision table says. The `silent` contact's dials were all silences
     * and nobody was ever spoken to, which stays a failure — never a fourth
     * (or third) dial for either.
     */
    {
      const c = await contact(cap, P.cap);
      d.check('G3', c.status === 'COMPLETED' && c.goalAchieved === false,
        `cap contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/false`);
      d.check('G3', c.followUpCount === 0 && c.nextEligibleAt === null,
        `cap contact re-armed past the cap (followUpCount=${c.followUpCount} next=${c.nextEligibleAt?.toISOString()})`);
      d.check('G3', dialsTo(P.cap).length === 3, `cap contact dialed ${dialsTo(P.cap).length} times, cap is 3`);
      const kinds = await kindsOf(cap.contactByPhone.get(P.cap)!);
      d.check('G3', kinds.join(',') === 'fresh,retry,retry',
        `cap contact kinds ${kinds.join(',')}, expected fresh,retry,retry`);

      const s = await contact(silent, P.silent);
      d.check('G3', s.status === 'FAILED' && s.goalAchieved === null,
        `silent contact ended ${s.status}/goalAchieved=${s.goalAchieved}, expected FAILED/null`);
      d.check('G3', dialsTo(P.silent).length === 2,
        `silent contact dialed ${dialsTo(P.silent).length} times, cap is 2`);
    }

    /**
     * G1/G2 — the re-arm after the first `incomplete`/`flexible`. The wait is
     * `followUpDelayHours`, a day here; `nextEligibleAt` is stamped from
     * the webhook's real clock, so the band allows for the run's own wall time
     * but not for a wait that was quietly shorter or longer.
     */
    for (const [row, campaign, phone] of [
      ['G1', converge, P.converge],
      ['G2', budget, P.budget],
    ] as const) {
      const c = await contact(campaign, phone);
      const next = c.nextEligibleAt?.getTime() ?? 0;
      d.check(row, c.status === 'PENDING' && c.followUpCount === 1,
        `${phone}: expected PENDING/followUpCount=1 after an incomplete call, got ${c.status}/${c.followUpCount}`);
      d.check(row, next >= T0 + 24 * HOUR - MINUTE && next <= T0 + 24 * HOUR + 10 * MINUTE,
        `${phone}: follow-up armed at ${c.nextEligibleAt?.toISOString()}, expected ≈ T0+24h (followUpDelayHours)`);
      d.check(row, c.callbackAt === null, `${phone}: follow-up re-arm invented a callback promise`);
    }

    // The hold, probed from inside the wait: twelve hours in, nothing dials.
    // An engine reading the 17-minute ladder would have dialled long ago.
    d.advanceBy(12 * HOUR - (d.nowMs - T0));
    await d.tick();
    d.check('G1', dialsTo(P.converge).length === 1, 'a follow-up dialed inside the cooldown');
    d.check('G2', dialsTo(P.budget).length === 1, 'a follow-up dialed inside the cooldown');

    // Past the delay: the second wave dials, and its outcome lands.
    d.advanceBy(12 * HOUR + 15 * MINUTE);
    await d.tick();
    d.advanceBy(MINUTE);
    await d.tick();

    /**
     * G2 — the FOLLOW-UP budget spent on conversations: `maxGoalFollowUps: 1`
     * buys one more call after the first, the bot asked for a third anyway, so
     * the journey ends COMPLETED with the goal unachieved. Never FAILED — they
     * did talk to us, twice — and the five retries on the campaign bought
     * nothing, which is the forfeit made visible.
     */
    {
      const c = await contact(budget, P.budget);
      d.check('G2', c.status === 'COMPLETED' && c.goalAchieved === false,
        `budget contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/false`);
      d.check('G2', c.followUpCount === 1 && dialsTo(P.budget).length === 2,
        `budget contact followUpCount=${c.followUpCount} dials=${dialsTo(P.budget).length}, expected 1 and 2`);
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: budget.campaignId } });
      d.check('G2', row.completedCount === 1 && row.failedCount === 0,
        `budget campaign counters ${row.completedCount}/${row.failedCount}, expected 1/0`);
    }

    /**
     * The third wave. The second re-arm was stamped off the webhook's REAL
     * clock (≈ wall now + 24h), and the virtual clock is already a day ahead
     * of the wall — so from here the engine sees every follow-up as due at
     * once, and the spacing property is only observable on the first hop
     * (probed above at 12h). The cross-clock artifact, not an engine bug.
     */
    {
      const c = await contact(converge, P.converge);
      d.check('G1', c.followUpCount === 2,
        `converge contact after call 2: followUpCount=${c.followUpCount}, expected 2`);
    }
    for (let i = 0; i < 4; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    /**
     * G1 — convergence. Three conversations, a note written on each, and the
     * third one comes back `completed`.
     */
    const convergeId = converge.contactByPhone.get(P.converge)!;
    {
      const c = await contact(converge, P.converge);
      d.check('G1', c.status === 'COMPLETED' && c.goalAchieved === true,
        `converge contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/true`);
      d.check('G1', c.followUpCount === 2 && dialsTo(P.converge).length === 3,
        `converge followUpCount=${c.followUpCount} dials=${dialsTo(P.converge).length}, expected 2 and 3`);
      const kinds = await kindsOf(convergeId);
      d.check('G1', kinds.join(',') === 'fresh,follow_up,follow_up',
        `converge kinds ${kinds.join(',')}, expected fresh,follow_up,follow_up`);
    }

    // The context record: the LAST note the bot wrote (the `memory` column
    // holds the note now), YE's own line for the last call, and one log
    // entry per attempt carrying that call's outcome and callback type.
    {
      const record = await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: convergeId },
      });
      d.check('G1', record.memory === NOTES.third,
        `memory is ${JSON.stringify(record.memory)}, expected the third call's note`);
      d.check('G1', record.memoryAttempt === 3,
        `memoryAttempt=${record.memoryAttempt}, expected 3 — the attempt that wrote the note`);
      d.check('G1', record.lastCallNote === 'spoke, completed: they told me everything',
        `lastCallNote is ${JSON.stringify(record.lastCallNote)}`);
      const log = record.attemptLog as Array<{
        attemptNo: number;
        outcome: string | null;
        callbackType: string | null;
      }>;
      d.check('G1', log.length === 3, `attempt log has ${log.length} entries, expected 3`);
      const decided = log.map((e) => `${e.outcome}/${e.callbackType}`).join(',');
      d.check('G1', decided === 'incomplete/flexible,incomplete/flexible,completed/null',
        `outcome/callbackType per attempt: ${decided}, expected incomplete/flexible,incomplete/flexible,completed/null`);
    }

    /**
     * G1 — the variable contract, read off what the mock actually received on
     * each dial.
     *
     * Beside the standing campaign context every outbound dial carries, YE
     * adds exactly one variable, and only once there is a note: the first
     * dial carries the contact's own variables and no NOTE from YE (the
     * block renders empty, and no "this is a follow-up" frame reaches a call
     * that is not one), and every later dial carries
     * `next_call_instructions_vocobaseplatform` = the JSON object YE
     * assembles from its own frame and the PREVIOUS conversation's note —
     * nothing else: no call number, no memory paragraph, and nothing
     * goal-shaped, the campaign's goal now being a switch with no words to
     * send even if something wanted to.
     *
     * This is the assertion the whole wave turns on: the third dial must carry
     * the SECOND call's note. A decision taken on the status event — before
     * that call's `session.completed` had delivered the note — would leave
     * every dial one conversation behind, and dial three would still carry
     * the first call's note.
     */
    {
      const state = await d.mockState();
      const dialVars = state.dialLog
        .filter((entry) => entry.toNumber === P.converge)
        .map((entry) => (entry.variables ?? {}) as Record<string, string>);
      d.check('G1', dialVars.length === 3, `mock saw ${dialVars.length} converge dials, expected 3`);
      const [v1, v2, v3] = dialVars as [Record<string, string>, Record<string, string>, Record<string, string>];
      // The contact's own variables are whatever the first dial carried; the
      // only thing that may differ on later dials is the one YE variable.
      const contactKeys = Object.keys(v1).sort().join(',');
      // The context names are subtracted explicitly rather than left to the
      // "wasn't on dial 1" test. They ARE on dial 1, so that test excludes
      // them by accident today; naming them says it is the intent.
      const ezoKeysOf = (v: Record<string, string>) =>
        Object.keys(v).filter((k) => !(k in v1) && !CONTEXT_NAMES.has(k)).sort().join(',');
      d.check('G1', !(NOTE_VARIABLE in v1) && !RETIRED_VARIABLES.some((k) => k in v1),
        `first dial carried an YE variable: ${JSON.stringify(v1)}`);
      // Every dial, including the first: nothing dialled it but this campaign.
      for (const [i, v] of [v1, v2, v3].entries()) {
        const problem = contextProblem(v);
        d.check('G1', problem === null,
          `dial ${i + 1} campaign context: ${problem} — ${JSON.stringify(v)}`);
      }
      d.check('G1', carriesNote(v2[NOTE_VARIABLE], NOTES.first) && ezoKeysOf(v2) === NOTE_VARIABLE,
        `second dial variables: ${JSON.stringify(v2)}, expected the follow-up frame plus the first call's note, and nothing else from YE`);
      d.check('G1', carriesNote(v3[NOTE_VARIABLE], NOTES.second) && ezoKeysOf(v3) === NOTE_VARIABLE,
        `third dial variables: ${JSON.stringify(v3)}, expected the follow-up frame plus the second call's note, and nothing else from YE`);
      d.check('G1',
        [v2, v3].every((v) => Object.keys(v).filter((k) => k !== NOTE_VARIABLE).sort().join(',') === contactKeys),
        'a later dial changed the contact\'s own variables');
      d.check('G1', !v1.campaign_goal && !v2.campaign_goal && !v3.campaign_goal,
        `a dial carried campaign_goal: ${JSON.stringify(v1.campaign_goal ?? v2.campaign_goal ?? v3.campaign_goal)} — ` +
          'the objective lives in the agent\'s own prompt and the campaign holds only a switch');
    }

    // Delay spacing on the first hop, measured on the virtual clock. The
    // later hops are unmeasurable here — see the cross-clock note above.
    {
      const at = dialsTo(P.converge).map((e) => e.atMs);
      const spaced = at.length === 3 && at[1]! - at[0]! >= 24 * HOUR - MINUTE;
      d.check('G1', spaced, `converge dials at ${at.map((t) => `t+${(t - T0) / HOUR}h`).join(', ')} — a follow-up inside the delay`);
    }
  },
};
