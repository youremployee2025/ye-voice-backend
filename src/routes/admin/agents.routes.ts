import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { detachForeignResources } from '../../services/agentHandover.js';
import { parseBody } from '../../lib/validate.js';
import { serializeAgentForStaff } from '../../lib/serialize.js';
import { syncAllAgents } from '../../services/agentSync.js';
import { deleteAgent } from '../../adapter/vocobase.js';

/**
 * Staff view of the agent pool.
 *
 * Every agent Vocobase knows about lives in one pool; assignment is
 * what makes it visible to a workspace. These routes are the only place an
 * assignment can change, which is why customer routes can treat `workspaceId`
 * as trustworthy.
 */
export const adminAgentRoutes: Router = Router();

adminAgentRoutes.use(requireStaffToken);

/** `?assigned=` narrows the pool; anything but true/false is a mistake worth
 *  reporting, since silently ignoring it would return the wrong list. */
const listQuerySchema = z.object({
  assigned: z.enum(['true', 'false']).optional(),
});

/**
 * The confirm token is the agent's **own upstream id**, not a boolean.
 *
 * A `{ confirm: true }` is something a misrouted script can send by accident;
 * an id can only be supplied by a caller who deliberately looked this agent
 * up. This is the one endpoint on the platform that destroys an agent, so the
 * cost of proving intent is worth it.
 */
const hardDeleteSchema = z.object({
  confirm: z.string().min(1),
});

/**
 * `null` means "return this agent to the pool" and must be stated. Treating a
 * missing field as null would let a malformed request un-share an agent.
 */
const assignmentSchema = z.object({
  workspaceId: z.string().min(1).nullable(),
});

adminAgentRoutes.get(
  '/agents',
  asyncHandler(async (req, res) => {
    const { assigned } = parseBody(listQuerySchema, req.query);

    const workspaceFilter =
      assigned === undefined ? {} : assigned === 'true' ? { not: null } : null;

    const agents = await prisma.agent.findMany({
      where: assigned === undefined ? {} : { workspaceId: workspaceFilter },
      include: { workspace: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    res.json({ success: true, data: agents.map(serializeAgentForStaff) });
  }),
);

adminAgentRoutes.post(
  '/agents/sync',
  asyncHandler(async (_req, res) => {
    const result = await syncAllAgents();

    res.json({ success: true, data: result });
  }),
);

adminAgentRoutes.post(
  '/agents/:agentId/assignment',
  asyncHandler(async (req, res) => {
    const { workspaceId } = parseBody(assignmentSchema, req.body);

    const agent = await prisma.agent.findUnique({ where: { id: req.params.agentId } });
    if (!agent) {
      throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
    }

    // Checked before the write so a typo in the workspace id fails loudly
    // rather than being rejected by the foreign key as a 500.
    if (workspaceId) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!workspace) {
        throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
      }
    }

    /**
     * The attached resources do not move with the agent, so they are detached
     * first.
     *
     * A plain overwrite is right for the *mapping* — an agent maps to at most
     * one workspace — but the dictionaries, functions and documents hanging off
     * it are partner-level and belong to whoever created them. Handing the
     * agent over without stripping them gave the incoming workspace the
     * previous one's endpoint URLs and term lists to read, and left the agent
     * answering their calls out of the previous tenant's knowledge base.
     *
     * Before the write, and fail-closed: if the detach cannot be completed the
     * agent stays where it is.
     */
    if (agent.workspaceId !== workspaceId) {
      await detachForeignResources(agent, workspaceId ?? null);
    }

    // Moving an agent out of a workspace silently strips it from that
    // workspace's campaigns: `agentId` stays valid, the foreign key sees
    // nothing, and every reader re-resolves ownership and reports the agent as
    // unavailable. Campaigns that are merely drafted can wait for staff to put
    // the agent back, but a RUNNING one has just lost the agent it was dialing
    // with and nothing re-checks after `start`.
    //
    // Counted before the write, and reported rather than refused: staff need to
    // be able to move an agent, but they should not have to discover its cost
    // from the customer.
    const orphanedRunning =
      agent.workspaceId && agent.workspaceId !== workspaceId
        ? await prisma.campaign.count({
            where: { agentId: agent.id, workspaceId: agent.workspaceId, status: 'RUNNING' },
          })
        : 0;

    // An agent maps to at most one workspace, so reassignment is a plain
    // overwrite and needs no unlink step.
    const updated = await prisma.agent.update({
      where: { id: agent.id },
      data: { workspaceId },
      include: { workspace: true },
    });

    res.json({
      success: true,
      data: { ...serializeAgentForStaff(updated), orphanedRunningCampaigns: orphanedRunning },
    });
  }),
);

/**
 * Deletes an agent upstream and drops the mirror row.
 *
 * Staff-only, and deliberately not reachable from any workspace: a workspace is
 * lent an agent and cannot know whether it is used elsewhere, so its own
 * "delete" unassigns instead.
 *
 * Order matters. Upstream goes first, and the mirror row is dropped only once
 * it succeeded — dropping it first would hide an agent that still exists in the
 * partner account, which is the one state nothing here could then find again.
 */
adminAgentRoutes.delete(
  '/agents/:agentId',
  asyncHandler(async (req, res) => {
    const { confirm } = parseBody(hardDeleteSchema, req.body);

    const agent = await prisma.agent.findUnique({ where: { id: req.params.agentId } });
    if (!agent) {
      throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
    }

    if (confirm !== agent.externalId) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        "confirm must be the agent's platform id. Nothing was deleted.",
      );
    }

    await deleteAgent(agent.externalId);

    // Campaigns carry `agentId` as a plain column with no foreign key, so
    // deleting the row leaves them pointing at an agent that no longer exists
    // — and `start` only checks that the field is set, not that it resolves.
    // Cleared in the same transaction as the delete so the two cannot diverge.
    await prisma.$transaction([
      prisma.campaign.updateMany({ where: { agentId: agent.id }, data: { agentId: null } }),
      prisma.agent.delete({ where: { id: agent.id } }),
    ]);

    res.json({ success: true, data: { deleted: true } });
  }),
);
