import { Router } from 'express';
import { z } from 'zod';
import type { Tier } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { toDisplayCredits, toInternalCredits } from '../../lib/credits.js';
import {
  BILLING_INCREMENT_MIN,
  parseBillingIncrement,
} from '../../lib/tierPricing.js';
import { syncVoiceTiers } from '../../services/tierSync.js';

/**
 * Staff view of the voice tier catalogue and who holds what.
 *
 * The catalogue itself is the platform's — synced, never authored here. What
 * these routes own is everything the platform does not send: what a tier costs
 * an YE customer, which tier an unassigned account falls back to, and which
 * accounts hold which tiers.
 *
 * Nothing here writes upstream. The only call this module can reach is the
 * paged read inside `syncVoiceTiers`.
 */
export const adminTierRoutes: Router = Router();

adminTierRoutes.use(requireStaffToken);

/**
 * A tier's list price, its billing increment, or either.
 *
 * **`null` must be stated rather than implied by omission** — the same rule the
 * DID price and the agent assignment endpoints hold. A malformed body that
 * unpriced a tier would take it out of every voice picker on the product, and
 * a missing key is exactly what a half-written client sends. So an omitted key
 * means *leave that column alone*, and `{}` — every key omitted — is refused
 * outright rather than being read as a no-op somebody meant as an edit.
 *
 * Both fields are separately optional because they are edited by two separate
 * one-field editors on the same row of the same table. A price edit forced to
 * resubmit the increment would overwrite whatever another operator set between
 * the two page loads, and the increment edit would do the same back.
 */
const tierPatchSchema = z
  .object({
    defaultPriceCreditsPerMin: z.string().nullable().optional(),
    // `unknown` rather than `z.number()`: the bounds and the integer rule live
    // in `tierPricing.ts` beside the precedence chain, and restating even the
    // type here is the first step towards a second copy of the rule.
    billingIncrementSecs: z.unknown().optional(),
  })
  .refine(
    (body) =>
      body.defaultPriceCreditsPerMin !== undefined || body.billingIncrementSecs !== undefined,
    { message: 'Send a price, an increment, or both.' },
  );

const defaultTierSchema = z.object({
  tierId: z.string().min(1),
});

const assignmentSchema = z.object({
  /**
   * The complete intended set, not a patch. A form with one Save button means
   * one request; add/remove endpoints turn one intention into three that can
   * half-land. Required, so `{}` is a 400 rather than "clear everything".
   */
  tiers: z
    .array(
      z.object({
        tierId: z.string().min(1),
        /** Absent means the tier's list price applies. */
        priceCreditsPerMin: z.string().nullable().optional(),
        /** Absent means the tier's own increment applies, which itself may be
         *  absent and therefore per-second. Same empty-means-default
         *  convention as the price above, one column across. */
        billingIncrementSecs: z.unknown().optional(),
      }),
    )
    .max(50),
});

/**
 * Parses a credit amount, turning the parser's internals into a 400.
 *
 * The parser's own wording names implementation detail; the code is what the
 * caller acts on. Out-of-range lands here too rather than reaching the write
 * as an unhandled Prisma error — a validated money field must not be able to
 * answer 500.
 */
function parsePrice(value: string, field: string): bigint {
  try {
    return toInternalCredits(value);
  } catch {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `${field} must be a non-negative amount with at most 4 decimal places, within the supported range.`,
    );
  }
}

/**
 * Parses a billing increment, turning the refusal into a 400.
 *
 * The bounds themselves are `tierPricing.ts`'s — this only decides what a
 * refusal looks like over HTTP. **Rejected, never clamped**: silently turning
 * 3600 into 600 charges a customer at an increment nobody chose, and leaves
 * nothing on any screen saying it happened.
 */
function parseIncrement(value: unknown, field: string): number | null {
  if (value === null) return null;

  try {
    return parseBillingIncrement(value as number);
  } catch (err) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `${field}: ${err instanceof RangeError ? err.message : 'not a valid billing increment.'}`,
    );
  }
}

const price = (value: bigint | null): string | null =>
  value === null ? null : toDisplayCredits(value);

function serializeTierForStaff(tier: Tier & { _count?: { accounts: number } }) {
  return {
    id: tier.id,
    slug: tier.slug,
    name: tier.name,
    status: tier.status,
    // Null, never "0". An unpriced tier cannot be used at all, and a zero
    // would read as a tier that is free.
    default_price_credits_per_min: price(tier.defaultPriceCreditsPerMin),
    // Null, and rendered by the console as "per second" rather than as blank.
    // Per-second billing is the increment of one, not the absence of billing.
    billing_increment_secs: tier.billingIncrementSecs,
    is_default: tier.isDefault,
    account_count: tier._count?.accounts ?? 0,
    last_synced_at: tier.lastSyncedAt,
  };
}

/**
 * One assigned tier, with both prices and the rate that wins.
 *
 * All three are emitted because this is the staff surface, where the point is
 * to see *why* a rate is what it is. The customer's plan card emits only the
 * resolved rate — what anyone else pays is not on their page.
 */
