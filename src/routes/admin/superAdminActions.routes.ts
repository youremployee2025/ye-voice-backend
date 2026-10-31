import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { paginated, parsePagination } from '../../lib/pagination.js';
import { serializeSuperAdminAction } from '../../lib/serialize.js';

/** Read-only: what the super admins have done, newest first. */
export const adminSuperAdminActionRoutes: Router = Router();

adminSuperAdminActionRoutes.use(requireStaffToken);

const filterSchema = z.object({
  accountId: z.string().min(1).optional(),
  subjectAccountId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  q: z.string().trim().max(200).optional(),
});

adminSuperAdminActionRoutes.get(
  '/super-admin-actions',
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { accountId, subjectAccountId, workspaceId, q } = parseBody(filterSchema, {
      accountId: req.query.accountId,
      subjectAccountId: req.query.subjectAccountId,
      workspaceId: req.query.workspaceId,
      q: req.query.q,
    });

    // `q` narrows within the id filters rather than replacing them, so the
    // console's search box works on top of a page already scoped to one
    // account or workspace.
    const where: Prisma.SuperAdminActionWhereInput = {
      // `accountId` is who acted; `subjectAccountId` is who a grant was about.
      // They are separate filters because they are separate questions, and
      // answering "what did this account do" with a grant it merely received
      // is the wrong answer to the one an incident review is asking.
      ...(accountId ? { accountId } : {}),
      ...(subjectAccountId ? { subjectAccountId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(q
        ? {
            OR: [
              { account: { email: { contains: q, mode: 'insensitive' } } },
              { subjectAccount: { email: { contains: q, mode: 'insensitive' } } },
              { workspace: { name: { contains: q, mode: 'insensitive' } } },
              // The console's "what" column is `method path`, and `path` is
              // the only field naming which customer resource was touched.
              // Without these, somebody asking "did anyone delete a campaign
              // through the bypass" searches the one column the question is
              // about and is told there were none.
              { path: { contains: q, mode: 'insensitive' } },
              { method: { equals: q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const [rows, total] = await prisma.$transaction([
      prisma.superAdminAction.findMany({
        where,
        include: {
          account: { select: { id: true, email: true, name: true } },
          subjectAccount: { select: { id: true, email: true, name: true } },
          workspace: { select: { id: true, name: true, slug: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.superAdminAction.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(rows.map(serializeSuperAdminAction), total, pagination),
    });
  }),
);
