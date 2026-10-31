import type { Tier } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * What a minute of calling costs, in what increments it is billed, and who may
 * use which voices.
 *
 * **This module is the only place the precedence chain exists.** Three copies
 * of a pricing rule eventually say three different things, and here the
 * disagreement is a customer charged a rate they never agreed to. Nothing else
 * may reimplement the fallback — read it from here, or extend it here.
 *
 * The rate and the billing increment walk that chain **together**, in one
 * query, and are returned as one value. Resolving them separately is how a
 * call comes to be priced at the account's rate and the tier's increment —
 * two different plans, and the customer agreed to neither.
 */

/**
 * A tier that cannot be priced, and so cannot be used.
 *
 * A distinct error rather than a `null` return, because every caller must
 * decide what to do about it and a nullable bigint is the kind of value that
 * gets `?? 0n`'d in a hurry. Zero is a price somebody set; unknown is not a
 * price at all, and substituting one for the other rents calls out for free.
 */
export class TierRateUnavailableError extends Error {
  constructor(readonly slug: string | null) {
    super(
      slug
        ? `Tier "${slug}" has no price, so it cannot be used.`
        : 'That tier does not exist, so it cannot be priced.',
    );
    this.name = 'TierRateUnavailableError';
  }
}

/** The shortest billing increment: one second, which is per-second billing.
 *  There is no "off" — per-second IS an increment, so the charge path has one
 *  formula rather than a formula and a branch that must agree with it. */
export const BILLING_INCREMENT_MIN = 1;

/** Ten minutes. Nothing plausible bills in a longer pulse, and an increment
 *  longer than most calls turns a rate per minute into a flat fee while still
 *  being labelled a rate. */
export const BILLING_INCREMENT_MAX = 600;

/**
 * A billing increment, or a refusal.
 *
 * **Rejects, never clamps.** Clamping 3600 to 600 charges a customer at an
 * increment nobody chose, and leaves nothing on any screen saying so. Every
 * write path calls this rather than restating the bounds, for the same reason
 * the precedence chain below has exactly one home.
 *
 * A `RangeError` rather than the API's own error type: this module is beneath
 * the HTTP layer and must not know what a status code is. The routes catch it
 * and turn it into a 400.
 */
export function parseBillingIncrement(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RangeError('A billing increment is a whole number of seconds.');
  }

  if (value < BILLING_INCREMENT_MIN || value > BILLING_INCREMENT_MAX) {
    throw new RangeError(
      `A billing increment is between ${BILLING_INCREMENT_MIN} and ${BILLING_INCREMENT_MAX} seconds.`,
    );
  }

  return value;
}

/** What one minute costs this account on this tier, and the pulse its calls
 *  are rounded up to. Both from one resolution — see the module comment. */
export interface TierPricing {
  /** Internal credit units per minute. */
  rateCreditsPerMin: bigint;
  /** Seconds. Always resolved and never null past this boundary: `1` is
   *  per-second billing, which is what an unset increment means. */
  incrementSecs: number;
}

/**
 * The rate this account pays per minute on this tier, and the increment its
 * calls are billed in.
 *
 * The chain, in order, walked once for both values:
 *
 *   1. `AccountTier.priceCreditsPerMin` / `.billingIncrementSecs` — this
 *      account's own plan.
 *   2. `Tier.defaultPriceCreditsPerMin` / `.billingIncrementSecs` — the list
 *      plan.
 *   3. Refuse the rate; bill the increment per second.
 *
 * The two ends differ because the two absences differ. **An unresolvable rate
 * is a refusal** — zero is a price somebody set, unknown is not a price at all,
 * and substituting one for the other rents calls out for free. **An
 * unresolvable increment is not**: the chain bottoms out at one second, which
 * is not a guess but the arithmetic this service billed with before increments
 * existed.
 *
 * One query joining the assignment to the tier; the precedence is decided in
 * code rather than in SQL `COALESCE`, so it is readable, testable, and cannot
 * be half-changed by an index hint.
 *
 * A tier the account has no assignment for still resolves — to the list plan.
 * Entitlement is a separate question, answered by `tiersForAccount`; a caller
 * that needs both must ask both. Merging them would make one function refuse
 * for two unrelated reasons.
 */
