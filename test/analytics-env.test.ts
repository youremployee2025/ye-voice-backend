import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The analytics worker's configuration, read at boot.
 *
 * In its own file rather than added to `env.test.ts` — that file belongs to
 * another slice's settings and editing it buys a rebase conflict for nothing.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('../src/lib/env.js')).env;
}

const saved = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...saved };
});

describe('ANALYTICS_SYNC_ENABLED', () => {
  it('is off when unset', async () => {
    delete process.env.ANALYTICS_SYNC_ENABLED;

    expect((await loadEnv()).analyticsSyncEnabled).toBe(false);
  });

  it('is on for `true`, whatever the case and spacing', async () => {
    for (const raw of ['true', 'TRUE', ' True ']) {
      process.env.ANALYTICS_SYNC_ENABLED = raw;
      expect((await loadEnv()).analyticsSyncEnabled).toBe(true);
    }
  });

  it('is off for `false`, whatever the case', async () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      process.env.ANALYTICS_SYNC_ENABLED = raw;
      expect((await loadEnv()).analyticsSyncEnabled).toBe(false);
    }
  });

  it('refuses anything that is not exactly true or false', async () => {
    // Shared with the dialer switch, and strict for the same reason: a
    // permissive parser is the wrong shape for a safety control. Read loosely,
    // `ANALYTICS_SYNC_ENABLED=yes` is either false — a worker off while the
    // operator believes it is on — or true, which is worse. Neither reading is
    // defensible, so the operator learns at boot instead.
    for (const raw of ['1', 'yes', 'on', 'sure']) {
      process.env.ANALYTICS_SYNC_ENABLED = raw;
      await expect(loadEnv()).rejects.toThrow(/must be exactly/);
    }
  });
});

describe('numeric analytics settings', () => {
  it('uses documented defaults when unset', async () => {
    for (const name of [
      'ANALYTICS_SYNC_INTERVAL_MS',
      'ANALYTICS_SYNC_MAX_PAGES',
      'ANALYTICS_SYNC_OVERLAP_MINS',
      'ANALYTICS_REFRESH_RATE_LIMIT_MAX',
    ]) {
      delete process.env[name];
    }

    const env = await loadEnv();

    expect(env.analyticsSyncIntervalMs).toBe(300_000);
    expect(env.analyticsSyncMaxPages).toBe(20);
    expect(env.analyticsSyncOverlapMins).toBe(10);
    expect(env.analyticsRefreshRateLimitMax).toBe(4);
  });

  it('reads valid overrides', async () => {
    process.env.ANALYTICS_SYNC_INTERVAL_MS = '60000';
    process.env.ANALYTICS_SYNC_MAX_PAGES = '3';
    process.env.ANALYTICS_SYNC_OVERLAP_MINS = '0';

    const env = await loadEnv();

    expect(env.analyticsSyncIntervalMs).toBe(60_000);
    expect(env.analyticsSyncMaxPages).toBe(3);
    // Zero overlap is legal — allowed, but it has to be asked for.
    expect(env.analyticsSyncOverlapMins).toBe(0);
  });

  it('refuses an interval below the floor rather than clamping it', async () => {
    // A sub-minute interval is a worker spending a shared upstream budget in a
    // tight loop. Loud at boot beats slow at runtime.
    process.env.ANALYTICS_SYNC_INTERVAL_MS = '1000';

    await expect(loadEnv()).rejects.toThrow(/at least 60000/);
  });

  it('refuses a zero page budget', async () => {
    // Zero is a worker that runs forever and ingests nothing, which reads as an
    // empty product rather than as a misconfiguration.
    process.env.ANALYTICS_SYNC_MAX_PAGES = '0';

    await expect(loadEnv()).rejects.toThrow(/at least 1/);
  });

  it('refuses a value that is not a whole number', async () => {
    process.env.ANALYTICS_REFRESH_RATE_LIMIT_MAX = 'lots';

    await expect(loadEnv()).rejects.toThrow(/ANALYTICS_REFRESH_RATE_LIMIT_MAX/);
  });
});
