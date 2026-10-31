import { Router } from 'express';
import { CampaignStatus } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { toDisplayCredits } from '../../lib/credits.js';

/**
 * The numbers the console opens on.
 *
 * Counts only — no rows, no page. Everything here is a `count`, a `groupBy` or
 * an `aggregate`, so the cost of the home screen does not grow with the
 * platform it is describing.
 */
export const adminOverviewRoutes: Router = Router();

adminOverviewRoutes.use(requireStaffToken);

/**
 * Every status, whether or not anything is in it.
 *
 * `groupBy` returns rows only for statuses that occur, and a console that
 * dropped the absent ones would read as if `PAUSED` were not a state a
 * campaign can be in. Seeding from the enum makes "none right now" and "no
 * such thing" different answers.
 */
function zeroed<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

adminOverviewRoutes.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [accounts, workspaces, agentsTotal, agentsAssigned, campaignsByStatus, creditSum] =
      await prisma.$transaction([
        prisma.account.count(),
        prisma.workspace.count(),
        prisma.agent.count(),
        prisma.agent.count({ where: { workspaceId: { not: null } } }),
        prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.account.aggregate({ _sum: { credits: true } }),
      ]);

    const campaigns = zeroed(Object.values(CampaignStatus));
    for (const row of campaignsByStatus) {
      campaigns[row.status] = row._count._all;
    }

    res.json({
      success: true,
      data: {
        accounts,
        workspaces,
        agents: {
          total: agentsTotal,
          assigned: agentsAssigned,
          // Derived rather than counted again: two queries could disagree if a
          // row were assigned between them, and a pool that does not add up is
          // worse than one that is a moment stale.
          unassigned: agentsTotal - agentsAssigned,
        },
        campaigns,
        // What the platform owes its accounts, as a display string like every
        // other credit value. `_sum` is null when there are no accounts at all.
        credits_outstanding: toDisplayCredits(creditSum._sum.credits ?? 0n),
      },
    });
  }),
);
