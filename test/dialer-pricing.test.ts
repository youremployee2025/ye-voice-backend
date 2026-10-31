import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chargeFor, resolveCallRate } from '../src/lib/dialerPricing.js';
import { TierRateUnavailableError } from '../src/lib/tierPricing.js';
import { toInternalCredits } from '../src/lib/credits.js';
import { prisma } from '../src/lib/prisma.js';
import { makeAccount } from './helpers.js';
import { truncateAll } from './setup.js';

const price = (display: string) => toInternalCredits(display);

async function makeTier(
  slug: string,
  listPrice: string | null,
  isDefault = false,
  increment: number | null = null,
) {
  return prisma.tier.create({
    data: {
      slug,
      name: slug.toUpperCase(),
      defaultPriceCreditsPerMin: listPrice === null ? null : price(listPrice),
      billingIncrementSecs: increment,
      isDefault,
    },
  });
}

beforeEach(truncateAll);
afterEach(truncateAll);

describe('resolveCallRate', () => {
  it("carries the tier's increment through the same resolution as its rate", async () => {
    const account = await makeAccount('pulse-through');
    const pro = await makeTier('va-pro', '2.00', false, 30);
    await prisma.accountTier.create({
      data: { accountId: account.id, tierId: pro.id, priceCreditsPerMin: price('1.25') },
    });

    await expect(resolveCallRate(account.id, 'va-pro')).resolves.toMatchObject({
      rateCreditsPerMin: price('1.25'),
      incrementSecs: 30,
    });
  });

  it('reports per-second billing for a tier nobody has pulsed', async () => {
    const account = await makeAccount('unpulsed');
    await makeTier('va-pro', '2.00');

    await expect(resolveCallRate(account.id, 'va-pro')).resolves.toMatchObject({
      incrementSecs: 1,
    });
  });

  it("uses the account's own rate for the tier its voice is sold in", async () => {
    const account = await makeAccount('priced');
    const pro = await makeTier('va-pro', '2.00');
    await prisma.accountTier.create({
      data: { accountId: account.id, tierId: pro.id, priceCreditsPerMin: price('1.25') },
    });

    const rate = await resolveCallRate(account.id, 'va-pro');

    expect(rate.tierSlug).toBe('va-pro');
    expect(rate.rateCreditsPerMin).toBe(price('1.25'));
  });

  it('falls back to the list price when the account has no rate of its own', async () => {
    const account = await makeAccount('listed');
    await makeTier('va-pro', '2.00');

    await expect(resolveCallRate(account.id, 'va-pro')).resolves.toMatchObject({
      rateCreditsPerMin: price('2.00'),
    });
  });

  /**
   * A voice outside the tier system. The voice picker offers these to
   * everybody, so a campaign can legitimately be dialing on one, and it still
   * has to be billed at a price somebody set.
   */
  it("charges the default tier's rate for a voice with no tier", async () => {
    const account = await makeAccount('untiered');
    await makeTier('va-basic', '0.50', true);

    await expect(resolveCallRate(account.id, null)).resolves.toMatchObject({
      tierSlug: 'va-basic',
      rateCreditsPerMin: price('0.50'),
    });
  });

  /**
   * Deliberately unlike the voice picker, which withholds an unknown band as
   * un-entitled. The picker asks "may they choose this", where withholding is
   * safe; this asks "what does this cost", where withholding means a call
   * already placed cannot be billed at all.
   */
  it('falls back to the default tier for a slug the mirror does not know', async () => {
    const account = await makeAccount('unsynced');
    await makeTier('va-basic', '0.50', true);

    await expect(resolveCallRate(account.id, 'va-from-the-future')).resolves.toMatchObject({
      tierSlug: 'va-basic',
    });
  });

  it('refuses when there is no default tier and the slug is unknown', async () => {
    const account = await makeAccount('unpriceable');
    await makeTier('va-pro', '2.00');

    await expect(resolveCallRate(account.id, 'va-from-the-future')).rejects.toBeInstanceOf(
      TierRateUnavailableError,
    );
  });

  /**
   * A freshly synced tier is unpriced, and unpriced is not free. Refusing here
   * is what stops the dialer placing a call whose cost is decided after the
   * money is spent.
   */
  it('refuses when the tier exists but nobody has priced it', async () => {
    const account = await makeAccount('nopricing');
    await makeTier('va-pro', null);

    await expect(resolveCallRate(account.id, 'va-pro')).rejects.toBeInstanceOf(
      TierRateUnavailableError,
    );
  });

  /**
   * Zero is a price somebody set. `||` anywhere on this path would step over
   * it onto the list price and charge for calls that were sold as free.
   */
  it('honours a deliberate zero rate rather than falling through to the list price', async () => {
    const account = await makeAccount('free');
    const pro = await makeTier('va-pro', '2.00');
    await prisma.accountTier.create({
      data: { accountId: account.id, tierId: pro.id, priceCreditsPerMin: 0n },
    });

    await expect(resolveCallRate(account.id, 'va-pro')).resolves.toMatchObject({
      rateCreditsPerMin: 0n,
    });
  });

  /**
   * A REMOVED tier keeps its price and its assignments — a call launched on it
   * must still be billable, because the alternative is a call already placed
   * that cannot be charged.
   */
  it('still prices a retired tier', async () => {
    const account = await makeAccount('retired');
    const old = await makeTier('va-old', '3.00');
    await prisma.tier.update({ where: { id: old.id }, data: { status: 'REMOVED' } });

    await expect(resolveCallRate(account.id, 'va-old')).resolves.toMatchObject({
      rateCreditsPerMin: price('3.00'),
    });
  });
});

