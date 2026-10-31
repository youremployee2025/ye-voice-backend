import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'i'.repeat(48);

/** Reload the verifier bound to a chosen secret — env is parsed once at import,
 *  so a different secret means a fresh module graph. */
async function load(secret: string | undefined) {
  vi.resetModules();
  if (secret === undefined) delete process.env.INBOUND_ROUTE_POLICY_SECRET;
  else process.env.INBOUND_ROUTE_POLICY_SECRET = secret;
  return import('../src/lib/inboundRouteSignature.js');
}

afterEach(() => {
  process.env.INBOUND_ROUTE_POLICY_SECRET = SECRET;
  vi.resetModules();
});

describe('verifyInboundRoute', () => {
  it('accepts a correctly signed body', async () => {
    const { verifyInboundRoute, signInboundRoute } = await load(SECRET);
    const body = JSON.stringify({ from_number: '+91', to_number: '+92' });
    const ts = new Date().toISOString();
    expect(verifyInboundRoute(body, signInboundRoute(body, ts, SECRET), ts)).toEqual({ ok: true });
  });

  it('accepts the epoch-millisecond timestamp the platform actually sends', async () => {
    // Vocobase signs the policy callback with `Date.now().toString()` (its
    // inboundRoutePolicyWebhook.service.ts), NOT the ISO string the outcome
    // webhook uses. `new Date("1788975699367")` is NaN, so a verifier that only
    // parses ISO rejects every real callback as stale.
    const { verifyInboundRoute, signInboundRoute } = await load(SECRET);
    const body = JSON.stringify({ call: { from_number: '+91', to_number: '+92' } });
    const ts = Date.now().toString();
    expect(verifyInboundRoute(body, signInboundRoute(body, ts, SECRET), ts)).toEqual({ ok: true });
  });

  it('accepts an epoch-seconds timestamp too', async () => {
    const { verifyInboundRoute, signInboundRoute } = await load(SECRET);
    const ts = Math.floor(Date.now() / 1000).toString();
    expect(verifyInboundRoute('{}', signInboundRoute('{}', ts, SECRET), ts)).toEqual({ ok: true });
  });

  it('rejects a stale epoch-millisecond timestamp', async () => {
    const { verifyInboundRoute, signInboundRoute } = await load(SECRET);
    const ts = String(Date.now() - 10 * 60_000);
    expect(verifyInboundRoute('{}', signInboundRoute('{}', ts, SECRET), ts)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects a tampered body', async () => {
    const { verifyInboundRoute, signInboundRoute } = await load(SECRET);
    const ts = new Date().toISOString();
    const sig = signInboundRoute('{"a":1}', ts, SECRET);
    expect(verifyInboundRoute('{"a":2}', sig, ts)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a short signature without throwing (length checked first)', async () => {
    const { verifyInboundRoute } = await load(SECRET);
    const ts = new Date().toISOString();
    expect(verifyInboundRoute('{}', 'v1=short', ts)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp', async () => {
    const { verifyInboundRoute, signInboundRoute } = await load(SECRET);
    const ts = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(verifyInboundRoute('{}', signInboundRoute('{}', ts, SECRET), ts)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects missing headers', async () => {
    const { verifyInboundRoute } = await load(SECRET);
    expect(verifyInboundRoute('{}', undefined, undefined)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('an unset secret rejects everything', async () => {
    const { verifyInboundRoute, signInboundRoute } = await load(undefined);
    const ts = new Date().toISOString();
    // Even a body signed with some secret is rejected: with no secret the door
    // is closed, not open.
    expect(verifyInboundRoute('{}', signInboundRoute('{}', ts, 'anything'), ts)).toEqual({
      ok: false,
      reason: 'no_secret',
    });
  });
});
