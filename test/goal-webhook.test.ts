import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When a goal contact is decided, and against what.
 *
 * The platform sends `call.status.updated` for a completed call carrying the
 * disposition and `answered_by` BEFORE it runs extraction, and sends the
 * extraction values on `session.completed` seconds later. YE used to resolve
 * a connected contact on the first classified event it saw — which meant every
 * goal decision was taken against the PREVIOUS calls' record alone, with this
 * call's answers still invisible. A first call that collected everything was
 * followed up anyway. These cases pin the ordering that fixes it, plus the
 * callback promise that must survive the dial budget and the re-arm.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { processWebhookEvent } = await import('../src/services/webhookOutcome.js');
const { scheduleCampaignCallback, MAX_CALLBACKS_PER_CONTACT } = await import(
  '../src/services/campaignCallback.js'
);
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');
const { env } = await import('../src/lib/env.js');

// The resume lane is off by default (`IMMEDIATE_RESUME_ENABLED`), because the
// model over-reports drops. Every test in this file that expects a RESUME is
// exercising the lane as designed, so it is switched on here; the block at
// the bottom pins what the default does instead.
env.immediateResumeEnabled = true;

let seq = 0;

interface SeededAttempt {
  campaignId: string;
  contactId: string;
  attemptId: string;
  sessionId: string;
  callId: string;
}

