import { ApiError } from './errors.js';
import { env } from './env.js';
import { chargeFor, resolveCallRate } from './dialerPricing.js';
import { TierRateUnavailableError } from './tierPricing.js';

/**
 * What a browser test session would cost, and whether one may be priced at all.
 *
 * This module answers **at what price**, and nothing else. It talks to no
 * upstream, inserts nothing, and takes no lock — the concurrency caps and the
 * balance check belong in the transaction that holds the slot, because both are
 * check-then-act the moment they are done anywhere else.
 *
 * It deliberately does not restate a single link of the pricing chain.
 * `resolveCallRate` chooses which tier applies and `chargeFor` turns seconds
 * into credits, exactly as they do for a dial. A test session is a call without
 * a carrier; pricing it by a second route is how the same minute comes to cost
 * two different amounts.
 */

export interface TestSessionPlan {
  tierId: string;
  tierSlug: string;
  /** Internal credit units per minute. */
  rateCreditsPerMin: bigint;
  /** Seconds the duration is rounded UP to before it is priced. `1` is
   *  per-second billing. Resolved from the same walk as the rate. */
  billingIncrementSecs: number;
  /**
   * What this session can cost at worst: the full `TEST_SESSION_MAX_SECS` at
   * the resolved plan. This is what the balance has to cover before anything
   * starts.
   */
  maxCostCredits: bigint;
}

/**
 * Prices one test session for an account, or refuses to.
 *
 * **Unpriced is not free.** A platform with no default tier and an agent on a
 * voice no tier claims has no resolvable rate, and starting anyway would mean
 * deciding the cost after the money was spent. The dialer refuses to launch in
 * exactly this situation; so does this.
 *
 * The ceiling is computed by `chargeFor` rather than by multiplying the rate by
 * five minutes here. The two roundings are the plan the customer is on, and a
 * second implementation of them is a second answer to what a minute costs.
 */
export async function planTestSession(
  accountId: string,
  agent: { voiceTierSlug: string | null },
): Promise<TestSessionPlan> {
  let priced;

  try {
    priced = await resolveCallRate(accountId, agent.voiceTierSlug);
  } catch (err) {
    if (!(err instanceof TierRateUnavailableError)) throw err;

    throw new ApiError(
      409,
      'TEST_SESSION_RATE_UNAVAILABLE',
      "This agent's voice has no rate set, so it cannot be tested. Contact support.",
    );
  }

  const { cost } = chargeFor(
    priced.rateCreditsPerMin,
    env.testSessionMaxSecs,
    priced.incrementSecs,
  );

  return {
    tierId: priced.tierId,
    tierSlug: priced.tierSlug,
    rateCreditsPerMin: priced.rateCreditsPerMin,
    billingIncrementSecs: priced.incrementSecs,
    maxCostCredits: cost,
  };
}
