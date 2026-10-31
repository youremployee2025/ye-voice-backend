import { Router } from 'express';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { serializeAccount, serializeInvite, serializeMembership } from '../lib/serialize.js';

export const meRoutes: Router = Router();

/** Bootstrap payload the dashboard loads immediately after sign-in. */
meRoutes.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountOf(req);

    // Both halves filter out deleted workspaces. This payload is the
    // switcher's source of truth, so a workspace listed here is one the
    // dashboard offers to open and every scoped route then refuses — and an
    // account whose last workspace was deleted falls into the existing
    // `/onboarding` redirect with no new code on either side. A PENDING
    // invite outlives the delete, and one shown here is one somebody would
    // accept into a workspace nobody can open.
    const [memberships, pendingInvites] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { accountId: account.id, workspace: { deletedAt: null } },
        include: { workspace: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.workspaceInvite.findMany({
        where: { email: account.email, status: 'PENDING', workspace: { deletedAt: null } },
        include: { workspace: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    res.json({
      success: true,
      data: {
        account: serializeAccount(account),
        workspaces: memberships.map((m) => serializeMembership(m.workspace, m.role, account.id)),
        pendingInvites: pendingInvites.map(serializeInvite),
      },
    });
  }),
);
