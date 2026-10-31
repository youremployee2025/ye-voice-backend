import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from 'bullmq';

/**
 * The maintenance worker's own flag checks, against a real worker.
 *
 * The registration gate in `repeatable.ts` is the first line, but it cannot
 * reach a scheduler that already exists in Redis — one registered by an older
 * build, or orphaned by a renamed id (`types.ts` warns about exactly that).
 * The consumer is the layer that can, the way `runDialerSweep` re-checks
 * `DIALER_ENABLED` on every pass: a `schedule-scan` job arriving with the
 * dialer off must not run the scanner, whose `DIALER_DISABLED` refusals
 * permanently unschedule campaigns; an `analytics-sync` job arriving with its
 * switch off must not spend the shared partner rate limit.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

vi.mock('../src/services/scheduleScanner.js', () => ({
  runScheduleScan: vi.fn(async () => ({ started: 0, refused: 0, errored: 0 })),
}));

vi.mock('../src/services/analyticsIngest.js', () => ({
  runAnalyticsSync: vi.fn(async () => undefined),
}));

// Mocked for the same reason as its two neighbours: this file grades the
// worker's routing and its flag checks, not what each sweep does. The real
// `syncAllAgents` walks the shared partner listing.
vi.mock('../src/services/agentSync.js', () => ({
  syncAllAgents: vi.fn(async () => ({ synced: 0, removed: 0, truncated: false })),
}));

// And the wallet poll, by the same rule: the real one reads every open link
// from the supplier.
vi.mock('../src/services/platformWallet.js', () => ({
  refreshOpenTopups: vi.fn(async () => ({ refreshed: 0, credited: 0, expired: 0, failed: 0 })),
}));

const { env } = await import('../src/lib/env.js');
const { maintenanceQueue, closeQueues } = await import('../src/lib/queue/queues.js');
const { createMaintenanceWorker, dispatch } = await import(
  '../src/lib/queue/workers/maintenance.worker.js'
);
import type { MaintenanceJobKind } from '../src/lib/queue/types.js';
const { closeWorkerConnections, closeQueueConnection } = await import(
  '../src/lib/queue/connection.js'
);
const { runScheduleScan } = await import('../src/services/scheduleScanner.js');
const { runAnalyticsSync } = await import('../src/services/analyticsIngest.js');

let worker: Worker | null = null;

/** Runs one maintenance job of the given kind through a real worker. */
async function runKind(kind: string): Promise<void> {
  await maintenanceQueue.add('maintenance', { kind });
  worker ??= createMaintenanceWorker();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job never settled')), 10_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    worker!.on('completed', done);
    worker!.on('failed', done);
  });
}

beforeEach(async () => {
  await maintenanceQueue.obliterate({ force: true });
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await worker?.close();
  worker = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await maintenanceQueue.obliterate({ force: true });
  await closeWorkerConnections();
  await closeQueues();
  await closeQueueConnection();
});

describe('maintenance worker flag guards', () => {
  it('does not run the schedule scan while the dialer is off', async () => {
    env.dialerEnabled = false;
    try {
      await runKind('schedule-scan');
    } finally {
      env.dialerEnabled = true;
    }

    expect(runScheduleScan).not.toHaveBeenCalled();
  });

  it('runs the schedule scan while the dialer is on', async () => {
    await runKind('schedule-scan');

    expect(runScheduleScan).toHaveBeenCalledTimes(1);
  });

  it('does not run the analytics sync while its switch is off', async () => {
    // Off by default, including in tests — asserted rather than assumed.
    expect(env.analyticsSyncEnabled).toBe(false);

    await runKind('analytics-sync');

    expect(runAnalyticsSync).not.toHaveBeenCalled();
  });

  it('runs the analytics sync while its switch is on', async () => {
    env.analyticsSyncEnabled = true;
    try {
      await runKind('analytics-sync');
    } finally {
      env.analyticsSyncEnabled = false;
    }

    expect(runAnalyticsSync).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every kind the union declares has a case in the switch.
 *
 * `dispatch` ends in a `default:` that throws, and a `default` is exactly what
 * turns off TypeScript's exhaustiveness check — so adding a member to
 * `MaintenanceJobKind` and a scheduler for it compiles perfectly, and the only
 * symptom is a worker that throws on every tick in production. Nothing else
 * covers this: `agent-sync` shipped with a registration, a scheduler and a
 * case, and no test ever dispatched it.
 *
 * Deliberately asserts on the *default* rather than on what each handler does.
 * The handlers have their own cases above; this one only has to fail when a
 * kind has no handler at all.
 */
describe('every maintenance kind is handled', () => {
  const KINDS: MaintenanceJobKind[] = [
    'schedule-scan',
    'did-renewal',
    'analytics-sync',
    'agent-sync',
    'wallet-topup-poll',
  ];

  it('covers exactly the kinds the union declares', () => {
    // A compile-time pin as well as a runtime one: adding a member to the
    // union without adding it here stops type-checking, so the list cannot
    // silently fall behind the thing it is testing.
    const exhaustive: Record<MaintenanceJobKind, true> = {
      'schedule-scan': true,
      'did-renewal': true,
      'analytics-sync': true,
      'agent-sync': true,
      'wallet-topup-poll': true,
    };

    expect(Object.keys(exhaustive).sort()).toEqual([...KINDS].sort());
  });

  it.each(KINDS)('dispatches %s without falling through to the default', async (kind) => {
    await expect(dispatch(kind)).resolves.not.toThrow();
  });
});
