import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two origins the Google connect flow redirects between.
 *
 * In its own file rather than added to `env.test.ts`, the reason
 * `analytics-env.test.ts` gives: that file belongs to another slice's settings
 * and editing it buys a rebase conflict for nothing.
 */
async function loadEnv() {
  vi.resetModules();
  return (await import('../src/lib/env.js')).env;
}

const saved = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // The production-mode cases below flip `NODE_ENV`, which un-softens every
  // `required()` in `env.ts`. Without these the module throws on
  // `CLERK_SECRET_KEY` before the `PUBLIC_API_URL` rule is ever reached, so
  // the case would be asserting the wrong refusal. Values are placeholders;
  // nothing connects to them.
  process.env.CLERK_SECRET_KEY ??= 'sk_test_placeholder';
  process.env.DATABASE_URL ??= 'postgresql://placeholder@localhost:5432/placeholder';
  process.env.REDIS_URL ??= 'redis://localhost:6379/0';
});

afterEach(() => {
  process.env = { ...saved };
});

describe('PUBLIC_API_URL', () => {
  it('is empty when unset', async () => {
    delete process.env.PUBLIC_API_URL;

    expect((await loadEnv()).publicApiUrl).toBe('');
  });

  it('reads an absolute URL back', async () => {
    process.env.PUBLIC_API_URL = 'https://api.ezo.test';

    expect((await loadEnv()).publicApiUrl).toBe('https://api.ezo.test');
  });

  /** The return URL is built by concatenation, so a trailing slash here would
   *  mint `https://api.ezo.test//integrations/...` — which is a different host
   *  path and would not match an allow-listed redirect. */
  it('drops a trailing slash', async () => {
    process.env.PUBLIC_API_URL = 'https://api.ezo.test/';

    expect((await loadEnv()).publicApiUrl).toBe('https://api.ezo.test');
  });

  it('refuses a malformed value', async () => {
    process.env.PUBLIC_API_URL = 'api.ezo.test';

    await expect(loadEnv()).rejects.toThrow(/PUBLIC_API_URL/);
  });

  /**
   * Required only where the platform integration exists at all. A deployment
   * with no partner key cannot mint a connect link, so demanding its public
   * origin would stop a perfectly valid configuration from booting.
   */
  it('is not required when there is no partner key', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_API_URL;
    // Blank, not deleted: `env.ts` calls `dotenv.config()` at import and dotenv
    // does not overwrite a key that is already present, so a deleted variable
    // comes back from `.env`. Blank is how this suite spells absent.
    process.env.VOCOBASE_API_KEY = '';

    expect((await loadEnv()).publicApiUrl).toBe('');
  });

  it('refuses to boot with a partner key and no public origin', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_API_URL;
    process.env.VOCOBASE_API_KEY = 'rg_live_x';

    await expect(loadEnv()).rejects.toThrow(/PUBLIC_API_URL/);
  });

  it('stays quiet under test even with a partner key, as every required value does', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.PUBLIC_API_URL;
    process.env.VOCOBASE_API_KEY = 'rg_live_x';

    expect((await loadEnv()).publicApiUrl).toBe('');
  });
});

describe('dashboardUrl', () => {
  /**
   * The dashboard origin is `CORS_ORIGIN`, which already names it — the CSV
   * export links are built from the same value. A second variable for one
   * origin is a second thing to get wrong on a deploy, and the two would
   * disagree the first time only one of them was updated.
   */
  it('is the CORS origin', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test';

    expect((await loadEnv()).dashboardUrl).toBe('https://app.ezo.test');
  });

  it('drops a trailing slash, so the redirect path is not doubled', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test/';

    expect((await loadEnv()).dashboardUrl).toBe('https://app.ezo.test');
  });

  it('falls back to the local dashboard, as the CORS setting itself does', async () => {
    // Blank rather than deleted: dotenv refills a deleted key from `.env`.
    process.env.CORS_ORIGIN = '';

    expect((await loadEnv()).dashboardUrl).toBe('http://localhost:3000');
  });

  /**
   * A browser can be sent to one place only. With more than one dashboard
   * allowed, the first is the one the connect flow returns to and the CSV
   * links name — the whole string would be `https://a,https://b/settings/…`,
   * which is not an address.
   */
  it('is the FIRST origin when several are allowed', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test, https://old.ezo.test';

    expect((await loadEnv()).dashboardUrl).toBe('https://app.ezo.test');
  });

  it('drops the trailing slash on the first of several', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test/,https://old.ezo.test';

    expect((await loadEnv()).dashboardUrl).toBe('https://app.ezo.test');
  });
});