function serializeAssignment(tier: Tier, override: bigint | null, incrementOverride: number | null) {
  const resolved = override ?? tier.defaultPriceCreditsPerMin;

  return {
    tier_id: tier.id,
    slug: tier.slug,
    name: tier.name,
    status: tier.status,
    price_credits_per_min: price(override),
    default_price_credits_per_min: price(tier.defaultPriceCreditsPerMin),
    // Null when neither is set: the tier cannot be priced, so it cannot be
    // used. Saying so is the point — a zero here is a rate nobody chose.
    rate_credits_per_min: price(resolved ?? null),
    billing_increment_secs: incrementOverride,
    default_billing_increment_secs: tier.billingIncrementSecs,
    /**
     * What this account is actually billed in, the same walk `resolveTierPricing`
     * makes. Unlike the rate beside it this is never null: the chain bottoms
     * out at one second, because per-second billing is an increment rather
     * than an absence of one.
     */
    increment_secs:
      incrementOverride ?? tier.billingIncrementSecs ?? BILLING_INCREMENT_MIN,
  };
}

/** The fallback row, with everything needed to explain an account that holds
 *  no tier of its own. */
const serializeDefaultTier = (tier: Tier) => ({
  id: tier.id,
  slug: tier.slug,
  name: tier.name,
  rate_credits_per_min: price(tier.defaultPriceCreditsPerMin),
  billing_increment_secs: tier.billingIncrementSecs,
});

// Registered before `/tiers/:tierId`, or Express matches the literal "sync" as
// a tier id.
adminTierRoutes.post(
  '/tiers/sync',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await syncVoiceTiers() });
  }),
);

adminTierRoutes.get(
  '/tiers',
  asyncHandler(async (_req, res) => {
    // The catalogue is two or three rows; `_count` rather than a loaded
    // relation regardless, because the count grows with the customer base
    // even when the catalogue does not.
    const tiers = await prisma.tier.findMany({
      include: { _count: { select: { accounts: true } } },
      orderBy: [{ status: 'asc' }, { slug: 'asc' }],
    });

    res.json({ success: true, data: tiers.map(serializeTierForStaff) });
  }),
);

/**
 * Moves the platform default.
 *
 * Registered before `/tiers/:tierId` for the same reason `sync` is.
 *
 * One transaction: clear the current default, set the new one. The partial
 * unique index (`... WHERE "isDefault"`) is what makes two concurrent moves
 * unable to both land — this transaction is how the intended one succeeds
 * rather than colliding with itself.
 */
adminTierRoutes.patch(
  '/tiers/default',
  asyncHandler(async (req, res) => {
    const { tierId } = parseBody(defaultTierSchema, req.body);

    const tier = await prisma.tier.findUnique({ where: { id: tierId } });
    if (!tier) throw new ApiError(404, 'NOT_FOUND', 'Tier not found.');

    /**
     * The default tier is the one that prices every account nobody priced
     * explicitly. An unpriced or retired tier in that slot makes the fallback
     * unreachable for exactly the population it exists to serve — which shows
     * up as an empty voice picker for every new customer.
     *
     * A deliberate 0 passes: zero is a price somebody set.
     */
    if (tier.defaultPriceCreditsPerMin === null || tier.status !== 'ACTIVE') {
      throw new ApiError(
        409,
        'TIER_NOT_PRICEABLE',
        tier.status !== 'ACTIVE'
          ? 'That tier is no longer offered by the platform, so it cannot be the default.'
          : 'Set a list price on that tier before making it the default — it is what prices every account with no assignment of its own.',
      );
    }

    await prisma.$transaction([
      prisma.tier.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
      prisma.tier.update({ where: { id: tier.id }, data: { isDefault: true } }),
    ]);

    const updated = await prisma.tier.findUniqueOrThrow({
      where: { id: tier.id },
      include: { _count: { select: { accounts: true } } },
    });

    res.json({ success: true, data: serializeTierForStaff(updated) });
  }),
);

/**
 * Sets a tier's list price.
 *
 * Deliberately reaches every account holding the tier that has no price of its
 * own — unlike the DID catalog price, which never touches an existing rental.
 * The difference is that a rental captured a price the customer agreed to at a
 * moment in time, while a tier rate is a standing rate on a running service.
 * An account that must not move is given its own `priceCreditsPerMin`.
 */
adminTierRoutes.patch(
  '/tiers/:tierId',
  asyncHandler(async (req, res) => {
    const body = parseBody(tierPatchSchema, req.body);

    // Parsed before anything is looked up, so a malformed value is a 400 with
    // nothing written. `undefined` reaches Prisma as "leave this column", which
    // is exactly what an omitted key means here.
    const data = {
      ...(body.defaultPriceCreditsPerMin === undefined
        ? {}
        : {
            defaultPriceCreditsPerMin:
              body.defaultPriceCreditsPerMin === null
                ? null
                : parsePrice(body.defaultPriceCreditsPerMin, 'defaultPriceCreditsPerMin'),
          }),
      ...(body.billingIncrementSecs === undefined
        ? {}
        : { billingIncrementSecs: parseIncrement(body.billingIncrementSecs, 'billingIncrementSecs') }),
    };

    const tier = await prisma.tier.findUnique({ where: { id: req.params.tierId } });
    if (!tier) throw new ApiError(404, 'NOT_FOUND', 'Tier not found.');

    const updated = await prisma.tier.update({
      where: { id: tier.id },
      data,
      include: { _count: { select: { accounts: true } } },
    });

    res.json({ success: true, data: serializeTierForStaff(updated) });
  }),
);

