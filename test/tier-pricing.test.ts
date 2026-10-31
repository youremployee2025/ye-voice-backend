import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import {
  BILLING_INCREMENT_MAX,
  BILLING_INCREMENT_MIN,
  TierRateUnavailableError,
  assignedTiers,
  parseBillingIncrement,
  resolveTierPricing,
  tiersForAccount,
} from '../src/lib/tierPricing.js';
import { makeAccount } from './helpers.js';
import { truncateAll } from './setup.js';

/**
 * The precedence chain, and the refusal at the end of it.
 *
 * This is the module a later slice's dialer will call once per call to decide
 * what a minute costs, so the cases below are the ones where being wrong is a
 * wrong charge rather than a wrong screen.
 */

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

async function assign(
  account: Account,
  tierId: string,
  price: bigint | null = null,
  increment: number | null = null,
) {
  return prisma.accountTier.create({
    data: {
      accountId: account.id,
      tierId,
      priceCreditsPerMin: price,
      billingIncrementSecs: increment,
    },
  });
}

beforeEach(truncateAll);
afterAll(truncateAll);

describe('resolveTierPricing — the rate', () => {
  it("prefers the account's own price over the tier's default", async () => {
    const account = await makeAccount('custom');
    const tier = await makeTier('va-1', { price: 10_000n });
    await assign(account, tier.id, 7_500n);

    expect((await resolveTierPricing(account.id, tier.id)).rateCreditsPerMin).toBe(7_500n);
  });

  it('falls back to the list price when the assignment carries none', async () => {
    const account = await makeAccount('listed');
    const tier = await makeTier('va-1', { price: 10_000n });
    await assign(account, tier.id, null);

    expect((await resolveTierPricing(account.id, tier.id)).rateCreditsPerMin).toBe(10_000n);
  });

  it('falls back to the list price when the account has no assignment at all', async () => {
    const account = await makeAccount('unassigned');
    const tier = await makeTier('va-1', { price: 10_000n });

    expect((await resolveTierPricing(account.id, tier.id)).rateCreditsPerMin).toBe(10_000n);
  });

  /**
   * The load-bearing case. Zero is a price somebody set; unknown is not a
   * price at all, and returning 0n for it would rent calls out for free with
   * nothing anywhere saying so.
   */
  it('refuses when neither a custom price nor a default exists', async () => {
    const account = await makeAccount('unpriced');
    const tier = await makeTier('va-1', { price: null });
    await assign(account, tier.id, null);

    await expect(resolveTierPricing(account.id, tier.id)).rejects.toBeInstanceOf(
      TierRateUnavailableError,
    );
  });

  it('names the tier it could not price', async () => {
    const account = await makeAccount('named');
    const tier = await makeTier('va-1-pro', { price: null });

    const error = await resolveTierPricing(account.id, tier.id).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TierRateUnavailableError);
    expect((error as TierRateUnavailableError).slug).toBe('va-1-pro');
  });

  it('returns a deliberate zero, because zero is a price and absence is not', async () => {
    const account = await makeAccount('free');
    const tier = await makeTier('va-1', { price: 0n });

    expect((await resolveTierPricing(account.id, tier.id)).rateCreditsPerMin).toBe(0n);
  });

  it('refuses a tier that does not exist rather than inventing a rate', async () => {
    const account = await makeAccount('ghost');

    await expect(resolveTierPricing(account.id, 'no-such-tier')).rejects.toBeInstanceOf(
      TierRateUnavailableError,
    );
  });
});

/**
 * The increment chain, which is the rate chain one column over.
 *
 * It is deliberately the same walk through the same row, because a call priced
 * at the account's rate and the tier's increment is priced on a plan the
 * customer never agreed to. The cases here are the ones where being wrong is a
 * wrong charge rather than a wrong screen.
 */
describe('resolveTierPricing — the increment', () => {
  it("prefers the account's own increment over the tier's default", async () => {
    const account = await makeAccount('pulsed');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });
    await assign(account, tier.id, null, 30);

    expect((await resolveTierPricing(account.id, tier.id)).incrementSecs).toBe(30);
  });

  it("falls back to the tier's increment when the assignment carries none", async () => {
    const account = await makeAccount('default-pulse');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });
    await assign(account, tier.id, null, null);

    expect((await resolveTierPricing(account.id, tier.id)).incrementSecs).toBe(60);
  });

  it("falls back to the tier's increment when the account has no assignment at all", async () => {
    const account = await makeAccount('unassigned-pulse');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 15 });

    expect((await resolveTierPricing(account.id, tier.id)).incrementSecs).toBe(15);
  });

  it('bills per second when neither level sets one', async () => {
    const account = await makeAccount('per-second');
    const tier = await makeTier('va-1', { price: 10_000n });
    await assign(account, tier.id);

    expect((await resolveTierPricing(account.id, tier.id)).incrementSecs).toBe(1);
  });

  /**
   * The load-bearing case, and the reason the chain uses `??` rather than
   * `||`. An account deliberately put back on per-second billing while its
   * tier pulses at a minute is the concession you give the customer who
   * noticed — and `1` must beat `60`, not be stepped over as a falsy-looking
   * placeholder by a fallback written without thought.
   */
  it('honours a deliberate per-second override of a tier that pulses', async () => {
    const account = await makeAccount('deliberate-one');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });
    await assign(account, tier.id, null, 1);

    expect((await resolveTierPricing(account.id, tier.id)).incrementSecs).toBe(1);
  });

  /**
   * Rate and increment are resolved from ONE walk, so an account that
   * overrides only the rate keeps the tier's increment and vice versa. Two
   * separate lookups could disagree about which row won.
   */
  it('resolves the rate and the increment from the same row', async () => {
    const account = await makeAccount('half-override');
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });
    await assign(account, tier.id, 7_500n, null);

    expect(await resolveTierPricing(account.id, tier.id)).toEqual({
      rateCreditsPerMin: 7_500n,
      incrementSecs: 60,
    });
  });

  /**
   * An unpriced tier is a refusal whatever its increment says. An increment
   * without a rate prices nothing.
   */
  it('still refuses an unpriced tier that has an increment', async () => {
    const account = await makeAccount('unpriced-pulse');
    const tier = await makeTier('va-1', { price: null, increment: 60 });

    await expect(resolveTierPricing(account.id, tier.id)).rejects.toBeInstanceOf(
      TierRateUnavailableError,
    );
  });
});

