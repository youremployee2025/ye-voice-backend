import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The multi-instance invariant, asserted directly.
 *
 * Every instance runs the same bootstrap, so every instance registers the same
 * repeatable schedules. If that produced one schedule per instance, three
 * replicas would sweep three times a minute instead of once and the platform's
 * call-start rate limit would be the thing that noticed.
 *
 * BullMQ dedups by the repeat key — the job name, the repeat options and the
 * supplied `jobId` — so registering the same schedule twice replaces it rather
 * than adding to it. This file is the proof, because "the library does it" is
 * a claim that should be checked before a phone bill checks it.
 */

const { campaignDispatchQueue, campaignCleanupQueue, maintenanceQueue, closeQueues } =
  await import('../src/lib/queue/queues.js');
const { env } = await import('../src/lib/env.js');
const { registerRepeatableJobs } = await import('../src/lib/queue/repeatable.js');
const { closeQueueConnection } = await import('../src/lib/queue/connection.js');

async function clearSchedulers() {
  for (const queue of [campaignDispatchQueue, campaignCleanupQueue, maintenanceQueue]) {
    for (const scheduler of await queue.getJobSchedulers()) {
      await queue.removeJobScheduler(scheduler.key);
    }
    await queue.obliterate({ force: true });
  }
}

beforeEach(clearSchedulers);

afterAll(async () => {
  await clearSchedulers();
  await closeQueues();
  await closeQueueConnection();
});

describe('repeatable job registration', () => {
  it('registers one schedule per job', async () => {
    await registerRepeatableJobs();

    expect(await campaignDispatchQueue.getJobSchedulers()).toHaveLength(1);
    expect(await campaignCleanupQueue.getJobSchedulers()).toHaveLength(1);
  });

  it('does not double-register when a second instance boots', async () => {
    await registerRepeatableJobs();
    await registerRepeatableJobs();
    await registerRepeatableJobs();

    // Three instances, one schedule. This is the whole reason the refactor is
    // safe to deploy on more than one box.
    expect(await campaignDispatchQueue.getJobSchedulers()).toHaveLength(1);
    expect(await campaignCleanupQueue.getJobSchedulers()).toHaveLength(1);
  });

  it('registers the maintenance sweeps under distinct keys', async () => {
    await registerRepeatableJobs();
    await registerRepeatableJobs();

    const schedulers = await maintenanceQueue.getJobSchedulers();
    const keys = schedulers.map((scheduler) => scheduler.key).sort();

    // The schedule scan is gated on the dialer, which the suite turns on; the
    // analytics sync is gated on its own switch, which is off by default. So
    // what must be here is the three that are unconditional plus the scan.
    // Three unconditional sweeps plus the dialer-gated scan; a count as well
    // as uniqueness, because a registration that appended under a distinct
    // per-instance key would keep every key unique while doubling the work.
    // did-renewal, agent-sync and the wallet top-up poll are ungated; the
    // schedule scan follows the dialer switch and analytics its own. Counting
    // them explicitly keeps this assertion about uniqueness rather than about
    // which switches are on.
    expect(keys).toHaveLength(
      3 + (env.dialerEnabled ? 1 : 0) + (env.analyticsSyncEnabled ? 1 : 0),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((key) => key.includes('did-renewal'))).toBe(true);
    expect(keys.some((key) => key.includes('schedule-scan'))).toBe(true);
  });

  /**
   * Registration must be symmetric. A BullMQ job scheduler is persistent
   * Redis state: once registered it fires forever, whether or not the process
   * that registered it still boots that branch. So "don't register when the
   * flag is off" is not a disable — turning `DIALER_ENABLED` off and
   * redeploying left the schedule scan firing, and a scanner that runs with
   * the dialer off records `DIALER_DISABLED` as a permanent refusal and
   * clears the schedule of every campaign somebody set for tonight.
   */
  it('removes the dialer-gated schedulers when the switch is turned off', async () => {
    await registerRepeatableJobs();

    expect(await campaignDispatchQueue.getJobSchedulers()).toHaveLength(1);

    env.dialerEnabled = false;
    try {
      await registerRepeatableJobs();
    } finally {
      env.dialerEnabled = true;
    }

    expect(await campaignDispatchQueue.getJobSchedulers()).toHaveLength(0);
    const keys = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key);
    expect(keys.some((key) => key.includes('schedule-scan'))).toBe(false);
    // The ungated sweeps stay.
    expect(keys.some((key) => key.includes('did-renewal'))).toBe(true);
  });

  it('registers the wallet top-up poll on the maintenance queue', async () => {
    await registerRepeatableJobs();

    const schedulers = await maintenanceQueue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain('maintenance-wallet-topup-poll');

    // The key existing proves nothing about the period: a copy-paste of a
    // neighbouring interval would ship a 15-minute wallet poll unnoticed.
    const scheduler = schedulers.find((s) => s.key === 'maintenance-wallet-topup-poll');
    expect(scheduler?.every).toBe(env.walletTopupPollMs);
  });

  it('registers and removes the analytics sync as its switch moves', async () => {
    env.analyticsSyncEnabled = true;
    try {
      await registerRepeatableJobs();

      const withSync = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key);
      expect(withSync.some((key) => key.includes('analytics-sync'))).toBe(true);

      env.analyticsSyncEnabled = false;
      await registerRepeatableJobs();

      const withoutSync = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key);
      expect(withoutSync.some((key) => key.includes('analytics-sync'))).toBe(false);
    } finally {
      env.analyticsSyncEnabled = false;
    }
  });
});

