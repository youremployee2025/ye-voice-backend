import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import {
  getConcurrency,
  startCall,
  voicelinkCallReady,
  type StartCallBody,
} from '../src/adapter/vocobase.js';

/**
 * The adapter's dialing surface, and in particular the two statuses this slice
 * had to stop collapsing.
 *
 * `fetch` is stubbed rather than the module mocked, because what is under test
 * *is* the module: how it maps an upstream status onto something a caller can
 * branch on. Nothing here reaches the network.
 */

const body: StartCallBody = {
  agent_id: 'ag_1',
  to_number: '+919876543210',
  provider: 'voicelink',
  from_number: '+918011223344',
  client_reference_id: 'ezo:cmp_1:cc_1:att_1',
  variables: { callee_name: 'Sajal' },
};

function respond(status: number, payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status })),
  );
}

beforeEach(() => {
  process.env.VOCOBASE_API_KEY = 'rg_live_testkey';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startCall', () => {
  it('posts the call and returns what the platform answered', async () => {
    respond(201, {
      success: true,
      data: { call_id: 'c_1', session_id: 's_1', status: 'pending' },
    });

    await expect(startCall(body)).resolves.toMatchObject({ call_id: 'c_1', session_id: 's_1' });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/calls/start');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      client_reference_id: 'ezo:cmp_1:cc_1:att_1',
      provider: 'voicelink',
      from_number: '+918011223344',
    });
  });

  /**
   * The shared partner account is at its concurrency ceiling — very often
   * because of somebody else's traffic entirely. Before this, it arrived as a
   * generic 502 and was indistinguishable from an outage, so the sweep spent
   * a contact's attempt on it. It is transient and account-wide, and both
   * facts have to survive the adapter.
   */
  it('keeps a 429 distinguishable, so the dialer can back off instead of failing a contact', async () => {
    respond(429, {
      success: false,
      error: { code: 'LIMIT_REACHED', message: 'Maximum concurrent calls allowed' },
    });

    await expect(startCall(body)).rejects.toMatchObject({
      status: 429,
      code: 'UPSTREAM_RATE_LIMITED',
    });
  });

  /**
   * YE's own balance with the supplier, not the customer's balance with YE.
   * Entirely different remedy, and it must never pause fifty customers'
   * campaigns.
   */
  it('keeps a 403 distinguishable from an outage', async () => {
    respond(403, { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient credits' } });

    await expect(startCall(body)).rejects.toMatchObject({
      status: 403,
      code: 'UPSTREAM_FORBIDDEN',
    });
  });

  /**
   * The supplier's own wallet running dry: a 402 from VoiceLink's `add_lead`,
   * returned by `/calls/start` before any call exists.
   *
   * This was collapsed into the generic `UPSTREAM_ERROR`, which the dialer
   * reads as transient — so on 2026-09-06/07 it handed each contact back with
   * one cooldown and left both campaigns RUNNING, re-claiming and re-failing
   * 3,803 dials over thirty hours against a wallet that could not place one.
   * Like 403 and 429, the dialer has to act on it differently from an outage,
   * which is the whole reason a status gets its own code here.
   */
  it('surfaces a 402 distinctly, so the dialer can pause on it', async () => {
    respond(402, {
      success: false,
      error: {
        code: 'PAYMENT_REQUIRED',
        message: 'VoiceLink add_lead error (402): {"message":"Insufficient wallet balance. Please top-up to continue."}',
      },
    });

    await expect(startCall(body)).rejects.toMatchObject({
      status: 402,
      code: 'UPSTREAM_PAYMENT_REQUIRED',
    });
  });

  /**
   * Both of those messages reach a customer's screen. A 429 is usually another
   * integrator's traffic and a 403 means YE is short with its supplier; the
   * customer is entitled to learn about neither, which is the same rule that
   * keeps `credits_used` and the carrier's name off the calls surface.
   */
  it('repeats neither upstream wording nor the reason to the caller', async () => {
    for (const [status, upstream] of [
      [429, 'Maximum concurrent calls allowed for partner acme-corp'],
      [402, 'VoiceLink add_lead error (402): Insufficient wallet balance. Please top-up'],
      [403, 'Insufficient credits: balance 0.00'],
    ] as const) {
      respond(status, { success: false, error: { message: upstream } });

      const error = await startCall(body).catch((err: ApiError) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).not.toContain('acme-corp');
      expect((error as ApiError).message).not.toContain('balance');
      expect((error as ApiError).message).not.toMatch(/vocobase|voicelink/i);
    }
  });

  it('still surfaces a 400 as a validation error the caller can act on', async () => {
    respond(400, {
      success: false,
      error: { message: 'to_number must be in E.164 format' },
    });

    await expect(startCall(body)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('still surfaces a 500 as a generic upstream error', async () => {
    respond(500, { success: false, error: { message: 'boom' } });

    await expect(startCall(body)).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_ERROR' });
  });

  /**
   * A write whose response never arrived may well have been applied — the call
   * may be ringing. This is why the dialer leaves such an attempt QUEUED for
   * the reaper rather than rolling the contact back and dialing again.
   */
  it('reports a lost response as unconfirmed rather than as nothing happening', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    await expect(startCall(body)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_WRITE_UNCONFIRMED',
    });
  });
});

describe('voicelinkCallReady', () => {
  it('sends only the number, never a client id', async () => {
    respond(200, { success: true, data: { ready: true, readiness: { state: 'READY' } } });

    await voicelinkCallReady('+918011223344');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/voicelink/call-ready');

    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.did_number).toBe('+918011223344');
    // Mapping a DID to a client is the one step in that workflow that is not
    // idempotent in a recoverable direction, so this service never asks for it.
    expect(sent).not.toHaveProperty('client_id');
    expect(sent).not.toHaveProperty('agent_id');
    /**
     * Asserted field by field rather than as a whole-body `toEqual`.
     *
     * The body also carries `connection_id` when the deployment pins one, and
     * `env` snapshots that at import — so a whole-body equality here read the
     * developer's `.env` rather than the code, and passed or failed depending
     * on whose checkout ran it. What the pin does in both directions is tested
     * where the module can be reloaded around it, in `vocobase-adapter.test.ts`.
     */
  });

  it('returns the readiness the platform reported', async () => {
    respond(200, {
      success: true,
      data: { ready: false, readiness: { state: 'ROUTING_MISSING', issues: ['ROUTING_MISSING'] } },
    });

    await expect(voicelinkCallReady('+918011223344')).resolves.toMatchObject({
      ready: false,
      readiness: { state: 'ROUTING_MISSING' },
    });
  });
});

describe('getConcurrency', () => {
  it('reads the account-wide pool', async () => {
    respond(200, {
      success: true,
      data: { limit: 100, active: 4, remaining: 96, limit_source: 'partner' },
    });

    await expect(getConcurrency()).resolves.toMatchObject({ limit: 100, active: 4, remaining: 96 });
  });

  /**
   * An uncapped account reports null, and a `?? 0` anywhere on this path would
   * stop an unlimited platform from placing a single call — a failure that
   * looks exactly like a dialer that is switched off.
   */
  it('passes an unlimited pool through as null rather than as zero', async () => {
    respond(200, {
      success: true,
      data: { limit: null, active: 7, remaining: null, limit_source: 'partner_unlimited' },
    });

    const pool = await getConcurrency();

    expect(pool.limit).toBeNull();
    expect(pool.remaining).toBeNull();
    expect(pool.active).toBe(7);
  });
});
