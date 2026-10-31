import { Router } from 'express';
import { z } from 'zod';
import { accountOf, requireAuth } from '../middleware/auth.js';
import {
  isSuperAdminHere,
  requireMembership,
  requireOwner,
  roleOf,
  workspaceOf,
} from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { IN_FLIGHT } from '../lib/concurrency.js';
import { prisma } from '../lib/prisma.js';
import { colorForSlug, uniqueSlug } from '../lib/slug.js';
import { parseBody } from '../lib/validate.js';
import { serializeMembership } from '../lib/serialize.js';

export const workspaceRoutes: Router = Router();

const nameSchema = z.object({ name: z.string().trim().min(1).max(64) });

workspaceRoutes.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const { name } = parseBody(nameSchema, req.body);

    const slug = await uniqueSlug(name);

    // The owner is also an ADMIN member, so every permission check downstream
    // is a plain membership lookup.
    const workspace = await prisma.workspace.create({
      data: {
        name,
        slug,
        color: colorForSlug(slug),
        ownerAccountId: account.id,
        members: { create: { accountId: account.id, role: 'ADMIN' } },
      },
    });

    res.status(201).json({
      success: true,
      data: serializeMembership(workspace, 'ADMIN', account.id),
    });
  }),
);

/**
 * One workspace as the caller sees it.
 *
 * Added for the super admin picker: a workspace not in `/api/me` has to be
 * fetched on its own before the dashboard can make it active. Ordinary members
 * get exactly what `/api/me` already told them.
 */
workspaceRoutes.get(
  '/:workspaceId',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    res.json({
      success: true,
      data: serializeMembership(workspaceOf(req), roleOf(req), account.id, isSuperAdminHere(req)),
    });
  }),
);

workspaceRoutes.patch(
  '/:workspaceId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const { name } = parseBody(nameSchema, req.body);

    const workspace = await prisma.workspace.update({
      where: { id: workspaceOf(req).id },
      data: { name },
    });

    res.json({
      success: true,
      data: serializeMembership(workspace, roleOf(req), account.id, isSuperAdminHere(req)),
    });
  }),
);

/**
 * Deleting a workspace — a soft delete, and the only one in this service.
 *
 * `PhoneNumber.workspace` and `CreditTransaction.workspace` are both
 * `onDelete: Restrict`, and any workspace that has ever rented a DID or placed
 * a call holds ledger rows. Clearing that for a row-level DELETE means erasing
 * the ledger or nulling its snapshot — the two things those constraints exist
 * to forbid, because a workspace's billing history must not evaporate exactly
 * when somebody wants to read it. Marking the row is what keeps them satisfied.
 *
 * Presented to the customer as permanent: no trash, no restore route, no purge
 * job. Recovery is a staff action against the database — an escape hatch for
 * support rather than a promised feature.
 *
 * **Background jobs need no `deletedAt` filter of their own, and that is a
 * consequence of the blockers below rather than luck.** The dispatcher reads
 * only RUNNING campaigns, `didRenewal` only rented DIDs, the schedule scanner
 * only `scheduledStartAt`, and inbound only fires on a claimed DID. Every one
 * of those is a precondition this route refuses on, so a deleted workspace is
 * invisible to all of them by construction — which is why loosening a blocker
 * here is never a local change: it hands one of those sweeps a workspace that
 * is gone, with nothing in the sweep to notice.
 */
workspaceRoutes.delete(
  '/:workspaceId',
  requireAuth,
  requireMembership('ADMIN'),
  requireOwner(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);

    const [phoneNumbers, liveCampaigns, inFlight, activeTestSessions] = await Promise.all([
      prisma.phoneNumber.findMany({
        where: { workspaceId: workspace.id },
        select: { id: true, did: true },
        orderBy: { did: 'asc' },
      }),
      prisma.campaign.findMany({
        // `scheduledStartAt` as well as the statuses, because a DRAFT carrying
        // a start time is a campaign that will begin dialing on its own. That
        // is the case nobody is watching: the scanner fires at 3am into a
        // workspace that is gone, and the only record is a `scheduleError`
        // nobody can open the page to read.
        where: {
          workspaceId: workspace.id,
          OR: [{ status: { in: ['RUNNING', 'SCHEDULED'] } }, { scheduledStartAt: { not: null } }],
        },
        select: { id: true, name: true, status: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      // `IN_FLIGHT` rather than a status list spelled out here: that set is
      // pinned to the platform's own `statuses_counted`, and a second copy of
      // it would eventually count different calls from the cap that enforces it.
      prisma.callAttempt.count({ where: { workspaceId: workspace.id, ...IN_FLIGHT } }),
      prisma.testSession.count({ where: { workspaceId: workspace.id, status: 'ACTIVE' } }),
    ]);

    // Checked together, reported one at a time and most-fixable first. All four
    // at once reads as a wall rather than as a next step, and the first is the
    // only one the reader can act on without waiting for something to finish.
    if (phoneNumbers.length) {
      const one = phoneNumbers.length === 1;
      throw new ApiError(
        409,
        'WORKSPACE_HAS_PHONE_NUMBERS',
        `This workspace still rents ${one ? 'a phone number' : `${phoneNumbers.length} phone numbers`}. Release ${one ? 'it' : 'them'} from Settings → Phone numbers first.`,
        { phoneNumbers },
      );
    }

    if (liveCampaigns.length) {
      const one = liveCampaigns.length === 1;
      throw new ApiError(
        409,
        'WORKSPACE_HAS_LIVE_CAMPAIGNS',
        `${one ? 'A campaign is' : `${liveCampaigns.length} campaigns are`} running or scheduled to start. Stop ${one ? 'it' : 'them'} first.`,
        { campaigns: liveCampaigns },
      );
    }

    if (inFlight) {
      const one = inFlight === 1;
      throw new ApiError(
        409,
        'WORKSPACE_HAS_CALLS_IN_FLIGHT',
        `${one ? 'A call is' : `${inFlight} calls are`} still connected. Wait for ${one ? 'it' : 'them'} to finish, then try again.`,
        { inFlight },
      );
    }

    if (activeTestSessions) {
      throw new ApiError(
        409,
        'WORKSPACE_HAS_ACTIVE_TEST_SESSION',
        'A test session is still running. End it, or wait for it to finish, then try again.',
        { activeTestSessions },
      );
    }

    // `deletedAt: null` in the guard and not just the id, so two clicks land as
    // one delete rather than moving the timestamp a second time. The second
    // request is refused by `requireMembership` before it reaches here anyway;
    // this is what holds when two arrive at once.
    await prisma.workspace.updateMany({
      where: { id: workspace.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    res.json({ success: true, data: { id: workspace.id } });
  }),
);
