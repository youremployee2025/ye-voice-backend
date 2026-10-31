import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type {
  Account,
  CallAttemptStatus,
  Campaign,
  CampaignContact,
  Workspace,
} from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * One contact's whole history on one campaign.
 *
 * The cases here are mostly about honesty: a contact that has never been
 * dialled and one whose attempt rows are gone both produce an empty timeline,
 * and the page must be able to tell them apart — a blank screen that means
 * "nothing has happened yet" and one that means "we lost the record" are
 * different things to show somebody.
 */

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const auth = as('user_alice', 'alice@ezo.test');

async function setup(campaignFields: Partial<Campaign> = {}) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Q3',
      status: 'RUNNING',
      retryCount: 3,
      cooldownMinutes: 30,
      ...campaignFields,
    },
  });

  return { alice, ws, campaign };
}

let seq = 0;

async function addContact(
  ws: Workspace,
  campaign: Campaign,
  fields: Partial<CampaignContact> = {},
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: ws.id,
      phone: `+9198765${String(43000 + seq).padStart(5, '0')}`,
      name: 'Asha',
      email: 'asha@example.com',
      tags: ['vip'],
      metadata: { city: 'Pune' },
    },
  });

  return prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, ...fields },
  });
}

let attemptSeq = 0;

async function addAttempt(
  ws: Workspace,
  owner: Account,
  campaign: Campaign,
  link: CampaignContact,
  fields: {
    attemptNo: number;
    startedAt: Date;
    resolvedAt?: Date | null;
    durationSecs?: number | null;
    disposition?: string | null;
    fromNumber?: string | null;
    withCallId?: boolean;
    costCredits?: bigint | null;
    kind?: string | null;
    /** Defaulted from `resolvedAt`; named explicitly for the dials that
     *  resolved without ever connecting. */
    status?: CallAttemptStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    endCallReason?: string | null;
  },
) {
  attemptSeq += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: ws.id,
      accountId: owner.id,
      attemptNo: fields.attemptNo,
      startedAt: fields.startedAt,
      resolvedAt: fields.resolvedAt ?? null,
      durationSecs: fields.durationSecs ?? null,
      disposition: fields.disposition ?? null,
      fromNumber: fields.fromNumber ?? null,
      costCredits: fields.costCredits ?? null,
      kind: fields.kind ?? null,
      status: fields.status ?? (fields.resolvedAt ? 'COMPLETED' : 'IN_PROGRESS'),
      errorCode: fields.errorCode ?? null,
      errorMessage: fields.errorMessage ?? null,
      endCallReason: fields.endCallReason ?? null,
      ...(fields.withCallId === false
        ? {}
        : {
            upstreamCallId: `call_${attemptSeq}`,
            upstreamSessionId: `sess_${attemptSeq}`,
          }),
    },
  });
}

const url = (ws: Workspace, campaign: Campaign, linkId: string) =>
  `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${linkId}/journey`;

const kinds = (body: { data: { events: { kind: string }[] } }) =>
  body.data.events.map((event) => event.kind);