async function seedGoalAttempt(
  /** `goalEnabled` and `maxTotalDials` are the retired columns, written so a
   *  case can assert the engine ignores them. The live policy is two lane
   *  budgets: `retryCount` for a number nobody answered, `maxGoalFollowUps`
   *  and `followUpDelayHours` for a contact somebody did, and the absolute
   *  ceiling is their sum plus one. */
  options: {
    goalEnabled?: boolean;
    maxTotalDials?: number;
    retryCount?: number;
    maxGoalFollowUps?: number;
    followUpDelayHours?: number;
  } = {},
): Promise<SeededAttempt> {
  seq += 1;
  const account = await makeAccount(`gwh${seq}${Math.random().toString(36).slice(2, 6)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits('100') },
  });
  const workspace = await makeWorkspace(account, 'Hooks');
  const agent = await makeAgent(workspace, 'caller');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Goals',
      agentId: agent.id,
      status: 'RUNNING',
      goalEnabled: options.goalEnabled ?? true,
      // A promised time has to be bookable for the `requested` case; the
      // campaign names no dialing window, so nothing rolls and the instant the
      // call promised is the instant the contact is armed at.
      callbackEnabled: true,
      maxTotalDials: options.maxTotalDials ?? 99,
      // The follow-up lane's own budget and wait, named rather than left at
      // the Prisma default: this file's cases turn on whether a contact is
      // re-armed or settled, which is what this budget now decides.
      maxGoalFollowUps: options.maxGoalFollowUps ?? 2,
      followUpDelayHours: options.followUpDelayHours ?? 24,
      immediateCallbackMinutes: 90,
      ...(options.retryCount === undefined ? {} : { retryCount: options.retryCount }),
    },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: `+91987654${3300 + seq}` },
  });
  const link = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'QUEUED' },
  });
  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: 1,
      kind: 'fresh',
      status: 'QUEUED',
      upstreamCallId: `c_g${seq}`,
      upstreamSessionId: `s_g${seq}`,
      rateCreditsPerMin: toInternalCredits('1.00'),
    },
  });

  return {
    campaignId: campaign.id,
    contactId: link.id,
    attemptId: attempt.id,
    sessionId: `s_g${seq}`,
    callId: `c_g${seq}`,
  };
}

/**
 * The next dial of the same contact — the resume the first re-arm asked for,
 * dialled and now ending. Copies the seeded attempt's row, bumps the ordinal,
 * and puts the contact back under claim so the resolution's guard admits it.
 */
async function seedFollowOnAttempt(s: SeededAttempt, attemptNo: number): Promise<SeededAttempt> {
  const previous = await prisma.callAttempt.findUniqueOrThrow({ where: { id: s.attemptId } });
  const suffix = `${seq}_${attemptNo}`;
  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: previous.campaignId,
      campaignContactId: previous.campaignContactId,
      workspaceId: previous.workspaceId,
      accountId: previous.accountId,
      attemptNo,
      kind: 'resume',
      status: 'QUEUED',
      upstreamCallId: `c_g${suffix}`,
      upstreamSessionId: `s_g${suffix}`,
      rateCreditsPerMin: previous.rateCreditsPerMin,
    },
  });
  await prisma.campaignContact.update({
    where: { id: s.contactId },
    data: { status: 'QUEUED', attempts: { increment: 1 } },
  });

  return { ...s, attemptId: attempt.id, sessionId: `s_g${suffix}`, callId: `c_g${suffix}` };
}

/** The classified status event: the disposition and `answered_by`, and no
 *  extraction — exactly what the platform sends first. */
const statusEvent = (s: SeededAttempt, over: Record<string, unknown> = {}) => ({
  kind: 'webhook' as const,
  event: 'call.status.updated',
  data: {
    call_id: s.callId,
    session_id: s.sessionId,
    status: 'completed',
    disposition: 'completed',
    answered_by: 'human',
    ...over,
  },
  receivedAtIso: new Date().toISOString(),
});

/**
 * The seven keys as the bot answers them; a case names only the fields it is
 * about. `callbackType` is this helper's own convenience parameter — there is
 * no `callback_type` key any more, and contender I derives it instead: an
 * `'immediate'` here writes `immediate_callback_needed_vocobaseplatform:
 * 'yes'`, and a `'requested'` writes a real, parseable
 * `callback_requested_time` (overridable through `over`, applied last).
 */
const said = (
  outcome: string,
  callbackType: 'requested' | 'immediate' | 'flexible' | 'null' = 'null',
  over: Record<string, unknown> = {},
) => ({
  call_outcome_vocobaseplatform: outcome,
  call_outcome_reason_vocobaseplatform: 'null',
  immediate_callback_needed_vocobaseplatform: callbackType === 'immediate' ? 'yes' : 'no',
  immediate_callback_needed_reason_vocobaseplatform: 'null',
  callback_requested_time_vocobaseplatform:
    callbackType === 'requested' ? '2026-09-08T17:00+05' : 'null',
  next_call_instructions_vocobaseplatform: 'null',
  ...over,
});

const NOTE = 'next_call_instructions_vocobaseplatform';
const TIME = 'callback_requested_time_vocobaseplatform';

/** The completion event, seconds later, carrying the call note. */
const completion = (s: SeededAttempt, values: Record<string, unknown>) => ({
  kind: 'webhook' as const,
  event: 'session.completed',
  data: {
    session_id: s.sessionId,
    duration_seconds: 60,
    extraction: { values },
    call: {
      call_id: s.callId,
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
    },
  },
  receivedAtIso: new Date().toISOString(),
});

const contactRow = (id: string) => prisma.campaignContact.findUniqueOrThrow({ where: { id } });
const goalRecord = (id: string) =>
  prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: id } });

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

describe('goal decisions wait for the completion event', () => {
  it('a classified status event on a connected goal call frees the line and resolves nothing', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(statusEvent(s));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: s.attemptId } });
    // The line is freed on time...
    expect(attempt.status).toBe('COMPLETED');
    // ...and the decision is left to the event that carries the note.
    expect(attempt.resolvedAt).toBeNull();
    expect((await contactRow(s.contactId)).status).toBe('QUEUED');
  });

  it('the completion event then records the note BEFORE deciding, and decides on the outcome', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(statusEvent(s));
    await processWebhookEvent(completion(s, said('completed', 'null', { [NOTE]: 'Priya.' })));

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(true);

    const r = await goalRecord(s.contactId);
    expect(r.memory).toBe('Priya.');
    expect(r.memoryAttempt).toBe(1);
    expect(r.lastCallNote).toBe('spoke, completed');
  });

  /**
   * The bug, stated as a single call: everything was collected on the first
   * conversation. Judged on the status event alone the record was still empty
   * and the contact was followed up; judged on the completion it settles after
   * ONE dial.
   */
  it('settles a first call that met the goal, rather than following it up', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(statusEvent(s));
    await processWebhookEvent(completion(s, said('completed', 'null', { [NOTE]: 'Priya, 2BHK, 50L.' })));

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(true);
    expect(c.followUpCount).toBe(0);
    expect(c.nextEligibleAt).toBeNull();
  });

  it('a silence still resolves on the status event', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(
      statusEvent(s, { status: 'no_answer', disposition: null, answered_by: null }),
    );

    // The retry ladder arms on the pacing event exactly as it always has.
    expect((await contactRow(s.contactId)).status).toBe('PENDING');
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: s.attemptId } });
    expect(attempt.resolvedAt).not.toBeNull();
  });

  /**
   * The record has to move on the SAME event that re-arms the contact. A
   * silence resolves on the status event, seconds before its completion
   * arrives — and the retry it arms may dial before then. A record written
   * only by the completion leaves that dial telling the model the last call
   * was the conversation before the voicemail.
   */
  it('a silence on the status event writes its own last-call line and leaves the note alone', async () => {
    const s = await seedGoalAttempt();
    await processWebhookEvent(statusEvent(s));
    await processWebhookEvent(completion(s, said('incomplete', 'flexible', { [NOTE]: 'Nikhil, on the road.' })));
    expect((await goalRecord(s.contactId)).lastCallNote).toBe('spoke, worth calling again');

    // The follow-up is claimed and dialled: attempt two, on the same contact.
    const first = await prisma.callAttempt.findUniqueOrThrow({ where: { id: s.attemptId } });
    await prisma.campaignContact.update({ where: { id: s.contactId }, data: { status: 'CALLING' } });
    const second = await prisma.callAttempt.create({
      data: {
        campaignId: s.campaignId,
        campaignContactId: s.contactId,
        workspaceId: first.workspaceId,
        accountId: first.accountId,
        attemptNo: 2,
        kind: 'follow_up',
        status: 'IN_PROGRESS',
        upstreamCallId: `${s.callId}-vm`,
        upstreamSessionId: `${s.sessionId}-vm`,
        rateCreditsPerMin: first.rateCreditsPerMin,
      },
    });
    const s2: SeededAttempt = { ...s, attemptId: second.id, callId: `${s.callId}-vm`, sessionId: `${s.sessionId}-vm` };

    // The machine picks up. Only the status event has arrived so far.
    await processWebhookEvent(statusEvent(s2, { disposition: 'voicemail', answered_by: 'machine' }));

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    // The voicemail is a MISSED FOLLOW-UP on a contact somebody has already
    // answered, so it spends a second follow-up rather than a retry. Under the
    // one-budget rule it went back on the retry ladder and left this at 1.
    expect(c.followUpCount).toBe(2);
    expect(c.armKind).toBe('FOLLOW_UP');
    expect(c.attempts).toBe(0);

    const r = await goalRecord(s.contactId);
    expect(r.lastCallNote).toBe('reached voicemail');
    expect(r.memory).toBe('Nikhil, on the road.');
    expect(r.memoryAttempt).toBe(1);
    expect((r.attemptLog as { attemptNo: number }[]).map((e) => e.attemptNo)).toEqual([1, 2]);

    // The completion that follows changes none of that; it only adds the duration.
    await processWebhookEvent({
      kind: 'webhook' as const,
      event: 'session.completed',
      data: {
        session_id: s2.sessionId,
        duration_seconds: 8,
        extraction: { values: {} },
        call: { call_id: s2.callId, status: 'completed', disposition: 'voicemail', answered_by: 'machine' },
      },
      receivedAtIso: new Date().toISOString(),
    });
    const after = await goalRecord(s.contactId);
    expect(after.lastCallNote).toBe('reached voicemail');
    expect(after.memory).toBe('Nikhil, on the road.');
    expect((after.attemptLog as { attemptNo: number; durationSecs?: number }[]).at(-1)).toMatchObject({
      attemptNo: 2,
      durationSecs: 8,
    });
  });

  it('a replayed completion changes nothing', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(completion(s, said('incomplete', 'flexible', { [NOTE]: 'A' })));
    const before = await goalRecord(s.contactId);

    await processWebhookEvent(completion(s, said('incomplete', 'flexible', { [NOTE]: 'A' })));
    const after = await goalRecord(s.contactId);

    expect(after.attemptLog).toEqual(before.attemptLog);
    expect(after.memory).toBe('A');
    expect((await contactRow(s.contactId)).followUpCount).toBe(1);
    // And the duplicate charged nothing twice — the marker still holds.
    expect(await prisma.creditTransaction.count({ where: { type: 'CALL_USAGE' } })).toBe(1);
  });

  it('records a silence too, so every attempt leaves a note', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent({
      kind: 'webhook' as const,
      event: 'session.completed',
      data: {
        session_id: s.sessionId,
        duration_seconds: 0,
        // A silence as the platform reports it on the completion: the status
        // stands in for the disposition, and nobody picked up.
        call: {
          call_id: s.callId,
          status: 'no_answer',
          disposition: 'no_answer',
          answered_by: 'not_answered',
        },
      },
      receivedAtIso: new Date().toISOString(),
    });

    const r = await goalRecord(s.contactId);
    expect(r.memory).toBeNull();
    expect(r.lastCallNote).toBe('the call was not answered');
    expect((r.attemptLog as unknown[]).length).toBe(1);
  });

  /** The record is written for every campaign now, the stored switch
   *  included: the call-note set is attached to every agent, and a note the
   *  next call needs is not the switch's to withhold. */
  it('writes the record even when the stored switch says false', async () => {
    const s = await seedGoalAttempt({ goalEnabled: false });

    await processWebhookEvent(completion(s, said('incomplete', 'flexible', { [NOTE]: 'A' })));

    const r = await goalRecord(s.contactId);
    expect(r.memory).toBe('A');
    expect((r.attemptLog as unknown[]).length).toBe(1);
  });

  /**
   * The specification's time shape, `YYYY-MM-DDTHH:mm±HH`: the booking reads
   * the two-digit offset as `±HH:00`, so 17:00 at +05 is 12:00 UTC. Built
   * five days ahead rather than on the specification's own 2026-09-08, so the
   * case does not rot past that day.
   */
  it('incomplete + requested with a readable time books the callback after the re-arm', async () => {
    const s = await seedGoalAttempt();
    const ymd = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const raw = `${ymd}T17:00+05`;

    await processWebhookEvent(completion(s, said('incomplete', 'requested', { [TIME]: raw })));

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.followUpCount).toBe(1);
    expect(c.callbackAt?.toISOString()).toBe(`${ymd}T12:00:00.000Z`);
    // The promised instant beats the follow-up delay the re-arm wrote.
    expect(c.nextEligibleAt?.getTime()).toBe(c.callbackAt?.getTime());
    // The line the next call's record carries, with the time as the model
    // wrote it.
    expect((await goalRecord(s.contactId)).lastCallNote).toBe(
      `spoke, asked to be called back: ${raw}`,
    );
  });

  /**
   * There is no `callback_type` key any more, so "requested but no time" is
   * not a shape the model can produce: `callbackType` is `'requested'` only
   * when `callback_requested_time` is itself a real, parseable value. A
   * "null" time (or an absent one) derives `'flexible'` instead, and the
   * cooldown ladder's wait stands exactly as it does for a flexible note.
   */
  it('a "null" time is read as flexible, and the follow-up wait stands', async () => {
    const s = await seedGoalAttempt({ followUpDelayHours: 6 });
    const before = Date.now();

    await processWebhookEvent(completion(s, said('incomplete', 'null', { [TIME]: 'null' })));

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.callbackAt).toBeNull();
    expect(c.followUpCount).toBe(1);
    // `followUpDelayHours`, not the two-hour cooldown beside it: the cooldown
    // times a number nobody answered, and this contact answered.
    const gap = c.nextEligibleAt!.getTime() - before;
    expect(gap).toBeGreaterThanOrEqual(6 * 3_600_000 - 1_000);
    expect(gap).toBeLessThan(6 * 3_600_000 + 60_000);
    expect((await goalRecord(s.contactId)).lastCallNote).toBe('spoke, worth calling again');
  });

  it('a requested callback nobody could read leaves the follow-up standing', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(
      completion(s, said('incomplete', 'requested', { [TIME]: 'sometime soon' })),
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.callbackAt).toBeNull();
    expect(c.followUpCount).toBe(1);
  });

  /** An unreadable time beside `immediate_callback_needed = yes` is not a
   *  promise: the drop resumes on its own gap, and nothing is booked. */
  it('incomplete + immediate (no real time) resumes on its own gap, armed as a resume', async () => {
    const s = await seedGoalAttempt();
    const before = Date.now();

    await processWebhookEvent(
      completion(s, said('incomplete', 'immediate', { [TIME]: 'sometime soon' })),
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    // RESUME, so this takes the resume lane — ahead of every retry, and
    // bounded by the reservation it shares with them.
    expect(c.armKind).toBe('RESUME');
    // The model wrote something unreadable beside `immediate`; nobody's time
    // was ever established, so nothing records a promise.
    expect(c.callbackAt).toBeNull();
    expect(c.followUpCount).toBe(1);
    expect(c.attempts).toBe(0);
    /**
     * The resume gap is the fixed `IMMEDIATE_CALLBACK_MINUTES`, 3 minutes.
     * The band is the wall clock's own slack and nothing more — an engine
     * reaching for the retry cooldown, for the campaign's stored
     * `immediateCallbackMinutes`, or for a multiple of the gap has to fail
     * here.
     */
    const gap = c.nextEligibleAt!.getTime() - before;
    expect(gap).toBeGreaterThanOrEqual(3 * 60_000 - 1_000);
    expect(gap).toBeLessThan(4 * 60_000);
  });

  /**
   * Once an hour, not once a gap. The first immediate stamps the contact
   * with the moment it landed; a second immediate inside the hour is armed a
   * whole hour out from now — still a RESUME, still spending a follow-up —
   * rather than ringing the same dropped line every five minutes for as
   * long as the dial budget lasts. The anchor moves to the second one.
   */
  it('stamps the first immediate, and pushes a second one inside the hour out to now + 1h', async () => {
    const s = await seedGoalAttempt();
    const before = Date.now();

    await processWebhookEvent(completion(s, said('incomplete', 'immediate')));

    const first = await contactRow(s.contactId);
    expect(first.armKind).toBe('RESUME');
    expect(first.lastImmediateAt).not.toBeNull();
    expect(first.lastImmediateAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(first.nextEligibleAt!.getTime() - before).toBeLessThan(6 * 60_000);

    // The resumed call, ten minutes on, drops again.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await prisma.campaignContact.update({
      where: { id: s.contactId },
      data: { lastImmediateAt: tenMinutesAgo },
    });
    const again = await seedFollowOnAttempt(s, 2);
    const secondBefore = Date.now();

    await processWebhookEvent(completion(again, said('incomplete', 'immediate')));

    const second = await contactRow(s.contactId);
    expect(second.status).toBe('PENDING');
    expect(second.armKind).toBe('RESUME');
    expect(second.callbackAt).toBeNull();
    expect(second.followUpCount).toBe(2);
    const gap = second.nextEligibleAt!.getTime() - secondBefore;
    expect(gap).toBeGreaterThanOrEqual(60 * 60_000 - 1_000);
    expect(gap).toBeLessThan(61 * 60_000);
    expect(second.lastImmediateAt!.getTime()).toBeGreaterThanOrEqual(secondBefore);
  });

  /** An immediate after the hour has closed is a fresh drop: the campaign's
   *  own gap again, and the anchor moves to it. */
  it('resumes on the gap again once the last immediate is more than an hour old', async () => {
    const s = await seedGoalAttempt();
    await prisma.campaignContact.update({
      where: { id: s.contactId },
      data: { lastImmediateAt: new Date(Date.now() - 90 * 60_000) },
    });
    const before = Date.now();

    await processWebhookEvent(completion(s, said('incomplete', 'immediate')));

    const c = await contactRow(s.contactId);
    expect(c.armKind).toBe('RESUME');
    const gap = c.nextEligibleAt!.getTime() - before;
    expect(gap).toBeGreaterThanOrEqual(3 * 60_000 - 1_000);
    expect(gap).toBeLessThan(4 * 60_000);
    expect(c.lastImmediateAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  /** A follow-up between two drops leaves the anchor alone: only an
   *  immediate moves it. */
  it('leaves lastImmediateAt untouched on a plain follow-up', async () => {
    const s = await seedGoalAttempt();
    const stamp = new Date(Date.now() - 10 * 60_000);
    await prisma.campaignContact.update({
      where: { id: s.contactId },
      data: { lastImmediateAt: stamp },
    });

    await processWebhookEvent(completion(s, said('incomplete', 'flexible')));

    const c = await contactRow(s.contactId);
    expect(c.armKind).toBe('FOLLOW_UP');
    expect(c.lastImmediateAt?.toISOString()).toBe(stamp.toISOString());
  });

  /**
   * A time that parses but cannot be booked — here the model echoed a stamp
   * from before the call ended, which the key's own description points it
   * at — is not a promise either. The derived type is `requested`, but the
   * booking would refuse the time and leave the contact on the follow-up
   * delay; the flag the model actually answered keeps the resume lane.
   */
  it('incomplete + immediate beside a stale parseable time still resumes on its own gap', async () => {
    const s = await seedGoalAttempt();
    const before = Date.now();
    const stale = new Date(before - 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    await processWebhookEvent(
      completion(s, said('incomplete', 'immediate', { [TIME]: stale })),
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.armKind).toBe('RESUME');
    expect(c.callbackAt).toBeNull();
    expect(c.followUpCount).toBe(1);
    const gap = c.nextEligibleAt!.getTime() - before;
    expect(gap).toBeGreaterThanOrEqual(3 * 60_000 - 1_000);
    expect(gap).toBeLessThan(4 * 60_000);
  });

  /**
   * The precedence rule, end to end: a real, parseable `callback_requested_time`
   * beats `immediate_callback_needed = "yes"`. The time's own description
   * tells the model to null it out when immediate is "yes", so a real time
   * arriving anyway means the model disobeyed that instruction — and the
   * explicit, bookable promise wins over the flag it was told to defer to.
   * This is contender I's restatement of contender H's own rule, where an
   * explicit callback request always took priority over "immediate" or
   * "flexible".
   */
  it('a real requested time beats immediate_callback_needed = yes, and books the callback', async () => {
    const s = await seedGoalAttempt();
    const ymd = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const raw = `${ymd}T17:00+05`;

    await processWebhookEvent(
      completion(s, said('incomplete', 'immediate', { [TIME]: raw })),
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.armKind).toBe('CALLBACK');
    expect(c.callbackAt?.toISOString()).toBe(`${ymd}T12:00:00.000Z`);
    expect(c.followUpCount).toBe(1);
  });

  it('a stop lists the number and settles not achieved', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(
      completion(s, said('stop', 'null', { call_outcome_reason_vocobaseplatform: 'wrong number' })),
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(false);
    const phone = (await prisma.campaignContact.findUniqueOrThrow({
      where: { id: s.contactId },
      include: { contact: true },
    })).contact.phone;
    expect(
      (await prisma.doNotCall.findUnique({
        where: { campaignId_phone: { campaignId: s.campaignId, phone } },
      }))?.reason,
    ).toBe('wrong number');
  });

  /**
   * A goal campaign's agent may share the agent with a plain callbacks
   * campaign and so still answer `callback_requested_at`. That key is not
   * this campaign's: the booking never reads it, and neither may the record
   * — a last-call line saying "asked to be called back: <that time>" would
   * tell the next call about a promise this campaign never booked.
   */
  it('the record ignores a plain callbacks key the shared agent answered', async () => {
    const s = await seedGoalAttempt();
    const ymd = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

    await processWebhookEvent(
      completion(s, {
        ...said('incomplete', 'flexible', { call_outcome_reason_vocobaseplatform: 'busy' }),
        callback_requested_at: `${ymd}T17:00:00+05:30`,
      }),
    );

    const c = await contactRow(s.contactId);
    expect(c.callbackAt).toBeNull();
    const r = await goalRecord(s.contactId);
    expect(r.lastCallNote).toBe('spoke, worth calling again: busy');
    expect((r.attemptLog as Record<string, unknown>[])[0]).not.toHaveProperty('callbackNote');
  });

  /** An extraction nobody could read is a follow-up, never a judgement. */
  it('an unreadable extraction follows up at the delay and records no outcome', async () => {
    const s = await seedGoalAttempt();

    await processWebhookEvent(completion(s, { call_outcome_vocobaseplatform: 'maybe' }));

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.followUpCount).toBe(1);
    expect(c.goalAchieved).toBeNull();
    const r = await goalRecord(s.contactId);
    expect(r.memory).toBeNull();
    expect(r.lastCallNote).toBe('spoke, but no outcome was recorded');
    expect((r.attemptLog as Record<string, unknown>[])[0]).toMatchObject({ outcome: null });
  });
});

describe('a callback promise against the dial budget', () => {
  async function resolved(
    options: {
      maxTotalDials?: number;
      goalEnabled?: boolean;
      retryCount?: number;
      maxGoalFollowUps?: number;
    } = {},
  ) {
    const seeded = await seedGoalAttempt(options);
    await prisma.campaignContact.update({
      where: { id: seeded.contactId },
      data: { status: 'COMPLETED' },
    });
    await prisma.callAttempt.update({ where: { id: seeded.attemptId }, data: { attemptNo: 2 } });
    return seeded;
  }

  it('refuses the booking once the budget is spent', async () => {
    // `retryCount: 1` with no follow-ups is a ceiling of two, and the
    // contact's second dial has already been placed. The stored
    // `maxTotalDials: 99` beside it is the assertion that the retired column
    // buys nothing.
    const { contactId } = await resolved({ retryCount: 1, maxGoalFollowUps: 0, maxTotalDials: 99 });

    const outcome = await scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: new Date(Date.now() + 3_600_000),
      attemptNo: 2,
    });

    expect(outcome).toBe('DIAL_BUDGET_EXHAUSTED');
    const row = await contactRow(contactId);
    expect(row.status).toBe('COMPLETED');
    expect(row.callbackAt).toBeNull();
    expect(row.callbackCount).toBe(0);
  });

  /** A promised callback IS placed at the last dial the budget allows: with
   *  `retryCount: 2` the budget is three, two are spent, and the third is the
   *  promise. Past it — the case above — the promise cannot be kept. */
  it('books the last dial the budget allows', async () => {
    const below = await resolved({ retryCount: 2, maxGoalFollowUps: 0 });

    expect(
      await scheduleCampaignCallback({
        campaignContactId: below.contactId,
        callbackAt: new Date(Date.now() + 3_600_000),
        attemptNo: 2,
      }),
    ).toBe('SCHEDULED');
  });

  /** The stored switch buys no exemption from the budget either. */
  it('refuses it on a campaign whose stored switch says false', async () => {
    const { contactId } = await resolved({ goalEnabled: false, retryCount: 1, maxGoalFollowUps: 0 });

    expect(
      await scheduleCampaignCallback({
        campaignContactId: contactId,
        callbackAt: new Date(Date.now() + 3_600_000),
        attemptNo: 2,
      }),
    ).toBe('DIAL_BUDGET_EXHAUSTED');
  });
});

describe('a callback promise over the follow-up re-arm', () => {
  it('books over a contact the goal re-arm left PENDING, moving no counter', async () => {
    const { contactId, campaignId } = await seedGoalAttempt();
    // The state the goal re-arm writes: PENDING, armed FOLLOW_UP, followUpCount
    // moved, no promise standing.
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: {
        status: 'PENDING',
        armKind: 'FOLLOW_UP',
        followUpCount: 1,
        nextEligibleAt: new Date(Date.now() + 24 * 3_600_000),
      },
    });

    const at = new Date(Date.now() + 2 * 3_600_000);
    const outcome = await scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: at,
      attemptNo: 1,
    });

    expect(outcome).toBe('SCHEDULED');
    const row = await contactRow(contactId);
    expect(row.callbackAt).toEqual(at);
    expect(row.nextEligibleAt).toEqual(at); // the promise beats the delay
    expect(row.callbackCount).toBe(1);
    // The booking is the only writer of this arm, and it overwrites the one
    // the resolution wrote a moment ago.
    expect(row.armKind).toBe('CALLBACK');

    // The re-arm was never counted settled, so nothing was handed back.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.completedCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
  });

  it('still refuses a PENDING contact on a non-goal campaign', async () => {
    const { contactId } = await seedGoalAttempt({ goalEnabled: false });
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: { status: 'PENDING', nextEligibleAt: new Date(Date.now() + 1_800_000) },
    });

    const outcome = await scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: new Date(Date.now() + 3_600_000),
      attemptNo: 1,
    });

    expect(outcome).toBe('NOT_RESOLVED');
  });

  it('never overwrites a promise already standing', async () => {
    const { contactId } = await seedGoalAttempt();
    const standing = new Date(Date.now() + 3_600_000);
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: {
        status: 'PENDING',
        armKind: 'CALLBACK',
        followUpCount: 1,
        callbackAt: standing,
        nextEligibleAt: standing,
        callbackCount: 1,
      },
    });

    const outcome = await scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: new Date(Date.now() + 7_200_000),
      attemptNo: 1,
    });

    expect(outcome).toBe('NOT_RESOLVED');
    const row = await contactRow(contactId);
    expect(row.callbackAt).toEqual(standing);
    expect(row.callbackCount).toBe(1);
  });

  /**
   * A resume, on the other hand, is bookable over. The engine picked that
   * instant off a dropped call; the lead has now named one, and the design
   * says the explicit time wins. Under the timestamp pair the two states were
   * one state, so this booking was refused as "a promise already standing" —
   * and the person who said "call me at four" was rung five minutes later
   * instead.
   */
  it('books over the engine’s own resume, which is not a promise', async () => {
    const { contactId } = await seedGoalAttempt();
    const resumeAt = new Date(Date.now() + 5 * 60_000);
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: {
        status: 'PENDING',
        armKind: 'RESUME',
        followUpCount: 1,
        nextEligibleAt: resumeAt,
      },
    });

    const promised = new Date(Date.now() + 7_200_000);
    const outcome = await scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: promised,
      attemptNo: 1,
    });

    expect(outcome).toBe('SCHEDULED');
    const row = await contactRow(contactId);
    expect(row.armKind).toBe('CALLBACK');
    expect(row.callbackAt).toEqual(promised);
    expect(row.nextEligibleAt).toEqual(promised);
  });

  it('still honours the per-contact callback cap', async () => {
    const { contactId } = await seedGoalAttempt();
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: {
        status: 'PENDING',
        followUpCount: 1,
        callbackCount: MAX_CALLBACKS_PER_CONTACT,
        nextEligibleAt: new Date(Date.now() + 24 * 3_600_000),
      },
    });

    const outcome = await scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: new Date(Date.now() + 3_600_000),
      attemptNo: 1,
    });

    expect(outcome).toBe('LIMIT_REACHED');
  });
});

describe('with IMMEDIATE_RESUME_ENABLED off, the default', () => {
  beforeEach(() => {
    env.immediateResumeEnabled = false;
  });
  afterEach(() => {
    env.immediateResumeEnabled = true;
  });

  it('follows up a dropped call on the retry ladder, and stamps no resume anchor', async () => {
    const s = await seedGoalAttempt();
    const before = Date.now();

    await processWebhookEvent(
      completion(s, said('incomplete', 'immediate', { [TIME]: 'sometime soon' })),
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.armKind).toBe('FOLLOW_UP');
    expect(c.lastImmediateAt).toBeNull();
    expect(c.callbackAt).toBeNull();
    expect(c.followUpCount).toBe(1);
    expect(c.attempts).toBe(0);
    // Not the three-minute gap: at least the retry ladder's first wait.
    const gap = c.nextEligibleAt!.getTime() - before;
    expect(gap).toBeGreaterThanOrEqual(4 * 60_000);
  });
});
