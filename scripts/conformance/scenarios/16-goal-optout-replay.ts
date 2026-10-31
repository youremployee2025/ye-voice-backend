import { createHmac } from 'node:crypto';
import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';
import { drainWebhookQueue } from '../lib.js';
import { BACKEND_PORT, WEBHOOK_SECRET } from '../boot.js';

/**
 * The completion event, and what it alone may decide (G4, G6).
 *
 * **G6 is the regression gate for this whole wave, and it is the first thing
 * this scenario runs.** For a completed call the platform sends
 * `call.status.updated` carrying the disposition and `answered_by` and only
 * afterwards — post-call processing later, three virtual seconds here — sends
 * `session.completed` with the extraction. The status event carries no call
 * note. An engine that resolved a connected goal contact on the first
 * classified event it saw judged every goal call with none of that call's
 * answers: a person who answered everything on call one was followed up
 * anyway, and every contact settled "not achieved". So this scenario looks at
 * the world **inside the gap** — after
 * the classified status event, before the completion — and asserts that the
 * attempt is closed (the line is freed on time) while the contact is
 * undecided. Then it advances past the completion and asserts the contact
 * settled achieved after ONE dial.
 *
 * G6 also covers the other half of "the completion decides": it decides
 * **once**. A duplicated `session.completed` — the queue's own redelivery
 * shape — changes no counter, no record and no schedule.
 *
 * G4 is the `stop` outcome on a first call: "not interested" settles the
 * contact at once and lists the number **for this campaign only**. A second
 * campaign in the same workspace still dials it, which is the decision the
 * design records and the reason the list moved off the workspace.
 */
const P = {
  ordering: '+919877730010', // one call, outcome `completed`, decided on the completion
  optout: '+919877730011', // "not interested" on the first call
  clean: '+919877730012', // proves the second campaign still dials others
  replay: '+919877730013', // an incomplete call whose completion is delivered twice
};

const HOUR = 60 * MINUTE;

/**
 * One conversation, and the call note the bot came back with.
 *
 * `post_call` is pinned at three seconds here for a reason no other scenario
 * has: G6 steps the virtual clock INTO the gap between the terminal status
 * event and the completion, so both instants have to be known exactly rather
 * than drawn from the 1–3 s range.
 */
const RINGING_SECS = 1;
const HOLD_SECS = 2;
const TALK_SECS = 20;
const POST_CALL_SECS = 3;
/** When the terminal `call.status.updated` fires, relative to the dial. */
const TERMINAL_AT_MS = (RINGING_SECS + HOLD_SECS + TALK_SECS) * 1000;
/** And when `session.completed` follows it. */
const COMPLETION_AT_MS = TERMINAL_AT_MS + POST_CALL_SECS * 1000;

const conversation = (note: Record<string, unknown>) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: TALK_SECS,
  delays_secs: {
    ringing: RINGING_SECS,
    hold: HOLD_SECS,
    talk: TALK_SECS,
    post_call: POST_CALL_SECS,
  },
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

/**
 * The replayed contact's first note, held as one object because the replay
 * below has to POST byte-for-byte what the mock delivered the first time.
 */
const KARAN_NOTE = 'Karan wants a 3BHK, was in a meeting. Open with: "Hi Karan, is this a better time?" Then ask the budget.';
const REPLAY_FIRST_NOTE = {
  call_outcome_vocobaseplatform: 'incomplete',
  call_outcome_reason_vocobaseplatform: 'he was in a meeting',
  immediate_callback_needed_vocobaseplatform: 'no',
  callback_requested_time_vocobaseplatform: 'null',
  next_call_instructions_vocobaseplatform: KARAN_NOTE,
};
const VIKRAM_NOTE = 'Vikram: budget 80L. Nothing left to ask.';

