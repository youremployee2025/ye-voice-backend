import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { campaignInWorkspace } from '../lib/campaign.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';

/**
 * One campaign's do-not-call list.
 *
 * Rows here are written by the dialer, off a language model's answer: the bot
 * judges at the end of a conversation that the person asked not to be called
 * again and returns `stop`, and the resolution lists the number. That is
 * read generously on purpose — striking somebody off a list they never asked
 * to leave is the cheaper mistake — but the consequence is not small: the row
 * is permanent, the claim refuses the number in every lane, and the sweep
 * settles every matching contact `EXCLUDED`. Read-only automation with those
 * consequences and no surface to inspect or undo it means one hallucinated
 * verdict bars a number for the life of the campaign, with SQL against
 * production as the only remedy. This is that surface.
 *
 * **The list belongs to the campaign, not the workspace.** Somebody who says
 * "stop calling me about this" has opted out of the campaign they were called
 * about; a second campaign the same workspace runs for a different reason —
 * a renewal reminder to an existing customer, say — is a different
 * conversation and asks its own list. So the routes sit under a campaign,
 * a row lists a number for that campaign only, and the same phone on another
 * campaign of the same workspace is neither shown here nor removable here.
 *
 * **Unlisting does not re-open contacts already settled.** A number removed
 * here is dialable again by this campaign — the claim reads this table on
 * every pass — but the `CampaignContact` rows the exclusion already settled
 * stay `EXCLUDED`, which is the same word an operator's own remove writes and
 * is not this route's to reverse. Putting a person back on a running campaign
 * is the top-up's job, and it is a decision somebody should make rather than a
 * side effect of correcting a list.
 */
export const doNotCallRoutes: Router = Router();

/**
 * Offset paging, deliberately, and never a Prisma `cursor`.
 *
 * A cursor is resolved before the `where` is applied, so a cursor id from one
 * campaign positions a page inside another's rows — an existence oracle over
 * a table of real phone numbers, which is the last table in this service that
 * should have one. Offsets also let the page say "1,284 numbers", which is the
 * first thing an operator wants to know about a list nobody chose to build.
 */
const listSchema = z.object({
  /** Matched against the phone as typed. A number is the only thing anybody
   *  searches this list for; the reason is machine-written boilerplate. */
  search: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

doNotCallRoutes.get(
  '/:workspaceId/campaigns/:campaignId/do-not-call',
  requireAuth,
  // Member-read, like the contact library it is the counterpart of: a member
  // who can see the campaign needs to be able to see why a number stopped
  // being dialled, and the list holds no more than the contacts already do.
  requireMembership(),
  asyncHandler(async (req, res) => {
    // The campaign is resolved against the workspace FIRST, so an id from
    // another workspace is a 404 before a single row is read — the same rule
    // every other campaign-scoped route here follows, and what makes the
    // `campaignId` below safe to trust as a filter.
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const { search, limit, offset } = parseBody(listSchema, req.query);

    const where = {
      campaignId: campaign.id,
      ...(search ? { phone: { contains: search } } : {}),
    };

    const [numbers, total] = await Promise.all([
      prisma.doNotCall.findMany({
        where,
        // The id rides along because the whole of a campaign's opt-outs can be
        // written inside one second, and offset paging over an unstable sort
        // shows a row on two pages while hiding another.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      prisma.doNotCall.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        numbers: numbers.map((row) => ({
          id: row.id,
          phone: row.phone,
          reason: row.reason,
          // The contact whose call put the number here, for the journey link.
          // A plain pointer, never a join: the opt-out outlives the row it
          // came from, so this is often an id nothing answers to any more.
          sourceCampaignContactId: row.sourceCampaignContactId,
          createdAt: row.createdAt,
        })),
        total,
        limit,
        offset,
      },
    });
  }),
);

doNotCallRoutes.delete(
  '/:workspaceId/campaigns/:campaignId/do-not-call/:id',
  requireAuth,
  // ADMIN, like every other destructive workspace operation here: this one
  // puts a real person's phone back on a calling list, which is the direction
  // that cannot be undone by dialing them again.
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    // Scoped in the lookup, never checked after the fact — the rule every
    // other resource in this service follows. A row from another campaign,
    // this workspace's own included, finds nothing and 404s with the message
    // an id that never existed gets, so this cannot be asked whether a number
    // is on somebody else's list.
    const row = await prisma.doNotCall.findFirst({
      where: { id: req.params.id!, campaignId: campaign.id },
    });

    if (!row) throw new ApiError(404, 'NOT_FOUND', 'That number is not on this list.');

    // Guarded on the id it was found by, so two clicks are a 200 and a 404
    // rather than a second delete of a row a third party has since written.
    const removed = await prisma.doNotCall.deleteMany({ where: { id: row.id } });

    if (removed.count === 0) {
      throw new ApiError(404, 'NOT_FOUND', 'That number is not on this list.');
    }

    res.json({ success: true, data: { id: row.id, phone: row.phone } });
  }),
);
