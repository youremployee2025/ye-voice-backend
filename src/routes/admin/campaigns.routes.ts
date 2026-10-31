import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import {
  CampaignNotFoundError,
  CampaignRunningError,
  ContactCountChangedError,
  SameWorkspaceError,
  TargetWorkspaceDeletedError,
  WorkspaceNotFoundError,
  describeCampaignTransfer,
  transferCampaign,
} from '../../services/campaignTransfer.js';

/**
 * Moving one campaign from one workspace to another — a staff write across a
 * tenancy boundary, and one with no undo.
 *
 * The service owns the rules; this file owns the HTTP. Every refusal below is
 * a typed error raised inside `describeCampaignTransfer`, which the commit
 * calls in its own transaction, so a rule that lived here instead would be a
 * rule the write does not have. Each maps to one status and one sentence —
 * the service's own — so a rule is never expressed twice and the preview and
 * the commit cannot answer the same refusal differently.
 */
export const adminCampaignRoutes: Router = Router();

// Repeated on the router as well as on the mount in `index.ts`, which is that
// file's house rule: a router that guards itself cannot be mounted somewhere
// else and arrive open. The repeat is free — the guard remembers its answer
// for the life of the request.
adminCampaignRoutes.use(requireStaffToken);

const previewSchema = z.object({ target: z.string().min(1) });

const transferSchema = z.object({
  targetWorkspaceId: z.string().min(1),
  /**
   * The figure the operator confirmed on the preview, and **required** rather
   * than defaulted. A missing count is an operator who did not review a
   * preview, and defaulting it to the live number would move whatever the
   * campaign happens to hold now — which is the one thing the drift check
   * exists to refuse.
   */
  expectedContactCount: z.number().int().min(0),
});

/** Translates a service refusal into a status and a sentence. Shared by both
 *  routes, so the preview cannot refuse something the commit allows. */
function asApiError(err: unknown): ApiError | null {
  if (err instanceof CampaignNotFoundError || err instanceof WorkspaceNotFoundError) {
    return new ApiError(404, 'NOT_FOUND', err.message);
  }
  if (
    err instanceof CampaignRunningError ||
    err instanceof SameWorkspaceError ||
    err instanceof TargetWorkspaceDeletedError
  ) {
    // One code for four refusals, carrying the service's own sentence. The
    // operator acts on the sentence — stop the campaign, wait for the call,
    // pick another target — and four codes the console renders identically buy
    // nothing but four ways to fall out of step with these messages.
    return new ApiError(409, 'CAMPAIGN_NOT_TRANSFERABLE', err.message);
  }
  if (err instanceof ContactCountChangedError) {
    // The same code an account transfer answers when its balance moved under
    // the preview: the request was well formed and the plan is simply stale.
    return new ApiError(409, 'CONCURRENT_MODIFICATION', err.message);
  }

  return null;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const mapped = asApiError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

adminCampaignRoutes.get(
  '/campaigns/:campaignId/transfer-preview',
  asyncHandler(async (req, res) => {
    const { target } = parseBody(previewSchema, req.query);

    const plan = await run(() => describeCampaignTransfer(req.params.campaignId!, target));

    res.json({ success: true, data: plan });
  }),
);

adminCampaignRoutes.post(
  '/campaigns/:campaignId/transfer',
  asyncHandler(async (req, res) => {
    const { targetWorkspaceId, expectedContactCount } = parseBody(transferSchema, req.body);

    const plan = await run(() =>
      transferCampaign(req.params.campaignId!, targetWorkspaceId, expectedContactCount),
    );

    res.json({ success: true, data: plan });
  }),
);
