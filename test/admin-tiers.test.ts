import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listVoiceTiers: vi.fn(),
}));

const { listVoiceTiers } = await import('../src/adapter/vocobase.js');
const upstream = vi.mocked(listVoiceTiers);

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const app = createApp();

const staff = () => ({ 'X-Admin-Token': TOKEN });

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

async function makeTier(
  slug: string,
  options: {
    price?: bigint | null;
    increment?: number | null;
    isDefault?: boolean;
    status?: 'ACTIVE' | 'REMOVED';
  } = {},
) {
  return prisma.tier.create({
    data: {
      slug,
      name: slug.toUpperCase(),
      status: options.status ?? 'ACTIVE',
      defaultPriceCreditsPerMin: options.price ?? null,
      billingIncrementSecs: options.increment ?? null,
      isDefault: options.isDefault ?? false,
    },
  });
}

describe('POST /api/admin/tiers/sync', () => {
  it('is registered before /tiers/:tierId, so "sync" is not read as an id', async () => {
    upstream.mockResolvedValue({ tiers: [{ tier: 'va-1', label: 'VA 1' }] });

    const res = await request(app).post('/api/admin/tiers/sync').set(staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ synced: 1, removed: 0 });
  });

  it('refuses without the staff token', async () => {
    const res = await request(app).post('/api/admin/tiers/sync');

    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/tiers', () => {
  it('lists the catalogue with its prices, the default, and how many accounts hold each', async () => {
    const one = await makeTier('va-1', { price: 10_000n, isDefault: true });
    await makeTier('va-1-pro', { price: 25_000n });
    const account = await makeAccount('holder');
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: one.id } });

    const res = await request(app).get('/api/admin/tiers').set(staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        slug: 'va-1',
        status: 'ACTIVE',
        default_price_credits_per_min: '1',
        is_default: true,
        account_count: 1,
      }),
      expect.objectContaining({
        slug: 'va-1-pro',
        default_price_credits_per_min: '2.5',
        is_default: false,
        account_count: 0,
      }),
    ]);
  });

  it('reports an unpriced tier as null, never as zero', async () => {
    await makeTier('va-1');

    const res = await request(app).get('/api/admin/tiers').set(staff());

    expect(res.body.data[0].default_price_credits_per_min).toBeNull();
  });

  it('refuses without the staff token', async () => {
    expect((await request(app).get('/api/admin/tiers')).status).toBe(401);
  });
});

