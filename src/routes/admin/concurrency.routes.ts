import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler, ApiError } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { resolveAccountConcurrency, IN_FLIGHT } from '../../lib/concurrency.js';
import { getConcurrency } from '../../adapter/vocobase.js';

/**
 * Allotting the platform's call capacity to accounts.
 *
 * YE buys a pool of simultaneous calls and sells slices of it, which is the
 * same shape as the DID inventory and the tier catalogue: the platform owns a
 * supply, staff decide who gets what, and a per-row null falls back to a
 * platform default.
 *
 * **Overallocation is permitted and reported, never refused.** Allotting 150
 * lines out of a pool of 100 is a legitimate operator strategy — not every
 * account dials at once, and overcommitting is how a shared resource is
 * normally sold. Refusing it would also make a staff write depend on a live
 * upstream read, so the form would stop working whenever the platform was
 * unreachable. The console states the overcommit instead, the way the billing
 * projection states a shortfall rather than blocking a rental.
 */

export const adminConcurrencyRoutes: Router = Router();

adminConcurrencyRoutes.use(requireStaffToken);

/**
 * The pool, what has been allotted out of it, and who holds what.
 *
 * Registered before any `/:id` route in this router for the usual reason:
 * Express would otherwise match `concurrency` as an id.
 */
adminConcurrencyRoutes.get(
  '/concurrency',
  asyncHandler(async (_req, res) => {
    /**
     * The pool is read live and is allowed to be unavailable.
     *
     * A failure here must not take the whole page down: staff must still be
     * able to see and change allotments when the platform is unreachable,
     * because an allotment is YE's commercial decision and does not depend on
     * the supplier answering. Reported as `null` with a reason rather than as
     * a zero, which would read as "the platform has no capacity".
     */
    let pool: { limit: number | null; active: number; remaining: number | null } | null = null;

    try {
      const upstream = await getConcurrency();
      pool = {
        limit: upstream.limit ?? null,
        active: upstream.active ?? 0,
        remaining: upstream.remaining ?? null,
      };
    } catch (err) {
      console.error('[admin] could not read the shared call pool:', err);
    }

    const accounts = await prisma.account.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        concurrencyLimit: true,
      },
      orderBy: [{ email: 'asc' }, { id: 'asc' }],
      take: 500,
    });

    // One grouped query rather than one per account: a console page must cost
    // what a page costs.
    const live = await prisma.callAttempt.groupBy({
      by: ['accountId'],
      where: IN_FLIGHT,
      _count: { _all: true },
    });

    const inFlightByAccount = new Map(live.map((row) => [row.accountId, row._count._all]));

    const rows = accounts.map((account) => ({
      id: account.id,
      email: account.email,
      name: account.name,
      // Emitted separately so the console can tell "staff set this" from
      // "falling back to the default" — the same distinction the tier page
      // draws between an account's own rate and the list price.
      concurrency_limit: account.concurrencyLimit,
      resolved_concurrency: resolveAccountConcurrency(account),
      in_flight: inFlightByAccount.get(account.id) ?? 0,
    }));

    const allotted = rows.reduce((sum, row) => sum + row.resolved_concurrency, 0);

    res.json({
      success: true,
      data: {
        pool,
        default_concurrency: env.dialerDefaultAccountConcurrency,
        allotted,
        /**
         * How far the allotments exceed the pool, or null when there is no
         * pool to compare against — either because it could not be read or
         * because the account is uncapped. Never a negative number dressed up
         * as headroom.
         */
        overcommitted:
          pool && pool.limit !== null ? Math.max(0, allotted - pool.limit) : null,
        headroom: pool && pool.limit !== null ? Math.max(0, pool.limit - allotted) : null,
        accounts: rows,
      },
    });
  }),
);

const concurrencySchema = z.object({
  /**
   * `null` restores the platform default. Required rather than optional, so a
   * malformed body cannot silently leave an allotment where it was while the
   * operator believes they changed it — the same rule the agent assignment
   * route holds about an omitted `workspaceId`.
   */
  concurrencyLimit: z.number().int().min(0).max(10_000).nullable(),
});

adminConcurrencyRoutes.patch(
  '/accounts/:accountId/concurrency',
  asyncHandler(async (req, res) => {
    const body = parseBody(concurrencySchema, req.body);

    const account = await prisma.account.findUnique({
      where: { id: req.params.accountId! },
      select: { id: true },
    });

    if (!account) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');

    const updated = await prisma.account.update({
      where: { id: account.id },
      data: { concurrencyLimit: body.concurrencyLimit },
      select: { id: true, email: true, concurrencyLimit: true },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        email: updated.email,
        concurrency_limit: updated.concurrencyLimit,
        resolved_concurrency: resolveAccountConcurrency(updated),
      },
    });
  }),
);
