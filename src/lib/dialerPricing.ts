import { prisma } from './prisma.js';
import { TierRateUnavailableError, resolveTierPricing } from './tierPricing.js';

/**
 * What one call costs, and which tier decides.
 *
 * This module answers **which tier** to ask about. It deliberately does not
 * answer **what that tier costs** — `tierPricing.ts` owns the precedence chain
 * (account override → list price → refuse) and is the only place it exists.
 * Reimplementing even one link of it here would be the third copy of a pricing
 * rule, and the disagreement between copies is a customer charged a rate they
 * never agreed to.
 */

/** Sixty seconds, as the divisor for a per-minute rate. */
const SECONDS_PER_MINUTE = 60n;

export interface PricedCall {
  tierId: string;
  tierSlug: string;
  /** Internal credit units per minute. */
  rateCreditsPerMin: bigint;
  /** Seconds a call's duration is rounded UP to before it is priced. `1` is
   *  per-second billing. Resolved from the same walk as the rate above, never
   *  looked up separately — see `tierPricing.ts`. */
  incrementSecs: number;
}

/**
 * The rate this account pays for a minute on this agent's voice.
 *
 * The chain:
 *
 *   1. The agent's `voiceTierSlug`, resolved against the local `Tier` mirror.
 *   2. The platform default tier, for a voice with no tier or a slug the
 *      mirror does not know.
 *   3. Refuse.
 *
 * **A slug the mirror does not know falls back rather than failing**, unlike
 * the voice picker, which withholds an unknown band as un-entitled. The two
 * surfaces are asking different questions: the picker asks "may they choose
 * this", where withholding is safe, and this asks "what does this cost", where
 * withholding means a call already placed cannot be billed. The default tier's
 * rate is a price somebody set, so charging it is defensible; charging nothing
 * is not.
 *
 * **Refusing is a real outcome.** A platform with no default tier and an agent
 * on an unknown voice has no resolvable rate, and unpriced is not free. The
 * dialer treats this as a reason not to launch at all, because a call placed
 * at an unknown price is a call whose cost is decided after the money is
 * spent.
 */
export async function resolveCallRate(accountId: string, voiceTierSlug: string | null): Promise<PricedCall> {
  const tier = voiceTierSlug
    ? await prisma.tier.findUnique({ where: { slug: voiceTierSlug } })
    : null;

  const priced =
    tier ?? (await prisma.tier.findFirst({ where: { isDefault: true, status: 'ACTIVE' } }));

  if (!priced) throw new TierRateUnavailableError(voiceTierSlug);

  // One resolution for both numbers. Asking twice, or asking here for one and
  // elsewhere for the other, is how a call gets priced at the account's rate
  // and the tier's increment — two plans, neither of them the customer's.
  const pricing = await resolveTierPricing(accountId, priced.id);

  return {
    tierId: priced.id,
    tierSlug: priced.slug,
    rateCreditsPerMin: pricing.rateCreditsPerMin,
    incrementSecs: pricing.incrementSecs,
  };
}

/** What a call cost, and the seconds it was billed for. Both, because a
 *  charge that records only the amount cannot answer "why is this a minute
 *  when the call was forty-seven seconds". */
export interface CallCharge {
  /** `durationSecs` rounded up to the increment. Always >= the duration, and
   *  always a whole number of pulses. */
  billedSecs: number;
  /** Internal credit units. */
  cost: bigint;
}

/**
 * What a call of this length costs, in internal credit units, and the seconds
 * it is charged for.
 *
 * **Two roundings, in opposite directions, both deliberate.**
 *
 * First the duration is rounded **up** to the next whole increment. That is
 * the billing increment doing its job: a 47-second call on a 60 is billed as a
 * minute, because that is the plan. `ceil` of an exact multiple is that
 * multiple, so a call that ends on the tick does not roll into a pulse it
 * never entered. An increment of `1` rounds a whole number of seconds to
 * itself and the step is a no-op, which is why per-second billing needs no
 * branch of its own.
 *
 * Then the credits are divided by sixty and **truncated**, exactly as before
 * increments existed. At the 10000× multiplier the loss is at most one
 * internal unit — 0.0001 display credits — per call, it always falls in the
 * customer's favour, and it is monotonic in billed seconds. Rounding half-up
 * would be defensible too; what is not defensible is leaving either rule
 * unstated, because the difference is a billing dispute nobody can settle by
 * reading the code.
 *
 * A zero-second call costs nothing and is billed for nothing, at every
 * increment: `ceil(0 / n) * n` is 0 for every n. That is arithmetic rather
 * than a special case, and the caller writes no ledger row for it.
 */
export function chargeFor(
  rateCreditsPerMin: bigint,
  durationSecs: number,
  incrementSecs: number,
): CallCharge {
  // Every app write path resolves an increment of at least one, but the
  // CallAttempt snapshot column is deliberately CHECK-less, so a hand-edited
  // row could reach here with 0 — where `ceil(n / 0) * 0` is NaN and
  // `BigInt(NaN)` throws an opaque error inside the charge transaction.
  // Refuse legibly instead.
  if (!Number.isInteger(incrementSecs) || incrementSecs < 1) {
    throw new RangeError(
      `A call cannot be billed at an increment of ${incrementSecs} seconds.`,
    );
  }

  if (durationSecs <= 0) return { billedSecs: 0, cost: 0n };

  const seconds = Math.floor(durationSecs);
  const billedSecs = Math.ceil(seconds / incrementSecs) * incrementSecs;

  return {
    billedSecs,
    cost: (rateCreditsPerMin * BigInt(billedSecs)) / SECONDS_PER_MINUTE,
  };
}
