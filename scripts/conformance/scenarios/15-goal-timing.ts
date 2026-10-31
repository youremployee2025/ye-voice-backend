import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';
import { FOLLOW_UP_NOTE, GOAL_VARIABLE_NAMES } from '../../../src/lib/goalVariables.js';
import { IMMEDIATE_CALLBACK_MINUTES } from '../../../src/lib/campaignConfig.js';

/**
 * Goal timing, the null note, and the dropped call (G5, G7).
 *
 * Four of the decision table's rows, all of which are about *when* the next
 * call happens rather than whether there is one:
 *
 * - `incomplete` + `flexible` re-arms at **`followUpDelayHours`**, the
 *   follow-up lane's own wait — NOT the retry ladder, which times a number
 *   nobody answered — **rolled into the dial window**: a re-arm landing after
 *   the window closes moves to the next opening, exactly the way a callback
 *   promise rolls. Every campaign below sets `cooldownMinutes` to a value the
 *   assertions would notice, so an engine still timing a follow-up off the
 *   ladder fails here.
 * - `incomplete` + `requested` re-arms identically and is then MOVED by the
 *   callback booking to the time the person actually promised, read off
 *   `callback_requested_time_vocobaseplatform` in the platform's own
 *   `YYYY-MM-DDTHH:mm±HH` form: they told us when to call, and the ladder's
 *   wait is only our own guess.
 * - **No note at all** — a conversation whose extraction never came back —
 *   is a follow-up on the follow-up wait and never a guess about the person.
 *   The journey says so in as many words: the attempt's `outcome` is null,
 *   and YE's own line for the call records that nothing was decided.
 * - `incomplete` + `immediate` (G7) — the call dropped mid-conversation — is
 *   the one row that re-arms at the fixed **`IMMEDIATE_CALLBACK_MINUTES`**
 *   (three minutes) rather than at the `followUpDelayHours` every other
 *   follow-up waits.
 *   It still spends a follow-up (not a retry) — `followUpCount` moves,
 *   `attempts` does not — and it is armed **`RESUME`**, which is a lane of its
 *   own: ahead of retries and fresh contacts, behind a promise, and drawn from
 *   the retry reservation so a burst of dropped calls cannot take every slot.
 *   `callbackAt` stays null. The re-arm rolls into the window like every other.
 *
 * Where G7's expectations come from, since it is the row this branch adds and
 * the temptation is to read them off the engine: the gap from
 * `IMMEDIATE_CALLBACK_MINUTES` in `src/lib/campaignConfig.ts`; the
 * arming from `ContactArmKind` in `prisma/schema.prisma`, which states in as
 * many words that a resume is engine-chosen and a callback is a time a person
 * named; and the decision table in
 * `docs/plans/2026-09-03-call-note-design.md`, whose Record row says what each
 * re-arm writes. Nothing here is graded against what the implementation
 * currently emits.
 */
const P = {
  windowed: '+919877720011', // flexible; the follow-up rolls to the next window
  promised: '+919877720012', // requested with a promised time at +2h, in ±HH form
  unread: '+919877720013', // a conversation that came back with no note at all
  dropped: '+919877720014', // immediate: re-armed at its own gap, not the delay
  droppedWindowed: '+919877720015', // immediate whose gap lands past the window
};

const HOUR = 60 * MINUTE;

/** The one variable YE adds to a dial, and only once a note exists. */
const NOTE_VARIABLE = GOAL_VARIABLE_NAMES[0];

/**
 * What that variable must hold: the JSON object YE assembles, carrying its
 * own standing continuation order and the memory the previous call wrote.
 * Graded by content, not by an exact string — see scenario 14.
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

/** One conversation, with the call note the bot came back with (see scenario
 *  14 for why `post_call` is pinned rather than drawn). */
const conversation = (note: Record<string, unknown>) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: 20,
  delays_secs: { ringing: 1, hold: 2, talk: 20, post_call: 3 },
  extraction: note,
});

