import { Router } from 'express';
import type { Prisma, InviteStatus } from '@prisma/client';
import { z } from 'zod';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { serializeInvite } from '../lib/serialize.js';
import { notify } from '../lib/notify.js';

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  role: z.enum(['ADMIN', 'MEMBER']),
});

/**
 * WorkspaceInvite is unique on (workspaceId, email, status), so a second
 * revoke/decline/accept for the same person would collide with the first.
 * Clearing the superseded row keeps the terminal transition idempotent.
 */
async function clearSupersededInvite(
  tx: Prisma.TransactionClient,
  invite: { id: string; workspaceId: string; email: string },
  status: InviteStatus,
): Promise<void> {
  await tx.workspaceInvite.deleteMany({
    where: {
      workspaceId: invite.workspaceId,
      email: invite.email,
      status,
      id: { not: invite.id },
    },
  });
}

/** Loads a PENDING invite the caller is entitled to act on. */
async function loadActionableInvite(inviteId: string, accountEmail: string) {
  const invite = await prisma.workspaceInvite.findUnique({
    where: { id: inviteId },
    include: { workspace: true },
  });

  // A deleted workspace's invites stay PENDING behind it, and accepting one
  // would mint a membership row in a workspace every scoped route refuses.
  // Folded into the same 404 as an unknown id: the invite is gone from
  // `/api/me`, so nothing offers it, and a distinct answer would tell a
  // holder the workspace once existed.
  if (!invite || invite.status !== 'PENDING' || invite.workspace.deletedAt) {
    throw new ApiError(404, 'NOT_FOUND', 'Invite not found.');
  }

  if (invite.email !== accountEmail.toLowerCase()) {
    throw new ApiError(403, 'INVITE_EMAIL_MISMATCH', 'This invite was sent to a different email.');
  }

  return invite;
}

/** Nested under /api/workspaces — managing a workspace's invites (ADMIN only). */
export const workspaceInviteRoutes: Router = Router();

workspaceInviteRoutes.post(
  '/:workspaceId/invites',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);
    const { email, role } = parseBody(inviteSchema, req.body);

    const existingMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, account: { email } },
    });

    if (existingMember) {
      throw new ApiError(409, 'ALREADY_MEMBER', 'That person is already a member of this workspace.');
    }

    const existingInvite = await prisma.workspaceInvite.findFirst({
      where: { workspaceId: workspace.id, email, status: 'PENDING' },
    });

    if (existingInvite) {
      throw new ApiError(409, 'ALREADY_INVITED', 'That email already has a pending invite.');
    }

    const invite = await prisma.workspaceInvite.create({
      data: { workspaceId: workspace.id, email, role, invitedById: account.id },
    });

    res.status(201).json({ success: true, data: serializeInvite(invite) });
  }),
);

workspaceInviteRoutes.delete(
  '/:workspaceId/invites/:inviteId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const inviteId = req.params.inviteId!;

    const invite = await prisma.workspaceInvite.findFirst({
      where: { id: inviteId, workspaceId: workspace.id, status: 'PENDING' },
    });

    if (!invite) {
      throw new ApiError(404, 'NOT_FOUND', 'Invite not found.');
    }

    const revoked = await prisma.$transaction(async (tx) => {
      await clearSupersededInvite(tx, invite, 'REVOKED');
      return tx.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'REVOKED' } });
    });

    res.json({ success: true, data: serializeInvite(revoked) });
  }),
);

/** Mounted at /api/invites — the invitee acting on their own invite. */
export const inviteRoutes: Router = Router();

inviteRoutes.post(
  '/:inviteId/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const invite = await loadActionableInvite(req.params.inviteId!, account.email);

    const alreadyMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_accountId: { workspaceId: invite.workspaceId, accountId: account.id } },
    });

    if (alreadyMember) {
      throw new ApiError(409, 'ALREADY_MEMBER', 'You are already a member of this workspace.');
    }

    await prisma.$transaction(async (tx) => {
      await clearSupersededInvite(tx, invite, 'ACCEPTED');
      await tx.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, accountId: account.id, role: invite.role },
      });
      await tx.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'ACCEPTED' } });
    });

    // After the transaction: the membership exists, so the sentence is true.
    void notify(
      invite.workspaceId,
      'ADMINS_ONLY',
      'invite.accepted',
      `${account.email} joined the workspace`,
      `${account.email} accepted an invitation and is now ${invite.role === 'ADMIN' ? 'an admin' : 'a member'}.`,
      '/settings/members',
    );

    res.json({
      success: true,
      data: {
        workspace: {
          id: invite.workspace.id,
          name: invite.workspace.name,
          slug: invite.workspace.slug,
          color: invite.workspace.color,
          role: invite.role,
          isOwner: false,
        },
      },
    });
  }),
);

inviteRoutes.post(
  '/:inviteId/decline',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const invite = await loadActionableInvite(req.params.inviteId!, account.email);

    const declined = await prisma.$transaction(async (tx) => {
      await clearSupersededInvite(tx, invite, 'DECLINED');
      return tx.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'DECLINED' } });
    });

    void notify(
      invite.workspaceId,
      'ADMINS_ONLY',
      'invite.declined',
      `${account.email} declined the invitation`,
      `${account.email} was invited to this workspace and declined.`,
      '/settings/members',
    );

    res.json({ success: true, data: serializeInvite(declined) });
  }),
);