export const goalOptoutReplay: Scenario = {
  name: 'goal-optout-replay',
  rows: ['G4', 'G6'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `goaldnc${d.seed}` });

    // A day's cooldown on the three campaigns whose contacts may be re-armed:
    // the follow-up wait is the retry ladder now, and these scenarios must not
    // have a second dial land inside the window they observe.
    const ordering = await d.seedCampaign(ws, {
      name: 'ordering',
      retryCount: 5,
      cooldownMinutes: 24 * 60,
      contacts: [P.ordering],
    });
    const journey = await d.seedCampaign(ws, {
      name: 'journey',
      retryCount: 5,
      cooldownMinutes: 24 * 60,
      contacts: [P.optout],
    });
    const second = await d.seedCampaign(ws, {
      name: 'second',
      contacts: [P.optout, P.clean],
    });
    const replay = await d.seedCampaign(ws, {
      name: 'replay',
      retryCount: 5,
      cooldownMinutes: 24 * 60,
      contacts: [P.replay],
    });

    await d.script({
      numbers: [
        {
          to_number: P.ordering,
          rules: [done(VIKRAM_NOTE, 'he told me everything on the first call')],
        },
        {
          to_number: P.optout,
          rules: [
            conversation({
              call_outcome_vocobaseplatform: 'stop',
              call_outcome_reason_vocobaseplatform: 'not interested, asked not to be called again',
              immediate_callback_needed_vocobaseplatform: 'no',
              callback_requested_time_vocobaseplatform: 'null',
              next_call_instructions_vocobaseplatform: 'Do not call again.',
            }),
            // The second campaign's own call to the same person. It happens
            // because the list is per campaign — which is the point of G4.
            done('Looking in Kothrud. Nothing left to ask.', 'answered the other campaign'),
          ],
        },
        {
          to_number: P.clean,
          rules: [done('Looking in Wakad. Nothing left to ask.', 'she told me')],
        },
        // The replay contact's own journey continues after the probe; a
        // scripted second call keeps that tail deterministic.
        {
          to_number: P.replay,
          rules: [
            conversation(REPLAY_FIRST_NOTE),
            done('Karan: 3BHK, budget 90L. Nothing left to ask.', 'he gave me the budget'),
          ],
        },
      ],
    });

    const contact = async (campaign: { contactByPhone: Map<string, string> }, phone: string) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({
        where: { id: campaign.contactByPhone.get(phone)! },
      });
    const dialsTo = (phone: string) => d.trace.filter((e) => e.kind === 'dial' && e.phone === phone);

    /* ------------- G6: decided on the event that carries the note --------- */

    /**
     * Alone, and first. Every assertion below is about a single virtual
     * instant, and a second campaign's traffic in the same ticks would only
     * make the trace harder to read when this row goes red.
     */
    await d.start(ws, ordering.campaignId);
    await d.tick();

    const orderingId = ordering.contactByPhone.get(P.ordering)!;
    d.check('G6', dialsTo(P.ordering).length === 1,
      `ordering contact dialed ${dialsTo(P.ordering).length} times on the first tick, expected 1`);

    // Into the gap: one second before the completion is due, so the terminal
    // status event has been delivered and applied and the completion has not.
    d.advanceBy(TERMINAL_AT_MS + 1000);
    await d.tick();

    {
      const attempt = await d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: orderingId, attemptNo: 1 },
      });

      /**
       * The status event really did arrive, and really was classified — the
       * disposition and `answered_by` on the row can only have come from it,
       * and without this check the whole gate would pass vacuously against a
       * platform that had not sent one.
       */
      d.check('G6', attempt.status === 'COMPLETED' && attempt.endedAt !== null,
        `mid-gap: attempt is ${attempt.status} endedAt=${attempt.endedAt?.toISOString()}, expected a closed COMPLETED attempt`);
      d.check('G6', attempt.answeredBy === 'human',
        `mid-gap: the terminal status event carried no classification (answeredBy=${attempt.answeredBy})`);

      /**
       * And the decision was NOT taken. `resolvedAt` null is the mark the
       * completion reads to know the queue move is still its to make; a
       * contact still in the claim states is one nothing has settled or
       * re-armed. An engine that resolved here would have both the stamp and
       * a PENDING contact carrying a follow-up it invented from a note it
       * never saw.
       */
      d.check('G6', attempt.resolvedAt === null,
        `mid-gap: the attempt was resolved at ${attempt.resolvedAt?.toISOString()} — the status event decided a goal call`);

      const c = await contact(ordering, P.ordering);
      d.check('G6', c.status === 'QUEUED' || c.status === 'CALLING',
        `mid-gap: contact is ${c.status}, expected to still be claimed while the note is outstanding`);
      d.check('G6', c.followUpCount === 0 && c.goalAchieved === null && c.nextEligibleAt === null,
        `mid-gap: contact already judged (followUpCount=${c.followUpCount} goalAchieved=${c.goalAchieved} next=${c.nextEligibleAt?.toISOString()})`);
    }

    // Past the completion: the note lands and settles the contact.
    d.advanceBy(COMPLETION_AT_MS - TERMINAL_AT_MS);
    await d.tick();

    {
      const c = await contact(ordering, P.ordering);
      d.check('G6', c.status === 'COMPLETED' && c.goalAchieved === true,
        `ordering contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/true after one call`);
      d.check('G6', c.followUpCount === 0 && c.nextEligibleAt === null,
        `ordering contact was followed up anyway (followUpCount=${c.followUpCount} next=${c.nextEligibleAt?.toISOString()})`);

      const record = await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: orderingId },
      });
      d.check('G6', record.memory === VIKRAM_NOTE,
        `the completion's note was not recorded: ${JSON.stringify(record.memory)}`);
    }

    /* ---------------- G6: the replay, at the armed follow-up ---------------- */

    /**
     * The rest of the scenario runs from here, minutes rather than a day
     * after T0, and deliberately so: `nextEligibleAt` is stamped off the
     * webhook's REAL clock, so a virtual clock already a day ahead would make
     * every follow-up due the instant it was armed — and the replay probe
     * below needs a contact that stays armed while it is being probed. The
     * day-long advance comes at the end, once nothing is left to observe in
     * between.
     */
    d.advanceBy(MINUTE);
    await d.start(ws, journey.campaignId);
    await d.start(ws, replay.campaignId);

    for (let i = 0; i < 3; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    const replayContactId = replay.contactByPhone.get(P.replay)!;
    {
      const c = await contact(replay, P.replay);
      d.check('G6', c.status === 'PENDING' && c.followUpCount === 1,
        `replay contact: expected an armed follow-up first, got ${c.status}/followUpCount=${c.followUpCount}`);
    }

    const RECORD_FIELDS = {
      memory: true,
      memoryAttempt: true,
      lastCallNote: true,
      goalMissing: true,
      attemptLog: true,
    } as const;

    const before = {
      contact: await contact(replay, P.replay),
      record: await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: replayContactId },
        select: RECORD_FIELDS,
      }),
      campaign: await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: replay.campaignId } }),
      dials: dialsTo(P.replay).length,
    };

    // The exact delivery, again: same session, same note, same event key.
    // Signed like the platform signs, POSTed to the real sink, drained through
    // the real worker.
    const attempt = await d.backend.prisma.callAttempt.findFirstOrThrow({
      where: { campaignContactId: replayContactId, attemptNo: 1 },
      select: { upstreamCallId: true, upstreamSessionId: true },
    });
    const body = JSON.stringify({
      event: 'session.completed',
      timestamp: new Date().toISOString(),
      data: {
        session_id: attempt.upstreamSessionId,
        duration_seconds: TALK_SECS,
        extraction: { values: REPLAY_FIRST_NOTE },
        call: {
          call_id: attempt.upstreamCallId,
          status: 'completed',
          disposition: 'completed',
          answered_by: 'human',
          hangup_cause: null,
        },
      },
    });
    const ts = new Date().toISOString();
    const signature = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/webhooks/vocobase`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Webhook-Timestamp': ts,
        'X-Webhook-Signature': signature,
      },
      body,
    });
    d.check('G6', res.status >= 200 && res.status < 300, `replayed delivery answered ${res.status}`);
    await drainWebhookQueue(d.backend);
    await d.tick();

    {
      const after = {
        contact: await contact(replay, P.replay),
        record: await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
          where: { campaignContactId: replayContactId },
          select: RECORD_FIELDS,
        }),
        campaign: await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: replay.campaignId } }),
      };
      d.check('G6', JSON.stringify(after.record) === JSON.stringify(before.record),
        `replay changed the context record: ${JSON.stringify(after.record)} vs ${JSON.stringify(before.record)}`);
      d.check('G6',
        after.contact.followUpCount === 1 &&
          after.contact.status === 'PENDING' &&
          after.contact.nextEligibleAt?.getTime() === before.contact.nextEligibleAt?.getTime(),
        `replay moved the schedule: followUpCount=${after.contact.followUpCount} status=${after.contact.status} ` +
          `next=${after.contact.nextEligibleAt?.toISOString()} (was ${before.contact.nextEligibleAt?.toISOString()})`);
      d.check('G6',
        after.campaign.completedCount === before.campaign.completedCount &&
          after.campaign.failedCount === before.campaign.failedCount,
        `replay drifted the counters: ${after.campaign.completedCount}/${after.campaign.failedCount}`);
      d.check('G6', dialsTo(P.replay).length === before.dials,
        `replay provoked a dial: ${dialsTo(P.replay).length} vs ${before.dials}`);
    }

    /* ---------------- G4: "not interested" on the first call ---------------- */

    const journeyContactId = journey.contactByPhone.get(P.optout)!;
    {
      const c = await contact(journey, P.optout);
      d.check('G4', c.status === 'COMPLETED' && c.goalAchieved === false,
        `opt-out contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/false`);
      d.check('G4', c.nextEligibleAt === null && c.followUpCount === 0,
        `opt-out contact still armed: next=${c.nextEligibleAt?.toISOString()} followUpCount=${c.followUpCount}`);
      d.check('G4', dialsTo(P.optout).length === 1,
        `opt-out contact dialed ${dialsTo(P.optout).length} times, expected 1 — a stop is heard the first time`);

      const listed = await d.backend.prisma.doNotCall.findUnique({
        where: { campaignId_phone: { campaignId: journey.campaignId, phone: P.optout } },
      });
      d.check('G4', listed !== null, 'no DoNotCall row was written for the opt-out');
      d.check('G4', listed?.sourceCampaignContactId === journeyContactId,
        `DoNotCall source is ${listed?.sourceCampaignContactId}, expected the journey contact`);
      d.check('G4', (listed?.reason ?? '') !== '', 'the DoNotCall row carries no reason');

      // And nothing was written for anybody else's campaign. The list is per
      // campaign; a row under the second campaign's id would be the old
      // workspace-wide behaviour wearing a new key.
      const elsewhere = await d.backend.prisma.doNotCall.findMany({
        where: { campaignId: { not: journey.campaignId } },
      });
      d.check('G4', elsewhere.length === 0,
        `${elsewhere.length} do-not-call rows were written outside the campaign that heard the stop`);
    }

    /**
     * The second campaign in the same workspace STILL dials that number. This
     * is the decision the design records and the reverse of what the
     * workspace-wide list used to do: a person who told one campaign to stop
     * has told that campaign, not the company.
     */
    await d.start(ws, second.campaignId);
    for (let i = 0; i < 3; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    {
      const alsoCalled = await contact(second, P.optout);
      d.check('G4', alsoCalled.status === 'COMPLETED' && alsoCalled.goalAchieved === true,
        `the second campaign's contact is ${alsoCalled.status}/goalAchieved=${alsoCalled.goalAchieved}, ` +
          'expected COMPLETED/true — a per-campaign list must not exclude it');
      d.check('G4', dialsTo(P.optout).length === 2,
        `the opt-out number was dialed ${dialsTo(P.optout).length} times in all, expected 2 (one per campaign)`);

      const clean = await contact(second, P.clean);
      d.check('G4', clean.status === 'COMPLETED' && clean.goalAchieved === true,
        `clean contact ended ${clean.status}/goalAchieved=${clean.goalAchieved}`);

      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: second.campaignId } });
      d.check('G4', row.totalContacts === 2,
        `second campaign totalContacts=${row.totalContacts}, expected 2 — nobody was excluded`);
      d.check('G4', row.completedCount === 2 && row.skippedCount === 0,
        `second campaign counters ${row.completedCount}/${row.skippedCount}, expected 2 completed and 0 skipped`);
    }

    /* -------- G6: and the replayed contact's own journey still finishes ----- */

    d.advanceBy(24 * HOUR);
    for (let i = 0; i < 3; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    {
      const c = await contact(replay, P.replay);
      d.check('G6', c.status === 'COMPLETED' && c.goalAchieved === true,
        `replay contact ended ${c.status}/goalAchieved=${c.goalAchieved}, expected COMPLETED/true`);
      d.check('G6', dialsTo(P.replay).length === 2,
        `replay contact dialed ${dialsTo(P.replay).length} times, expected 2`);
      const record = await d.backend.prisma.campaignContactGoal.findUniqueOrThrow({
        where: { campaignContactId: replayContactId },
      });
      const log = record.attemptLog as Array<{
        attemptNo: number;
        outcome: string | null;
        callbackType: string | null;
      }>;
      const decided = log.map((e) => `${e.outcome}/${e.callbackType}`).join(',');
      d.check('G6', log.length === 2 && decided === 'incomplete/flexible,completed/null',
        `replay attempt log: ${decided}, expected incomplete/flexible,completed/null`);
      d.check('G6', record.memory === 'Karan: 3BHK, budget 90L. Nothing left to ask.',
        `replay record holds ${JSON.stringify(record.memory)}, expected the second call's note`);
    }

    // And a day past its own follow-up delay, the contact that settled
    // achieved on ONE call has still only ever been dialled once.
    d.check('G6', dialsTo(P.ordering).length === 1,
      `ordering contact dialed ${dialsTo(P.ordering).length} times in all, expected 1 — a settled contact was re-dialled`);
  },
};
