import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const SECRET = 'w'.repeat(48);
process.env.VOCOBASE_WEBHOOK_SECRET = SECRET;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { dialBudgetSpent } = await import('../src/lib/dialBudget.js');
const { signWebhook } = await import('../src/lib/webhookSignature.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');
const { MAX_STORED_EXTRACTION_VALUE_CHARS } = await import('../src/lib/extractionCapture.js');
const { drainWebhooks, clearWebhooks, closeWebhookQueue } = await import('./webhook-pass.js');

const app = createApp();

interface Fixture {
  accountId: string;
  workspaceId: string;
  campaignId: string;
  contactId: string;
  attemptId: string;
}

async function seedAttempt(overrides: { rate?: string; credits?: string } = {}): Promise<Fixture> {
  const account = await makeAccount(`w${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits(overrides.credits ?? '100') },
  });

  const workspace = await makeWorkspace(account, 'Hooked');
  const agent = await makeAgent(workspace, 'caller');

  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'Outreach', agentId: agent.id, status: 'RUNNING' },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: '+919876543210' },
  });
  const link = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'QUEUED', attempts: 1 },
  });
  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: 1,
      status: 'QUEUED',
      upstreamCallId: 'c_1',
      upstreamSessionId: 's_1',
      rateCreditsPerMin: toInternalCredits(overrides.rate ?? '1.00'),
    },
  });

  return {
    accountId: account.id,
    workspaceId: workspace.id,
    campaignId: campaign.id,
    contactId: link.id,
    attemptId: attempt.id,
  };
}

/**
 * Signs a delivery, posts it, and **runs the work it enqueued**.
 *
 * The handler's job is now verification and nothing else, so a case that
 * asserted "after this delivery the contact is FAILED" is asserting about the
 * worker, not about the handler. The drain is what keeps every one of those
 * assertions saying what it always said.
 */
async function deliver(payload: unknown, options: { secret?: string; timestamp?: string } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? new Date().toISOString();

  const res = await request(app)
    .post('/webhooks/vocobase')
    .set('Content-Type', 'application/json')
    .set('X-Webhook-Timestamp', timestamp)
    .set('X-Webhook-Signature', signWebhook(body, timestamp, options.secret ?? SECRET))
    .send(body);

  await drainWebhooks();

  return res;
}

const completion = (over: Record<string, unknown> = {}, call: Record<string, unknown> = {}) => ({
  event: 'session.completed',
  timestamp: new Date().toISOString(),
  data: {
    session_id: 's_1',
    duration_seconds: 120,
    credits_used: 2.12,
    ...over,
    call: {
      call_id: 'c_1',
      from_number: '+918011223344',
      to_number: '+919876543210',
      direction: 'outbound',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
      ...call,
    },
  },
});

beforeEach(async () => {
  await truncateAll();
  await clearWebhooks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(closeWebhookQueue);

describe('verification', () => {
  it('accepts a correctly signed delivery', async () => {
    await seedAttempt();

    await expect(deliver(completion())).resolves.toMatchObject({ status: 200 });
  });

  it('rejects an unsigned delivery and writes nothing', async () => {
    const { attemptId } = await seedAttempt();

    const res = await request(app)
      .post('/webhooks/vocobase')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(completion()));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_UNVERIFIED');

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('QUEUED');
    expect(attempt.chargedAt).toBeNull();
  });

  it('rejects a delivery signed with the wrong secret', async () => {
    await seedAttempt();

    const res = await deliver(completion(), { secret: 'x'.repeat(48) });

    expect(res.status).toBe(401);
  });

  /**
   * The body is what is signed, so altering one byte must break it. This is
   * the case that would fail if the route verified a re-serialized object
   * rather than the bytes received.
   */
  it('rejects a body altered after signing', async () => {
    await seedAttempt();

    const body = JSON.stringify(completion());
    const timestamp = new Date().toISOString();
    const signature = signWebhook(body, timestamp, SECRET);

    const res = await request(app)
      .post('/webhooks/vocobase')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', signature)
      .send(body.replace('"duration_seconds":120', '"duration_seconds":9999'));

    expect(res.status).toBe(401);
  });

  it('rejects a replayed delivery from outside the skew window', async () => {
    await seedAttempt();

    const stale = new Date(Date.now() - 10 * 60_000).toISOString();

    await expect(deliver(completion(), { timestamp: stale })).resolves.toMatchObject({
      status: 401,
    });
  });

  /**
   * `timingSafeEqual` throws on buffers of unequal length rather than
   * returning false. Without the length check first, a forged signature of the
   * wrong length is a 500 — and by the platform's retry policy, five of them.
   */
  it('rejects a signature of the wrong length without crashing', async () => {
    await seedAttempt();

    const res = await request(app)
      .post('/webhooks/vocobase')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', new Date().toISOString())
      .set('X-Webhook-Signature', 'sha256=tooshort')
      .send(JSON.stringify(completion()));

    expect(res.status).toBe(401);
  });

  it('rejects everything when no secret is configured', async () => {
    vi.resetModules();
    process.env.VOCOBASE_WEBHOOK_SECRET = '';

    const { createApp: build } = await import('../src/app.js');
    const unconfigured = build();

    const body = JSON.stringify(completion());
    const timestamp = new Date().toISOString();

    const res = await request(unconfigured)
      .post('/webhooks/vocobase')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', signWebhook(body, timestamp, SECRET))
      .send(body);

    // A missing secret must never mean an open door.
    expect(res.status).toBe(401);

    vi.resetModules();
    process.env.VOCOBASE_WEBHOOK_SECRET = SECRET;
  });

  it('answers a malformed body with 400 rather than 500', async () => {
    const timestamp = new Date().toISOString();
    const body = '{not json';

    const res = await request(app)
      .post('/webhooks/vocobase')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', signWebhook(body, timestamp, SECRET))
      .send(body);

    // Retrying an unparseable body four more times helps nobody.
    expect(res.status).toBe(400);
  });
});

describe('a completed call', () => {
  it('closes the attempt and charges for the minutes', async () => {
    const { attemptId, accountId, contactId } = await seedAttempt();

    // Carrying the note that ends the conversation: without one the settle is
    // a follow-up, and this case is about the charge and the settle rather
    // than about which branch the note chooses.
    await deliver(
      completion({ extraction: { values: { call_outcome_vocobaseplatform: 'completed' } } }),
    );

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.durationSecs).toBe(120);
    expect(attempt.disposition).toBe('completed');
    expect(attempt.answeredBy).toBe('human');
    expect(attempt.costCredits).toBe(toInternalCredits('2.00'));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('COMPLETED');
  });

  it('writes one CALL_USAGE row carrying the attempt', async () => {
    const { attemptId, workspaceId } = await seedAttempt();

    await deliver(completion());

    const rows = await prisma.creditTransaction.findMany({ where: { type: 'CALL_USAGE' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      callAttemptId: attemptId,
      // Rides the existing per-account unique index, so a second charge for
      // one attempt is refused by the database itself.
      reference: attemptId,
      workspaceId,
      amount: -toInternalCredits('2.00'),
    });
  });

  it('charges pro rata, truncating in the customer’s favour', async () => {
    const { accountId } = await seedAttempt();

    await deliver(completion({ duration_seconds: 127 }));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    // 10000 × 127 / 60 = 21166.66…, truncated.
    expect(account.credits).toBe(toInternalCredits('100') - 21_166n);
  });
});

/**
 * The delete that arrives while a call is still connected.
 *
 * A campaign may now be deleted from any status, and the calls it already
 * placed keep running. The attempt row survives with its campaign pointers
 * nulled, and this is the case that proves the charge survives with it — the
 * customer used the minutes either way, and a delete that erased the bill
 * would be a refund button disguised as a tidy-up.
 */
describe('a call whose campaign was deleted mid-flight', () => {
  it('still charges, against an attempt with no campaign left', async () => {
    const { attemptId, accountId, campaignId } = await seedAttempt();

    await prisma.campaign.delete({ where: { id: campaignId } });

    await expect(deliver(completion())).resolves.toMatchObject({ status: 200 });

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.campaignId).toBeNull();
    expect(attempt.campaignContactId).toBeNull();
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.chargedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));
  });
});

describe('a call that was never answered', () => {
  it('closes the attempt at no cost and writes no ledger row', async () => {
    const { attemptId, accountId, contactId } = await seedAttempt();

    await deliver(
      completion({ duration_seconds: 0 }, { status: 'no_answer', disposition: 'no_answer', answered_by: 'not_answered' }),
    );

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.costCredits).toBe(0n);
    // Set even at zero, so a late delivery cannot charge it afterwards.
    expect(attempt.chargedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('100'));
    expect(await prisma.creditTransaction.count()).toBe(0);

    // Nobody was spoken to and the campaign allows two retries, so the contact
    // goes back on the queue with one spent rather than settling.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
    expect(contact.disposition).toBe('no_answer');
    expect(contact.answeredBy).toBe('not_answered');
  });

  it('settles the contact once the retry budget is spent', async () => {
    const { contactId, campaignId } = await seedAttempt();
    await prisma.campaignContact.update({ where: { id: contactId }, data: { attempts: 2 } });

    await deliver(completion({ duration_seconds: 0 }, { status: 'busy', disposition: 'busy', answered_by: null }));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('FAILED');

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.failedCount).toBe(1);
  });

  /**
   * A free-text disposition the platform has never published before. An enum
   * anywhere on this path would turn next month's carrier value into a 500.
   */
  it('records a disposition it has never seen, verbatim', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(
      completion({ duration_seconds: 0 }, { status: 'failed', disposition: 'carrier_rejected_xyz' }),
    );

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.disposition).toBe('carrier_rejected_xyz');
  });
});

/**
 * The one queue entry carrying a time a human agreed to. It rides in on the
 * completion's extraction results, and is booked after the charge and never
 * instead of it.
 */
describe('a callback the lead asked for', () => {
  const promised = new Date(Date.now() + 30 * 3_600_000);

  /**
   * The promise as the call note carries it: an `incomplete` conversation
   * that named a time. `callbackRawFrom` reads no other key, so this is the
   * only shape that books.
   */
  const asked = (time: string) => ({
    call_outcome_vocobaseplatform: 'incomplete',
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: time,
    next_call_instructions_vocobaseplatform: 'Resume from the budget question.',
  });

  it('arms the contact from the call note’s time', async () => {
    const { contactId } = await seedAttempt();

    await deliver(completion({ extraction: { values: asked(promised.toISOString()) } }));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.callbackAt?.toISOString()).toBe(promised.toISOString());
    expect(contact.nextEligibleAt?.getTime()).toBe(contact.callbackAt?.getTime());
    expect(contact.callbackCount).toBe(1);
  });

  /**
   * The plain callbacks keys are never a promise since 2026-09-06. Agents are
   * shared between campaigns, so one of these routinely rides along from some
   * other campaign's set — and read as a promise it books a call on a
   * conversation that named no time. See `callbackRawFrom`.
   */
  it('books nothing off the plain callbacks keys', async () => {
    const { contactId } = await seedAttempt();

    await deliver(
      completion({
        extraction: {
          values: {
            callback_requested_at: promised.toISOString(),
            callback_at: promised.toISOString(),
          },
        },
      }),
    );

    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } })).callbackAt,
    ).toBeNull();
  });

  it('charges and answers 200 even when the promise is unusable', async () => {
    const { accountId, contactId } = await seedAttempt();

    const res = await deliver(
      completion({
        extraction: {
          values: {
            // A time nobody can read, beside an outcome that settles the
            // conversation: charged, settled, and no promise booked.
            ...asked('sometime next week'),
            call_outcome_vocobaseplatform: 'completed',
          },
        },
      }),
    );

    expect(res.status).toBe(200);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } })).status,
    ).toBe('COMPLETED');
  });

  it('books nothing off a replayed delivery', async () => {
    const { contactId } = await seedAttempt();
    const payload = completion({ extraction: { values: asked(promised.toISOString()) } });

    await deliver(payload);
    await deliver(payload);

    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } })).callbackCount,
    ).toBe(1);
  });

  /**
   * The delayed completion of a dial the queue moved past still charges — the
   * minutes were real — but its promise died with it. Booked, it would re-arm
   * a callback from a superseded call, hand back a terminal counter, and
   * re-open a campaign the operator watched finish.
   */
  it('books nothing off a dial a later attempt has superseded', async () => {
    const { attemptId, contactId, campaignId, workspaceId, accountId } = await seedAttempt();

    // The reaper abandoned attempt 1; the dispatcher re-dialled; attempt 2
    // settled the contact and the campaign completed.
    await prisma.callAttempt.update({
      where: { id: attemptId },
      data: { status: 'ABANDONED', resolvedAt: new Date(), endedAt: new Date() },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: contactId,
        workspaceId,
        accountId,
        attemptNo: 2,
        status: 'COMPLETED',
        resolvedAt: new Date(),
        chargedAt: new Date(),
      },
    });
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: { status: 'COMPLETED', attempts: 1 },
    });
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'COMPLETED', completedCount: 1 },
    });

    const res = await deliver(
      completion({ extraction: { values: { callback_requested_at: promised.toISOString() } } }),
    );
    expect(res.status).toBe(200);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('COMPLETED');
    expect(contact.callbackCount).toBe(0);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('COMPLETED');
    expect(campaign.completedCount).toBe(1);

    // The minutes were still real: attempt 1's charge runs regardless.
    const charged = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(charged.chargedAt).not.toBeNull();
  });
});

/**
 * The extraction results, kept.
 *
 * Nothing stored them before: the callback path read `callback_requested_at`
 * straight off the delivery and threw the rest away. Lead buckets are computed
 * at READ time from what a call actually returned, so that changing which key
 * a campaign buckets on re-reads history rather than only affecting calls
 * placed after the change — and that is only possible if the answers survive
 * the delivery that carried them.
 */
describe('what a finished call extracted', () => {
  it('stores the session’s extraction values on the attempt', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ extraction: { values: { lead_stage: 'hot', budget: 50000 } } }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.extraction).toEqual({ lead_stage: 'hot', budget: 50000 });
  });

  /** An extraction that ran and matched none of its keys is a fact about the
   *  call; one that never ran is a fact about the agent. Null is the second. */
  it('leaves the column null when the delivery carried no extraction', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion());

    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).extraction,
    ).toBeNull();
  });

  it('stores an empty result as an empty record rather than as nothing', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ extraction: { values: {} } }));

    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).extraction,
    ).toEqual({});
  });

  /** Bounded on the way in — the keys are the customer's and the values are
   *  free text a model wrote, so the row's size is otherwise upstream's to
   *  decide. */
  it('truncates a value too large to be anybody’s real answer', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(
      completion({ extraction: { values: { notes: 'x'.repeat(MAX_STORED_EXTRACTION_VALUE_CHARS + 100) } } }),
    );

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect((attempt.extraction as Record<string, string>).notes)
      .toHaveLength(MAX_STORED_EXTRACTION_VALUE_CHARS);
  });

  /**
   * A campaign is not what makes extraction worth keeping — a hand-placed call
   * on a workspace's own agent extracts the same answers, and the attempt row
   * is the same row. The callback booking beside it is campaign-only for its
   * own reasons; this is not.
   */
  it('stores extraction for an attempt no campaign owns', async () => {
    const { attemptId } = await seedAttempt();
    await prisma.callAttempt.update({
      where: { id: attemptId },
      data: { campaignId: null, campaignContactId: null },
    });

    await deliver(completion({ extraction: { values: { lead_stage: 'warm' } } }));

    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).extraction,
    ).toEqual({ lead_stage: 'warm' });
  });
});

describe('duplicate deliveries', () => {
  /**
   * The platform retries anything that is not a 2xx, four times over eight
   * hours. Charging twice for one call is the failure this whole design is
   * arranged around.
   */
  it('charges exactly once however many times the same event arrives', async () => {
    const { accountId } = await seedAttempt();

    await deliver(completion());
    await deliver(completion());
    await deliver(completion());

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));
    expect(await prisma.creditTransaction.count({ where: { type: 'CALL_USAGE' } })).toBe(1);
  });

  it('still answers 200 to a duplicate, so the platform stops retrying', async () => {
    await seedAttempt();

    await deliver(completion());

    await expect(deliver(completion())).resolves.toMatchObject({ status: 200 });
  });

  it('records the delivery marker exactly once', async () => {
    await seedAttempt();

    await deliver(completion());
    await deliver(completion());

    expect(await prisma.webhookEvent.count()).toBe(1);
  });
});

describe('insufficient credits at charge time', () => {
  it('debits nothing, marks the shortfall, and pauses the campaign', async () => {
    const { attemptId, accountId, campaignId, workspaceId } = await seedAttempt({ credits: '0.5' });

    await deliver(completion());

    // Nothing partially debited: the ledger's rule is that a balance never
    // goes negative and every movement pairs with a row.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('0.5'));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.shortfall).toBe(true);
    // What was owed and not taken, recorded rather than lost.
    expect(attempt.costCredits).toBe(toInternalCredits('2.00'));

    const marker = await prisma.creditTransaction.findFirstOrThrow({
      where: { type: 'CALL_USAGE_SHORTFALL' },
    });
    expect(marker.amount).toBe(0n);
    expect(marker.callAttemptId).toBe(attemptId);

    // Its own status rather than PAUSED: the operator did not stop this
    // campaign, the balance did, and resume has to re-run the estimate.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('CREDIT_EXHAUSTED');
    expect(campaign.pausedAt).not.toBeNull();

    await flushNotifications();
    const notification = await prisma.notification.findFirst({
      where: { workspaceId, type: 'campaign.paused_insufficient_credits' },
    });
    expect(notification?.scope).toBe('ADMINS_ONLY');
    expect(notification?.href).toBe('/settings/billing');
  });
});

/**
 * The endpoint is account-wide on a partner account YE shares, so it receives
 * every other integrator's completions — transcripts included.
 */
describe('an event that is not ours', () => {
  it('answers 200 and records nothing', async () => {
    await seedAttempt();

    const res = await deliver(
      completion({ session_id: 's_stranger' }, { call_id: 'c_stranger' }),
    );

    // 200 and not 500: a stranger's call is not an error, and a non-2xx would
    // have the platform retry it four more times.
    expect(res.status).toBe(200);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('logs the id and never the payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedAttempt();

    await deliver(
      completion(
        { session_id: 's_stranger', transcript: [{ role: 'user', content: 'my account number is 4242' }] },
        { call_id: 'c_stranger', to_number: '+15551234567' },
      ),
    );

    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('c_stranger');
    // Another customer's transcript and their contact's number never reach a
    // log line of ours.
    expect(logged).not.toContain('4242');
    expect(logged).not.toContain('+15551234567');
  });
});

/**
 * A browser test session's completion carries NO `call` object — there was no
 * carrier — so it arrives on exactly the path that used to return early.
 */
describe('a browser test session completing', () => {
  async function seedTestSession(sessionId: string, credits = '100') {
    const account = await makeAccount(`t${Math.random().toString(36).slice(2, 7)}`);
    await prisma.account.update({
      where: { id: account.id },
      data: { credits: toInternalCredits(credits) },
    });
    const workspace = await makeWorkspace(account, 'Tested');
    const agent = await makeAgent(workspace, 'tested');

    return prisma.testSession.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        agentId: agent.id,
        startedByAccountId: account.id,
        upstreamSessionId: sessionId,
        status: 'ACTIVE',
        tierSlug: 'va-pro',
        rateCreditsPerMin: toInternalCredits('2.00'),
        billingIncrementSecs: 60,
      },
    });
  }

  /** A completion with no `call` object, which is what a browser session sends. */
  const browserCompletion = (over: Record<string, unknown> = {}) => ({
    event: 'session.completed',
    timestamp: new Date().toISOString(),
    data: { session_id: 's_web', duration_seconds: 47, status: 'completed', ...over },
  });

  it('charges the session it names', async () => {
    const session = await seedTestSession('s_web');

    const res = await deliver(browserCompletion());

    expect(res.status).toBe(200);

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('COMPLETED');
    expect(row.durationSecs).toBe(47);
    expect(row.billedSecs).toBe(60);
    expect(row.costCredits).toBe(toInternalCredits('2.00'));

    const ledger = await prisma.creditTransaction.findFirstOrThrow({});
    expect(ledger.type).toBe('TEST_SESSION_USAGE');
    expect(ledger.testSessionId).toBe(session.id);
  });

  it('charges once when the platform redelivers it', async () => {
    await seedTestSession('s_web');

    await deliver(browserCompletion());
    await deliver(browserCompletion());

    expect(await prisma.creditTransaction.count()).toBe(1);
  });

  /**
   * The rule this endpoint has always held: the account is shared, so a session
   * that is not ours is absent rather than an error, and nothing about it is
   * persisted or logged in full.
   */
  it("answers 200 and records nothing for a session that is not ours", async () => {
    const res = await deliver(browserCompletion({ session_id: 's_stranger_web' }));

    expect(res.status).toBe(200);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await prisma.testSession.count()).toBe(0);
  });
});

describe('a call whose session id also names a test session', () => {
  /**
   * The attempt is tried first, so a telephony call is never mistaken for a
   * browser test even when the two share an id. A campaign call carries a
   * `call` object; a test does not.
   */
  it('settles the attempt and leaves the test session alone', async () => {
    const { attemptId } = await seedAttempt();
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    const account = await makeAccount(`x${Math.random().toString(36).slice(2, 7)}`);
    const workspace = await makeWorkspace(account, 'Other');
    const agent = await makeAgent(workspace, 'other');
    const session = await prisma.testSession.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        agentId: agent.id,
        startedByAccountId: account.id,
        upstreamSessionId: attempt.upstreamSessionId!,
        status: 'ACTIVE',
        rateCreditsPerMin: toInternalCredits('2.00'),
        billingIncrementSecs: 60,
      },
    });

    await deliver(completion({ session_id: attempt.upstreamSessionId! }));

    const untouched = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.chargedAt).toBeNull();

    const settled = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(settled.chargedAt).not.toBeNull();
  });
});

describe('call.status.updated', () => {
  it('advances a live attempt without closing or charging it', async () => {
    const { attemptId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'ringing', terminal: false },
    });

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('RINGING');
    expect(attempt.chargedAt).toBeNull();
  });

  /**
   * The platform says plainly not to wait for `session.completed` to release a
   * dialer slot. A slot held through transcription is a slot the customer paid
   * for and cannot use.
   */
  it('frees the line on a terminal status, leaving the charge to the completion event', async () => {
    const { attemptId, accountId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'completed', disposition: 'completed', terminal: true },
    });

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.chargedAt).toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('100'));

    // ...and the completion event that follows still charges.
    await deliver(completion());

    const charged = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(charged.costCredits).toBe(toInternalCredits('2.00'));
  });

  /**
   * The pacing event usually lands first. Writing the contact terminal here
   * would put it outside the claimed state the completion's own resolution is
   * guarded on — so the ladder would never arm, and a campaign configured for
   * three retries would place one call.
   */
  it('arms the retry from whichever event resolves the contact first', async () => {
    const { contactId, campaignId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'no_answer', disposition: 'no_answer', terminal: true },
    });

    const afterPacing = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(afterPacing.status).toBe('PENDING');
    expect(afterPacing.attempts).toBe(2);

    // The completion follows and charges, but resolves nothing a second time.
    await deliver(
      completion({ duration_seconds: 0 }, { status: 'no_answer', disposition: 'no_answer', answered_by: 'not_answered' }),
    );

    const afterCompletion = await prisma.campaignContact.findUniqueOrThrow({
      where: { id: contactId },
    });
    expect(afterCompletion.attempts).toBe(2);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.failedCount).toBe(0);
  });

  /**
   * The pacing event fires at the status transition; for a completed call the
   * provider computes `disposition` and `answered_by` with post-call
   * processing, after it has already gone out. A bare completed status is
   * "not classified yet", not "a conversation happened" — resolved from it,
   * every voicemail would settle as a success and the ladder would never arm.
   */
  it('leaves an unclassified completion to the event that knows the outcome', async () => {
    const { attemptId, contactId, campaignId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'completed', terminal: true },
    });

    // The line is freed...
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
    // ...but the queue move is deferred: the attempt carries no resolution and
    // the contact stays claimed for whoever first knows what the call was.
    expect(attempt.resolvedAt).toBeNull();
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } })).status,
    ).toBe('QUEUED');

    // The completion knows it was a voicemail: the ladder arms.
    await deliver(completion({}, { disposition: 'voicemail', answered_by: 'machine' }));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
    expect(contact.disposition).toBe('voicemail');
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).completedCount,
    ).toBe(0);
  });

  it('resolves a bare terminal status that classifies itself', async () => {
    const { contactId } = await seedAttempt();

    // `no_answer` is its own classification; it needs no disposition.
    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'no_answer', terminal: true },
    });

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
  });

  it('does not reopen an attempt that has already been charged', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion());
    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'ringing', terminal: false },
    });

    // A late `ringing` must not put a settled call back on the line.
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
  });
});

/**
 * The platform's new wire contract: `error_code` (string | null) and
 * `error_message` (string) on BOTH events. `hangup_cause` set with a null
 * code means the carrier decided and the disposition is trusted; a code set
 * with a null cause means the PLATFORM decided and the number was never
 * tested. Such an outcome must never settle the contact and must never spend
 * a retry — and `TELEPHONY_CREDIT_EXHAUSTED` pauses the campaign outright.
 */
describe('an outcome the platform decided (error_code)', () => {
  const contactOf = (id: string) => prisma.campaignContact.findUniqueOrThrow({ where: { id } });
  const attemptOf = (id: string) => prisma.callAttempt.findUniqueOrThrow({ where: { id } });
  const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

  it('hands the contact back untouched off session.completed', async () => {
    const { attemptId, contactId, campaignId } = await seedAttempt();

    await deliver(
      completion(
        { duration_seconds: 0 },
        {
          status: 'failed',
          disposition: 'failed',
          answered_by: null,
          hangup_cause: null,
          error_code: 'PENDING_TIMEOUT',
          error_message: 'Session reaped before connect',
        },
      ),
    );

    const contact = await contactOf(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);

    const attempt = await attemptOf(attemptId);
    expect(attempt.errorCode).toBe('PENDING_TIMEOUT');
    expect(attempt.errorMessage).toBe('Session reaped before connect');
    expect(attempt.chargedAt).not.toBeNull();

    expect((await campaignOf(campaignId)).failedCount).toBe(0);
  });

  it('reads the pair off the envelope when it is not on the call object', async () => {
    const { attemptId, contactId } = await seedAttempt();

    await deliver(
      completion(
        { duration_seconds: 0, error_code: 'DIAL_TRANSPORT_FAILURE', error_message: 'No route' },
        { status: 'failed', disposition: 'failed', answered_by: null, hangup_cause: null },
      ),
    );

    expect((await contactOf(contactId)).attempts).toBe(1);
    expect((await attemptOf(attemptId)).errorCode).toBe('DIAL_TRANSPORT_FAILURE');
  });

  it('hands the contact back untouched off call.status.updated, and the completion charges without moving it again', async () => {
    const { attemptId, contactId, campaignId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'failed',
        disposition: 'failed',
        hangup_cause: null,
        error_code: 'DIAL_TRANSPORT_FAILURE',
        error_message: 'Could not reach the carrier',
        terminal: true,
      },
    });

    const afterPacing = await contactOf(contactId);
    expect(afterPacing.status).toBe('PENDING');
    expect(afterPacing.attempts).toBe(1);

    const attempt = await attemptOf(attemptId);
    expect(attempt.status).toBe('FAILED');
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.errorCode).toBe('DIAL_TRANSPORT_FAILURE');
    expect(attempt.errorMessage).toBe('Could not reach the carrier');

    await deliver(
      completion(
        { duration_seconds: 0 },
        {
          status: 'failed',
          disposition: 'failed',
          answered_by: null,
          hangup_cause: null,
          error_code: 'DIAL_TRANSPORT_FAILURE',
          error_message: 'Could not reach the carrier',
        },
      ),
    );

    expect((await contactOf(contactId)).attempts).toBe(1);
    expect((await attemptOf(attemptId)).chargedAt).not.toBeNull();
    expect((await campaignOf(campaignId)).failedCount).toBe(0);
  });

  it('keeps the code the pacing event wrote when the completion arrives without the pair', async () => {
    const { attemptId, contactId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'failed',
        disposition: 'failed',
        hangup_cause: null,
        error_code: 'PENDING_TIMEOUT',
        error_message: 'Session reaped before connect',
      },
    });

    // The platform's completion for the same call, with neither field on it.
    await deliver(
      completion(
        { duration_seconds: 0 },
        { status: 'failed', disposition: 'failed', answered_by: null, hangup_cause: null },
      ),
    );

    const attempt = await attemptOf(attemptId);
    expect(attempt.errorCode).toBe('PENDING_TIMEOUT');
    expect(attempt.errorMessage).toBe('Session reaped before connect');
    expect(attempt.chargedAt).not.toBeNull();
    // Still never placed: the dial the give-back protected is not re-charged to the ladder.
    expect(await dialBudgetSpent(prisma, contactId, 1)).toBe(false);
  });

  it('outranks a cause that names the number on the pacing event', async () => {
    const { contactId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'failed',
        disposition: 'failed',
        hangup_cause: '1 - Unallocated (unassigned) number',
        error_code: 'ADMIN_DISMISSED',
        error_message: 'Dismissed by an operator',
        terminal: true,
      },
    });

    expect((await contactOf(contactId)).status).toBe('PENDING');
  });

  it('still trusts the carrier when the code is null', async () => {
    const { contactId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'failed',
        disposition: 'failed',
        hangup_cause: '1 - Unallocated (unassigned) number',
        error_code: null,
        error_message: '',
        terminal: true,
      },
    });

    expect((await contactOf(contactId)).status).toBe('FAILED');
  });

  it('pauses the campaign the first time the platform reports its own credit exhausted, off either event', async () => {
    const { contactId, campaignId, workspaceId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'failed',
        disposition: 'failed',
        hangup_cause: null,
        error_code: 'TELEPHONY_CREDIT_EXHAUSTED',
        error_message: 'Telephony credit exhausted',
        terminal: true,
      },
    });

    const campaign = await campaignOf(campaignId);
    expect(campaign.status).toBe('PAUSED');
    expect(campaign.pausedAt).not.toBeNull();

    const contact = await contactOf(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);

    // The completion for the same call says the same thing; nothing repeats.
    await deliver(
      completion(
        { duration_seconds: 0 },
        {
          status: 'failed',
          disposition: 'failed',
          answered_by: null,
          hangup_cause: null,
          error_code: 'TELEPHONY_CREDIT_EXHAUSTED',
          error_message: 'Telephony credit exhausted',
        },
      ),
    );
    await flushNotifications();

    const notes = await prisma.notification.findMany({
      where: { workspaceId, type: 'campaign.paused_platform_credit_exhausted' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.scope).toBe('ADMINS_ONLY');
    expect(notes[0]!.href).toBe(`/campaigns/${campaignId}`);
    expect((await campaignOf(campaignId)).status).toBe('PAUSED');
  });
});

describe('events this platform does not handle', () => {
  /**
   * The same fact, reported the way the platform ACTUALLY reports it.
   *
   * On 2026-09-07 the supplier refused every dial with a 402 and the platform
   * surfaced it as `error_message` with **no `error_code`** — 2,593 attempts
   * across 1,407 contacts, not one carrying a code. Read only from the code,
   * every one settled as an ordinary failure: the contact lost a retry for a
   * number that was never dialled, and both campaigns went on dialing into a
   * dead wallet for a day and a half.
   */
  it('pauses and hands the contact back when the wallet is empty and no code is sent', async () => {
    const { campaignId, contactId, workspaceId } = await seedAttempt();

    await deliver(
      completion(
        { duration_seconds: 0 },
        {
          status: 'failed',
          disposition: 'failed',
          answered_by: null,
          hangup_cause: null,
          // Exactly as production sends it: no code, the reason in the text.
          error_code: null,
          error_message:
            'VoiceLink add_lead error (402): {"status":false,"message":"Insufficient wallet balance. Please top-up to continue."}',
        },
      ),
    );
    await flushNotifications();

    // The number was never tested, so the ladder must not have moved: the
    // contact goes back on the queue with the retry count it arrived with,
    // which is what the seed set — the same assertion the `error_code` case
    // above makes, because this is meant to be the identical outcome.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);

    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status,
    ).toBe('PAUSED');
    expect(
      await prisma.notification.count({
        where: { workspaceId, type: 'campaign.paused_platform_credit_exhausted' },
      }),
    ).toBe(1);
  });

  it('acknowledges an unrecognised event rather than failing it', async () => {
    await seedAttempt();

    const res = await deliver({
      event: 'whatsapp.message.sent',
      data: { message_id: 'm_1' },
    });

    // An endpoint that 500s on an event it did not expect would be retried
    // into an incident by the platform's own policy.
    expect(res.status).toBe(200);
  });
});

/**
 * `hangup_source` — WHO ended the call, beside the `hangup_cause` that says
 * how.
 *
 * The platform sends it and this service used to drop it: the outcome path
 * read `hangup_cause` and nothing else, and the source survived only as a live
 * read on the call-detail screen, which stores nothing. The campaign export
 * needs it per attempt — it is what `Call Disconnected By` and
 * `Disconnect Reason Key` are derived from — and a column filled only by a
 * backfill is one that goes stale the moment the backfill stops running.
 *
 * Read from the call object first and the envelope second, the same two
 * spellings and the same precedence `error_code` already uses. Free text, and
 * never an enum: the published set is the platform's and grows without this
 * service deploying, exactly as `disposition` and `hangupCause` beside it do.
 */
describe('hangup_source on a completion', () => {
  const attemptOf = (id: string) => prisma.callAttempt.findUniqueOrThrow({ where: { id } });

  it('stores the source from the call object', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({}, { hangup_cause: 'NORMAL_CLEARING', hangup_source: 'callee' }));

    expect((await attemptOf(attemptId)).hangupSource).toBe('callee');
  });

  it('reads it off the envelope when it is not on the call object', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ hangup_source: 'agent' }, { hangup_cause: 'NORMAL_CLEARING' }));

    expect((await attemptOf(attemptId)).hangupSource).toBe('agent');
  });

  /** Absent is null and stays null. A delivery that does not carry the field
   *  must not write an empty string, which reads as an attribution nobody
   *  made — the same distinction `billedSecs` draws between null and zero. */
  it('leaves it null when the delivery does not carry it', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({}, { hangup_cause: 'NORMAL_CLEARING' }));

    expect((await attemptOf(attemptId)).hangupSource).toBeNull();
  });

  /** A value this service has never seen is stored as sent. Mapping it is the
   *  export's job and the export refuses to guess; throwing it away here would
   *  make that refusal permanent for every row. */
  it('stores a source it does not recognise, verbatim', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({}, { hangup_source: 'carrier_gateway_7' }));

    expect((await attemptOf(attemptId)).hangupSource).toBe('carrier_gateway_7');
  });

  /**
   * The pacing event closes the attempt and records the cause; it records the
   * source too, so a call whose completion never arrives is not left
   * unattributed when the platform said who hung up on the one delivery that
   * did land.
   */
  it('is also recorded off a terminal call.status.updated', async () => {
    const { attemptId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'completed',
        disposition: 'completed',
        terminal: true,
        hangup_cause: 'NORMAL_CLEARING',
        hangup_source: 'callee',
      },
    });

    expect((await attemptOf(attemptId)).hangupSource).toBe('callee');
  });
});

/**
 * The rest of what `session.completed` carries and this service was throwing
 * away: the conversation, the variables the dial went out with, and whether
 * the platform holds audio.
 *
 * Every one of these is rendered somewhere on this product — the call detail
 * shows all three, and the journey's `hasRecording` GUESSES the third from the
 * duration, with its own comment naming the call detail's answer as
 * authoritative. Storing them turns three live fetches and one heuristic into
 * facts on the row.
 */
describe('the session facts on a completion', () => {
  const attemptOf = (id: string) => prisma.callAttempt.findUniqueOrThrow({ where: { id } });

  it('stores the conversation', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(
      completion({
        transcript: [
          { role: 'assistant', content: 'Hello?' },
          { role: 'user', content: 'Yes, speaking.' },
        ],
      }),
    );

    expect((await attemptOf(attemptId)).transcript).toEqual([
      { role: 'assistant', content: 'Hello?', timestamp: null },
      { role: 'user', content: 'Yes, speaking.', timestamp: null },
    ]);
  });

  /** The field is not always a transcript: a call that never connected sends
   *  an object describing the failure, and storing that under this name files
   *  carrier internals as something the customer said. */
  it('stores no conversation for a call that never connected', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ transcript: { error: 'no answer', terminal_reason: 'CANCELLED' } }));

    expect((await attemptOf(attemptId)).transcript).toBeNull();
  });

  it('stores the variables the dial actually went out with', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ variables: { tb_business_name: 'Petal Palace' } }));

    expect((await attemptOf(attemptId)).variables).toEqual({ tb_business_name: 'Petal Palace' });
  });

  /** The flag, never the URL: a presigned link expires in seven days and is a
   *  bearer credential for a customer's audio that outlives any membership. */
  it('records that audio exists without storing where it is', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ recording_url: 'https://storage.test/rec.mp3?sig=secret' }));

    const attempt = await attemptOf(attemptId);
    expect(attempt.recordingAvailable).toBe(true);
    // The whole row, so this catches the URL landing in ANY column rather than
    // only the one it would obviously go in. A replacer because the row
    // carries BigInt credit columns, which `JSON.stringify` refuses.
    const serialised = JSON.stringify(attempt, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(serialised).not.toContain('sig=secret');
    expect(serialised).not.toContain('storage.test');
  });

  it('records the absence of audio as false, not as unknown', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ duration_seconds: 0, processing_complete: true }));

    expect((await attemptOf(attemptId)).recordingAvailable).toBe(false);
  });

  /**
   * **A delivery that shows no evidence of post-call processing marks
   * nothing.**
   *
   * The transcript and the recording are produced after the call ends. A
   * completion that arrives before that carries neither, and writing
   * `recordingAvailable: false` from it would be wrong twice over: the row
   * would claim a call has no audio when it has some, and that column is the
   * marker the backfill uses to decide a row has been looked at — so the wrong
   * answer would never be revisited.
   *
   * Left null instead, which costs one fetch from the reaper or the backfill
   * and cannot be wrong.
   */
  it('leaves the recording flag unset when the delivery shows no processing happened', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ duration_seconds: 30 }));

    expect((await attemptOf(attemptId)).recordingAvailable).toBeNull();
  });

  /** A transcript IS evidence processing ran, so a call that produced a
   *  conversation and no audio records that honestly. */
  it('records the absence of audio once there is evidence processing ran', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ transcript: [{ role: 'bot', content: 'Hello?' }] }));

    expect((await attemptOf(attemptId)).recordingAvailable).toBe(false);
  });

  /** Kept for the carrier-detail readout. Billing still reads `durationSecs`:
   *  the completion carries only that one, so billing on this would make the
   *  same call cost differently depending on how we heard of it. */
  it('keeps the carrier’s own billed duration beside the one we bill on', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({ duration_seconds: 47, bill_duration_seconds: 60 }));

    const attempt = await attemptOf(attemptId);
    expect(attempt.durationSecs).toBe(47);
    expect(attempt.billDurationSeconds).toBe(60);
  });
});

/**
 * The platform's one-vocabulary ending. `session.completed` carries the bot's
 * account on `call.end_call_reason`; the terminal `call.status.updated`
 * carries the CARRIER's snapshot alone (it fires before the bot reports), so
 * an answered call reads COMPLETED there and its real ending arrives on the
 * completion. Neither event ever writes null over a value, and the status
 * event writes only onto an open attempt.
 */
describe('end_call_reason', () => {
  const attemptOf = (id: string) => prisma.callAttempt.findUniqueOrThrow({ where: { id } });
  const contactOf = (id: string) => prisma.campaignContact.findUniqueOrThrow({ where: { id } });
  const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

  it('stores the completion’s reason beside the deprecated pair it still carries', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(
      completion({}, { end_call_reason: 'CUSTOMER_HUNG_UP', hangup_cause: '16', hangup_source: 'caller' }),
    );

    const attempt = await attemptOf(attemptId);
    expect(attempt.endCallReason).toBe('CUSTOMER_HUNG_UP');
    expect(attempt.hangupCause).toBe('16');
    expect(attempt.hangupSource).toBe('caller');
  });

  /** Next release the platform drops `hangup_cause` and `hangup_source`
   *  altogether: a payload with neither KEY still settles on the reason. */
  it('settles a next-release payload that carries no hangup_cause or hangup_source keys', async () => {
    const { attemptId } = await seedAttempt();

    const body = completion(
      {},
      { end_call_reason: 'COMPLETED', disposition: 'completed', answered_by: 'human' },
    );
    delete (body.data.call as Record<string, unknown>).hangup_cause;
    delete (body.data.call as Record<string, unknown>).hangup_source;
    expect(Object.keys(body.data.call)).not.toContain('hangup_cause');
    expect(Object.keys(body.data.call)).not.toContain('hangup_source');

    await deliver(body);

    const attempt = await attemptOf(attemptId);
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.endCallReason).toBe('COMPLETED');
    expect(attempt.hangupCause).toBeNull();
    expect(attempt.hangupSource).toBeNull();
  });

  /** The carrier's snapshot lands first, the bot's answer overwrites it. */
  it('lets the completion’s bot view overwrite the terminal status event’s carrier snapshot', async () => {
    const { attemptId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: {
        call_id: 'c_1',
        status: 'completed',
        disposition: 'completed',
        answered_by: 'human',
        end_call_reason: 'COMPLETED',
        terminal: true,
      },
    });

    expect((await attemptOf(attemptId)).endCallReason).toBe('COMPLETED');

    await deliver(completion({}, { end_call_reason: 'CUSTOMER_HUNG_UP' }));

    const attempt = await attemptOf(attemptId);
    expect(attempt.endCallReason).toBe('CUSTOMER_HUNG_UP');
    expect(attempt.chargedAt).not.toBeNull();
  });

  it('writes nothing off a live status event whose reason is null', async () => {
    const { attemptId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'ringing', end_call_reason: null, terminal: false },
    });

    const attempt = await attemptOf(attemptId);
    expect(attempt.status).toBe('RINGING');
    expect(attempt.endCallReason).toBeNull();
  });

  /** SYSTEM_ERROR beside nobody heard is the platform's fault, not the
   *  number's: the same give-back an `error_code` earns, on the same path. */
  it('hands the contact back at no cost on a SYSTEM_ERROR silence', async () => {
    const { attemptId, contactId, campaignId } = await seedAttempt();

    await deliver(
      completion(
        { duration_seconds: 0 },
        {
          status: 'failed',
          disposition: 'failed',
          answered_by: null,
          hangup_cause: null,
          end_call_reason: 'SYSTEM_ERROR',
        },
      ),
    );

    const contact = await contactOf(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);
    expect(await dialBudgetSpent(prisma, contactId, 1)).toBe(false);

    const attempt = await attemptOf(attemptId);
    expect(attempt.endCallReason).toBe('SYSTEM_ERROR');
    expect(attempt.errorCode).toBeNull();
    expect(attempt.chargedAt).not.toBeNull();

    expect((await campaignOf(campaignId)).failedCount).toBe(0);
  });

  /**
   * A `completed` status with no disposition and no answered_by is "not
   * classified yet" — unless the platform says IT ended the call. Then the
   * platform decided, exactly as an `error_code` means, and the contact goes
   * back at no cost from this event rather than waiting on a completion that
   * may say the same thing minutes later, or never arrive.
   */
  it('resolves a SYSTEM_ERROR on a bare completed status event, handing the contact back', async () => {
    const { attemptId, contactId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'completed', end_call_reason: 'SYSTEM_ERROR', terminal: true },
    });

    const contact = await contactOf(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);

    const attempt = await attemptOf(attemptId);
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.endCallReason).toBe('SYSTEM_ERROR');
    expect(await dialBudgetSpent(prisma, contactId, 1)).toBe(false);
  });

  /**
   * On voicelink the platform sets `answered_by: human` only when the bot's
   * own worker completes normally, so the teardown that yields SYSTEM_ERROR
   * leaves it null on a call a person had answered. The carrier's clock is
   * the proof: `answered_at` on the completion, or the row's own stamp from
   * the IN_PROGRESS event. Either way the retry is spent, not handed back.
   */
  it('spends the retry on a SYSTEM_ERROR whose completion says the call was answered', async () => {
    const { attemptId, contactId } = await seedAttempt();

    await deliver(
      completion(
        { duration_seconds: 95 },
        { status: 'failed', disposition: 'failed', answered_by: null, answered_at: '2026-09-15T10:00:05.000Z', end_call_reason: 'SYSTEM_ERROR' },
      ),
    );

    const contact = await contactOf(contactId);
    expect(contact.attempts).toBe(2);
    expect(await dialBudgetSpent(prisma, contactId, 1)).toBe(true);

    const attempt = await attemptOf(attemptId);
    expect(attempt.answeredAt).not.toBeNull();
    expect(attempt.endCallReason).toBe('SYSTEM_ERROR');
  });

  it('spends the retry on a SYSTEM_ERROR status event over a row the IN_PROGRESS event stamped', async () => {
    const { attemptId, contactId } = await seedAttempt();

    await deliver({
      event: 'call.status.updated',
      data: { call_id: 'c_1', status: 'in_progress', end_call_reason: null, terminal: false },
    });
    expect((await attemptOf(attemptId)).answeredAt).not.toBeNull();

    await deliver({
      event: 'call.status.updated',
      // `disposition: failed` as the platform's own failed-webhook path sends
      // it; a bare `failed` with no disposition is deferred to the completion.
      data: { call_id: 'c_1', status: 'failed', disposition: 'failed', end_call_reason: 'SYSTEM_ERROR', terminal: true },
    });

    const contact = await contactOf(contactId);
    expect(contact.attempts).toBe(2);
    expect(await dialBudgetSpent(prisma, contactId, 1)).toBe(true);
  });

  it('stores a lower-case reason normalised', async () => {
    const { attemptId } = await seedAttempt();

    await deliver(completion({}, { end_call_reason: 'customer_hung_up' }));

    expect((await attemptOf(attemptId)).endCallReason).toBe('CUSTOMER_HUNG_UP');
  });
});