/**
 * The agent mirror needs a sweep like every other mirror here.
 *
 * `Agent.variables` is the platform's, and the platform recomputes nothing on
 * our behalf: an agent edited anywhere except through this backend's own PATCH
 * leaves the local copy stale indefinitely, because nothing was scheduled to
 * notice. A stale copy is not a cosmetic problem — the CSV column mapper
 * offers variables out of it, so an agent that genuinely declares `name` shows
 * an empty picker and the operator cannot map a column onto it.
 */
describe('agent mirror refresh', () => {
  it('registers a schedule on the maintenance queue', async () => {
    const { REPEATABLE_JOB_IDS } = await import('../src/lib/queue/types.js');

    await registerRepeatableJobs();

    const keys = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key);
    expect(keys).toContain(REPEATABLE_JOB_IDS.AGENT_SYNC);
  });

  it('registers it at the configured interval', async () => {
    const { REPEATABLE_JOB_IDS } = await import('../src/lib/queue/types.js');

    await registerRepeatableJobs();

    const scheduler = (await maintenanceQueue.getJobSchedulers()).find(
      (s) => s.key === REPEATABLE_JOB_IDS.AGENT_SYNC,
    );
    expect(scheduler?.every).toBe(env.agentSyncIntervalMs);
  });

  /** Unlike the dialer and analytics pairs, this one is not gated: a stale
   *  mirror is wrong in every configuration, and refreshing it places no call
   *  and spends no credit. */
  it('registers it whether or not the dialer is enabled', async () => {
    const { REPEATABLE_JOB_IDS } = await import('../src/lib/queue/types.js');
    // `env` is an eagerly-evaluated literal — `flag('DIALER_ENABLED', …)` reads
    // `process.env` once, at import. Setting the variable here changes nothing
    // and the case passed with agent-sync gated on the very switch it claims
    // independence from. Mutate the resolved value, as every sibling does.
    const previous = env.dialerEnabled;
    env.dialerEnabled = false;

    try {
      await registerRepeatableJobs();
      const keys = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key);
      expect(keys).toContain(REPEATABLE_JOB_IDS.AGENT_SYNC);
    } finally {
      env.dialerEnabled = previous;
    }
  });
});
