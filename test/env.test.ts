import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The limiter's cap arrives as a string from the environment, and a malformed
 * one used to become `NaN`. Every comparison against `NaN` is false, so
 * `count > limit` never fired: a typo did not raise the cap, it removed the
 * limiter. A misconfigured limit has to be loud at boot rather than absent at
 * runtime.
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

describe('numeric configuration', () => {
  it('uses the default when the variable is unset', async () => {
    delete process.env.ADMIN_RATE_LIMIT_MAX;

    expect((await loadEnv()).adminRateLimitMax).toBe(600);
  });

  it('uses the default when the variable is blank', async () => {
    process.env.ADMIN_RATE_LIMIT_MAX = '   ';

    expect((await loadEnv()).adminRateLimitMax).toBe(600);
  });

  it('reads a valid override', async () => {
    process.env.ADMIN_RATE_LIMIT_MAX = '5';

    expect((await loadEnv()).adminRateLimitMax).toBe(5);
  });

  it('refuses a non-numeric cap rather than disabling the limiter', async () => {
    process.env.ADMIN_RATE_LIMIT_MAX = 'sixty';

    await expect(loadEnv()).rejects.toThrow(/ADMIN_RATE_LIMIT_MAX/);
  });

  it('refuses a negative cap', async () => {
    process.env.ADMIN_RATE_LIMIT_MAX = '-1';

    await expect(loadEnv()).rejects.toThrow(/ADMIN_RATE_LIMIT_MAX/);
  });

  it('refuses a fractional window', async () => {
    process.env.ADMIN_RATE_LIMIT_WINDOW_MS = '1.5';

    await expect(loadEnv()).rejects.toThrow(/ADMIN_RATE_LIMIT_WINDOW_MS/);
  });

  it('defaults the proxy hop count to trusting nothing', async () => {
    delete process.env.TRUST_PROXY_HOPS;

    expect((await loadEnv()).trustProxyHops).toBe(0);
  });
});

describe('DID_DEFAULT_MONTHLY_PRICE_CREDITS', () => {
  it('defaults to 500 display credits in internal units', async () => {
    delete process.env.DID_DEFAULT_MONTHLY_PRICE_CREDITS;
    const env = await loadEnv();
    expect(env.didDefaultMonthlyPriceCredits).toBe(5_000_000n);
  });

  it('accepts a fractional price exactly', async () => {
    process.env.DID_DEFAULT_MONTHLY_PRICE_CREDITS = '12.34';
    const env = await loadEnv();
    expect(env.didDefaultMonthlyPriceCredits).toBe(123_400n);
  });

  it('refuses to boot on a malformed price rather than charging a guess', async () => {
    process.env.DID_DEFAULT_MONTHLY_PRICE_CREDITS = 'five hundred';
    await expect(loadEnv()).rejects.toThrow(/DID_DEFAULT_MONTHLY_PRICE_CREDITS/);
  });

  it('refuses a negative price', async () => {
    process.env.DID_DEFAULT_MONTHLY_PRICE_CREDITS = '-1';
    await expect(loadEnv()).rejects.toThrow(/DID_DEFAULT_MONTHLY_PRICE_CREDITS/);
  });
});

describe('the renewal sweep period', () => {
  it('refuses a period below a minute', async () => {
    // `0` used to pass, and setInterval(fn, 0) is clamped to about a
    // millisecond: a thousand overlapping sweeps a second, each opening
    // transactions against a shared pool. The compare-and-set keeps that
    // correct; it does not keep it survivable.
    process.env.DID_RENEWAL_SWEEP_MS = '0';

    await expect(loadEnv()).rejects.toThrow(/at least 60000/);
  });

  it('accepts a period at the floor', async () => {
    process.env.DID_RENEWAL_SWEEP_MS = '60000';

    expect((await loadEnv()).didRenewalSweepMs).toBe(60_000);
  });
});

describe('the non-payment grace window', () => {
  it('defaults to a week', async () => {
    delete process.env.DID_GRACE_DAYS;

    expect((await loadEnv()).didGraceDays).toBe(7);
  });

  it('allows zero, which releases on the first decline', async () => {
    // Allowed, but it has to be asked for — it is the behaviour that cost
    // people their numbers over a one-credit shortfall.
    process.env.DID_GRACE_DAYS = '0';

    expect((await loadEnv()).didGraceDays).toBe(0);
  });

  it('refuses a negative window', async () => {
    process.env.DID_GRACE_DAYS = '-1';

    await expect(loadEnv()).rejects.toThrow(/DID_GRACE_DAYS/);
  });
});

