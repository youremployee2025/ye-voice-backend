import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { paginated, parsePagination } from '../../lib/pagination.js';
import {
  serializeAgentForStaff,
  serializeCampaignForStaff,
  serializeMemberForStaff,
  serializeWorkspaceForStaff,
} from '../../lib/serialize.js';

/**
 * Staff view of workspaces.
 *
 * Read-only throughout: this slice answers "who is in this workspace and what
 * do they have", and every way of changing that already has a home — agent
 * assignment on the pool routes, membership in the workspace's own routes.
 */
export const adminWorkspaceRoutes: Router = Router();

adminWorkspaceRoutes.use(requireStaffToken);

/**
 * How many rows of each relation the detail view carries.
 *
 * The listing above counts in the database precisely so a page costs what a
 * page costs; a detail view that then loads every member, every agent and
 * every campaign of the largest workspace on the platform gives that back. The
 * counts beside these lists come from `_count` and are the true totals, so a
 * reader can always tell a capped list from a complete one.
 */
const DETAIL_ROWS = 100;

/**
 * The search a picker types into.
 *
 * Bounded rather than unbounded because the value reaches the database as a
 * `LIKE` pattern; nothing a person searches a workspace by is longer than
 * this. Empty is allowed, unlike the accounts listing beside it: this
 * parameter backs a search box that a picker mounts with, and a box somebody
 * has just cleared must answer the whole list rather than a 400.
 */
const searchSchema = z.object({ q: z.string().trim().max(200).optional() });

adminWorkspaceRoutes.get(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { q } = parseBody(searchSchema, { q: req.query.q });

    /*
     * Name or slug, because staff hold a workspace by either — the name is
     * what the customer calls it, the slug is what the URL they were sent
     * says. `contains`, matching the accounts listing: a remembered fragment
     * is at least as common as a beginning.
     *
     * Deliberately no `deletedAt` filter. This is the staff surface, and a
     * deleted workspace that simply stops appearing reads as one that never
     * existed; the campaign-transfer service refuses a deleted target with a
     * typed error of its own, so the refusal is already somebody's job and it
     * is one a staff member can act on.
     */
    const where: Prisma.WorkspaceWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { slug: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};

    const [workspaces, total] = await prisma.$transaction([
      prisma.workspace.findMany({
        where,
        include: {
          owner: true,
          // Counted in the database rather than by loading the rows: a listing
          // that measures `.length` on every workspace's agents grows with the
          // platform instead of with the page.
          _count: { select: { members: true, agents: true, campaigns: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      // The same `where` as the page above it, not a bare count: a picker told
      // "1 of 340" while holding one matching row pages straight into
      // emptiness, and the number it trusts is this one.
      prisma.workspace.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(workspaces.map(serializeWorkspaceForStaff), total, pagination),
    });
  }),
);

adminWorkspaceRoutes.get(
  '/workspaces/:workspaceId',
  asyncHandler(async (req, res) => {
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.workspaceId },
      include: {
        owner: true,
        _count: { select: { members: true, agents: true, campaigns: true } },
        members: {
          include: { account: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: DETAIL_ROWS,
        },
        agents: { orderBy: [{ name: 'asc' }, { id: 'asc' }], take: DETAIL_ROWS },
        campaigns: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: DETAIL_ROWS },
      },
    });

    if (!workspace) {
      throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
    }

    res.json({
      success: true,
      data: {
        ...serializeWorkspaceForStaff(workspace),
        members: workspace.members.map(serializeMemberForStaff),
        agents: workspace.agents.map((agent) => serializeAgentForStaff(agent)),
        // Name and status only: this is an inventory of what the workspace
        // runs, not a console for running it.
        campaigns: workspace.campaigns.map(serializeCampaignForStaff),
      },
    });
  }),
);
