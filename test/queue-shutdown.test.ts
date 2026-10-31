import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `stopWorkers()` must be a complete teardown.
 *
 * Each worker runs on a dedicated ioredis instance from
 * `createWorkerConnection()`, and BullMQ treats a caller-supplied instance as
 * shared: `worker.close()` closes only the blocking duplicate it made
 * internally and leaves the supplied connection open. The two shipped
 * entrypoints mask that with `process.exit(0)`, but every non-exiting caller
 * — the vitest suite, the conformance harness, a future hot restart — is left
 * holding live sockets with reconnect timers, and the event loop never
 * drains.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { startWorkers, stopWorkers } = await import('../src/lib/queue/bootstrap.js');
const { openWorkerConnectionCount } = await import('../src/lib/queue/connection.js');
const { ALL_QUEUES } = await import('../src/lib/queue/queues.js');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
});

describe('worker shutdown', () => {
  it('closes every worker connection, not only the shared queue singleton', async () => {
    await startWorkers();

    // One dedicated connection per worker — the invariant connection.ts
    // documents. If this number changes, the factory list changed.
    expect(openWorkerConnectionCount()).toBe(5);

    // The repeatable schedules the boot registered are persistent Redis
    // state; drop them before teardown so this test leaves the shared test
    // Redis exactly as it found it.
    for (const queue of ALL_QUEUES) {
      const schedulers = await queue.getJobSchedulers();
      for (const scheduler of schedulers) {
        if (scheduler.key) await queue.removeJobScheduler(scheduler.key);
      }
      await queue.obliterate({ force: true });
    }

    await stopWorkers();

    expect(openWorkerConnectionCount()).toBe(0);
  });
});