describe('the voice platform URL', () => {
  it('refuses a malformed URL at boot', async () => {
    // Unvalidated, this threw `TypeError: Invalid URL` from inside the adapter
    // on the first upstream call, which surfaced as a generic 500 and looked
    // nothing like the configuration mistake it was.
    process.env.VOCOBASE_API_URL = 'not-a-url';

    await expect(loadEnv()).rejects.toThrow(/VOCOBASE_API_URL/);
  });

  it('accepts an absolute URL', async () => {
    process.env.VOCOBASE_API_URL = 'https://api.example.test/api/v2';

    expect((await loadEnv()).vocobaseApiUrl).toBe('https://api.example.test/api/v2');
  });
});

describe('RECORDING_TOKEN_SECRET', () => {
  it('stays empty when unconfigured, so every token is invalid and the service starts', async () => {
    // Explicitly empty rather than deleted: dotenv would repopulate it from
    // the local .env and the test would assert nothing.
    process.env.RECORDING_TOKEN_SECRET = '';

    expect((await loadEnv()).recordingTokenSecret).toBe('');
  });

  it('reads a strong secret', async () => {
    const strong = 'a'.repeat(64);
    process.env.RECORDING_TOKEN_SECRET = strong;

    expect((await loadEnv()).recordingTokenSecret).toBe(strong);
  });

  it('refuses a secret short enough to be worth guessing', async () => {
    // Empty fails closed, but a weak value fails *open*: one legitimately
    // minted token is an offline oracle, and a cracked secret forges tokens
    // for any (workspace, call) pair — including for somebody who has since
    // been removed from that workspace.
    process.env.RECORDING_TOKEN_SECRET = 'dev';

    await expect(loadEnv()).rejects.toThrow(/RECORDING_TOKEN_SECRET/);
  });
});

describe('DIALER_ENABLED', () => {
  it('is off unless it is deliberately turned on', async () => {
    process.env.DIALER_ENABLED = '';

    expect((await loadEnv()).dialerEnabled).toBe(false);
  });

  it('reads true and false', async () => {
    process.env.DIALER_ENABLED = 'true';
    expect((await loadEnv()).dialerEnabled).toBe(true);

    process.env.DIALER_ENABLED = 'FALSE';
    expect((await loadEnv()).dialerEnabled).toBe(false);
  });

  /**
   * A permissive parser is the wrong shape for the switch that decides whether
   * this deployment can ring a stranger's phone. Read loosely, `yes` is either
   * false — a switch that is off while the operator believes it is on — or
   * true, which is worse. Neither reading is defensible, so the operator finds
   * out at boot instead of from a phone bill.
   */
  it('refuses anything that is not exactly true or false', async () => {
    for (const value of ['yes', '1', 'on', 'enabled', 'true false']) {
      process.env.DIALER_ENABLED = value;
      await expect(loadEnv()).rejects.toThrow(/DIALER_ENABLED/);
    }
  });

  it('tolerates surrounding whitespace and case, as every other reader here does', async () => {
    process.env.DIALER_ENABLED = '  True  ';

    expect((await loadEnv()).dialerEnabled).toBe(true);
  });
});

/**
 * Which process runs the background workers.
 *
 * The opposite default to `DIALER_ENABLED`, and deliberately: this flag decides
 * *where* the workers run, not *whether* the platform may dial. Off by default
 * it would silently stop every existing single-process deployment's renewal
 * sweep — money that quietly stops being collected. The four controls that
 * decide whether a call is placed are all still in front of it.
 *
 * Three states rather than one, because "test" means two different things
 * here. The cases below run inside vitest, so reaching the other two means
 * unsetting `VITEST` for the duration — which is itself the point of the first
 * case: nothing a test can do from the *inside* turns the workers on.
 */
