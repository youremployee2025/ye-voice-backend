import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker, type Job } from 'bullmq';

/**
 * The retry policy behind a delivery, against a real worker.
 *
 * The handler answers 200 the moment a job is durable, so from that point the
 * queue owns the charge, the contact resolution and the callback. Two things
 * therefore have to be true, and neither is provable by calling the processor
 * directly: a job that throws must come back and land, and a job that throws
 * **after** doing the work must not do it twice.
 *
 * The second is what the whole design rests on. There is no table of received
 * events — the job payload is the record — and what makes a redelivered or
 * retried outcome exactly-once is the event key `applyTerminalOutcome` writes
 * inside the same transaction as the charge. This file is where that claim is
 * checked rather than asserted.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { processWebhookEvent } = await import('../src/services/webhookOutcome.js');
const { webhookProcessingQueue, closeQueues } = await import('../src/lib/queue/queues.js');
const { createWorkerConnection, closeWorkerConnections, closeQueueConnection } = await import(
  '../src/lib/queue/connection.js'
);
const { QUEUE_NAMES } = await import('../src/lib/queue/types.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { clearWebhooks } = await import('./webhook-pass.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

async function seedAttempt() {
  const account = await makeAccount(`q${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits('100') },
  });
  const workspace = await makeWorkspace(account, 'Queued');
  const agent = await makeAgent(workspace, 'caller');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'Outreach', agentId: agent.id, status: 'RUNNING' },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: '+919876543211' },
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
      upstreamCallId: 'c_q1',
      upstreamSessionId: 's_q1',
      rateCreditsPerMin: toInternalCredits('1.00'),
    },
  });

  return { accountId: account.id, attemptId: attempt.id, contactId: link.id };
}

const completion = {
  kind: 'webhook' as const,
  event: 'session.completed',
  data: {
    session_id: 's_q1',
    duration_seconds: 120,
    // The note that ends the conversation. Without one the settle is a
    // follow-up — every campaign follows an unfinished conversation up — and
    // the contact goes back on the queue instead of settling, which is not
    // what these cases are about.
    extraction: { values: { call_outcome_vocobaseplatform: 'completed' } },
    call: {
      call_id: 'c_q1',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
    },
  },
  receivedAtIso: new Date().toISOString(),
};

/**
 * A worker whose processor misbehaves in a scripted way, then behaves.
 *
 * The backoff is overridden per job to twenty milliseconds. The *policy* — five
 * attempts, exponential from two seconds — is asserted separately below; what
 * these cases need to observe is the retry happening at all, and six seconds of
 * real waiting would buy nothing but a slow suite.
 */
function workerThat(process: (job: Job) => Promise<void>): Worker {
  return new Worker(QUEUE_NAMES.WEBHOOK_PROCESSING, process, {
    connection: createWorkerConnection(),
    concurrency: 1,
  });
}

async function settled(worker: Worker, timeoutMs = 10_000): Promise<'completed' | 'failed'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job never settled')), timeoutMs);
    const done = (outcome: 'completed' | 'failed') => {
      clearTimeout(timer);
      resolve(outcome);
    };

    worker.on('completed', () => done('completed'));
    worker.on('failed', (job) => {
      // Only when the queue has given up: the earlier failures are the point.
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) done('failed');
    });
  });
}

let worker: Worker | null = null;

beforeEach(async () => {
  await truncateAll();
  await clearWebhooks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await worker?.close();
  worker = null;
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(async () => {
  // worker.close() leaves the connection createWorkerConnection() supplied
  // open — BullMQ treats a caller-provided instance as shared.
  await closeWorkerConnections();
  await closeQueues();
  await closeQueueConnection();
});

describe('the webhook queue', () => {
  it('carries five attempts over exponential backoff', () => {
    // The policy itself, read off the queue rather than off the design doc.
    // Behind a delivery is a charge somebody is owed; a single attempt would
    // make a database blip into a call that is never billed.
    expect(webhookProcessingQueue.defaultJobOptions.attempts).toBe(5);
    expect(webhookProcessingQueue.defaultJobOptions.backoff).toEqual({
      type: 'exponential',
      delay: 2_000,
    });
  });

  it('retries a job that throws, and lands it', async () => {
    const { attemptId, accountId } = await seedAttempt();
    let seen = 0;

    worker = workerThat(async (job) => {
      seen += 1;
      if (seen < 3) throw new Error('the database was briefly unavailable');
      await processWebhookEvent(job.data);
    });

    const outcome = settled(worker);
    await webhookProcessingQueue.add('webhook', completion, {
      backoff: { type: 'fixed', delay: 20 },
    });

    expect(await outcome).toBe('completed');
    expect(seen).toBe(3);

    // The two thrown attempts left nothing behind; the third did all of it.
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.costCredits).toBe(toInternalCredits('2.00'));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));
  });

  /**
   * The exactly-once claim, checked rather than asserted.
   *
   * This is the shape a crash actually takes: the transaction committed, the
   * charge is on the ledger, and the process died before the acknowledgement.
   * The queue redelivers, and the second run must find the event key already
   * written and change nothing — because there is no table of received events
   * standing between the two, on purpose.
   */
  it('does not charge twice when a job dies after the outcome landed', async () => {
    const { attemptId, accountId, contactId } = await seedAttempt();
    let seen = 0;

    worker = workerThat(async (job) => {
      seen += 1;
      await processWebhookEvent(job.data);
      if (seen === 1) throw new Error('killed after the transaction committed');
    });

    const outcome = settled(worker);
    await webhookProcessingQueue.add('webhook', completion, {
      backoff: { type: 'fixed', delay: 20 },
    });

    expect(await outcome).toBe('completed');
    expect(seen).toBe(2);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));

    const rows = await prisma.creditTransaction.findMany({ where: { type: 'CALL_USAGE' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.callAttemptId).toBe(attemptId);

    // And the contact was resolved once, not twice: a second resolution would
    // move the campaign's counters past the number of contacts it has.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    expect(contact.status).toBe('COMPLETED');
  });
});

/**
 * The file's own invariant: every timestamp comes from `receivedAt`, never
 * from `new Date()`. On the request thread the two were the same instant to
 * within milliseconds; on a worker with five attempts over exponential
 * backoff, "when the queue got round to it" can be minutes after the call was
 * answered — and the timeline sorts by instant, so a skewed `answeredAt`
 * renders "answered" after "ended".
 */
describe('live-status timestamps', () => {
  it('stamps answeredAt with the delivery instant, not the processing instant', async () => {
    const { attemptId } = await seedAttempt();
    const receivedAt = new Date('2026-08-20T10:00:05.000Z');

    await processWebhookEvent({
      kind: 'webhook',
      event: 'call.status.updated',
      data: { call_id: 'c_q1', status: 'in_progress' },
      receivedAtIso: receivedAt.toISOString(),
    });

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('IN_PROGRESS');
    expect(attempt.answeredAt).toEqual(receivedAt);
  });
});
