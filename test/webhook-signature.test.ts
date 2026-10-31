import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rotating the webhook secret without dropping a delivery.
 *
 * The platform issues a secret once and shows it again never, so rotating one
 * is: mint upstream, put the new value in `.env`, restart. Between the mint and
 * the restart every delivery in flight is still signed with the old secret, and
 * this endpoint is the one that closes call attempts and charges credits — a
 * dropped delivery there is a line held open until the reaper finds it and a
 * charge that arrives late or not at all.
 *
 * So verification accepts a second, outgoing secret while one is configured.
 * The window is the operator's to close, and the runbook in `.env.example`
 * says to close it.
 *
 * The env module reads `process.env` once at load, so each case reloads it —
 * the same pattern `env.test.ts` uses, and the reason this lives in its own
 * file rather than in `webhooks.test.ts`, which builds an app at import time.
 */

const CURRENT = 'c'.repeat(48);
const PREVIOUS = 'p'.repeat(48);

const BODY = JSON.stringify({ event: 'session.completed', data: { session_id: 's_1' } });

async function load(secrets: { current?: string; previous?: string }) {
  vi.resetModules();

  if (secrets.current === undefined) delete process.env.VOCOBASE_WEBHOOK_SECRET;
  else process.env.VOCOBASE_WEBHOOK_SECRET = secrets.current;

  if (secrets.previous === undefined) delete process.env.VOCOBASE_WEBHOOK_SECRET_PREVIOUS;
  else process.env.VOCOBASE_WEBHOOK_SECRET_PREVIOUS = secrets.previous;

  return import('../src/lib/webhookSignature.js');
}

const saved = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('verifying a delivery while a secret is being rotated', () => {
  it('accepts the current secret', async () => {
    const { signWebhook, verifyWebhook } = await load({ current: CURRENT, previous: PREVIOUS });
    const at = new Date().toISOString();

    expect(verifyWebhook(BODY, signWebhook(BODY, at, CURRENT), at)).toEqual({ ok: true });
  });

  it('accepts the outgoing secret too, so nothing in flight is dropped', async () => {
    const { signWebhook, verifyWebhook } = await load({ current: CURRENT, previous: PREVIOUS });
    const at = new Date().toISOString();

    expect(verifyWebhook(BODY, signWebhook(BODY, at, PREVIOUS), at)).toEqual({ ok: true });
  });

  it('refuses the outgoing secret once it has been cleared', async () => {
    const { signWebhook, verifyWebhook } = await load({ current: CURRENT });
    const at = new Date().toISOString();

    expect(verifyWebhook(BODY, signWebhook(BODY, at, PREVIOUS), at)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  /**
   * The one ordering that must not be an open door. A deployment that set only
   * the outgoing value — a half-finished rotation, or a copy-paste into the
   * wrong line — has no current secret, and a missing secret has always meant
   * "reject everything" rather than "accept the other one".
   */
  it('fails closed when only the outgoing secret is set', async () => {
    const { signWebhook, verifyWebhook } = await load({ current: '', previous: PREVIOUS });
    const at = new Date().toISOString();

    expect(verifyWebhook(BODY, signWebhook(BODY, at, PREVIOUS), at)).toEqual({
      ok: false,
      reason: 'no_secret',
    });
  });

  it('refuses a secret short enough to be worth guessing in either slot', async () => {
    vi.resetModules();
    process.env.VOCOBASE_WEBHOOK_SECRET = CURRENT;
    process.env.VOCOBASE_WEBHOOK_SECRET_PREVIOUS = 'whsec_dev';

    await expect(import('../src/lib/env.js')).rejects.toThrow(
      /VOCOBASE_WEBHOOK_SECRET_PREVIOUS/,
    );
  });
});

describe('what a second secret does not change', () => {
  it('still refuses a delivery outside the skew window', async () => {
    const { signWebhook, verifyWebhook } = await load({ current: CURRENT, previous: PREVIOUS });
    const now = new Date('2026-08-30T10:00:00Z');
    const at = new Date(now.getTime() - 400_000).toISOString();

    expect(verifyWebhook(BODY, signWebhook(BODY, at, PREVIOUS), at, now)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('still refuses a signature of the wrong length without throwing', async () => {
    const { verifyWebhook } = await load({ current: CURRENT, previous: PREVIOUS });
    const at = new Date().toISOString();

    expect(verifyWebhook(BODY, 'sha256=tooshort', at)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('still refuses a delivery with no headers at all', async () => {
    const { verifyWebhook } = await load({ current: CURRENT, previous: PREVIOUS });

    expect(verifyWebhook(BODY, undefined, undefined)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });
});
