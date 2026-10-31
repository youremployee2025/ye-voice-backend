import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Mocked because the ingest's first pass runs the moment its schedule is
 * registered — otherwise the table stays empty for a whole interval after a
 * deploy, which reads as a broken feature rather than as a worker that has not
 * run yet. That immediate pass is real work, and no test in this suite may
 * reach the partner account.
 */
const { listCallsMock } = vi.hoisted(() => ({ listCallsMock: vi.fn(async () => ({ calls: [] })) }));

vi.mock('../src/adapter/vocobase.js', () => ({ listCalls: listCallsMock }));

/**
 * The analytics worker's headline safety property, asserted rather than assumed.
 *
 * `createApp()` must not start the ingest timer. Every test in this suite builds
 * an app; if building one started a pass, the suite would read the production
 * partner account on a clock — and the failures would look like flakes rather
 * than like the cause.
 *
 * The same rule the renewal sweep and the dispatcher hold, in its own file:
 * adding a fourth assertion to theirs would buy a rebase conflict for nothing,
 * and this worker's reason for the rule is its own — it spends a rate limit
 * every customer of the voice platform shares.
 */

const appSource = () =>
  import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/app.ts', import.meta.url), 'utf8'),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createApp', () => {
  it('starts no timer that reads the partner account', async () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    const { createApp } = await import('../src/app.js');
    createApp();

    expect(setInterval).not.toHaveBeenCalled();
  });

  it('does not schedule the analytics ingest from the app module graph', async () => {
    // The ingest module is reachable from `app.ts` — the refresh route calls
    // `runAnalyticsSync` — so the module itself cannot be asserted absent. What
    // can be, and is what matters, is that nothing in `app.ts` puts it on a
    // schedule. That belongs to the queue bootstrap alone.
    expect(await appSource()).not.toContain('ANALYTICS_SYNC');
    expect(await appSource()).not.toContain('analyticsSyncInterval');
  });
});

describe('the ingest schedule', () => {
  const source = (file: string) =>
    import('node:fs/promises').then((fs) =>
      fs.readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'),
    );

  it('is registered only behind the env flag', async () => {
    // The flag is not decoration. The sweep walks the platform's call listing
    // against a rate limit every customer of that platform shares, so it is
    // switched on per deployment rather than inherited by anything that boots
    // a worker.
    const repeatable = await source('lib/queue/repeatable.ts');

    expect(repeatable).toContain('ANALYTICS_SYNC');
    expect(repeatable).toContain('env.analyticsSyncIntervalMs');

    // Presence before position: `indexOf` answers -1 for a missing gate and
    // any real index clears -1, so the comparison alone passed with the gate
    // deleted. The behavioral halves live in queue-repeatable.test.ts and
    // maintenance-guards.test.ts.
    const gate = repeatable.indexOf('if (env.analyticsSyncEnabled)');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(repeatable.indexOf('REPEATABLE_JOB_IDS.ANALYTICS_SYNC')).toBeGreaterThan(gate);
  });

  it('is registered exactly once however many instances boot', async () => {
    // The property a timer could not have, and the reason this moved: three
    // replicas of a `setInterval` are three walks of the same listing. The
    // schedule is keyed in Redis, so three registrations are one schedule.
    const { maintenanceQueue } = await import('../src/lib/queue/queues.js');
    const { registerRepeatableJobs } = await import('../src/lib/queue/repeatable.js');
    const { closeQueues } = await import('../src/lib/queue/queues.js');
    const { closeQueueConnection } = await import('../src/lib/queue/connection.js');
    const { env } = await import('../src/lib/env.js');

    for (const scheduler of await maintenanceQueue.getJobSchedulers()) {
      await maintenanceQueue.removeJobScheduler(scheduler.key);
    }
    await maintenanceQueue.obliterate({ force: true });

    // The switch is on for this case, or the schedule under test is never
    // registered at all and the uniqueness predicate passes over an empty
    // list — a test of nothing. A count beside the uniqueness, because a
    // registration appending under a distinct per-instance key would keep
    // every key unique while doubling the walk.
    env.analyticsSyncEnabled = true;
    try {
      await registerRepeatableJobs();
      const afterOne = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key).sort();

      await registerRepeatableJobs();
      const afterTwo = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key).sort();

      expect(afterOne.some((key) => key.includes('analytics-sync'))).toBe(true);
      /**
       * Against a real baseline, not a literal and not a floor.
       *
       * The failure this exists to catch is a registration that appends under
       * a distinct per-instance key: every key stays unique and the count
       * still clears any floor, while the walk runs twice. Only comparing the
       * second boot to the first can see it — a `toBeGreaterThanOrEqual`
       * passes just as happily on eight keys as on four. A literal count was
       * the other wrong answer: it restated how many sweeps happen to exist
       * and failed every time one was added, for the wrong reason.
       */
      expect(afterTwo).toEqual(afterOne);
    } finally {
      env.analyticsSyncEnabled = false;
      for (const scheduler of await maintenanceQueue.getJobSchedulers()) {
        await maintenanceQueue.removeJobScheduler(scheduler.key);
      }
      await maintenanceQueue.obliterate({ force: true });
      await closeQueues();
      await closeQueueConnection();
    }
  });
});
