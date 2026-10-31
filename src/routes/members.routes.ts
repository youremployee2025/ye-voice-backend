import { Router } from 'express';
import { z } from 'zod';
import { accountOf, requireAuth } from '../middleware/auth.js';
import {
  recordSuperAdminAction,
  requireMembership,
  roleOf,
  workspaceOf,
} from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { serializeInvite } from '../lib/serialize.js';
import { notify } from '../lib/notify.js';

export const memberRoutes: Router = Router();

const roleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

function serializeMember(
  member: {
    id: string;
    role: 'ADMIN' | 'MEMBER';
    createdAt: Date;
    account: { id: string; email: string; name: string | null; imageUrl: string | null };
  },
  ownerAccountId: string,
) {
  return {
    id: member.id,
    role: member.role,
    isOwner: member.account.id === ownerAccountId,
    createdAt: member.createdAt,
    account: {
      id: member.account.id,
      email: member.account.email,
      name: member.account.name,
      imageUrl: member.account.imageUrl,
    },
  };
}

/** Looks up a member within this workspace only, so ids cannot be crossed over. */
async function memberInWorkspace(workspaceId: string, memberId: string) {
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
    include: { account: true },
  });

  if (!member) {
    throw new ApiError(404, 'NOT_FOUND', 'Member not found.');
  }

  return member;
}

memberRoutes.get(
  '/:workspaceId/members',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const isAdmin = roleOf(req) === 'ADMIN';

    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { account: true },
      orderBy: { createdAt: 'asc' },
    });

    // Pending invites are management data — MEMBERs see the roster only.
    const pendingInvites = isAdmin
      ? await prisma.workspaceInvite.findMany({
          where: { workspaceId: workspace.id, status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    res.json({
      success: true,
      data: {
        members: members.map((m) => serializeMember(m, workspace.ownerAccountId)),
        pendingInvites: pendingInvites.map(serializeInvite),
      },
    });
  }),
);

memberRoutes.patch(
  '/:workspaceId/members/:memberId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const { role } = parseBody(roleSchema, req.body);
    const member = await memberInWorkspace(workspace.id, req.params.memberId!);

    // The owner is permanently ADMIN — otherwise an admin could strip their rights.
    if (member.accountId === workspace.ownerAccountId) {
      throw new ApiError(400, 'CANNOT_MODIFY_OWNER', 'The workspace owner’s role cannot be changed.');
    }

    const updated = await prisma.workspaceMember.update({
      where: { id: member.id },
      data: { role },
      include: { account: true },
    });

    // Only when it actually changed. PATCHing a member to the role they already
    // hold is a successful no-op, and a feed of "things that happened" recording
    // one contradicts what the feed claims to be — the reader would go looking
    // for a change that nobody made.
    if (member.role !== role) {
      void notify(
        workspace.id,
        'ADMINS_ONLY',
        'member.role_changed',
        `${updated.account.email}’s role changed`,
        `${updated.account.email} is now ${role === 'ADMIN' ? 'an admin' : 'a member'} of this workspace.`,
        '/settings/members',
      );
    }

    res.json({ success: true, data: serializeMember(updated, workspace.ownerAccountId) });
  }),
);

memberRoutes.delete(
  '/:workspaceId/members/:memberId',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);
    const member = await memberInWorkspace(workspace.id, req.params.memberId!);

    const isSelf = member.accountId === account.id;

    // Anyone may leave; only an ADMIN may remove somebody else.
    if (!isSelf && roleOf(req) !== 'ADMIN') {
      throw new ApiError(403, 'FORBIDDEN', 'This action requires workspace admin access.');
    }

    if (member.accountId === workspace.ownerAccountId) {
      throw new ApiError(400, 'CANNOT_MODIFY_OWNER', 'The workspace owner cannot be removed.');
    }

    await prisma.workspaceMember.delete({ where: { id: member.id } });

    // A super admin leaving is the one own-membership write that is audited.
    //
    // "Own membership wins" holds inside a request and is not a boundary
    // across two: a flagged account pinned to MEMBER here can drop its own
    // row and take the bypass on the very next request, as ADMIN and owner.
    // That is not a privilege it did not already hold platform-wide — the
    // flag grants it everywhere — so this is not refused. What mattered is
    // that the step was invisible: self-removal runs on the member path,
    // which records nothing, so the trail began mid-escalation with no
    // account of how the account got there.
    if (isSelf && account.isSuperAdmin) {
      recordSuperAdminAction({
        accountId: account.id,
        workspaceId: workspace.id,
        method: req.method,
        path: req.originalUrl.split('?')[0]!,
        status: 200,
      });
    }

    // Leaving and being removed reach this handler by the same door but are
    // not the same event, and reporting "was removed" about somebody who
    // walked out is simply wrong. `isSelf` already tells them apart.
    void notify(
      workspace.id,
      'ADMINS_ONLY',
      isSelf ? 'member.left' : 'member.removed',
      isSelf
        ? `${member.account.email} left the workspace`
        : `${member.account.email} was removed from the workspace`,
      isSelf
        ? `${member.account.email} left this workspace.`
        : `${member.account.email} was removed and no longer has access to this workspace.`,
      '/settings/members',
    );

    res.json({ success: true, data: { id: member.id, removed: true } });
  }),
);