describe('GET .../contacts/:id/journey', () => {
  it('answers an honest empty timeline for a contact nobody has called', async () => {
    const { ws, campaign } = await setup();
    const link = await addContact(ws, campaign);

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    // True, and it means "there is nothing to show" rather than "we lost it".
    expect(res.body.data.attemptsRecorded).toBe(true);
    expect(res.body.data.inFlight).toBeNull();
    expect(res.body.data.campaign).toMatchObject({
      id: campaign.id,
      name: 'Q3',
      retryCount: 3,
      cooldownMinutes: 30,
      retryDelaysMinutes: [],
    });
    expect(res.body.data.contact).toMatchObject({
      campaignContactId: link.id,
      name: 'Asha',
      email: 'asha@example.com',
      tags: ['vip'],
      metadata: { city: 'Pune' },
      status: 'PENDING',
      attempts: 0,
      callbackCount: 0,
      callbackPending: false,
      // A display string, not a float: a balance must not lose its hundredths.
      creditsUsed: '0',
    });
  });

  it('says so when a contact was dialled and the attempt rows are gone', async () => {
    const { ws, campaign } = await setup();
    // Contact-level state that only a past dial can produce, with no attempt
    // rows behind it. Every field here survives a re-arm, so none of them can
    // be reset by later activity.
    const link = await addContact(ws, campaign, {
      status: 'COMPLETED',
      attempts: 2,
      lastAttemptAt: new Date(),
      lastSessionId: 'sess_gone',
      disposition: 'no_answer',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.attemptsRecorded).toBe(false);
  });

  /**
   * The arms `hasEverDialed` has that `HAS_BEEN_DIALED_SQL` does not, pinned
   * one at a time.
   *
   * The two predicates ask the same English question — "has anybody ever
   * dialled this contact" — from different sides, and the near-miss invites
   * somebody to unify them. This is what that would cost: each row below
   * carries a **single** piece of dial evidence, and every one of them has to
   * be enough on its own, or the journey answers "there is nothing to show"
   * about a contact whose attempt rows were pruned. `attemptsRecorded` claims
   * the rows are complete; it is the one flag on this payload that must never
   * be optimistic.
   *
   * `lastAttemptAt` is the load-bearing one — the claim stamps it on every dial
   * in every lane — and it is the whole of the query-side predicate every
   * other campaign panel reads, for that reason. The rows either side of it
   * are why this one is a superset rather than the same rule.
   */
  it.each([
    ['the claim timestamp', { lastAttemptAt: new Date() }],
    ['a session id', { lastSessionId: 'sess_gone' }],
    ['a recorded outcome', { disposition: 'no_answer' }],
    ['a consumed retry', { attempts: 1 }],
    ['a booked callback', { callbackCount: 1 }],
  ])('reports the attempt rows missing off %s alone', async (_label, evidence) => {
    const { ws, campaign } = await setup();
    // Every column zeroed or null first, so the spread below is the row's
    // ONLY piece of dial evidence and each arm has to carry the verdict on its
    // own. Without the reset, a row could pass on an arm it did not set.
    const link = await addContact(ws, campaign, {
      status: 'COMPLETED',
      attempts: 0,
      callbackCount: 0,
      followUpCount: 0,
      lastAttemptAt: null,
      lastSessionId: null,
      disposition: null,
      ...evidence,
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.attemptsRecorded).toBe(false);
  });

  it('draws the retry ladder with the cooldown actually served between dials', async () => {
    const { alice, ws, campaign } = await setup({ retryDelaysMinutes: [15, 45] });
    const link = await addContact(ws, campaign, { attempts: 2, status: 'PENDING' });
    const t0 = new Date('2026-08-01T09:00:00.000Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: at(1),
      durationSecs: 12,
      disposition: 'no_answer',
      fromNumber: '+14155550100',
    });
    // 20 minutes served against a scheduled 15.
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 2,
      startedAt: at(21),
      resolvedAt: at(22),
      durationSecs: 8,
      disposition: 'busy',
    });
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 3,
      startedAt: at(70),
      resolvedAt: at(71),
      durationSecs: 90,
      disposition: 'completed',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(kinds(res.body)).toEqual([
      'attempt',
      'cooldown',
      'attempt',
      'cooldown',
      'attempt',
    ]);
    expect(res.body.data.events[0]).toMatchObject({
      attemptNo: 1,
      disposition: 'no_answer',
      answeredBy: null,
      fromNumber: '+14155550100',
      durationSecs: 12,
      sessionId: expect.stringContaining('sess_'),
      // The recording route resolves the upstream CALL id, so the journey must
      // hand the page that handle — the session id alone cannot play audio.
      callId: expect.stringContaining('call_'),
      hasRecording: true,
    });
    // Measured and scheduled are reported side by side because they routinely
    // disagree in the honest direction: the sweep runs on an interval, so
    // served is normally a little more than scheduled.
    expect(res.body.data.events[1]).toMatchObject({
      kind: 'cooldown',
      servedMinutes: 20,
      scheduledMinutes: 15,
    });
    expect(res.body.data.events[3]).toMatchObject({
      servedMinutes: 48,
      scheduledMinutes: 45,
    });
  });

  /**
   * A SYSTEM_ERROR nobody answered is handed back free: it takes an ordinal
   * and spends no retry, so from then on the ordinal is ahead of the retry
   * index and no ladder entry is honest. The same fourth kind an `errorCode`
   * marks — through the field the platform actually emits.
   */
  it('stops printing ladder entries after a free SYSTEM_ERROR give-back', async () => {
    const { alice, ws, campaign } = await setup({ retryDelaysMinutes: [15, 45] });
    const link = await addContact(ws, campaign, { attempts: 2, status: 'PENDING' });
    const t0 = new Date('2026-09-15T09:00:00.000Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    await addAttempt(ws, alice, campaign, link, { attemptNo: 1, startedAt: t0, resolvedAt: at(1), durationSecs: 0, disposition: 'no_answer' });
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 2, startedAt: at(21), resolvedAt: at(22), durationSecs: 0, disposition: 'failed', status: 'FAILED', endCallReason: 'SYSTEM_ERROR',
    });
    await addAttempt(ws, alice, campaign, link, { attemptNo: 3, startedAt: at(30), resolvedAt: at(31), durationSecs: 0, disposition: 'no_answer' });
    await addAttempt(ws, alice, campaign, link, { attemptNo: 4, startedAt: at(80), resolvedAt: at(81), durationSecs: 90, disposition: 'completed' });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    const scheduled = res.body.data.events
      .filter((event: { kind: string }) => event.kind === 'cooldown')
      .map((event: { scheduledMinutes: number | null }) => event.scheduledMinutes);
    expect(scheduled).toEqual([null, null, null]);
    expect(res.body.data.events[2].failureReason).toContain('not counted');
  });

  /**
   * The gap belongs to the dial that ends it, and it is read off the next
   * attempt's KIND rather than off the ordinal.
   *
   * A resume waits the fixed `IMMEDIATE_CALLBACK_MINUTES`. A retry and a
   * follow-up both walk the retry ladder — they have shared it since
   * 2026-09-06 — but the ladder is indexed by the retry counter, and a
   * contact that has taken a resume or a follow-up no longer has an ordinal
   * that tracks it. So both come back null here, which is the truth: the
   * measured gap is drawn alone rather than labelled with some other
   * attempt's wait. Read off the ordinal alone — which is what this did,
   * because a resume left no mark the ordinal could see — the page reported a
   * three-minute wait as the campaign's thirty-minute cooldown, on the
   * timeline whose whole job is saying what happened and when.
   *
   * The stored `immediateCallbackMinutes: 5` and `followUpDelayHours: 24` are
   * written deliberately: neither appears in the answer.
   */
  it('names the gap the policy that scheduled it actually applied', async () => {
    const { alice, ws, campaign } = await setup({
      goalEnabled: true,
      retryDelaysMinutes: [15],
      immediateCallbackMinutes: 5,
      followUpDelayHours: 24,
    });
    const link = await addContact(ws, campaign, { attempts: 1, followUpCount: 2 });
    const t0 = new Date('2026-08-01T09:00:00.000Z');
    const at = (m: number) => new Date(t0.getTime() + m * 60_000);

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: at(1),
      kind: 'fresh',
    });
    // The drop, resumed five minutes later.
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 2,
      startedAt: at(6),
      resolvedAt: at(7),
      kind: 'resume',
    });
    // Then a plain follow-up, a day out.
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 3,
      startedAt: at(24 * 60 + 8),
      resolvedAt: at(24 * 60 + 9),
      kind: 'follow_up',
    });
    // And a retry, which is the only one the ladder speaks for.
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 4,
      startedAt: at(24 * 60 + 25),
      kind: 'retry',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    const scheduled = res.body.data.events
      .filter((event: { kind: string }) => event.kind === 'cooldown')
      .map((event: { scheduledMinutes: number | null }) => event.scheduledMinutes);

    // The fixed resume gap, and then nothing for either the follow-up or the
    // retry: two dials have taken an ordinal without spending a retry, so the
    // ladder cannot be indexed by the ordinal any more and the measured gap
    // stands alone rather than being labelled with some other attempt's wait.
    expect(scheduled).toEqual([3, null, null]);
  });

  it('drops a gap that runs backwards rather than drawing a negative cooldown', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1 });
    const t0 = new Date('2026-08-01T09:00:00.000Z');

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: new Date(t0.getTime() + 30 * 60_000),
    });
    // Clock skew: the next dial starts before the previous one resolved.
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 2,
      startedAt: new Date(t0.getTime() + 10 * 60_000),
      resolvedAt: new Date(t0.getTime() + 40 * 60_000),
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(kinds(res.body)).toEqual(['attempt', 'attempt']);
  });

  it('shows a live promise once, and stops printing a schedule after a callback', async () => {
    const { alice, ws, campaign } = await setup({ retryDelaysMinutes: [15] });
    const promised = new Date(Date.now() + 3 * 60 * 60_000);
    const link = await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 1,
      callbackCount: 1,
      // The arm the booking wrote, which is what makes the promise live.
      armKind: 'CALLBACK',
      nextEligibleAt: promised,
      callbackAt: promised,
    });
    const t0 = new Date('2026-08-01T09:00:00.000Z');

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: new Date(t0.getTime() + 60_000),
    });
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 2,
      startedAt: new Date(t0.getTime() + 20 * 60_000),
      resolvedAt: new Date(t0.getTime() + 21 * 60_000),
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(kinds(res.body)).toEqual(['attempt', 'cooldown', 'attempt', 'callback_due']);
    expect(res.body.data.contact.callbackPending).toBe(true);
    expect(res.body.data.events[3]).toMatchObject({ at: promised.toISOString() });
    // A callback took an attempt number without spending a retry, so the
    // ordinal and the retry index have diverged: the measured gap stands, the
    // schedule does not.
    expect(res.body.data.events[1]).toMatchObject({
      servedMinutes: 19,
      scheduledMinutes: null,
    });
  });

  it('keeps a kept promise out of the timeline', async () => {
    const { ws, campaign } = await setup();
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    const link = await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 1,
      callbackCount: 1,
      // History: the ladder re-armed this contact and left the promise behind
      // as the only record that one was ever made. Nobody is owed a call.
      armKind: 'RETRY',
      nextEligibleAt: new Date(Date.now() + 60 * 60_000),
      callbackAt: past,
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(kinds(res.body)).not.toContain('callback_due');
    expect(res.body.data.contact.callbackPending).toBe(false);
  });

  /**
   * Defence in depth over the same fact. A settle clears `nextEligibleAt` and
   * deliberately leaves the arm behind as history, so a settled row carrying
   * `CALLBACK` is the ordinary state and not a corruption — a promise is owed
   * only by a contact that is still **waiting**, and a reader that decided
   * this from the arm alone would believe every settled row it is handed.
   * `COMPLETED` is not waiting for anything.
   */
  it.each(['COMPLETED', 'FAILED', 'SKIPPED', 'EXCLUDED', 'QUEUED'] as const)(
    'never promises a call on a %s contact, whatever arm it carries',
    async (status) => {
      const { ws, campaign } = await setup();
      const promised = new Date(Date.now() + 3 * 60 * 60_000);
      const link = await addContact(ws, campaign, {
        status,
        attempts: 1,
        callbackCount: 1,
        armKind: 'CALLBACK',
        nextEligibleAt: promised,
        callbackAt: promised,
      });

      const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

      expect(res.body.data.contact.callbackPending).toBe(false);
      expect(kinds(res.body)).not.toContain('callback_due');
    },
  );

  /**
   * A resume is drawn as its own thing, and never as a promise.
   *
   * The `immediate` re-arm used to arm the timestamp pair to reach the
   * dispatcher's callback lane, so this page told whoever read it that the
   * lead had asked to be rung at an instant the lead never heard of — and the
   * contact block reported `callbackPending`, which is the sentence an
   * operator acts on before dialling.
   */
  it('draws an engine-chosen resume as a resume, not as a promise', async () => {
    const { ws, campaign } = await setup();
    const resumeAt = new Date(Date.now() + 5 * 60_000);
    const link = await addContact(ws, campaign, {
      status: 'PENDING',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: resumeAt,
      // A promise kept a fortnight ago, still on the row as the only record
      // that one was made.
      callbackAt: new Date(Date.now() - 14 * 24 * 60 * 60_000),
      callbackCount: 1,
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(kinds(res.body)).toContain('resume_due');
    expect(kinds(res.body)).not.toContain('callback_due');
    expect(res.body.data.contact).toMatchObject({
      callbackPending: false,
      armKind: 'RESUME',
    });
    // The instant the queue will act on, not the promise the row remembers.
    const resume = res.body.data.events.find((e: { kind: string }) => e.kind === 'resume_due');
    expect(resume.at).toBe(resumeAt.toISOString());
  });

  it('is the only place a live dial appears', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { status: 'QUEUED' });
    const started = new Date();

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: started,
      resolvedAt: null,
      fromNumber: '+14155550100',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.inFlight).toMatchObject({
      attemptNo: 1,
      fromNumber: '+14155550100',
      startedAt: started.toISOString(),
    });
  });

  it('sums what was actually charged, from the ledger', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { status: 'COMPLETED', attempts: 1 });
    const t0 = new Date('2026-08-01T09:00:00.000Z');

    const charged = await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: new Date(t0.getTime() + 60_000),
      costCredits: 20_000n,
    });
    const owed = await addAttempt(ws, alice, campaign, link, {
      attemptNo: 2,
      startedAt: new Date(t0.getTime() + 60 * 60_000),
      resolvedAt: new Date(t0.getTime() + 61 * 60_000),
      costCredits: 50_000n,
    });

    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        workspaceId: ws.id,
        callAttemptId: charged.id,
        reference: charged.id,
        amount: -20_000n,
        type: 'CALL_USAGE',
      },
    });
    // The second call could not be paid for: a zero-amount marker, and nothing
    // debited. Counting its `costCredits` would show a workspace spending
    // credits it still has.
    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        workspaceId: ws.id,
        callAttemptId: owed.id,
        reference: owed.id,
        amount: 0n,
        type: 'CALL_USAGE_SHORTFALL',
      },
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.contact.creditsUsed).toBe('2');
  });

  it('caps a corrupted history rather than reading it all', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1 });
    const t0 = new Date('2026-08-01T09:00:00.000Z');

    await prisma.callAttempt.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ws.id,
        accountId: alice.id,
        attemptNo: index + 1,
        startedAt: new Date(t0.getTime() + index * 60 * 60_000),
        resolvedAt: new Date(t0.getTime() + index * 60 * 60_000 + 60_000),
      })),
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    const attempts = res.body.data.events.filter((e: { kind: string }) => e.kind === 'attempt');
    expect(attempts).toHaveLength(200);
    expect(attempts[0].attemptNo).toBe(1);
  });

  it('reports no recording for an attempt that never reached the platform', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1 });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date(),
      resolvedAt: new Date(),
      // A real conversation, so the duration arm is satisfied and the missing
      // id is the ONLY reason to withhold playback. Without this the row is
      // null on both arms and the test passes for two independent reasons —
      // which makes it unable to fail when the id arm is dropped, and it is
      // the only test pinning that arm.
      durationSecs: 60,
      withCallId: false,
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ hasRecording: false, sessionId: null });
  });

  /**
   * An upstream id is not audio.
   *
   * A launch the platform refused, a blocked number and a carrier failure all
   * record an id and zero seconds. Offering a Play link on one of those is a
   * row promising what only a 404 can answer, and the reader finds that out by
   * clicking.
   */
  it('offers no recording for a call that never connected', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1, status: 'FAILED' });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date(),
      resolvedAt: new Date(),
      // The id exists — but nobody ever spoke.
      durationSecs: 0,
      status: 'FAILED',
      disposition: 'failed',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({
      // Still handed over: the panel needs it to ask the call detail what is
      // actually there. It is the *affordance* that is withheld, not the id.
      callId: expect.stringContaining('call_'),
      hasRecording: false,
    });
  });

  /**
   * A duration nothing ever wrote is **not** the zero the settle paths write.
   *
   * Every terminal settle stamps a number — `?? 0` in `webhookOutcome.ts` and
   * `dialerReaper.ts`'s reconcile — so a `COMPLETED` attempt whose duration is
   * still null was never settled by one of them. It is the reaper's other
   * stamp (`dialerReaper.ts`): an attempt an unclassified pacing event closed
   * as COMPLETED, whose completion webhook never arrived, given a `resolvedAt`
   * and nothing else. The carrier says the call was answered and ended; only
   * our record of how long it ran is missing, and the recording is upstream
   * where it always was. Read as zero, that answered call lost its Play button
   * on the strength of a number nothing wrote.
   */
  it('offers a recording for an answered call whose duration was never reported', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1, status: 'COMPLETED' });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date(),
      // Resolved — the reaper stamped it — with no duration ever reported.
      resolvedAt: new Date(),
      durationSecs: null,
      status: 'COMPLETED',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ hasRecording: true });
  });

  /**
   * The null duration that is **not** an answered call, and the reason the
   * null arm is gated on the status rather than on `resolvedAt` alone.
   *
   * `dialerReaper.ts` stamps `resolvedAt` on a terminal attempt whose outcome
   * was never classified — and that sweep takes `FAILED` as well as
   * `COMPLETED`. A carrier failure records an upstream id, no duration and now
   * a resolution stamp; there is no audio of a call the carrier could not
   * place, and a Play button there spends a click to reach a 404.
   */
  it('offers no recording for a failed call whose duration was never reported', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1, status: 'FAILED' });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date(),
      resolvedAt: new Date(),
      durationSecs: null,
      status: 'FAILED',
      disposition: 'failed',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ hasRecording: false });
  });

  /**
   * The other one the reaper closes: `ABANDONED`.
   *
   * It reaches that state from `QUEUED`, `RINGING` or `IN_PROGRESS` — including
   * the branch where the call detail still says `ringing` or `queued` long past
   * the timeout. "We never found out" is not "somebody answered", and a
   * telephone that was still ringing when we gave up on it has no recording to
   * offer.
   */
  it('offers no recording for a call the reaper abandoned while it was ringing', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1 });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date(),
      resolvedAt: new Date(),
      durationSecs: null,
      status: 'ABANDONED',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ hasRecording: false });
  });

  /**
   * The other half of that: a null duration on a dial nothing has closed out
   * is a telephone that may still be ringing, and there is no recording of a
   * call that has not ended. `resolvedAt` is what tells the two nulls apart,
   * and it is the same stamp the journey already reads to decide whether an
   * attempt is the live one.
   */
  it('offers no recording for a dial that has not been closed out', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1, status: 'CALLING' });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      status: 'COMPLETED',
      startedAt: new Date(),
      resolvedAt: null,
      durationSecs: null,
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ hasRecording: false });
  });

  it('still offers a recording for a call that carried a conversation', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 1, status: 'COMPLETED' });

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date(),
      resolvedAt: new Date(),
      durationSecs: 42,
      disposition: 'completed',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ hasRecording: true });
  });

  /**
   * A dial the platform ended before the carrier tested the number produced
   * nothing — no disposition worth reading, no audio, no retry spent — and
   * the journey has to be able to say why, or an operator reads a row of
   * nulls and blames the contact.
   */
  it('says why a dial the platform ended produced nothing', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 0, status: 'PENDING' });
    const t0 = new Date('2026-09-07T09:00:00.000Z');

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: new Date(t0.getTime() + 60_000),
      durationSecs: 0,
      disposition: 'failed',
      status: 'FAILED',
      errorCode: 'PENDING_TIMEOUT',
      errorMessage: 'Session reaped before connect',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({
      kind: 'attempt',
      errorCode: 'PENDING_TIMEOUT',
      errorMessage: 'Session reaped before connect',
      hasRecording: false,
      // The sentence the page prints. No code in it.
      failureReason: expect.stringContaining('gave up on this call before it connected'),
    });
    expect(res.body.data.events[0].failureReason).not.toContain('PENDING_TIMEOUT');
  });

  it('carries a null reason on an ordinary dial', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { attempts: 0, status: 'PENDING' });
    const t0 = new Date('2026-09-07T09:00:00.000Z');

    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: t0,
      resolvedAt: new Date(t0.getTime() + 60_000),
      durationSecs: 40,
      disposition: 'completed',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.body.data.events[0]).toMatchObject({ errorCode: null, errorMessage: null, failureReason: null });
  });

  it('404s a contact row that belongs to another campaign of the same workspace', async () => {
    const { ws, campaign } = await setup();
    const other = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Other' } });
    const link = await addContact(ws, other);

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('is readable by a MEMBER and 404s across workspaces', async () => {
    const { ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const ok = await request(app)
      .get(url(ws, campaign, link.id))
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(ok.status).toBe(200);

    const other = await makeWorkspace(bob, 'B Co');
    const crossed = await request(app)
      .get(url(other, campaign, link.id))
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe('NOT_FOUND');
  });
});

/**
 * What the journey adds for a goal campaign.
 *
 * Three additions, and each answers a question the page could not answer
 * before: what the agent knows about this person and what the goal still
 * needs, why they will not be called again, and — per attempt — what kind of
 * dial it was and what the agent decided at the end of it.
 */
describe('the goal additions', () => {
  const AT = new Date('2026-08-30T10:00:00Z');

  async function goalContact(
    goalEnabled: boolean,
    link: Partial<CampaignContact> = {},
    record?: {
      memory?: string;
      lastCallNote?: string;
      goalMissing?: string;
      log?: unknown[];
    },
  ) {
    const { alice, ws, campaign } = await setup({ goalEnabled });
    const contact = await addContact(ws, campaign, link);

    if (record) {
      await prisma.campaignContactGoal.create({
        data: {
          campaignContactId: contact.id,
          attemptLog: (record.log ?? []) as never,
          ...(record.memory === undefined ? {} : { memory: record.memory }),
          ...(record.lastCallNote === undefined ? {} : { lastCallNote: record.lastCallNote }),
          ...(record.goalMissing === undefined ? {} : { goalMissing: record.goalMissing }),
        },
      });
    }

    return { alice, ws, campaign, contact };
  }

  const fetch = (
    ctx: { ws: Workspace; campaign: Campaign; contact: CampaignContact },
  ) => request(app).get(url(ctx.ws, ctx.campaign, ctx.contact.id)).set(...auth);

  /** The block is present on every campaign now — including one whose stored
   *  switch says false, which is the only way to prove the column is unread.
   *  Empty rather than absent: a contact nobody has spoken to yet has no
   *  verdict, which is a different fact from "this campaign has no goal", and
   *  there is no longer such a campaign for the null to mean. */
  it('is present, and empty, on a campaign whose stored switch is off', async () => {
    const ctx = await goalContact(false);

    const res = await fetch(ctx);

    expect(res.status).toBe(200);
    expect(res.body.data.goal).toMatchObject({
      achieved: null,
      followUpCount: 0,
      memory: null,
      lastCallNote: '',
    });
  });

  /** Exact, not a subset: a `goal` string reappearing here is the page being
   *  told this campaign owns wording that lives in the agent's prompt. */
  it('reports the decision, the follow-ups, the call note and the last-call line', async () => {
    const ctx = await goalContact(
      true,
      { goalAchieved: false, followUpCount: 2 },
      {
        memory: 'Asha, looking in Baner, 2BHK.',
        lastCallNote: 'spoke, worth calling again: wants to check with her husband',
        goalMissing: 'the budget and the move-in month',
      },
    );

    const res = await fetch(ctx);

    expect(res.body.data.goal).toEqual({
      achieved: false,
      followUpCount: 2,
      memory: 'Asha, looking in Baner, 2BHK.',
      lastCallNote: 'spoke, worth calling again: wants to check with her husband',
      goalMissing: 'the budget and the move-in month',
    });
  });

  /** Null until a settle judges it — which is not the same as false, and a
   *  page that collapsed the two would report a live contact as a loss. */
  it('leaves the decision null before anything settles it', async () => {
    const ctx = await goalContact(true, {}, {});

    expect((await fetch(ctx)).body.data.goal).toMatchObject({
      achieved: null,
      memory: null,
      goalMissing: null,
    });
  });

  /**
   * Before the first dial resolves there is no record at all. The three prose
   * fields still have to be present and honest: nulls for the two the bot
   * writes, and an empty note — never null — because YE derives the note on
   * every attempt and "" is exactly "no attempt recorded yet".
   */
  it('reports an empty context before the record exists', async () => {
    const ctx = await goalContact(true);

    expect((await fetch(ctx)).body.data.goal).toMatchObject({
      memory: null,
      lastCallNote: '',
      goalMissing: null,
    });
  });

  describe('the opt-out block', () => {
    it('is null when the phone is not on the list', async () => {
      const ctx = await goalContact(true);

      expect((await fetch(ctx)).body.data.optOut).toBeNull();
    });

    /** Present whether or not the EXCLUDED settle has caught up: the list is
     *  checked at claim time, so a listed contact is not going to be dialled
     *  either way. */
    it('says why, whatever status the contact is still carrying', async () => {
      const ctx = await goalContact(true);
      const phone = (await prisma.contact.findUniqueOrThrow({
        where: { id: ctx.contact.contactId },
      })).phone;

      await prisma.doNotCall.create({
        data: { campaignId: ctx.campaign.id, phone, reason: 'Asked not to be called again.' },
      });

      expect((await fetch(ctx)).body.data.optOut)
        .toMatchObject({ reason: 'Asked not to be called again.' });
    });

    /** Always on, never a knob: a campaign whose stored switch is off still
     *  shows it. */
    it('is present on a campaign whose stored switch is off', async () => {
      const ctx = await goalContact(false);
      const phone = (await prisma.contact.findUniqueOrThrow({
        where: { id: ctx.contact.contactId },
      })).phone;

      await prisma.doNotCall.create({
        data: { campaignId: ctx.campaign.id, phone, reason: 'opted out' },
      });

      const res = await fetch(ctx);
      expect(res.body.data.optOut).toMatchObject({ reason: 'opted out' });
    });

    /**
     * The scoping decision, on the journey. Another campaign of the SAME
     * workspace listing this number says nothing about this campaign, and a
     * page that showed it would tell the operator their contact will not be
     * called when in fact this campaign is still dialling them.
     */
    it('never reads another campaign’s list', async () => {
      const ctx = await goalContact(true);
      const phone = (await prisma.contact.findUniqueOrThrow({
        where: { id: ctx.contact.contactId },
      })).phone;
      const sibling = await prisma.campaign.create({
        data: { workspaceId: ctx.ws.id, name: 'Renewals', status: 'RUNNING', retryCount: 3 },
      });

      await prisma.doNotCall.create({
        data: { campaignId: sibling.id, phone, reason: 'theirs' },
      });

      expect((await fetch(ctx)).body.data.optOut).toBeNull();
    });
  });

  describe('the per-attempt annotation', () => {
    it('carries the claim’s kind stamp on every attempt', async () => {
      const ctx = await goalContact(true);
      await addAttempt(ctx.ws, ctx.alice, ctx.campaign, ctx.contact, {
        attemptNo: 1,
        startedAt: AT,
        resolvedAt: AT,
        kind: 'follow_up',
      });

      const attempt = (await fetch(ctx)).body.data.events.find(
        (event: { kind: string }) => event.kind === 'attempt',
      );

      expect(attempt.attemptKind).toBe('follow_up');
    });

    /** Null on rows from before the stamp existed; readers fall back to the
     *  ordinal, and the payload says so rather than guessing. */
    it('reports a missing stamp as null rather than inventing one', async () => {
      const ctx = await goalContact(true);
      await addAttempt(ctx.ws, ctx.alice, ctx.campaign, ctx.contact, {
        attemptNo: 1,
        startedAt: AT,
        resolvedAt: AT,
      });

      const attempt = (await fetch(ctx)).body.data.events.find(
        (event: { kind: string }) => event.kind === 'attempt',
      );

      expect(attempt.attemptKind).toBeNull();
      // No context record, so no goal annotation either.
      expect(attempt.goal).toBeUndefined();
    });

    /**
     * The annotation carries the call note's decision fields as the bot said
     * them, plus `nextAction` — the dashboard's four-word reading of the same
     * note, derived on the way out so the page's labels need not change in
     * the release that changed the contract.
     */
    it('annotates the attempt the context record logged, and only that one', async () => {
      const ctx = await goalContact(
        true,
        {},
        {
          memory: 'Open with the budget question.',
          log: [
            {
              attemptNo: 1,
              kind: 'fresh',
              disposition: 'completed',
              answeredBy: 'human',
              outcome: 'incomplete',
              callbackType: 'requested',
              callbackRequestedTime: '2026-09-08T17:00+05',
              reason: 'busy at work',
              callbackNote: 'tomorrow after 5pm',
            },
          ],
        },
      );

      for (const attemptNo of [1, 2]) {
        await addAttempt(ctx.ws, ctx.alice, ctx.campaign, ctx.contact, {
          attemptNo,
          startedAt: new Date(AT.getTime() + attemptNo * 60_000),
          resolvedAt: new Date(AT.getTime() + attemptNo * 60_000),
        });
      }

      const events = (await fetch(ctx)).body.data.events.filter(
        (event: { kind: string }) => event.kind === 'attempt',
      );

      expect(events[0].goal).toEqual({
        kind: 'fresh',
        outcome: 'incomplete',
        callbackType: 'requested',
        reason: 'busy at work',
        nextAction: 'call_back_at',
        callbackNote: 'tomorrow after 5pm',
      });
      // The webhook has not recorded the second one: "no goal context" is the
      // truth, and is not the same as "the agent reached no outcome".
      expect(events[1].goal).toBeUndefined();
    });

    /** The compatibility mapping, row by row, as the page sees it. */
    it('folds each decision onto the dashboard’s four words', async () => {
      const rows: [Record<string, unknown>, string | null][] = [
        [{ outcome: 'completed' }, 'done'],
        [{ outcome: 'stop', reason: 'wrong number' }, 'stop'],
        [{ outcome: 'incomplete', callbackType: 'requested' }, 'call_back_at'],
        [{ outcome: 'incomplete', callbackType: 'immediate' }, 'call_again'],
        [{ outcome: 'incomplete', callbackType: 'flexible' }, 'call_again'],
        [{ outcome: 'incomplete' }, 'call_again'],
      ];
      const ctx = await goalContact(true, {}, {
        log: rows.map(([fields], i) => ({
          attemptNo: i + 1, kind: i === 0 ? 'fresh' : 'follow_up',
          disposition: 'completed', answeredBy: 'human', ...fields,
        })),
      });
      for (let i = 0; i < rows.length; i++) {
        await addAttempt(ctx.ws, ctx.alice, ctx.campaign, ctx.contact, {
          attemptNo: i + 1,
          startedAt: new Date(AT.getTime() + (i + 1) * 60_000),
          resolvedAt: new Date(AT.getTime() + (i + 1) * 60_000),
        });
      }

      const events = (await fetch(ctx)).body.data.events.filter(
        (event: { kind: string }) => event.kind === 'attempt',
      );

      expect(events.map((e: { goal: { nextAction: string | null } }) => e.goal.nextAction))
        .toEqual(rows.map(([, nextAction]) => nextAction));
    });

    /**
     * A conversation whose extraction never came back, or came back outside
     * the vocabulary, was decided as `flexible` by the engine — but the
     * journey does not say so. It shows a null outcome, which is "no outcome",
     * never a decision the bot did not make.
     */
    it('says "no outcome" for a conversation the bot left undecided', async () => {
      const ctx = await goalContact(true, {}, {
        log: [{
          attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human',
          outcome: 'ring me', callbackType: null, callbackRequestedTime: null, reason: null,
        }],
      });
      await addAttempt(ctx.ws, ctx.alice, ctx.campaign, ctx.contact, {
        attemptNo: 1, startedAt: AT, resolvedAt: AT,
      });

      const attempt = (await fetch(ctx)).body.data.events.find(
        (event: { kind: string }) => event.kind === 'attempt',
      );

      expect(attempt.goal).toEqual({
        kind: 'fresh', outcome: null, callbackType: null, reason: null, nextAction: null,
      });
    });
  });

  /**
   * The third counter, beside the other two on the contact block rather than
   * only inside the goal block — a campaign whose goal was cleared can still
   * hold a contact that was followed up under it.
   */
  it('carries followUpCount on the contact beside the other two counters', async () => {
    const ctx = await goalContact(true, { attempts: 1, callbackCount: 1, followUpCount: 2 });

    expect((await fetch(ctx)).body.data.contact)
      .toMatchObject({ attempts: 1, callbackCount: 1, followUpCount: 2 });
  });

  /** The counter is on the contact, not inside the goal block, so it is
   *  readable without unwrapping one. Asserted on a campaign whose stored
   *  switch says false, which is where it used to be the only readout. */
  it('carries it whatever the stored goal switch says', async () => {
    const ctx = await goalContact(false, { followUpCount: 1 });

    const res = await fetch(ctx);

    expect(res.body.data.contact.followUpCount).toBe(1);
  });
});

describe('inbound calls in the journey', () => {
  async function addInbound(
    ws: Workspace,
    campaign: Campaign,
    link: CampaignContact,
    arrivedAt: Date,
    ids: { upstreamCallId?: string | null; upstreamPhoneCallId?: string | null } = {},
  ) {
    const did = await prisma.phoneNumber.create({
      data: { did: `+9180${Math.floor(Math.random() * 1e7)}`, workspaceId: ws.id, status: 'ASSIGNED' },
    });
    return prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        contactId: link.contactId,
        workspaceId: ws.id,
        phoneNumberId: did.id,
        fromNumber: '+919876543210',
        arrivedAt,
        endedAt: arrivedAt,
        durationSecs: 33,
        disposition: 'answered',
        ...ids,
      },
    });
  }

  it('merges an inbound call into the timeline, tagged as inbound', async () => {
    const { ws, alice, campaign } = await setup();
    const link = await addContact(ws, campaign);
    await addAttempt(ws, alice, campaign, link, {
      attemptNo: 1,
      startedAt: new Date('2026-09-09T10:00:00Z'),
      resolvedAt: new Date('2026-09-09T10:01:00Z'),
      disposition: 'no_answer',
    });
    await addInbound(ws, campaign, link, new Date('2026-09-09T11:00:00Z'));

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.status).toBe(200);
    expect(kinds(res.body)).toContain('inbound_call');
    const inbound = res.body.data.events.find((e: { kind: string }) => e.kind === 'inbound_call');
    expect(inbound).toMatchObject({ direction: 'inbound', disposition: 'answered', durationSecs: 33 });
    // Ordered by instant: the 10:00 attempt sorts before the 11:00 inbound call.
    expect(kinds(res.body).indexOf('attempt')).toBeLessThan(kinds(res.body).indexOf('inbound_call'));
  });

  it('a contact with only an inbound call is not reported as an empty timeline', async () => {
    const { ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    await addInbound(ws, campaign, link, new Date('2026-09-09T11:00:00Z'));

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    expect(res.status).toBe(200);
    expect(kinds(res.body)).toEqual(['inbound_call']);
    expect(res.body.data.attemptsRecorded).toBe(true);
  });

  /**
   * The two ids describing one inbound call come from different namespaces, and
   * only one of them resolves.
   *
   * `upstreamCallId` is the CARRIER's `provider_call_id` — the only id the
   * routing policy carries, and the one the settle correlates on.
   * `upstreamPhoneCallId` is Vocobase's own `PhoneCall.id`, learned at
   * completion, and the only id `GET /api/v2/calls/:id` accepts. The journey
   * hands its `callId` to the recording route, so it must be the second — the
   * first is a guaranteed 404, which reads on the page as a spinner that never
   * stops.
   */
  it('carries the call id the calls surface can resolve, not the carrier id', async () => {
    const { ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    await addInbound(ws, campaign, link, new Date('2026-09-09T11:00:00Z'), {
      upstreamCallId: 'carrier-provider-call-id',
      upstreamPhoneCallId: 'platform-phone-call-id',
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    const inbound = res.body.data.events.find((e: { kind: string }) => e.kind === 'inbound_call');
    expect(inbound.callId).toBe('platform-phone-call-id');
    expect(inbound.hasRecording).toBe(true);
  });

  it('reports no recording for a call the platform never gave us an id for', async () => {
    // The imported history, and every call settled before the
    // `upstreamPhoneCallId` column existed. Saying `hasRecording: true` here
    // opens a panel that can only ever spin.
    const { ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    await addInbound(ws, campaign, link, new Date('2026-09-09T11:00:00Z'), {
      upstreamCallId: 'carrier-provider-call-id',
      upstreamPhoneCallId: null,
    });

    const res = await request(app).get(url(ws, campaign, link.id)).set(...auth);

    const inbound = res.body.data.events.find((e: { kind: string }) => e.kind === 'inbound_call');
    expect(inbound.callId).toBeNull();
    expect(inbound.hasRecording).toBe(false);
  });
});