/** The catalogue row an account with no assignments is treated as holding. */
async function defaultTier() {
  return prisma.tier.findFirst({ where: { isDefault: true, status: 'ACTIVE' } });
}

adminTierRoutes.get(
  '/accounts/:accountId/tiers',
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({ where: { id: req.params.accountId } });
    if (!account) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');

    const [rows, fallback] = await Promise.all([
      prisma.accountTier.findMany({
        where: { accountId: account.id },
        include: { tier: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      defaultTier(),
    ]);

    res.json({
      success: true,
      data: {
        tiers: rows.map((row) =>
          serializeAssignment(row.tier, row.priceCreditsPerMin, row.billingIncrementSecs),
        ),
        /**
         * Named rather than inferred. An empty `tiers` means this account is
         * on the default, and a console that could not say which tier that is
         * would leave the operator to guess. Null when none is set, which is
         * a real state and one worth seeing.
         */
        default_tier: fallback ? serializeDefaultTier(fallback) : null,
      },
    });
  }),
);

/**
 * Replaces an account's whole set of tier assignments.
 *
 * **Validate everything, then write.** A body naming one good tier and one
 * unknown one must leave the account exactly as it was: a half-applied plan is
 * a plan nobody chose, and the operator cannot tell from the error which half
 * landed.
 */
adminTierRoutes.put(
  '/accounts/:accountId/tiers',
  asyncHandler(async (req, res) => {
    const { tiers } = parseBody(assignmentSchema, req.body);

    const account = await prisma.account.findUnique({ where: { id: req.params.accountId } });
    if (!account) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');

    // A duplicate is refused rather than resolved last-one-wins: the two rows
    // carry different prices, and silently picking one writes a rate the
    // operator did not choose.
    const ids = tiers.map((row) => row.tierId);
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A tier may appear only once in the set.');
    }

    // Parsed before anything is looked up, so a malformed price is a 400 with
    // nothing written.
    const parsed = tiers.map((row) => ({
      tierId: row.tierId,
      priceCreditsPerMin:
        row.priceCreditsPerMin === undefined || row.priceCreditsPerMin === null
          ? null
          : parsePrice(row.priceCreditsPerMin, 'priceCreditsPerMin'),
      // Absent and null are the same intention here — "whatever the tier
      // says" — because this is a whole-set replace and a row the form did
      // not fill in is a row with no override.
      billingIncrementSecs:
        row.billingIncrementSecs === undefined || row.billingIncrementSecs === null
          ? null
          : parseIncrement(row.billingIncrementSecs, 'billingIncrementSecs'),
    }));

    const found = await prisma.tier.findMany({ where: { id: { in: ids } } });

    if (found.length !== ids.length) {
      throw new ApiError(404, 'NOT_FOUND', 'One of those tiers does not exist.');
    }

    const retired = found.find((tier) => tier.status !== 'ACTIVE');
    if (retired) {
      throw new ApiError(
        409,
        'TIER_NOT_ASSIGNABLE',
        `"${retired.name}" is no longer offered by the platform, so it cannot be assigned. ` +
          'Accounts already holding it keep it.',
      );
    }

    // One transaction: what is not in the body goes, what is in it is upserted.
    // Upsert rather than delete-all-then-create, so a resubmitted assignment
    // keeps its `createdAt` — when an account was put on a tier is a fact, and
    // saving the form without changing that row must not rewrite it.
    await prisma.$transaction([
      prisma.accountTier.deleteMany({
        where: { accountId: account.id, ...(ids.length ? { tierId: { notIn: ids } } : {}) },
      }),
      ...parsed.map((row) =>
        prisma.accountTier.upsert({
          where: { accountId_tierId: { accountId: account.id, tierId: row.tierId } },
          create: {
            accountId: account.id,
            tierId: row.tierId,
            priceCreditsPerMin: row.priceCreditsPerMin,
            billingIncrementSecs: row.billingIncrementSecs,
          },
          update: {
            priceCreditsPerMin: row.priceCreditsPerMin,
            billingIncrementSecs: row.billingIncrementSecs,
          },
        }),
      ),
    ]);

    const [rows, fallback] = await Promise.all([
      prisma.accountTier.findMany({
        where: { accountId: account.id },
        include: { tier: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      defaultTier(),
    ]);

    res.json({
      success: true,
      data: {
        tiers: rows.map((row) =>
          serializeAssignment(row.tier, row.priceCreditsPerMin, row.billingIncrementSecs),
        ),
        default_tier: fallback ? serializeDefaultTier(fallback) : null,
      },
    });
  }),
);
