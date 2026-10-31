import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  getBalance: vi.fn(),
  getTopupConfig: vi.fn(),
  quoteTopup: vi.fn(),
  createTopupLink: vi.fn(),
  getTopupLink: vi.fn(),
}));

process.env.ADMIN_STAFF_TOKEN = 'staff-token-for-wallet-tests';
// Deliberately NOT the 25000 default: with the default here, a typo in the
// variable's name in `env.ts` would leave every assertion below still passing.
process.env.WALLET_LOW_BALANCE_INR = '31000';

const { getBalance, getTopupConfig, quoteTopup, createTopupLink, getTopupLink } = await import(
  '../src/adapter/vocobase.js'
);
const { ApiError } = await import('../src/lib/errors.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');

const app = createApp();
const STAFF = ['X-Admin-Token', process.env.ADMIN_STAFF_TOKEN!] as const;
const LATER = '2026-12-31T10:00:00.000Z';

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('staff guard', () => {
  it.each([
    ['get', '/api/admin/wallet'],
    ['get', '/api/admin/wallet/topup-config'],
    ['post', '/api/admin/wallet/topup-quote'],
    ['post', '/api/admin/wallet/topups'],
    ['get', '/api/admin/wallet/topups'],
    ['get', '/api/admin/wallet/topups/po_1'],
    ['delete', '/api/admin/wallet/topups/po_1'],
  ] as const)('%s %s rejects a request without a token', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/wallet', () => {
  it('reports the balance, the threshold, and whether it is low', async () => {
    vi.mocked(getBalance).mockResolvedValue({ credits: '18400' });
    const res = await request(app).get('/api/admin/wallet').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ balance_inr: 18400, low: true, threshold_inr: 31000 });
  });

  it('is a 502 when the supplier does not answer, never a zero', async () => {
    vi.mocked(getBalance).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    const res = await request(app).get('/api/admin/wallet').set(...STAFF);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('config and quote', () => {
  it('passes the config through', async () => {
    vi.mocked(getTopupConfig).mockResolvedValue({
      presets: [1000, 5000],
      min: 1000,
      max: 400000,
      gst_rate_bps: 1800,
    });
    const res = await request(app).get('/api/admin/wallet/topup-config').set(...STAFF);
    expect(res.body.data).toEqual({
      presets: [1000, 5000],
      min: 1000,
      max: 400000,
      gst_rate_bps: 1800,
    });
  });

  it('quotes a whole-rupee amount', async () => {
    vi.mocked(quoteTopup).mockResolvedValue({ base: 5000, gst: 900, total: 5900 });
    const res = await request(app)
      .post('/api/admin/wallet/topup-quote')
      .set(...STAFF)
      .send({ amount_rupees: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ base: 5000, gst: 900, total: 5900 });
    expect(quoteTopup).toHaveBeenCalledWith(5000);
  });

  it.each([['5000'], [5000.5], [-1], [null], [undefined]])(
    'refuses %j before any upstream call',
    async (amount) => {
      const res = await request(app)
        .post('/api/admin/wallet/topup-quote')
        .set(...STAFF)
        .send({ amount_rupees: amount });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(quoteTopup).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/admin/wallet/topups', () => {
  it('mints a link, stores it, and answers 201 with the row', async () => {
    vi.mocked(createTopupLink).mockResolvedValue({
      payment_order_id: 'po_1',
      short_url: 'https://rzp.io/i/x',
      expires_at: LATER,
      base: 5000,
      gst: 900,
      total: 5900,
    });
    const res = await request(app)
      .post('/api/admin/wallet/topups')
      .set(...STAFF)
      .send({ amount_rupees: 5000 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      payment_order_id: 'po_1',
      short_url: 'https://rzp.io/i/x',
      amount_rupees: 5000,
      gst_rupees: 900,
      total_rupees: 5900,
      status: 'CREATED',
      expires_at: LATER,
      credited_at: null,
    });
    expect(await prisma.platformTopup.count()).toBe(1);
  });

  it('passes the open-link limit through as a 409 the console can act on', async () => {
    vi.mocked(createTopupLink).mockRejectedValue(
      new ApiError(409, 'OPEN_ORDER_LIMIT', '5 links are already open.'),
    );
    const res = await request(app)
      .post('/api/admin/wallet/topups')
      .set(...STAFF)
      .send({ amount_rupees: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_ORDER_LIMIT');
    expect(await prisma.platformTopup.count()).toBe(0);
  });

  it('refuses a string amount without calling upstream', async () => {
    const res = await request(app)
      .post('/api/admin/wallet/topups')
      .set(...STAFF)
      .send({ amount_rupees: '5000' });
    expect(res.status).toBe(400);
    expect(createTopupLink).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/wallet/topups', () => {
  it('lists newest first and refreshes only the open rows', async () => {
    await prisma.platformTopup.create({
      data: {
        paymentOrderId: 'po_old',
        shortUrl: 'u',
        amountRupees: 1000,
        gstRupees: 180,
        totalRupees: 1180,
        expiresAt: new Date(LATER),
        status: 'CREDITED',
        creditedAt: new Date(),
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.platformTopup.create({
      data: {
        paymentOrderId: 'po_new',
        shortUrl: 'u',
        amountRupees: 5000,
        gstRupees: 900,
        totalRupees: 5900,
        expiresAt: new Date(LATER),
      },
    });
    vi.mocked(getTopupLink).mockResolvedValue({
      payment_order_id: 'po_new',
      status: 'ATTEMPTED',
      base: 5000,
      gst: 900,
      total: 5900,
      credited_at: null,
      created_at: LATER,
    });

    const res = await request(app).get('/api/admin/wallet/topups').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { payment_order_id: string }) => r.payment_order_id)).toEqual([
      'po_new',
      'po_old',
    ]);
    expect(res.body.data[0].status).toBe('ATTEMPTED');
    expect(getTopupLink).toHaveBeenCalledTimes(1);
  });

  it('still lists when the supplier is unreachable, with the last known status', async () => {
    await prisma.platformTopup.create({
      data: {
        paymentOrderId: 'po_new',
        shortUrl: 'u',
        amountRupees: 5000,
        gstRupees: 900,
        totalRupees: 5900,
        expiresAt: new Date(LATER),
      },
    });
    vi.mocked(getTopupLink).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    const res = await request(app).get('/api/admin/wallet/topups').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('CREATED');
  });
});

describe('GET /api/admin/wallet/topups/:id', () => {
  it('refreshes and returns one row', async () => {
    await prisma.platformTopup.create({
      data: {
        paymentOrderId: 'po_1',
        shortUrl: 'u',
        amountRupees: 5000,
        gstRupees: 900,
        totalRupees: 5900,
        expiresAt: new Date(LATER),
      },
    });
    vi.mocked(getTopupLink).mockResolvedValue({
      payment_order_id: 'po_1',
      status: 'CREDITED',
      base: 5000,
      gst: 900,
      total: 5900,
      credited_at: '2026-09-07T10:04:12.000Z',
      created_at: LATER,
    });
    const res = await request(app).get('/api/admin/wallet/topups/po_1').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'CREDITED',
      credited_at: '2026-09-07T10:04:12.000Z',
    });
  });

  it('404s an id it has no row for', async () => {
    const res = await request(app).get('/api/admin/wallet/topups/po_none').set(...STAFF);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getTopupLink).not.toHaveBeenCalled();
  });

  it('is a 502 when the refresh fails, not a stale 200', async () => {
    await prisma.platformTopup.create({
      data: {
        paymentOrderId: 'po_1',
        shortUrl: 'u',
        amountRupees: 5000,
        gstRupees: 900,
        totalRupees: 5900,
        expiresAt: new Date(LATER),
      },
    });
    vi.mocked(getTopupLink).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    const res = await request(app).get('/api/admin/wallet/topups/po_1').set(...STAFF);
    expect(res.status).toBe(502);
  });
});

/**
 * Removing a link from the listing.
 *
 * The whole of this route is the refusal, and the refusal is decided on a
 * CONFIRMING READ rather than on the stored status — there is no callback from
 * the supplier, so a row reading CREATED may have been paid within the last
 * poll interval. The test that matters is the one where the stored status and
 * the live status disagree.
 */
describe('DELETE /api/admin/wallet/topups/:id', () => {
  async function topup(over: Record<string, unknown> = {}) {
    return prisma.platformTopup.create({
      data: {
        paymentOrderId: 'po_1',
        shortUrl: 'https://rzp.io/i/abc',
        amountRupees: 25000,
        gstRupees: 4500,
        totalRupees: 29500,
        expiresAt: new Date(LATER),
        ...over,
      },
    });
  }

  const remove = (id = 'po_1') =>
    request(app).delete(`/api/admin/wallet/topups/${id}`).set(...STAFF);

  it('removes an unpaid link that the platform still reports unpaid', async () => {
    await topup();
    vi.mocked(getTopupLink).mockResolvedValue({
      payment_order_id: 'po_1',
      status: 'CREATED',
      base: 25000,
      gst: 4500,
      total: 29500,
    } as never);

    const res = await remove();

    expect(res.status).toBe(200);
    expect(res.body.data.payment_order_id).toBe('po_1');
    expect(await prisma.platformTopup.count()).toBe(0);
  });

  /**
   * The reason this route reads upstream at all. The row on the operator's
   * screen said CREATED — it was written that way and the poll had not come
   * round — and the money had already landed. Deleting on the stored status
   * would have erased the record of a payment and told them it never happened.
   */
  it('refuses a link the stored row calls unpaid but the platform reports credited', async () => {
    await topup();
    vi.mocked(getTopupLink).mockResolvedValue({
      payment_order_id: 'po_1',
      status: 'CREDITED',
      credited_at: '2026-09-11T12:10:00.000Z',
      base: 25000,
      gst: 4500,
      total: 29500,
    } as never);

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOPUP_PAID');
    expect(await prisma.platformTopup.count()).toBe(1);

    // The confirming read is not thrown away: the row keeps what it learned,
    // so the listing the operator reloads shows CREDITED rather than the
    // CREATED they just tried to delete.
    const row = await prisma.platformTopup.findUniqueOrThrow({
      where: { paymentOrderId: 'po_1' },
    });
    expect(row.status).toBe('CREDITED');
    expect(row.creditedAt).not.toBeNull();
  });

  it('refuses a credited row without asking upstream, since it is already settled', async () => {
    await topup({ status: 'CREDITED', creditedAt: new Date(LATER) });

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOPUP_PAID');
    expect(getTopupLink).not.toHaveBeenCalled();
    expect(await prisma.platformTopup.count()).toBe(1);
  });

  /**
   * MISMATCH is "not yet credited" by the letter of the column, and is the one
   * row it would be worst to lose: money moved for an amount that did not match
   * the link, and this is the only record of the discrepancy to reconcile.
   */
  it('refuses a mismatched payment, which is not a link nobody paid', async () => {
    await topup({ status: 'MISMATCH' });

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOPUP_PAID');
    // A different sentence from the credited one: the remedy is not the same.
    expect(res.body.error.message).toMatch(/reconcil/i);
    expect(await prisma.platformTopup.count()).toBe(1);
  });

  it('removes a dead link without asking upstream about it', async () => {
    await topup({ status: 'EXPIRED' });

    const res = await remove();

    expect(res.status).toBe(200);
    expect(getTopupLink).not.toHaveBeenCalled();
    expect(await prisma.platformTopup.count()).toBe(0);
  });

  it('removes a failed payment, which is a link that can still be retried', async () => {
    await topup({ status: 'FAILED' });
    vi.mocked(getTopupLink).mockResolvedValue({
      payment_order_id: 'po_1',
      status: 'FAILED',
      base: 25000,
      gst: 4500,
      total: 29500,
    } as never);

    const res = await remove();

    expect(res.status).toBe(200);
    expect(await prisma.platformTopup.count()).toBe(0);
  });

  /**
   * "We could not check" must never become a delete. This is the one direction
   * with no undo, so an unreachable supplier leaves the row alone.
   */
  it('deletes nothing when the confirming read fails', async () => {
    await topup();
    vi.mocked(getTopupLink).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));

    const res = await remove();

    expect(res.status).toBe(502);
    expect(await prisma.platformTopup.count()).toBe(1);
  });

  it('404s an id it has no row for, and asks upstream nothing', async () => {
    const res = await remove('po_none');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getTopupLink).not.toHaveBeenCalled();
  });
});
