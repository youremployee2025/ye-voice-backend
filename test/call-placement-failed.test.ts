import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';

/**
 * The failed-handler's give-back, on the path retries never reach.
 *
 * The handler releases a contact only on the *last* attempt — releasing
 * earlier would put it back on the queue while a retry of its own dial is
 * still pending. But BullMQ's deferred-failure path (a job stalled past the
 * allowance) fails a job without consuming its attempts: `attemptsMade`
 * arrives below `attempts`, no retry is coming, and the last-attempt guard
 * alone skipped the release — stranding the contact until the claim lease
 * expires. An `UnrecoverableError` is BullMQ's own word for "no retry is
 * coming", so it releases too.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

vi.mock('../src/services/dialerPlacement.js', () => ({
  placeClaimedCall: vi.fn(),
  releaseFailedPlacement: vi.fn(async () => undefined),
}));

const { placeClaimedCall, releaseFailedPlacement } = await import(
  '../src/services/dialerPlacement.js'
);
const { createCallPlacementWorker } = await import(
  '../src/lib/queue/workers/call-placement.worker.js'
);
const { callPlacementQueue, closeQueues } = await import('../src/lib/queue/queues.js');
const { closeWorkerConnections, closeQueueConnection } = await import(
  '../src/lib/queue/connection.js'
);

const JOB = {
  kind: 'call-placement',
  campaignId: 'cmp_1',
  contactId: 'cc_1',
  attemptNo: 1,
  fromNumber: '+15550000001',
  batchId: 'batch_1',
  nowIso: new Date().toISOString(),
};

let worker: ReturnType<typeof createCallPlacementWorker> | null = null;

async function failOnce(): Promise<void> {
  await callPlacementQueue.add('placement', JOB);
  worker ??= createCallPlacementWorker();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job never failed')), 10_000);
    worker!.on('failed', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // The release is fired from an event handler; give it a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(async () => {
  await callPlacementQueue.obliterate({ force: true });
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await worker?.close();
  worker = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await callPlacementQueue.obliterate({ force: true });
  await closeWorkerConnections();
  await closeQueues();
  await closeQueueConnection();
});

describe('the placement retry policy', () => {
  it('redelivers a job that failed on an infra error, and the retry runs', async () => {
    // The three-attempt policy exists for infra errors — placeClaimedCall
    // returns rather than throws for every dialer-named outcome — and until
    // now no test ever let BullMQ actually redeliver. Backoff is overridden
    // per job to keep the suite fast; the policy's numbers are asserted on
    // the queue's defaults elsewhere.
    vi.mocked(placeClaimedCall)
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValue({ disposition: 'not-claimed' } as never);

    await callPlacementQueue.add('placement', JOB, {
      attempts: 3,
      backoff: { type: 'fixed', delay: 20 },
    });
    worker ??= createCallPlacementWorker();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('job never completed')), 10_000);
      worker!.on('completed', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(placeClaimedCall).toHaveBeenCalledTimes(2);
    // A retry is the same job: same contact, same fixed attempt ordinal.
    expect(vi.mocked(placeClaimedCall).mock.calls.every(([data]) => data.attemptNo === 1)).toBe(
      true,
    );
    // Nothing to give back — the retry succeeded.
    expect(releaseFailedPlacement).not.toHaveBeenCalled();
  });
});

describe('the placement failed handler', () => {
  it('releases the contact when the failure is unrecoverable, retries or not', async () => {
    vi.mocked(placeClaimedCall).mockRejectedValue(new UnrecoverableError('job stalled'));

    await failOnce();

    // attemptsMade is 1 of 3 here — below the last-attempt guard — and no
    // retry is coming. The release must fire anyway.
    expect(releaseFailedPlacement).toHaveBeenCalledTimes(1);
    expect(releaseFailedPlacement).toHaveBeenCalledWith(JOB);
  });
});
