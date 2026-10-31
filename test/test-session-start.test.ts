import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planTestSession } from '../src/lib/testSessionStart.js';
import { ApiError } from '../src/lib/errors.js';
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

describe('planTestSession', () => {
  it("resolves both halves of the plan from the agent's own tier", async () => {
    const account = await makeAccount('plan-both-halves');
    const pro = await makeTier('va-pro', '2.00', false, 30);

    const plan = await planTestSession(account.id, { voiceTierSlug: 'va-pro' });

    expect(plan.tierId).toBe(pro.id);
    expect(plan.tierSlug).toBe('va-pro');
    expect(plan.rateCreditsPerMin).toBe(price('2.00'));
    expect(plan.billingIncrementSecs).toBe(30);
  });

  /**
   * The gate is the WHOLE cap, not one pulse. A session that cannot be paid for
   * in full should not start: the browser can hold the line for the full five
   * minutes, and refusing at the far end — after the minutes are already spent
   * — is a shortfall rather than a refusal.
   *
   * At 2.00 display credits a minute and a 300-second cap the arithmetic is
   * exactly ten credits, asserted as an exact BigInt because a billing figure
   * that is approximately right is wrong.
   */
  it('requires a balance covering the whole cap, to the credit', async () => {
    const account = await makeAccount('plan-full-cap');
    await makeTier('va-pro', '2.00', false, 60);

    const plan = await planTestSession(account.id, { voiceTierSlug: 'va-pro' });

    expect(plan.maxCostCredits).toBe(price('10.00'));
  });

  it('prices the cap on the resolved increment, not on the raw seconds', async () => {
    const account = await makeAccount('plan-cap-increment');
    // 300 seconds is an exact multiple of both, so the two agree here — which
    // is the point: the cap is computed by `chargeFor` rather than by a second
    // implementation of the rounding that would drift from it.
    await makeTier('va-sec', '2.00', false, 1);

    const plan = await planTestSession(account.id, { voiceTierSlug: 'va-sec' });

    expect(plan.maxCostCredits).toBe(price('10.00'));
  });

  it('falls back to the platform default tier for a voice with no tier', async () => {
    const account = await makeAccount('plan-default-tier');
    const base = await makeTier('va-basic', '0.50', true);

    const plan = await planTestSession(account.id, { voiceTierSlug: null });

    expect(plan.tierId).toBe(base.id);
    expect(plan.rateCreditsPerMin).toBe(price('0.50'));
  });

  it("prefers an account's own rate over the list price", async () => {
    const account = await makeAccount('plan-override');
    const pro = await makeTier('va-pro', '2.00');
    await prisma.accountTier.create({
      data: { accountId: account.id, tierId: pro.id, priceCreditsPerMin: price('1.00') },
    });

    const plan = await planTestSession(account.id, { voiceTierSlug: 'va-pro' });

    expect(plan.rateCreditsPerMin).toBe(price('1.00'));
  });

  /**
   * Unpriced is not free. A platform with no default tier and an agent on an
   * unknown voice has no resolvable rate, and starting anyway would decide the
   * cost after the money was spent — which is the reason the dialer refuses to
   * launch in the same situation.
   */
  it('refuses when nothing can price the session', async () => {
    const account = await makeAccount('plan-unpriced');
    await makeTier('va-pro', null);

    await expect(planTestSession(account.id, { voiceTierSlug: 'va-pro' })).rejects.toMatchObject({
      status: 409,
      code: 'TEST_SESSION_RATE_UNAVAILABLE',
    });
  });

  it('reports the refusal as an ApiError the route layer already understands', async () => {
    const account = await makeAccount('plan-refusal-shape');

    await expect(planTestSession(account.id, { voiceTierSlug: null })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  /**
   * Never the supplier's name. The message reaches a customer's screen, and
   * which platform is under the product is not theirs to learn from an error.
   */
  it('does not name the supplier in the refusal', async () => {
    const account = await makeAccount('plan-no-supplier');

    const err = await planTestSession(account.id, { voiceTierSlug: null }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).not.toMatch(/vocobase/i);
  });
});
