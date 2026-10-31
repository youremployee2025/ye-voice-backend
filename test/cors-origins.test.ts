import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * `CORS_ORIGIN` may name more than one dashboard, comma-separated.
 *
 * Handed to `cors()` as the raw string it could not: the package echoes a
 * string origin back verbatim, so `https://a,https://b` came back as
 * `Access-Control-Allow-Origin: https://a,https://b` — a header naming two
 * origins, which every browser rejects. A second domain on the variable would
 * have broken CORS for BOTH dashboards, not added one.
 */

const saved = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function loadEnv() {
  return (await import('../src/lib/env.js')).env;
}

async function buildApp() {
  const { createApp } = await import('../src/app.js');
  return createApp();
}

/** A preflight, which answers before any auth and so needs no account. */
function preflight(app: Awaited<ReturnType<typeof buildApp>>, origin: string) {
  return request(app)
    .options('/api/workspaces/x/integrations')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'GET');
}

describe('corsOrigins', () => {
  it('reads a single origin as a list of one', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test';

    expect((await loadEnv()).corsOrigins).toEqual(['https://app.ezo.test']);
  });

  it('splits on commas and trims each entry', async () => {
    process.env.CORS_ORIGIN = ' https://app.ezo.test ,https://old.ezo.test ';

    expect((await loadEnv()).corsOrigins).toEqual([
      'https://app.ezo.test',
      'https://old.ezo.test',
    ]);
  });

  /**
   * A browser sends `Origin` with no trailing slash, and `cors()` compares
   * exactly, so an entry typed with one would match nothing.
   */
  it('drops a trailing slash from every entry', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test/,https://old.ezo.test/';

    expect((await loadEnv()).corsOrigins).toEqual([
      'https://app.ezo.test',
      'https://old.ezo.test',
    ]);
  });

  it('ignores empty entries from a stray comma', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test,,https://old.ezo.test,';

    expect((await loadEnv()).corsOrigins).toEqual([
      'https://app.ezo.test',
      'https://old.ezo.test',
    ]);
  });

  it('falls back to the local dashboard when blank', async () => {
    // Blank rather than deleted: dotenv refills a deleted key from `.env`.
    process.env.CORS_ORIGIN = '';

    expect((await loadEnv()).corsOrigins).toEqual(['http://localhost:3000']);
  });
});

describe('the CORS response', () => {
  beforeEach(() => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test,https://old.ezo.test';
  });

  it('allows the first dashboard, naming only it', async () => {
    const res = await preflight(await buildApp(), 'https://app.ezo.test');

    expect(res.headers['access-control-allow-origin']).toBe('https://app.ezo.test');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows the second dashboard, naming only it', async () => {
    const res = await preflight(await buildApp(), 'https://old.ezo.test');

    expect(res.headers['access-control-allow-origin']).toBe('https://old.ezo.test');
  });

  it('allows neither to a stranger', async () => {
    const res = await preflight(await buildApp(), 'https://evil.test');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  /**
   * The existing single-origin deployment, unchanged: a value with no comma
   * behaves exactly as it did before lists were allowed.
   */
  it('still serves a single configured origin', async () => {
    process.env.CORS_ORIGIN = 'https://app.ezo.test';

    const res = await preflight(await buildApp(), 'https://app.ezo.test');

    expect(res.headers['access-control-allow-origin']).toBe('https://app.ezo.test');
  });
});
