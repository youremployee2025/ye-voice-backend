import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  getBalance: vi.fn(),
  getTopupConfig: vi.fn(),
  quoteTopup: vi.fn(),
  createTopupLink: vi.fn(),
  getTopupLink: vi.fn(),
}));

const { getBalance, getTopupLink, createTopupLink } = await import('../src/adapter/vocobase.js');
const { ApiError } = await import('../src/lib/errors.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { createTopup, readWallet, refreshOpenTopups, refreshTopup } = await import(
  '../src/services/platformWallet.js'
);

const mockedBalance = vi.mocked(getBalance);
const mockedLink = vi.mocked(getTopupLink);
const mockedCreate = vi.mocked(createTopupLink);

const NOW = new Date('2026-09-07T10:00:00.000Z');
const LATER = new Date('2026-09-08T10:00:00.000Z');

async function row(
  overrides: Partial<Parameters<typeof prisma.platformTopup.create>[0]['data']> = {},
) {
  return prisma.platformTopup.create({
    data: {
      paymentOrderId: `po_${Math.random().toString(36).slice(2)}`,
      shortUrl: 'https://rzp.io/i/abc',
      amountRupees: 5000,
      gstRupees: 900,
      totalRupees: 5900,
      expiresAt: LATER,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('readWallet', () => {
  it('reads credits as rupees and flags low against the threshold', async () => {
    mockedBalance.mockResolvedValue({ credits: '18400.25' });
    await expect(readWallet(25_000)).resolves.toEqual({
      balance_inr: 18400.25,
      low: true,
      threshold_inr: 25_000,
    });
  });

  it('is not low at exactly the threshold', async () => {
    mockedBalance.mockResolvedValue({ credits: 25_000 });
    await expect(readWallet(25_000)).resolves.toMatchObject({ low: false });
  });

  it('refuses a balance that is not a number rather than reporting zero', async () => {
    mockedBalance.mockResolvedValue({ credits: 'lots' });
    await expect(readWallet(25_000)).rejects.toBeInstanceOf(ApiError);
  });

  /**
   * `Number('')` is 0, and so is `Number(' ')`. An empty decimal is a
   * plausible serialisation of a null column upstream, and it is exactly the
   * shape that would turn "the platform did not tell us" into "YE has no
   * money", banner and all. Blank is unreadable, not zero.
   */
  it.each([
    ['an empty string', ''],
    ['whitespace', '  '],
    ['a newline', '\n'],
  ])('refuses %s rather than reading it as zero', async (_label, credits) => {
    mockedBalance.mockResolvedValue({ credits });
    await expect(readWallet(25_000)).rejects.toBeInstanceOf(ApiError);
  });

  it('still reads a genuine zero balance as zero', async () => {
    mockedBalance.mockResolvedValue({ credits: 0 });
    await expect(readWallet(25_000)).resolves.toMatchObject({ balance_inr: 0, low: true });
  });
});

describe('createTopup', () => {
  it('writes the row from the link', async () => {
    mockedCreate.mockResolvedValue({
      payment_order_id: 'po_1',
      short_url: 'https://rzp.io/i/x',
      expires_at: LATER.toISOString(),
      base: 5000,
      gst: 900,
      total: 5900,
    });
    const created = await createTopup(5000);
    expect(created).toMatchObject({
      paymentOrderId: 'po_1',
      amountRupees: 5000,
      gstRupees: 900,
      totalRupees: 5900,
      status: 'CREATED',
    });
    expect(mockedCreate).toHaveBeenCalledWith(5000);
  });
});

describe('refreshTopup', () => {
  it('leaves a terminal row alone without calling upstream', async () => {
    const r = await row({ status: 'CREDITED', creditedAt: NOW });
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'CREDITED' });
    expect(mockedLink).not.toHaveBeenCalled();
  });

  /**
   * Past expiry the row always settles on this pass — that is the "stop on
   * our own clock" rule, and it is why we do not wait for the platform's
   * hourly sweep. But EXPIRED is terminal and is never revisited, so writing
   * it without looking would let a payment made in the last poll interval be
   * recorded, permanently, as a link nobody paid. The operator then mints a
   * second link and pays twice. One confirming read is the whole cost of not
   * doing that.
   */
  const PAST = new Date('2026-09-07T09:00:00.000Z');

  it('confirms a past-expiry row upstream before writing it off', async () => {
    const r = await row({ expiresAt: PAST });
    mockedLink.mockResolvedValue({
      payment_order_id: r.paymentOrderId,
      status: 'CREATED',
      base: 5000,
      gst: 900,
      total: 5900,
      credited_at: null,
      created_at: '2026-09-07T08:00:00.000Z',
    });
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'EXPIRED' });
    expect(mockedLink).toHaveBeenCalledWith(r.paymentOrderId);
  });

  it('keeps a credit that landed just before the expiry', async () => {
    const r = await row({ expiresAt: PAST });
    mockedLink.mockResolvedValue({
      payment_order_id: r.paymentOrderId,
      status: 'CREDITED',
      base: 5000,
      gst: 900,
      total: 5900,
      credited_at: '2026-09-07T08:59:00.000Z',
      created_at: '2026-09-07T08:00:00.000Z',
    });
    const out = await refreshTopup(r, NOW);
    expect(out.status).toBe('CREDITED');
    expect(out.creditedAt?.toISOString()).toBe('2026-09-07T08:59:00.000Z');
  });

  it('keeps a MISMATCH found on a past-expiry row', async () => {
    const r = await row({ expiresAt: PAST });
    mockedLink.mockResolvedValue({
      payment_order_id: r.paymentOrderId,
      status: 'MISMATCH',
      base: 5000,
      gst: 900,
      total: 5900,
      credited_at: null,
      created_at: '2026-09-07T08:00:00.000Z',
    });
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'MISMATCH' });
  });

  it('still settles a past-expiry row when the platform cannot be reached', async () => {
    const r = await row({ expiresAt: PAST });
    mockedLink.mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('writes the live status and credited_at', async () => {
    const r = await row();
    mockedLink.mockResolvedValue({
      payment_order_id: r.paymentOrderId,
      status: 'CREDITED',
      base: 5000,
      gst: 900,
      total: 5900,
      credited_at: '2026-09-07T09:59:00.000Z',
      created_at: '2026-09-07T09:00:00.000Z',
    });
    const out = await refreshTopup(r, NOW);
    expect(out.status).toBe('CREDITED');
    expect(out.creditedAt?.toISOString()).toBe('2026-09-07T09:59:00.000Z');
  });

  it('treats an upstream 404 as the link being gone', async () => {
    const r = await row();
    mockedLink.mockRejectedValue(new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'));
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('lets any other upstream failure propagate, leaving the row as it was', async () => {
    const r = await row();
    mockedLink.mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    await expect(refreshTopup(r, NOW)).rejects.toBeInstanceOf(ApiError);
    expect(
      (await prisma.platformTopup.findUniqueOrThrow({ where: { id: r.id } })).status,
    ).toBe('CREATED');
  });

  /**
   * Three things poll the same row: the maintenance job, the list route's
   * fan-out, and one console tab per open browser. Each reads upstream and
   * then writes what it read. A slow reader that started before a fast one
   * must not land afterwards and undo it — `creditedAt` is the field that
   * records that money moved, and clearing it turns a paid link back into an
   * open one that the expiry path will later write off.
   */
  it('does not let a slow poll overwrite a credit another poll already wrote', async () => {
    const r = await row();
    mockedLink.mockImplementation(async () => {
      // While this read is in flight, another poller settles the row.
      await prisma.platformTopup.update({
        where: { id: r.id },
        data: { status: 'CREDITED', creditedAt: NOW },
      });
      return {
        payment_order_id: r.paymentOrderId,
        status: 'CREATED' as const,
        base: 5000,
        gst: 900,
        total: 5900,
        credited_at: null,
        created_at: NOW.toISOString(),
      };
    });

    const out = await refreshTopup(r, NOW);
    expect(out.status).toBe('CREDITED');
    expect(out.creditedAt?.toISOString()).toBe(NOW.toISOString());

    const stored = await prisma.platformTopup.findUniqueOrThrow({ where: { id: r.id } });
    expect(stored.status).toBe('CREDITED');
    expect(stored.creditedAt).not.toBeNull();
  });
});

describe('refreshOpenTopups', () => {
  it('refreshes only non-terminal rows and counts what changed', async () => {
    const open = await row();
    await row({ status: 'CREDITED', creditedAt: NOW });
    const stale = await row({ expiresAt: new Date('2026-09-07T09:00:00.000Z') });
    const broken = await row();
    mockedLink.mockImplementation(async (id: string) => {
      if (id === broken.paymentOrderId) throw new ApiError(502, 'UPSTREAM_ERROR', 'down');
      // The past-expiry link was never paid, so it settles EXPIRED — but it
      // is still asked, which is what stops a late credit being written off.
      const unpaid = id === stale.paymentOrderId;
      return {
        payment_order_id: id,
        status: unpaid ? ('CREATED' as const) : ('CREDITED' as const),
        base: 5000,
        gst: 900,
        total: 5900,
        credited_at: unpaid ? null : NOW.toISOString(),
        created_at: NOW.toISOString(),
      };
    });

    await expect(refreshOpenTopups(NOW)).resolves.toEqual({
      refreshed: 3,
      credited: 1,
      expired: 1,
      failed: 1,
    });
    expect(mockedLink).toHaveBeenCalledTimes(3);
    expect(
      (await prisma.platformTopup.findUniqueOrThrow({ where: { id: open.id } })).status,
    ).toBe('CREDITED');
    expect(
      (await prisma.platformTopup.findUniqueOrThrow({ where: { id: stale.id } })).status,
    ).toBe('EXPIRED');
  });
});