describe('chargeFor', () => {
  const rate = price('1.00'); // 10_000 internal units per minute

  it('charges a full minute for sixty seconds', () => {
    expect(chargeFor(rate, 60, 1)).toEqual({ billedSecs: 60, cost: price('1.00') });
  });

  it('charges pro rata for a partial minute when billing per second', () => {
    expect(chargeFor(rate, 30, 1)).toEqual({ billedSecs: 30, cost: price('0.50') });
  });

  /**
   * Hand-computed rather than derived from the implementation's own
   * arithmetic: 10000 × 127 / 60 = 21166.66…, truncated to 21166.
   */
  it('truncates rather than rounding, in the customer’s favour', () => {
    expect(chargeFor(rate, 127, 1)).toEqual({ billedSecs: 127, cost: 21_166n });
  });

  it('costs nothing for a call that never connected', () => {
    expect(chargeFor(rate, 0, 1)).toEqual({ billedSecs: 0, cost: 0n });
  });

  it('never returns a negative charge for a nonsense duration', () => {
    expect(chargeFor(rate, -5, 1)).toEqual({ billedSecs: 0, cost: 0n });
  });

  it('charges nothing at a zero rate, however long the call', () => {
    expect(chargeFor(0n, 3_600, 1)).toEqual({ billedSecs: 3_600, cost: 0n });
  });

  it('stays exact on a rate small enough to lose in a float', () => {
    // 0.0001 credits/min is one internal unit; a 30-second call is half of it
    // and truncates to zero. Done in floating point this is 0.00005, which is
    // exactly the kind of value that becomes 0.000050000000000000004.
    expect(chargeFor(1n, 30, 1)).toEqual({ billedSecs: 30, cost: 0n });
    expect(chargeFor(1n, 60, 1)).toEqual({ billedSecs: 60, cost: 1n });
  });

  /**
   * The pulse itself, hand-computed at 10000 units per minute.
   *
   * Each of these is a number a customer could put in front of us, so none of
   * them is derived from the implementation.
   */
  describe('rounding up to the increment', () => {
    it('bills a minute and a second as two full minutes', () => {
      expect(chargeFor(rate, 61, 60)).toEqual({ billedSecs: 120, cost: 20_000n });
    });

    it('bills the same call to the second when the increment is one', () => {
      // 10000 × 61 / 60 = 10166.66…, truncated.
      expect(chargeFor(rate, 61, 1)).toEqual({ billedSecs: 61, cost: 10_166n });
    });

    it('bills a five-second call as half a minute on a thirty', () => {
      expect(chargeFor(rate, 5, 30)).toEqual({ billedSecs: 30, cost: 5_000n });
    });

    /** An exact multiple does NOT roll to the next pulse. `ceil` of a whole
     *  number is that number, and a customer who hangs up on the tick is not
     *  charged for a pulse they did not enter. */
    it('does not roll an exact multiple into the next pulse', () => {
      expect(chargeFor(rate, 60, 60)).toEqual({ billedSecs: 60, cost: 10_000n });
      expect(chargeFor(rate, 120, 60)).toEqual({ billedSecs: 120, cost: 20_000n });
    });

    it('leaves a zero-duration call free at every increment', () => {
      for (const increment of [1, 15, 30, 60, 600]) {
        expect(chargeFor(rate, 0, increment)).toEqual({ billedSecs: 0, cost: 0n });
      }
    });

    it('rounds a fractional duration down before rounding it up to the pulse', () => {
      // The platform reports whole seconds, but the type is a number and the
      // floor was already the stated rule for the raw duration.
      expect(chargeFor(rate, 60.9, 60)).toEqual({ billedSecs: 60, cost: 10_000n });
    });

    /**
     * The two invariants every stored charge satisfies, asserted over a spread
     * rather than at a handful of points. A charge row that failed either
     * would be one nobody could explain to the customer it belongs to.
     */
    it('always bills at least the call, and always a whole number of pulses', () => {
      for (const increment of [1, 6, 15, 30, 60, 600]) {
        for (const duration of [1, 2, 7, 29, 30, 31, 59, 60, 61, 599, 600, 601, 3_607]) {
          const { billedSecs } = chargeFor(rate, duration, increment);

          expect(billedSecs).toBeGreaterThanOrEqual(duration);
          expect(billedSecs % increment).toBe(0);
          // And never more than one pulse of padding, which is what makes it
          // rounding rather than a surcharge.
          expect(billedSecs - duration).toBeLessThan(increment);
        }
      }
    });

    it('refuses an increment below one instead of computing NaN', () => {
      // Unreachable through app writes — every resolution bottoms out at 1 —
      // but the CallAttempt snapshot column is deliberately CHECK-less, so a
      // hand-edited row must produce a legible refusal, not `BigInt(NaN)`.
      for (const increment of [0, -1, 0.5]) {
        expect(() => chargeFor(rate, 47, increment)).toThrow(RangeError);
      }
    });
  });
});