describe('PATCH /api/admin/tiers/:tierId', () => {
  it('sets the list price', async () => {
    const tier = await makeTier('va-1');

    const res = await request(app)
      .patch(`/api/admin/tiers/${tier.id}`)
      .set(staff())
      .send({ defaultPriceCreditsPerMin: '0.75' });

    expect(res.status).toBe(200);
    expect(res.body.data.default_price_credits_per_min).toBe('0.75');
    expect(
      (await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } })).defaultPriceCreditsPerMin,
    ).toBe(7_500n);
  });

  it('accepts null, which means unpriced — not free', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .patch(`/api/admin/tiers/${tier.id}`)
      .set(staff())
      .send({ defaultPriceCreditsPerMin: null });

    expect(res.status).toBe(200);
    expect(res.body.data.default_price_credits_per_min).toBeNull();
  });

  it('refuses a malformed amount with a 400 rather than a 500 from the write', async () => {
    const tier = await makeTier('va-1');

    for (const bad of ['abc', '-1', '1.234567', '1e3', '99999999999999999999999']) {
      const res = await request(app)
        .patch(`/api/admin/tiers/${tier.id}`)
        .set(staff())
        .send({ defaultPriceCreditsPerMin: bad });

      expect(res.status, `rejected ${bad}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    expect(
      (await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } })).defaultPriceCreditsPerMin,
    ).toBeNull();
  });

  it('requires the field, so a malformed body cannot silently unprice a tier', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app).patch(`/api/admin/tiers/${tier.id}`).set(staff()).send({});

    expect(res.status).toBe(400);
    expect(
      (await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } })).defaultPriceCreditsPerMin,
    ).toBe(10_000n);
  });

  it('404s an unknown tier', async () => {
    const res = await request(app)
      .patch('/api/admin/tiers/nope')
      .set(staff())
      .send({ defaultPriceCreditsPerMin: '1' });

    expect(res.status).toBe(404);
  });
});

/**
 * The tier's billing increment, edited independently of its price.
 *
 * The two are separate one-field writes from two separate inline editors, so
 * omitting either leaves that column alone. What a body may never do is turn
 * something off by accident, which is why an empty body is still a 400.
 */
describe('PATCH /api/admin/tiers/:tierId — the billing increment', () => {
  it('sets an increment', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .patch(`/api/admin/tiers/${tier.id}`)
      .set(staff())
      .send({ billingIncrementSecs: 30 });

    expect(res.status).toBe(200);
    expect(res.body.data.billing_increment_secs).toBe(30);
    expect(
      (await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } })).billingIncrementSecs,
    ).toBe(30);
  });

  it('clears it back to per-second billing with an explicit null', async () => {
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });

    const res = await request(app)
      .patch(`/api/admin/tiers/${tier.id}`)
      .set(staff())
      .send({ billingIncrementSecs: null });

    expect(res.status).toBe(200);
    expect(res.body.data.billing_increment_secs).toBeNull();
  });

  /**
   * Refused, never clamped. Clamping charges a customer at an increment
   * nobody chose and leaves nothing on screen saying so.
   */
  it.each([0, -1, 601, 3_600, 1.5, '30', true])(
    'refuses %p with a 400 and writes nothing',
    async (bad) => {
      const tier = await makeTier(`va-${String(bad).replace(/\W/g, '')}`, {
        price: 10_000n,
        increment: 60,
      });

      const res = await request(app)
        .patch(`/api/admin/tiers/${tier.id}`)
        .set(staff())
        .send({ billingIncrementSecs: bad });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(
        (await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } })).billingIncrementSecs,
      ).toBe(60);
    },
  );

  it('accepts both ends of the range', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });

    for (const value of [1, 600]) {
      const res = await request(app)
        .patch(`/api/admin/tiers/${tier.id}`)
        .set(staff())
        .send({ billingIncrementSecs: value });

      expect(res.status, `accepted ${value}`).toBe(200);
      expect(res.body.data.billing_increment_secs).toBe(value);
    }
  });

  /**
   * The two editors do not clobber each other. A price edit that had to
   * resubmit the increment would overwrite whatever another operator set
   * between the two page loads, and vice versa.
   */
  it('leaves the price alone when only the increment is sent', async () => {
    const tier = await makeTier('va-1', { price: 10_000n, increment: null });

    await request(app)
      .patch(`/api/admin/tiers/${tier.id}`)
      .set(staff())
      .send({ billingIncrementSecs: 30 });

    const row = await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } });
    expect(row.defaultPriceCreditsPerMin).toBe(10_000n);
    expect(row.billingIncrementSecs).toBe(30);
  });

  it('leaves the increment alone when only the price is sent', async () => {
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });

    await request(app)
      .patch(`/api/admin/tiers/${tier.id}`)
      .set(staff())
      .send({ defaultPriceCreditsPerMin: '2' });

    const row = await prisma.tier.findUniqueOrThrow({ where: { id: tier.id } });
    expect(row.defaultPriceCreditsPerMin).toBe(20_000n);
    expect(row.billingIncrementSecs).toBe(60);
  });

  it('lists the increment on GET, with null meaning per-second', async () => {
    await makeTier('va-1', { price: 10_000n, increment: 30 });
    await makeTier('va-2', { price: 10_000n });

    const res = await request(app).get('/api/admin/tiers').set(staff());

    const bySlug = Object.fromEntries(
      (res.body.data as { slug: string; billing_increment_secs: number | null }[]).map((row) => [
        row.slug,
        row.billing_increment_secs,
      ]),
    );

    expect(bySlug['va-1']).toBe(30);
    expect(bySlug['va-2']).toBeNull();
  });
});

describe('PATCH /api/admin/tiers/default', () => {
  it('moves the default, leaving exactly one', async () => {
    const one = await makeTier('va-1', { price: 10_000n, isDefault: true });
    const two = await makeTier('va-1-pro', { price: 25_000n });

    const res = await request(app)
      .patch('/api/admin/tiers/default')
      .set(staff())
      .send({ tierId: two.id });

    expect(res.status).toBe(200);
    expect(await prisma.tier.count({ where: { isDefault: true } })).toBe(1);
    expect((await prisma.tier.findUniqueOrThrow({ where: { id: two.id } })).isDefault).toBe(true);
    expect((await prisma.tier.findUniqueOrThrow({ where: { id: one.id } })).isDefault).toBe(false);
  });

  it('is registered before /tiers/:tierId, so "default" is not read as an id', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .patch('/api/admin/tiers/default')
      .set(staff())
      .send({ tierId: tier.id });

    expect(res.status).toBe(200);
  });

  /**
   * The default tier prices everyone who was never explicitly priced. Leaving
   * it unpriced makes the fallback unreachable for exactly the population it
   * exists for.
   */
  it('refuses a tier with no list price, and changes nothing', async () => {
    const priced = await makeTier('va-1', { price: 10_000n, isDefault: true });
    const unpriced = await makeTier('va-1-pro');

    const res = await request(app)
      .patch('/api/admin/tiers/default')
      .set(staff())
      .send({ tierId: unpriced.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_NOT_PRICEABLE');
    expect((await prisma.tier.findUniqueOrThrow({ where: { id: priced.id } })).isDefault).toBe(true);
  });

  it('refuses a retired tier', async () => {
    const gone = await makeTier('va-old', { price: 10_000n, status: 'REMOVED' });

    const res = await request(app)
      .patch('/api/admin/tiers/default')
      .set(staff())
      .send({ tierId: gone.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_NOT_PRICEABLE');
  });

  it('accepts a deliberate zero, because zero is a price', async () => {
    const free = await makeTier('va-free', { price: 0n });

    const res = await request(app)
      .patch('/api/admin/tiers/default')
      .set(staff())
      .send({ tierId: free.id });

    expect(res.status).toBe(200);
  });

  it('404s an unknown tier', async () => {
    const res = await request(app)
      .patch('/api/admin/tiers/default')
      .set(staff())
      .send({ tierId: 'nope' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/accounts/:accountId/tiers', () => {
  it("lists the account's assignments with the rate each resolves to", async () => {
    const account = await makeAccount('holder');
    const one = await makeTier('va-1', { price: 10_000n });
    const two = await makeTier('va-1-pro', { price: 25_000n });
    await prisma.accountTier.create({
      data: { accountId: account.id, tierId: one.id, priceCreditsPerMin: 7_500n },
    });
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: two.id } });

    const res = await request(app).get(`/api/admin/accounts/${account.id}/tiers`).set(staff());

    expect(res.status).toBe(200);
    expect(res.body.data.tiers).toEqual([
      expect.objectContaining({
        slug: 'va-1',
        price_credits_per_min: '0.75',
        default_price_credits_per_min: '1',
        rate_credits_per_min: '0.75',
      }),
      expect.objectContaining({
        slug: 'va-1-pro',
        price_credits_per_min: null,
        rate_credits_per_min: '2.5',
      }),
    ]);
  });

  it('says which tier an account with no assignments falls back to', async () => {
    const account = await makeAccount('none');
    const fallback = await makeTier('va-1', { price: 10_000n, isDefault: true });

    const res = await request(app).get(`/api/admin/accounts/${account.id}/tiers`).set(staff());

    expect(res.body.data.tiers).toEqual([]);
    expect(res.body.data.default_tier).toMatchObject({ id: fallback.id, slug: 'va-1' });
  });

  it('reports a null default tier rather than picking one', async () => {
    const account = await makeAccount('nodefault');
    await makeTier('va-1', { price: 10_000n });

    const res = await request(app).get(`/api/admin/accounts/${account.id}/tiers`).set(staff());

    expect(res.body.data.default_tier).toBeNull();
  });

  it('404s an unknown account', async () => {
    expect((await request(app).get('/api/admin/accounts/nope/tiers').set(staff())).status).toBe(404);
  });
});

describe('PUT /api/admin/accounts/:accountId/tiers', () => {
  it('replaces the whole set', async () => {
    const account = await makeAccount('holder');
    const one = await makeTier('va-1', { price: 10_000n });
    const two = await makeTier('va-1-pro', { price: 25_000n });
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: one.id } });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: two.id, priceCreditsPerMin: '2' }] });

    expect(res.status).toBe(200);
    const rows = await prisma.accountTier.findMany({ where: { accountId: account.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tierId: two.id, priceCreditsPerMin: 20_000n });
  });

  it('keeps an assignment that is resubmitted, updating only its price', async () => {
    const account = await makeAccount('holder');
    const tier = await makeTier('va-1', { price: 10_000n });
    const before = await prisma.accountTier.create({
      data: { accountId: account.id, tierId: tier.id },
    });

    await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id, priceCreditsPerMin: '0.5' }] });

    const after = await prisma.accountTier.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.priceCreditsPerMin).toBe(5_000n);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it('clears every assignment on an empty array, returning the account to the default', async () => {
    const account = await makeAccount('holder');
    const tier = await makeTier('va-1', { price: 10_000n });
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: tier.id } });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [] });

    expect(res.status).toBe(200);
    expect(await prisma.accountTier.count({ where: { accountId: account.id } })).toBe(0);
  });

  it('refuses an omitted `tiers`, so a malformed body cannot clear an account', async () => {
    const account = await makeAccount('holder');
    const tier = await makeTier('va-1', { price: 10_000n });
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: tier.id } });

    const res = await request(app).put(`/api/admin/accounts/${account.id}/tiers`).set(staff()).send({});

    expect(res.status).toBe(400);
    expect(await prisma.accountTier.count({ where: { accountId: account.id } })).toBe(1);
  });

  /**
   * Validate everything, then write. A body naming one good tier and one bad
   * one must leave the account exactly as it was — a half-applied plan is a
   * plan nobody chose.
   */
  it('writes nothing when any tier in the body is unknown', async () => {
    const account = await makeAccount('holder');
    const good = await makeTier('va-1', { price: 10_000n });
    const existing = await makeTier('va-2', { price: 30_000n });
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: existing.id } });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: good.id }, { tierId: 'nope' }] });

    expect(res.status).toBe(404);
    const rows = await prisma.accountTier.findMany({ where: { accountId: account.id } });
    expect(rows.map((row) => row.tierId)).toEqual([existing.id]);
  });

  it('refuses a retired tier, which no voice could satisfy', async () => {
    const account = await makeAccount('holder');
    const gone = await makeTier('va-old', { price: 10_000n, status: 'REMOVED' });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: gone.id }] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_NOT_ASSIGNABLE');
    expect(await prisma.accountTier.count({ where: { accountId: account.id } })).toBe(0);
  });

  it('refuses a duplicate tier rather than letting the last one win', async () => {
    const account = await makeAccount('holder');
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id, priceCreditsPerMin: '1' }, { tierId: tier.id }] });

    expect(res.status).toBe(400);
    expect(await prisma.accountTier.count({ where: { accountId: account.id } })).toBe(0);
  });

  it('refuses a malformed price with a 400 and writes nothing', async () => {
    const account = await makeAccount('holder');
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id, priceCreditsPerMin: '-3' }] });

    expect(res.status).toBe(400);
    expect(await prisma.accountTier.count({ where: { accountId: account.id } })).toBe(0);
  });

  it('lets a tier carry no price, meaning the list price applies', async () => {
    const account = await makeAccount('holder');
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id }] });

    expect(res.status).toBe(200);
    expect(res.body.data.tiers[0]).toMatchObject({
      price_credits_per_min: null,
      rate_credits_per_min: '1',
    });
  });

  it('404s an unknown account', async () => {
    const res = await request(app).put('/api/admin/accounts/nope/tiers').set(staff()).send({ tiers: [] });

    expect(res.status).toBe(404);
  });

  it('refuses without the staff token', async () => {
    const account = await makeAccount('holder');

    const res = await request(app).put(`/api/admin/accounts/${account.id}/tiers`).send({ tiers: [] });

    expect(res.status).toBe(401);
  });
});

describe('PUT /api/admin/accounts/:accountId/tiers — the billing increment', () => {
  it('round-trips a per-account override', async () => {
    const account = await makeAccount('pulsed');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id, billingIncrementSecs: 15 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.tiers[0]).toMatchObject({
      billing_increment_secs: 15,
      default_billing_increment_secs: 60,
      increment_secs: 15,
    });
    expect(
      (
        await prisma.accountTier.findFirstOrThrow({ where: { accountId: account.id } })
      ).billingIncrementSecs,
    ).toBe(15);
  });

  it('treats an absent increment as the tier default, exactly as a blank rate does', async () => {
    const account = await makeAccount('inherits');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 30 });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id }] });

    expect(res.status).toBe(200);
    expect(res.body.data.tiers[0]).toMatchObject({
      billing_increment_secs: null,
      default_billing_increment_secs: 30,
      // What the account actually gets: the tier's.
      increment_secs: 30,
    });
  });

  it('resolves per-second when neither level sets one', async () => {
    const account = await makeAccount('per-second');
    const tier = await makeTier('va-1', { price: 10_000n });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id, billingIncrementSecs: null }] });

    expect(res.body.data.tiers[0]).toMatchObject({
      billing_increment_secs: null,
      default_billing_increment_secs: null,
      increment_secs: 1,
    });
  });

  /** A deliberate 1 on a tier that pulses is a real concession and must not be
   *  read as an absence. */
  it('keeps a deliberate per-second override over a tier that pulses', async () => {
    const account = await makeAccount('deliberate');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({ tiers: [{ tierId: tier.id, billingIncrementSecs: 1 }] });

    expect(res.body.data.tiers[0]).toMatchObject({
      billing_increment_secs: 1,
      increment_secs: 1,
    });
  });

  /**
   * Validate everything, then write — the rule the price already holds. One
   * bad row must leave the account exactly as it was, or the operator cannot
   * tell from the error which half landed.
   */
  it('writes nothing when any row carries an out-of-range increment', async () => {
    const account = await makeAccount('half');
    const good = await makeTier('va-1', { price: 10_000n });
    const other = await makeTier('va-2', { price: 10_000n });
    await prisma.accountTier.create({ data: { accountId: account.id, tierId: other.id } });

    const res = await request(app)
      .put(`/api/admin/accounts/${account.id}/tiers`)
      .set(staff())
      .send({
        tiers: [
          { tierId: good.id, billingIncrementSecs: 30 },
          { tierId: other.id, billingIncrementSecs: 601 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const rows = await prisma.accountTier.findMany({ where: { accountId: account.id } });
    expect(rows.map((row) => row.tierId)).toEqual([other.id]);
    expect(rows[0]!.billingIncrementSecs).toBeNull();
  });

  it('reports the default tier increment on GET so an unassigned account is explainable', async () => {
    const account = await makeAccount('fallback');
    await makeTier('va-1', { price: 10_000n, increment: 30, isDefault: true });

    const res = await request(app).get(`/api/admin/accounts/${account.id}/tiers`).set(staff());

    expect(res.body.data.default_tier).toMatchObject({ billing_increment_secs: 30 });
  });
});
