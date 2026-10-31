import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { makeAccount } from './helpers.js';
import { truncateAll } from './setup.js';

/**
 * The mirror invariant, tested from the direction that costs money.
 *
 * Sync owns two columns — `name` and `status` — and must never touch a price
 * or the default flag. A refresh that reset either would re-rate every account
 * holding the tier, from a button whose label says "Sync".
 */

vi.mock('../src/adapter/vocobase.js', () => ({ listVoiceTiers: vi.fn() }));

const { listVoiceTiers } = await import('../src/adapter/vocobase.js');
const { syncVoiceTiers } = await import('../src/services/tierSync.js');

const upstream = vi.mocked(listVoiceTiers);

beforeEach(async () => {
  await truncateAll();
  upstream.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(truncateAll);

describe('syncVoiceTiers', () => {
  it('imports the tiers the platform lists', async () => {
    upstream.mockResolvedValue({
      tiers: [
        { tier: 'va-1', label: 'VA 1' },
        { tier: 'va-1-pro', label: 'VA 1 Pro' },
      ],
    });

    const result = await syncVoiceTiers();

    expect(result).toMatchObject({ synced: 2, skipped: 0, removed: 0, truncated: false });
    const rows = await prisma.tier.findMany({ orderBy: { slug: 'asc' } });
    expect(rows.map((row) => [row.slug, row.name, row.status])).toEqual([
      ['va-1', 'VA 1', 'ACTIVE'],
      ['va-1-pro', 'VA 1 Pro', 'ACTIVE'],
    ]);
  });

  it('reads both spellings the V2 API mixes', async () => {
    upstream.mockResolvedValue({ tiers: [{ slug: 'va-2', displayName: 'VA 2' }] });

    await syncVoiceTiers();

    expect(await prisma.tier.findUnique({ where: { slug: 'va-2' } })).toMatchObject({
      name: 'VA 2',
    });
  });

  it('falls back to the slug when upstream sends no label', async () => {
    upstream.mockResolvedValue({ tiers: [{ tier: 'va-3' }] });

    await syncVoiceTiers();

    expect(await prisma.tier.findUnique({ where: { slug: 'va-3' } })).toMatchObject({
      name: 'va-3',
    });
  });

  it('skips and counts a row with no readable slug rather than fabricating one', async () => {
    upstream.mockResolvedValue({ tiers: [{ label: 'Nameless' }, { tier: 'va-1', label: 'VA 1' }] });

    const result = await syncVoiceTiers();

    expect(result).toMatchObject({ synced: 1, skipped: 1 });
    expect(await prisma.tier.count()).toBe(1);
  });

  /**
   * The one this module exists to keep true.
   */
  it('never overwrites a price or the default flag on refresh', async () => {
    await prisma.tier.create({
      data: {
        slug: 'va-1',
        name: 'Old label',
        defaultPriceCreditsPerMin: 12_345n,
        isDefault: true,
      },
    });

    upstream.mockResolvedValue({ tiers: [{ tier: 'va-1', label: 'VA 1' }] });
    await syncVoiceTiers();

    const row = await prisma.tier.findUniqueOrThrow({ where: { slug: 'va-1' } });
    expect(row.name).toBe('VA 1');
    expect(row.defaultPriceCreditsPerMin).toBe(12_345n);
    expect(row.isDefault).toBe(true);
    expect(row.lastSyncedAt).not.toBeNull();
  });

  it('marks a tier the platform stopped listing REMOVED, and keeps its assignments', async () => {
    const account = await makeAccount('holder');
    const gone = await prisma.tier.create({
      data: { slug: 'va-old', name: 'VA Old', defaultPriceCreditsPerMin: 10_000n },
    });
    await prisma.accountTier.create({
      data: { accountId: account.id, tierId: gone.id, priceCreditsPerMin: 7_500n },
    });

    upstream.mockResolvedValue({ tiers: [{ tier: 'va-1', label: 'VA 1' }] });
    const result = await syncVoiceTiers();

    expect(result.removed).toBe(1);
    expect(await prisma.tier.findUniqueOrThrow({ where: { slug: 'va-old' } })).toMatchObject({
      status: 'REMOVED',
      defaultPriceCreditsPerMin: 10_000n,
    });
    // The assignment and its price survive: the customer's history of what
    // they were sold does not disappear because the platform stopped selling it.
    expect(await prisma.accountTier.count({ where: { tierId: gone.id } })).toBe(1);
  });

  it('restores a tier that reappears, keeping the price it had', async () => {
    await prisma.tier.create({
      data: {
        slug: 'va-1',
        name: 'VA 1',
        status: 'REMOVED',
        defaultPriceCreditsPerMin: 10_000n,
      },
    });

    upstream.mockResolvedValue({ tiers: [{ tier: 'va-1', label: 'VA 1' }] });
    await syncVoiceTiers();

    expect(await prisma.tier.findUniqueOrThrow({ where: { slug: 'va-1' } })).toMatchObject({
      status: 'ACTIVE',
      defaultPriceCreditsPerMin: 10_000n,
    });
  });

  /**
   * An empty list is far more likely to be an outage than a platform that
   * stopped selling every tier at once. Believing it would retire the whole
   * catalogue and empty every voice picker on the product.
   */
  it('marks nothing removed on an empty listing, and says the run was partial', async () => {
    await prisma.tier.create({ data: { slug: 'va-1', name: 'VA 1' } });

    upstream.mockResolvedValue({ tiers: [] });
    const result = await syncVoiceTiers();

    expect(result).toMatchObject({ synced: 0, removed: 0, truncated: true });
    expect(await prisma.tier.findUniqueOrThrow({ where: { slug: 'va-1' } })).toMatchObject({
      status: 'ACTIVE',
    });
  });

  it('treats an unreadable payload the same way', async () => {
    await prisma.tier.create({ data: { slug: 'va-1', name: 'VA 1' } });

    upstream.mockResolvedValue({});
    const result = await syncVoiceTiers();

    expect(result).toMatchObject({ removed: 0, truncated: true });
    expect(await prisma.tier.findUniqueOrThrow({ where: { slug: 'va-1' } })).toMatchObject({
      status: 'ACTIVE',
    });
  });

  it('lets an upstream failure through rather than reporting an empty catalogue', async () => {
    upstream.mockRejectedValue(new Error('platform down'));

    await expect(syncVoiceTiers()).rejects.toThrow('platform down');
  });

  it('ignores a duplicate slug in one listing rather than failing the run', async () => {
    upstream.mockResolvedValue({
      tiers: [
        { tier: 'va-1', label: 'VA 1' },
        { tier: 'va-1', label: 'VA 1 again' },
      ],
    });

    const result = await syncVoiceTiers();

    expect(result.synced).toBe(2);
    expect(await prisma.tier.count()).toBe(1);
  });
});
