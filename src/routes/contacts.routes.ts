import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';

/**
 * The workspace's contact library.
 *
 * Separate from the campaign routes because the library is not a campaign's:
 * a contact outlives every campaign it is ever put on, and the picker that
 * adds contacts to one has to be able to read the whole library — including
 * the people who are on no campaign at all.
 *
 * Member-read. Nothing here writes: contacts are created by the CSV upload,
 * which is a campaign's ADMIN-gated act.
 */
export const contactRoutes: Router = Router();

/**
 * Offset paging, deliberately, and never a Prisma `cursor`.
 *
 * A cursor is resolved before the `where` is applied, so a cursor id from one
 * workspace positions a page inside another's rows — which is a boundary this
 * service holds everywhere else. The list is also one a human scrolls, so the
 * stability a cursor buys is worth less here than the ability to say "1,284
 * contacts" and jump.
 */
const listSchema = z.object({
  search: z.string().trim().min(1).optional(),
  /** The picker's own filter: hide the people already on this campaign, so the
   *  list shows what adding would actually add. */
  excludeCampaignId: z.string().trim().min(1).max(191).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

contactRoutes.get(
  '/:workspaceId/contacts',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const { search, excludeCampaignId, limit, offset } = parseBody(listSchema, req.query);

    const where = {
      workspaceId,
      // Scoped by the workspace above, so a campaign id from elsewhere excludes
      // nothing rather than reaching across.
      ...(excludeCampaignId
        ? { campaignContacts: { none: { campaignId: excludeCampaignId } } }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        // A timestamp AND the id: a bulk import stamps one instant across every
        // row of it, and offset paging over an unstable sort shows a row on two
        // pages while hiding another.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      prisma.contact.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        contacts: contacts.map((contact) => ({
          id: contact.id,
          phone: contact.phone,
          name: contact.name,
          email: contact.email,
          tags: contact.tags,
          metadata: contact.metadata,
          createdAt: contact.createdAt,
        })),
        total,
        limit,
        offset,
      },
    });
  }),
);

/**
 * Every tag in use in this workspace, once each.
 *
 * Raw SQL because the tags are a Postgres array column and `DISTINCT unnest`
 * has no equivalent in the query builder — the alternative is reading every
 * contact in the workspace into memory to build a set of a dozen strings.
 */
contactRoutes.get(
  '/:workspaceId/contacts/tags',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const rows = await prisma.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT unnest(tags) AS tag
      FROM "Contact"
      WHERE "workspaceId" = ${workspaceOf(req).id}
      ORDER BY tag ASC`;

    res.json({ success: true, data: { tags: rows.map((row) => row.tag) } });
  }),
);