describe('WORKERS_ENABLED', () => {
  /** Restores whatever vitest set, since `afterEach` restores a snapshot taken before it. */
  const withoutVitest = async (fn: () => Promise<void>) => {
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await fn();
    } finally {
      if (vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitest;
    }
  };

  it('is off under vitest, and no variable can turn it on', async () => {
    // The one gate in env.ts that is not a preference. A unit suite that spun
    // up a dispatch worker would place real calls against whatever Redis it
    // found, and it would read as a flaky test rather than a phone bill.
    process.env.WORKERS_ENABLED = 'true';
    expect((await loadEnv()).workersEnabled).toBe(false);

    // Not even a value that would normally be a startup failure, because this
    // branch returns before the flag is ever parsed.
    process.env.WORKERS_ENABLED = 'no';
    expect((await loadEnv()).workersEnabled).toBe(false);
  });

  it('is off by default under NODE_ENV=test, but can be asked for', async () => {
    await withoutVitest(async () => {
      process.env.NODE_ENV = 'test';

      // The battle harness's combination: it needs `NODE_ENV=test` for the
      // header-auth path and real workers to be worth running at all, so it
      // says so explicitly. Anything else that merely happens to set NODE_ENV
      // gets the safe answer.
      delete process.env.WORKERS_ENABLED;
      expect((await loadEnv()).workersEnabled).toBe(false);

      process.env.WORKERS_ENABLED = 'true';
      expect((await loadEnv()).workersEnabled).toBe(true);
    });
  });

  it('is on unless it is deliberately turned off', async () => {
    await withoutVitest(async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.WORKERS_ENABLED;

      expect((await loadEnv()).workersEnabled).toBe(true);
    });
  });

  it('reads true and false', async () => {
    await withoutVitest(async () => {
      process.env.NODE_ENV = 'production';

      process.env.WORKERS_ENABLED = 'false';
      expect((await loadEnv()).workersEnabled).toBe(false);

      process.env.WORKERS_ENABLED = 'TRUE';
      expect((await loadEnv()).workersEnabled).toBe(true);
    });
  });

  it('refuses anything that is not exactly true or false', async () => {
    await withoutVitest(async () => {
      process.env.NODE_ENV = 'production';
      process.env.WORKERS_ENABLED = 'no';

      await expect(loadEnv()).rejects.toThrow(/WORKERS_ENABLED/);
    });
  });
});

describe('DIALER_TEST_ALLOWLIST', () => {
  it('is empty when unset, which means no restriction rather than no calls', async () => {
    process.env.DIALER_TEST_ALLOWLIST = '';

    expect((await loadEnv()).dialerTestAllowlist.size).toBe(0);
  });

  it('canonicalizes every entry, so one number written two ways is one entry', async () => {
    process.env.DIALER_TEST_ALLOWLIST = '+91 98765 43210, +919876543210 ,+14155551234';

    const allowlist = (await loadEnv()).dialerTestAllowlist;

    expect(allowlist.size).toBe(2);
    expect(allowlist.has('+919876543210')).toBe(true);
    expect(allowlist.has('+14155551234')).toBe(true);
  });

  /**
   * The entry that will not parse is the one that matters. Left to fail
   * silently at match time it would never equal any contact's number — which
   * looks exactly like the allowlist doing its job, right up to the moment
   * somebody trusts it and takes it out.
   */
  it('refuses an entry that is not a phone number, naming it', async () => {
    process.env.DIALER_TEST_ALLOWLIST = '+919876543210,not-a-number';

    await expect(loadEnv()).rejects.toThrow(/DIALER_TEST_ALLOWLIST/);
  });

  it('refuses a number with no country code rather than guessing one', async () => {
    process.env.DIALER_TEST_ALLOWLIST = '9876543210';

    await expect(loadEnv()).rejects.toThrow(/DIALER_TEST_ALLOWLIST/);
  });
});

describe('VOCOBASE_WEBHOOK_SECRET', () => {
  it('stays empty when unconfigured, so every delivery fails verification', async () => {
    process.env.VOCOBASE_WEBHOOK_SECRET = '';

    expect((await loadEnv()).vocobaseWebhookSecret).toBe('');
  });

  it('refuses a secret short enough to be worth guessing', async () => {
    process.env.VOCOBASE_WEBHOOK_SECRET = 'whsec_dev';

    await expect(loadEnv()).rejects.toThrow(/VOCOBASE_WEBHOOK_SECRET/);
  });
});

