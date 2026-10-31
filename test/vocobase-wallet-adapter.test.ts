import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The wallet surface of the adapter. `fetch` is stubbed rather than the module
 * mocked, because what is under test is how an upstream status is mapped.
 *
 * The key and the base URL are set before the client is imported, not in a
 * `beforeEach`: `env` is read once at module load, so a value assigned after
 * the import would never be seen and every call here would fail as
 * "not configured" rather than exercising the mapping.
 */
process.env.VOCOBASE_API_KEY = 'rg_live_testkey';
process.env.VOCOBASE_API_URL = 'https://voice.test/api/v2';

const { ApiError } = await import('../src/lib/errors.js');
const { createTopupLink, getBalance, getTopupConfig, getTopupLink, quoteTopup } = await import(
  '../src/adapter/vocobase.js'
);

function respond(status: number, payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getBalance', () => {
  it('unwraps the envelope', async () => {
    respond(200, { success: true, data: { credits: '12500.5', currency: 'INR' } });
    await expect(getBalance()).resolves.toEqual({ credits: '12500.5', currency: 'INR' });
  });
});

describe('getTopupConfig / quoteTopup', () => {
  it('reads the config document', async () => {
    respond(200, {
      success: true,
      data: { presets: [1000], min: 1000, max: 400000, gst_rate_bps: 1800 },
    });
    await expect(getTopupConfig()).resolves.toMatchObject({ min: 1000, max: 400000 });
  });

  it('posts the amount as a JSON number', async () => {
    const fetchMock = respond(200, { success: true, data: { base: 5000, gst: 900, total: 5900 } });
    await expect(quoteTopup(5000)).resolves.toEqual({ base: 5000, gst: 900, total: 5900 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ amount_rupees: 5000 });
  });
});

describe('createTopupLink', () => {
  it('returns the link on 201', async () => {
    respond(201, {
      success: true,
      data: {
        payment_order_id: 'po_1',
        short_url: 'https://rzp.io/i/abc',
        expires_at: '2026-09-08T10:00:00.000Z',
        base: 5000,
        gst: 900,
        total: 5900,
      },
    });
    await expect(createTopupLink(5000)).resolves.toMatchObject({ payment_order_id: 'po_1' });
  });

  it('passes a 409 through as OPEN_ORDER_LIMIT rather than NAME_TAKEN', async () => {
    respond(409, {
      success: false,
      error: { code: 'OPEN_ORDER_LIMIT', message: '5 links are already open.' },
    });
    const err = await createTopupLink(5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(409);
    expect((err as InstanceType<typeof ApiError>).code).toBe('OPEN_ORDER_LIMIT');
  });

  it('still reports a 400 as VALIDATION_ERROR with the upstream wording', async () => {
    respond(400, {
      success: false,
      error: { code: 'INVALID_AMOUNT', message: 'amount_rupees must be a whole number.' },
    });
    const err = await createTopupLink(5000).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ApiError>).code).toBe('VALIDATION_ERROR');
    expect((err as InstanceType<typeof ApiError>).message).toContain('whole number');
  });
});

describe('getTopupLink', () => {
  it('reads the status document', async () => {
    respond(200, {
      success: true,
      data: {
        payment_order_id: 'po_1',
        status: 'CREDITED',
        base: 5000,
        gst: 900,
        total: 5900,
        credited_at: '2026-09-07T10:04:12.000Z',
        created_at: '2026-09-07T10:00:00.000Z',
      },
    });
    await expect(getTopupLink('po_1')).resolves.toMatchObject({ status: 'CREDITED' });
  });

  it('reports a 404 as RESOURCE_NOT_FOUND, not as an outage', async () => {
    respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'nope' } });
    const err = await getTopupLink('po_x').catch((e: unknown) => e);
    expect((err as InstanceType<typeof ApiError>).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('a 409 on any other call is still NAME_TAKEN', async () => {
    respond(409, { success: false, error: { code: 'OPEN_ORDER_LIMIT', message: 'x' } });
    const err = await getTopupLink('po_1').catch((e: unknown) => e);
    expect((err as InstanceType<typeof ApiError>).code).toBe('NAME_TAKEN');
  });
});