const done = (note: string, reason: string) =>
  conversation({
    call_outcome_vocobaseplatform: 'completed',
    call_outcome_reason_vocobaseplatform: reason,
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

/** IST wall-clock parts for an instant (the campaign timezone used below). */
function istParts(ms: number): { hour: number; day: string; hm: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour),
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * An instant in the platform's `YYYY-MM-DDTHH:mm±HH` form, at a whole-hour
 * offset. `+05` rather than IST's `+05:30` on purpose: the two-digit offset
 * is the one the description asks the model for, JavaScript's own `Date`
 * parser does not accept it, and the engine's normalisation of it to `+05:00`
 * is exactly what this value proves. The form has no seconds, so the caller
 * must hand in a whole minute.
 */
function offsetForm(ms: number, offsetHours: number): string {
  const shifted = new Date(ms + offsetHours * HOUR);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = offsetHours < 0 ? '-' : '+';
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}${sign}${pad(Math.abs(offsetHours))}`
  );
}

export const goalTiming: Scenario = {
  name: 'goal-timing',
  rows: ['G5', 'G7'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `goaltime${d.seed}` });

    // A window open now and closing in two hours, so a four-hour cooldown
    // lands outside it and the follow-up must roll to tomorrow's opening.
    const nowIst = istParts(T0);
    const fromTime = `${String(nowIst.hour).padStart(2, '0')}:00`;
    const toTime = `${String((nowIst.hour + 2) % 24).padStart(2, '0')}:00`;
    const window = { fromTime, toTime, timezone: 'Asia/Kolkata' };
    // `followUpDelayHours: 4` is the wait under test; the ladder's own
    // `cooldownMinutes` is deliberately a different number, so an engine still
    // timing a follow-up off the ladder lands somewhere the roll check
    // notices. The retries are there and unspendable: this contact answered.
    const windowed = await d.seedCampaign(ws, {
      name: 'windowed',
      retryCount: 5,
      maxGoalFollowUps: 3,
      followUpDelayHours: 4,
      cooldownMinutes: 17,
      window,
      contacts: [P.windowed],
    });

    const promised = await d.seedCampaign(ws, {
      name: 'promised',
      retryCount: 5,
      maxGoalFollowUps: 3,
      followUpDelayHours: 24,
      cooldownMinutes: 17,
      contacts: [P.promised],
    });

    const unread = await d.seedCampaign(ws, {
      name: 'unread',
      retryCount: 5,
      maxGoalFollowUps: 3,
      followUpDelayHours: 6,
      cooldownMinutes: 17,
      contacts: [P.unread],
    });

    // The resume gap is a fixed three minutes; the follow-up wait here is an
    // hour and the ladder's cooldown forty minutes, so none of the three can
    // be confused. A re-arm at ≈ +3m is the resume gap — and the stored
    // `immediateCallbackMinutes` is left at its column default so an engine
    // still reading that column fails here too.
    const dropped = await d.seedCampaign(ws, {
      name: 'dropped',
      retryCount: 5,
      maxGoalFollowUps: 3,
      followUpDelayHours: 1,
      cooldownMinutes: 40,
      contacts: [P.dropped],
    });

    /**
     * The mirror image, for the roll.
     *
     * The resume gap is a constant now, and a constant of three minutes is
     * shorter than any wait the ladder can produce — so there is no window
     * that lets a resume roll while a follow-up does not, and the old
     * construction (a window closing between the two) has nothing left to sit
     * between. What is provable, and what this campaign proves, is the roll
     * itself: a window one minute wide, so the three-minute gap lands past its
     * close and the re-arm can only be at tomorrow's opening. That the gap IS
     * three minutes is pinned on the unwindowed `dropped` campaign above,
     * where nothing rolls.
     *
     * An engine that did not roll at all lands at T0+3m and fails here.
     */
    const dropFromTime = istParts(T0).hm;
    const dropWindow = {
      fromTime: dropFromTime,
      toTime: istParts(T0 + MINUTE).hm,
      timezone: 'Asia/Kolkata',
    };
    const droppedWindowed = await d.seedCampaign(ws, {
      name: 'dropped-windowed',
      retryCount: 5,
      maxGoalFollowUps: 3,
      followUpDelayHours: 1,
      cooldownMinutes: 40,
      window: dropWindow,
      contacts: [P.droppedWindowed],
    });

    // The promised instant: two hours out, on a whole minute because the
    // platform's form carries none, written at a whole-hour offset.
    const promiseMs = Math.floor((T0 + 2 * HOUR) / MINUTE) * MINUTE;
    const promiseAt = offsetForm(promiseMs, 5);
    const MEERA_NOTE = 'Meera, budget 50L, asked for a call in two hours. Open with: "Hi Meera, you asked me to call back now — is it a good time?" Then ask when she wants to move.';
    const DROPPED_NOTE = 'The line dropped while Aarav was giving his budget. Open with: "Hi Aarav, we got cut off — you were telling me your budget." Wait, then continue.';

    await d.script({
      numbers: [
        {
          to_number: P.windowed,
          rules: [
            conversation({
              call_outcome_vocobaseplatform: 'incomplete',
              call_outcome_reason_vocobaseplatform: 'he was at work',
              immediate_callback_needed_vocobaseplatform: 'no',
              callback_requested_time_vocobaseplatform: 'null',
              next_call_instructions_vocobaseplatform: 'Aditya works nights; ask for the budget.',
            }),
          ],
        },
        {
          to_number: P.promised,
          rules: [
            // The promise and the note travel together: `callback_type` says
            // the person asked, and `callback_requested_time` — in the
            // platform's own ±HH form — says when.
            conversation({
              call_outcome_vocobaseplatform: 'incomplete',
              call_outcome_reason_vocobaseplatform: 'she asked for two hours from now',
              immediate_callback_needed_vocobaseplatform: 'no',
              callback_requested_time_vocobaseplatform: promiseAt,
              next_call_instructions_vocobaseplatform: MEERA_NOTE,
            }),
            done('Meera: budget 50L, moving in March. Nothing left to ask.', 'she told me the rest'),
          ],
        },
        {
          // A conversation the extraction never came back for: the call
          // happened, nobody judged it. The platform's transcript-only
          // fallback returns exactly this — an answer to nothing.
          to_number: P.unread,
          rules: [conversation({})],
        },
        {
          to_number: P.dropped,
          rules: [
            conversation({
              call_outcome_vocobaseplatform: 'incomplete',
              call_outcome_reason_vocobaseplatform: 'call dropped mid-sentence',
              immediate_callback_needed_vocobaseplatform: 'yes',
              callback_requested_time_vocobaseplatform: 'null',
              next_call_instructions_vocobaseplatform: DROPPED_NOTE,
            }),
            done('Aarav: budget 75L. Nothing left to ask.', 'he gave the budget'),
          ],
        },
        {
          to_number: P.droppedWindowed,
          rules: [
            conversation({
              call_outcome_vocobaseplatform: 'incomplete',
              call_outcome_reason_vocobaseplatform: 'call dropped',
              immediate_callback_needed_vocobaseplatform: 'yes',
              callback_requested_time_vocobaseplatform: 'null',
              next_call_instructions_vocobaseplatform: 'The line dropped; resume with the budget question.',
            }),
          ],
        },
      ],
    });

    for (const c of [windowed, promised, unread, dropped, droppedWindowed]) await d.start(ws, c.campaignId);

    for (let i = 0; i < 3; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    const contact = async (campaign: { contactByPhone: Map<string, string> }, phone: string) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({
        where: { id: campaign.contactByPhone.get(phone)! },
      });
    const dialsTo = (phone: string) => d.trace.filter((e) => e.kind === 'dial' && e.phone === phone);
    const expectedNextOpening = istParts(T0 + 24 * HOUR).day;

    /**
     * The window roll: now + the 4h follow-up wait is past the window's close, so
     * the follow-up lands at the NEXT opening — tomorrow at fromTime, in the campaign's own
     * timezone — exactly the way a callback promise rolls (CB5).
     */
    {
      const c = await contact(windowed, P.windowed);
      const rolled = c.nextEligibleAt ? istParts(c.nextEligibleAt.getTime()) : null;
      d.check('G5', c.status === 'PENDING' && c.followUpCount === 1,
        `windowed contact: expected PENDING/followUpCount=1, got ${c.status}/${c.followUpCount}`);
      d.check('G5', rolled !== null && rolled.hm === fromTime && rolled.day === expectedNextOpening,
        `follow-up rolled to ${c.nextEligibleAt?.toISOString()} (${rolled?.day} ${rolled?.hm} IST), expected ${expectedNextOpening} ${fromTime}`);
      d.check('G5', c.callbackAt === null, 'the window roll manufactured a callback promise');
    }

    /**
     * `requested`: the note re-arms the contact exactly as `flexible` would
     * (on the campaign's 24-hour cooldown), and the booking that runs after
     * the resolution then
     * moves it to the promised instant — read from the `+05` form, which is
     * the part of this row that proves the platform's own time format parses.
     * What must be observable is the end of that sequence — the armed pair
     * holds the promise, and the dial goes out at +2h, not at +24h.
     */
    {
      const c = await contact(promised, P.promised);
      const cbAt = c.callbackAt?.getTime();
      d.check('G5',
        c.status === 'PENDING' && cbAt === promiseMs && c.nextEligibleAt?.getTime() === cbAt,
        `promise not armed: status=${c.status} next=${c.nextEligibleAt?.toISOString()} cb=${c.callbackAt?.toISOString()}, expected both at ${promiseAt} (${new Date(promiseMs).toISOString()})`);
      d.check('G5', c.callbackCount === 1, `callbackCount=${c.callbackCount}, expected 1`);
      d.check('G5', c.followUpCount === 1,
        `followUpCount=${c.followUpCount} after a requested callback, expected 1 — the re-arm is a follow-up the booking then moved`);
    }

    /**
     * The null note. A follow-up at the campaign's own cooldown — six hours
     * here, so it cannot be confused with either of the two above — and
     * nothing invented: no note, and a line that says in as many words that
     * this call decided nothing.
     */
    const unreadId = unread.contactByPhone.get(P.unread)!;
    {
      const c = await contact(unread, P.unread);
      const next = c.nextEligibleAt?.getTime() ?? 0;
      d.check('G5', c.status === 'PENDING' && c.followUpCount === 1,
        `no-note contact: expected PENDING/followUpCount=1, got ${c.status}/${c.followUpCount}`);
      d.check('G5', next >= T0 + 6 * HOUR - MINUTE && next <= T0 + 6 * HOUR + 10 * MINUTE,
        `no-note follow-up armed at ${c.nextEligibleAt?.toISOString()}, expected ≈ T0+6h (followUpDelayHours)`);
      d.check('G5', c.goalAchieved === null,
        `no-note contact was judged goalAchieved=${c.goalAchieved}; a missing outcome must never become one`);
      d.check('G5', c.callbackAt === null, 'the no-note re-arm invented a callback promise');

      const record = await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: unreadId },
      });
      d.check('G5', record.memory === null,
        `no-note record invented a note: memory=${JSON.stringify(record.memory)}`);
      d.check('G5', record.lastCallNote === 'spoke, but no outcome was recorded',
        `no-note line is ${JSON.stringify(record.lastCallNote)}`);
    }

    /**
     * And the journey says it, through the route an operator actually reads.
     * The attempt event carries a goal annotation whose `outcome` is null —
     * "no outcome", never a judgement about the person — and the dashboard's
     * compatibility mapping (`nextAction`) is null with it.
     */
    {
      const res = await d.api(ws)(
        'GET',
        `/workspaces/${ws.workspaceId}/campaigns/${unread.campaignId}/contacts/${unreadId}/journey`,
      );
      d.check('G5', res.status === 200, `journey answered ${res.status}`);
      const data = res.body.data as { events?: Array<Record<string, unknown>> } | undefined;
      const attemptEvents = (data?.events ?? []).filter((e) => e.kind === 'attempt');
      d.check('G5', attemptEvents.length === 1,
        `journey shows ${attemptEvents.length} attempts, expected 1`);
      const goalAnnotation = attemptEvents[0]?.goal as
        | { outcome: string | null; callbackType: string | null; reason: string | null; nextAction?: string | null }
        | undefined;
      d.check('G5', goalAnnotation !== undefined,
        'the journey carries no goal annotation for a goal campaign attempt');
      d.check('G5',
        goalAnnotation?.outcome === null && goalAnnotation?.callbackType === null &&
          goalAnnotation?.reason === null && (goalAnnotation?.nextAction ?? null) === null,
        `journey note is ${JSON.stringify(goalAnnotation)}, expected no outcome`);
    }

    /**
     * G7 — `immediate`. The dropped contact is re-armed at the fixed resume
     * gap (≈ +3m), not on the cooldown ladder every other follow-up waits
     * (+40m); it is a follow-up all the same, so `followUpCount` moved and the
     * retry counter did not; and no promise was invented. Three ticks in,
     * still inside the gap, it has not been re-dialled.
     */
    const droppedId = dropped.contactByPhone.get(P.dropped)!;
    {
      const c = await contact(dropped, P.dropped);
      const next = c.nextEligibleAt?.getTime() ?? 0;
      d.check('G7', c.status === 'PENDING' && c.followUpCount === 1,
        `dropped contact: expected PENDING/followUpCount=1, got ${c.status}/${c.followUpCount}`);
      d.check('G7', c.attempts === 0,
        `dropped contact spent a retry (attempts=${c.attempts}); an immediate re-arm is a follow-up, not a retry`);
      const gapMs = IMMEDIATE_CALLBACK_MINUTES * MINUTE;
      d.check('G7', next >= T0 + gapMs - MINUTE && next <= T0 + gapMs + 10 * MINUTE,
        `dropped contact re-armed at ${c.nextEligibleAt?.toISOString()}, expected ≈ T0+${IMMEDIATE_CALLBACK_MINUTES}m (IMMEDIATE_CALLBACK_MINUTES), not +40m (the cooldown)`);
      /**
       * No promise, and the row says why it is waiting instead.
       *
       * `callbackAt` is written by one thing: a person on the phone naming a
       * time. A dropped call is the engine choosing to ring back, which is a
       * different fact about a different party, and `ContactArmKind` in
       * `prisma/schema.prisma` is where the two are separated — RESUME is
       * documented there as engine-chosen precisely so that nothing
       * customer-facing can describe it as something the lead asked for. The
       * urgency the resume is owed is carried by its own claim lane, not by
       * borrowing the pair that means a promise.
       *
       * Both expectations come from that enum and from the Record row of the
       * decision table in `docs/plans/2026-09-03-call-note-design.md`.
       */
      d.check('G7', c.callbackAt === null,
        `the immediate re-arm invented a callback promise (callbackAt=${c.callbackAt?.toISOString()})`);
      d.check('G7', c.armKind === 'RESUME',
        `dropped contact is armed ${c.armKind}, expected RESUME — an engine-chosen resume, not a promise and not a plain follow-up`);
      d.check('G7', dialsTo(P.dropped).length === 1, 'the dropped contact was re-dialled inside its immediate gap');

      const record = await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: droppedId },
      });
      d.check('G7', record.memory === DROPPED_NOTE,
        `dropped record holds ${JSON.stringify(record.memory)}, expected the call's note`);
      d.check('G7', record.lastCallNote === 'spoke, call dropped mid-conversation: call dropped mid-sentence',
        `dropped line is ${JSON.stringify(record.lastCallNote)}`);
    }

    // And the roll: the resume gap lands past the one-minute window's close,
    // so the re-arm is at tomorrow's opening rather than at T0+3m. Still a
    // RESUME after the roll: rolling moves when the contact is due, never why.
    {
      const c = await contact(droppedWindowed, P.droppedWindowed);
      const rolled = c.nextEligibleAt ? istParts(c.nextEligibleAt.getTime()) : null;
      d.check('G7', c.status === 'PENDING' && c.followUpCount === 1 && c.attempts === 0,
        `dropped-windowed contact: expected PENDING/followUpCount=1/attempts=0, got ${c.status}/${c.followUpCount}/${c.attempts}`);
      d.check('G7', rolled !== null && rolled.hm === dropFromTime && rolled.day === expectedNextOpening,
        `resume re-arm landed at ${c.nextEligibleAt?.toISOString()} (${rolled?.day} ${rolled?.hm} IST), expected the resume gap rolled to ${expectedNextOpening} ${dropFromTime}`);
      d.check('G7', c.armKind === 'RESUME' && c.callbackAt === null,
        `rolled resume is armed ${c.armKind} callbackAt=${c.callbackAt?.toISOString() ?? 'null'}, expected RESUME with no promise`);
    }

    // Held until the promise: an hour in, nothing dials for the promised and
    // the unread contacts — and the dropped contact's immediate gap has
    // elapsed, so it goes out on this tick.
    d.advanceBy(HOUR - (d.nowMs - T0));
    await d.tick();
    d.check('G5', dialsTo(P.promised).length === 1, 'the callback dialed before the promised time');
    d.check('G5', dialsTo(P.unread).length === 1, 'the no-note follow-up dialed inside its cooldown');
    d.check('G7', dialsTo(P.dropped).length === 2,
      `dropped contact dialed ${dialsTo(P.dropped).length} times an hour in, expected 2 — the resume gap had elapsed`);
    d.check('G7', dialsTo(P.droppedWindowed).length === 1,
      'the dropped-windowed contact dialed before the opening its re-arm rolled to');

    // At the promise (+2h), the dial goes out on the callback lane and its
    // conversation completes the goal.
    d.advanceBy(HOUR + 2 * MINUTE);
    await d.tick();
    d.advanceBy(MINUTE);
    await d.tick();

    {
      const dials = dialsTo(P.promised);
      d.check('G5', dials.length === 2, `promised contact dialed ${dials.length} times, expected 2`);
      const secondAt = dials[1]?.atMs ?? 0;
      d.check('G5', secondAt - T0 >= 2 * HOUR - MINUTE && secondAt - T0 <= 2 * HOUR + 10 * MINUTE,
        `second dial at t+${((secondAt - T0) / HOUR).toFixed(2)}h, expected ≈ +2h (the promise), not +24h (the delay)`);

      const c = await contact(promised, P.promised);
      d.check('G5', c.status === 'COMPLETED' && c.goalAchieved === true,
        `promised contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/true`);

      const kinds = (
        await d.backend.prisma.callAttempt.findMany({
          where: { campaignContactId: promised.contactByPhone.get(P.promised)! },
          orderBy: { attemptNo: 'asc' },
          select: { kind: true },
        })
      ).map((a) => a.kind);
      d.check('G5', kinds.join(',') === 'fresh,callback',
        `promised contact kinds ${kinds.join(',')}, expected fresh,callback — the promise rides the callback lane`);

      // The second dial knew what the first one learned: the note the bot
      // wrote, and nothing else from YE.
      const state = await d.mockState();
      const dialVars = state.dialLog
        .filter((entry) => entry.toNumber === P.promised)
        .map((entry) => (entry.variables ?? {}) as Record<string, string>);
      const [first, second] = dialVars;
      d.check('G5', first !== undefined && !(NOTE_VARIABLE in first),
        `the first dial carried a note: ${JSON.stringify(first?.[NOTE_VARIABLE])}`);
      d.check('G5', carriesNote(second?.[NOTE_VARIABLE], MEERA_NOTE),
        `the callback dial carried ${JSON.stringify(second?.[NOTE_VARIABLE])}, expected the follow-up frame plus the first call's note`);
      d.check('G5',
        second !== undefined && first !== undefined &&
          Object.keys(second).filter((k) => !(k in first)).join(',') === NOTE_VARIABLE,
        `the callback dial carried more than the note from YE: ${JSON.stringify(second)}`);
    }

    /**
     * G7 — the dropped contact's second call, on the resume lane, and the
     * record's log naming the dropped call for what it was. The second dial
     * carried the dropped call's note — the resume line — and nothing else.
     */
    {
      const c = await contact(dropped, P.dropped);
      d.check('G7', c.status === 'COMPLETED' && c.goalAchieved === true,
        `dropped contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/true`);
      d.check('G7', c.followUpCount === 1 && c.attempts === 0,
        `dropped contact followUpCount=${c.followUpCount} attempts=${c.attempts}, expected 1 and 0`);
      const kinds = (
        await d.backend.prisma.callAttempt.findMany({
          where: { campaignContactId: droppedId },
          orderBy: { attemptNo: 'asc' },
          select: { kind: true },
        })
      ).map((a) => a.kind);
      // `resume`, and neither of the two labels it sits between. Not
      // `callback`, because the attempt row is the record an operator reads
      // back months later and a resume the engine chose must never be shown as
      // a call the lead asked for; not `follow_up`, because the dial it
      // describes was placed out of a different lane on a different clock. The
      // kind is stamped from the arming the claim froze, so the order the
      // batch was chosen in and the label it carries cannot disagree.
      d.check('G7', kinds.join(',') === 'fresh,resume',
        `dropped contact kinds ${kinds.join(',')}, expected fresh,resume — an immediate re-arm takes the resume lane`);

      const record = await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: droppedId },
      });
      const log = record.attemptLog as Array<{ outcome: string | null; callbackType: string | null }>;
      const decided = log.map((e) => `${e.outcome}/${e.callbackType}`).join(',');
      d.check('G7', decided === 'incomplete/immediate,completed/null',
        `dropped attempt log: ${decided}, expected incomplete/immediate,completed/null`);

      const state = await d.mockState();
      const second = state.dialLog
        .filter((entry) => entry.toNumber === P.dropped)
        .map((entry) => (entry.variables ?? {}) as Record<string, string>)[1];
      d.check('G7', carriesNote(second?.[NOTE_VARIABLE], DROPPED_NOTE),
        `the resumed dial carried ${JSON.stringify(second?.[NOTE_VARIABLE])}, expected the follow-up frame plus the dropped call's note`);
    }
  },
};