/**
 * The bounds, in the one place that owns them.
 *
 * Every write path calls this rather than restating `1` and `600`, for the
 * same reason the precedence chain has one home: three copies of a billing
 * rule eventually say three different things.
 */
describe('parseBillingIncrement', () => {
  it('accepts the ends of the range', () => {
    expect(parseBillingIncrement(BILLING_INCREMENT_MIN)).toBe(1);
    expect(parseBillingIncrement(BILLING_INCREMENT_MAX)).toBe(600);
  });

  it('accepts an ordinary increment', () => {
    expect(parseBillingIncrement(30)).toBe(30);
  });

  // Rejected, never clamped. A clamp charges a customer at an increment
  // nobody chose and leaves nothing on screen saying so.
  it.each([0, -1, 601, 3_600])('refuses %s rather than clamping it', (value) => {
    expect(() => parseBillingIncrement(value)).toThrow(RangeError);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s, which is not a whole number of seconds', (value) => {
    expect(() => parseBillingIncrement(value)).toThrow(RangeError);
  });

  it('refuses a string that merely looks like a number', () => {
    expect(() => parseBillingIncrement('30' as unknown as number)).toThrow(RangeError);
  });
});

describe('tiersForAccount', () => {
  it('returns the tiers the account is assigned', async () => {
    const account = await makeAccount('holder');
    const one = await makeTier('va-1', { price: 10_000n });
    const two = await makeTier('va-1-pro', { price: 20_000n });
    await makeTier('va-2', { price: 30_000n });
    await assign(account, one.id);
    await assign(account, two.id);

    const slugs = (await tiersForAccount(account.id)).map((tier) => tier.slug);

    expect(slugs.sort()).toEqual(['va-1', 'va-1-pro']);
  });

  it('treats an account with no assignments as holding the default tier', async () => {
    const account = await makeAccount('defaulted');
    await makeTier('va-1', { price: 10_000n, isDefault: true });
    await makeTier('va-1-pro', { price: 20_000n });

    expect((await tiersForAccount(account.id)).map((tier) => tier.slug)).toEqual(['va-1']);
  });

  /**
   * Fail closed. Picking "the first tier" when none is marked would price
   * somebody's calls off whichever row happened to sort first — and this is
   * the state every install is in before staff have priced anything.
   */
  it('returns nothing when there is no assignment and no default tier', async () => {
    const account = await makeAccount('nodefault');
    await makeTier('va-1', { price: 10_000n });

    expect(await tiersForAccount(account.id)).toEqual([]);
  });

  it('omits a REMOVED tier from the entitlement set', async () => {
    const account = await makeAccount('retired');
    const gone = await makeTier('va-old', { price: 10_000n, status: 'REMOVED' });
    await assign(account, gone.id);

    expect(await tiersForAccount(account.id)).toEqual([]);
  });

  /**
   * An account with an assignment is not an account with no assignment, even
   * when the tier it holds has been retired. Falling through to the default
   * here would silently grant a plan nobody sold them.
   */
  it('does not fall back to the default when the only assignment is retired', async () => {
    const account = await makeAccount('retired-only');
    const gone = await makeTier('va-old', { price: 10_000n, status: 'REMOVED' });
    await makeTier('va-1', { price: 10_000n, isDefault: true });
    await assign(account, gone.id);

    expect(await tiersForAccount(account.id)).toEqual([]);
  });
});

describe('assignedTiers', () => {
  it('lists everything the account holds, retired tiers included, with each price', async () => {
    const account = await makeAccount('display');
    const live = await makeTier('va-1', { price: 10_000n });
    const gone = await makeTier('va-old', { price: 30_000n, status: 'REMOVED' });
    await assign(account, live.id, 7_500n);
    await assign(account, gone.id);

    const rows = await assignedTiers(account.id);

    expect(rows.map((row) => [row.tier.slug, row.priceCreditsPerMin]).sort()).toEqual([
      ['va-1', 7_500n],
      ['va-old', null],
    ]);
  });

  it('is empty for an account with no assignments — it does not substitute the default', async () => {
    const account = await makeAccount('none');
    await makeTier('va-1', { price: 10_000n, isDefault: true });

    expect(await assignedTiers(account.id)).toEqual([]);
  });
});

describe('the one-default invariant', () => {
  /**
   * Enforced by a partial unique index rather than by handler discipline, so
   * this asserts the database refuses — not that some code path remembered to
   * check.
   */
  it('is the database refusing a second default, not a handler remembering', async () => {
    await makeTier('va-1', { price: 10_000n, isDefault: true });

    await expect(makeTier('va-1-pro', { price: 20_000n, isDefault: true })).rejects.toThrow();
  });

  it('places no limit on how many tiers are NOT the default', async () => {
    await makeTier('va-1', { price: 10_000n });
    await makeTier('va-1-pro', { price: 20_000n });
    await makeTier('va-2', { price: 30_000n });

    expect(await prisma.tier.count({ where: { isDefault: false } })).toBe(3);
  });
});