export async function resolveTierPricing(accountId: string, tierId: string): Promise<TierPricing> {
  const tier = await prisma.tier.findUnique({
    where: { id: tierId },
    include: { accounts: { where: { accountId }, take: 1 } },
  });

  if (!tier) throw new TierRateUnavailableError(null);

  const assignment = tier.accounts[0];

  // `?? tier.default…` rather than `||`, on both columns and for the same
  // reason: a deliberate 0n is a free tier and `||` would step over it onto
  // the list price. The increment carries the same trap one column across — an
  // account deliberately put back on per-second billing while its tier pulses
  // at a minute is a real concession, and `??` is what keeps a `1` from being
  // read as an absence. Neither line may become `|| 1`.
  const rate = assignment?.priceCreditsPerMin ?? tier.defaultPriceCreditsPerMin;
  const increment = assignment?.billingIncrementSecs ?? tier.billingIncrementSecs;

  if (rate === null || rate === undefined) throw new TierRateUnavailableError(tier.slug);

  return {
    rateCreditsPerMin: rate,
    // The bottom of the chain, and the only place `1` is supplied. Stored
    // values are held to the range by `parseBillingIncrement` at every write
    // path and by a CHECK constraint behind them, so this trusts the column
    // rather than second-guessing it: silently correcting a bad row here would
    // charge a customer at an increment nobody chose and hide that it happened.
    incrementSecs: increment ?? BILLING_INCREMENT_MIN,
  };
}

/**
 * The tiers this account is **entitled to** — what the voice picker filters on.
 *
 * An account's explicit assignments, restricted to ACTIVE tiers. An account
 * with **no assignments at all** is treated as holding the platform default
 * tier, which is what `Tier.isDefault` is for.
 *
 * Two rules that look adjacent and are not:
 *
 * - **Having a retired assignment is still having an assignment.** An account
 *   whose only tier has been retired gets nothing, not the default. Falling
 *   through would silently grant a plan nobody sold them.
 * - **No default tier means nobody gets one.** Not "the first tier", not "the
 *   cheapest". That is the state every install is in before staff have priced
 *   anything, and picking a row arbitrarily prices somebody's calls off it.
 *   Failing closed here shows up as an empty voice picker, which is visible
 *   and fixable; the alternative is invisible and is a wrong invoice.
 */
export async function tiersForAccount(accountId: string): Promise<Tier[]> {
  const assignments = await prisma.accountTier.findMany({
    where: { accountId },
    include: { tier: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  if (assignments.length > 0) {
    return assignments.map((row) => row.tier).filter((tier) => tier.status === 'ACTIVE');
  }

  const fallback = await prisma.tier.findFirst({
    where: { isDefault: true, status: 'ACTIVE' },
  });

  return fallback ? [fallback] : [];
}

/** One assignment, with the plan it carries — null on either field meaning
 *  "whatever the tier says". */
export interface AssignedTier {
  tier: Tier;
  priceCreditsPerMin: bigint | null;
  billingIncrementSecs: number | null;
}

/**
 * Everything the account actually holds, for **display** rather than for
 * entitlement.
 *
 * Retired tiers are included and the default is never substituted, because
 * both surfaces that read this — the staff assignment form and the customer's
 * plan card — are answering "what is on this account", not "what may it use".
 * A plan card that quietly drops a line is how a customer discovers a change
 * by not noticing it.
 */
export async function assignedTiers(accountId: string): Promise<AssignedTier[]> {
  const rows = await prisma.accountTier.findMany({
    where: { accountId },
    include: { tier: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => ({
    tier: row.tier,
    priceCreditsPerMin: row.priceCreditsPerMin,
    billingIncrementSecs: row.billingIncrementSecs,
  }));
}
