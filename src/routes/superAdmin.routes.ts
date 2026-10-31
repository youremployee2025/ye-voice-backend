import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireSuperAdmin } from '../middleware/superAdmin.js';
import { asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { paginated, parsePagination } from '../lib/pagination.js';
import { parseBody } from '../lib/validate.js';

/**
 * The super admin's own surface: what a flagged account can reach that a
 * customer cannot. Today that is one listing, the search behind the
 * dashboard's "All accounts…" picker.
 */
export const superAdminRoutes: Router = Router();

superAdminRoutes.use(requireAuth, requireSuperAdmin());

const searchSchema = z.object({ q: z.string().trim().max(200).optional() });

superAdminRoutes.get(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { q } = parseBody(searchSchema, { q: req.query.q });

    const where: Prisma.WorkspaceWhereInput = {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q, mode: 'insensitive' } },
              { owner: { email: { contains: q, mode: 'insensitive' } } },
              { owner: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [workspaces, total] = await prisma.$transaction([
      prisma.workspace.findMany({
        where,
        include: {
          owner: { select: { id: true, email: true, name: true } },
          // Only this caller's row, so `isMember` is one boolean per workspace
          // rather than a second query.
          members: { where: { accountId: account.id }, select: { id: true } },
        },
        orderBy: [{ owner: { email: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.workspace.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(
        workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          color: w.color,
          createdAt: w.createdAt,
          account: w.owner,
          isMember: w.members.length > 0,
        })),
        total,
        pagination,
      ),
    });
  }),
);