describe('the dialer caps', () => {
  it('floors the sweep period at a minute', async () => {
    process.env.DIALER_SWEEP_MS = '0';

    await expect(loadEnv()).rejects.toThrow(/DIALER_SWEEP_MS/);
  });

  it('refuses a per-sweep cap of zero, which would be a dialer that never dials', async () => {
    process.env.DIALER_MAX_CALLS_PER_SWEEP = '0';

    await expect(loadEnv()).rejects.toThrow(/DIALER_MAX_CALLS_PER_SWEEP/);
  });

  /**
   * Zero is legal here and is the fail-closed posture: an account staff have
   * not allotted lines to cannot dial at all until somebody decides how many
   * it gets.
   */
  it('allows a default account allotment of zero', async () => {
    process.env.DIALER_DEFAULT_ACCOUNT_CONCURRENCY = '0';

    expect((await loadEnv()).dialerDefaultAccountConcurrency).toBe(0);
  });

  it('validates the minimum balance through the same parser a price uses', async () => {
    process.env.DIALER_MIN_BALANCE_CREDITS = '1.5.2';

    await expect(loadEnv()).rejects.toThrow(/DIALER_MIN_BALANCE_CREDITS/);
  });
});

/**
 * REDIS_URL is documented as required, not optional — every queue schedules
 * over it and the webhook handler cannot accept a delivery without it. The
 * old `url()` fallback silently substituted `redis://localhost:6379` when the
 * variable was unset, so a production deployment that omitted it booted green
 * and pointed every queue at a Redis that does not exist: no background work,
 * every delivery stuck — behind a healthy-looking HTTP port. Missing must be
 * a startup failure (an empty string under test, where `required()` already
 * softens the throw), never a localhost default.
 */
describe('REDIS_URL', () => {
  // `delete process.env.REDIS_URL` cannot express "unset" here: `env.ts`
  // imports dotenv, which refills a deleted key from `.env` on re-import. A
  // blank value takes the same missing-value branch and dotenv never
  // overrides an existing key, so blank is how the suite spells absent.
  it('treats a blank value as missing, not as a fallback trigger', async () => {
    process.env.REDIS_URL = '   ';

    expect((await loadEnv()).redisUrl).toBe('');
  });

  it('refuses to boot outside test mode when the variable is missing', async () => {
    process.env.REDIS_URL = '';
    process.env.NODE_ENV = 'production';

    await expect(loadEnv()).rejects.toThrow(/REDIS_URL/);
  });

  it('still refuses a malformed value', async () => {
    process.env.REDIS_URL = 'not a url';

    await expect(loadEnv()).rejects.toThrow(/REDIS_URL/);
  });

  it('reads a valid value back verbatim', async () => {
    process.env.REDIS_URL = 'redis://queue-host:6390/3';

    expect((await loadEnv()).redisUrl).toBe('redis://queue-host:6390/3');
  });
});

describe('browser test sessions', () => {
  it('bounds a session by duration, by concurrency and by staleness', async () => {
    delete process.env.TEST_SESSION_MAX_SECS;
    delete process.env.TEST_SESSION_MAX_CONCURRENT;
    delete process.env.TEST_SESSION_TIMEOUT_MINS;

    const env = await loadEnv();

    expect(env.testSessionMaxSecs).toBe(300);
    expect(env.testSessionMaxConcurrent).toBe(2);
    expect(env.testSessionTimeoutMins).toBe(15);
  });

  it('takes the configured values', async () => {
    process.env.TEST_SESSION_MAX_SECS = '120';
    process.env.TEST_SESSION_MAX_CONCURRENT = '5';

    const env = await loadEnv();

    expect(env.testSessionMaxSecs).toBe(120);
    expect(env.testSessionMaxConcurrent).toBe(5);
  });

  /**
   * Zero live sessions is a switch that reads as "off" and is not one: the
   * whole feature would refuse with a message about busy lines. A minimum of
   * one makes the misconfiguration loud at boot instead.
   */
  it('refuses a concurrency ceiling of zero at boot', async () => {
    process.env.TEST_SESSION_MAX_CONCURRENT = '0';

    await expect(loadEnv()).rejects.toThrow(/TEST_SESSION_MAX_CONCURRENT/);
  });
});
