import { Router } from 'express';
import type { NotificationScope, WorkspaceRole } from '@prisma/client';
import { z } from 'zod';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireMembership, roleOf, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';

export const notificationRoutes: Router = Router();

/**
 * The single place that decides what a role may see.
 *
 * Scope is an access rule, not a display hint: the obvious implementation —
 * fetch everything and hide some of it in the browser — ships the rows either
 * way. So this feeds the `where` clause of every query here, and there is one
 * copy of it rather than one per handler for somebody to forget to update.
 *
 * The owner needs no special case: the owner holds an ADMIN WorkspaceMember
 * row, which is what the membership middleware resolves.
 */
function visibleScopes(role: WorkspaceRole): NotificationScope[] {
  return role === 'ADMIN' ? ['ALL_MEMBERS', 'ADMINS_ONLY'] : ['ALL_MEMBERS'];
}

const listQuerySchema = z.object({
  // An absent cursor and an empty one mean the same thing — page one. A client
  // that builds `&cursor=${nextCursor ?? ''}` should get the first page, not a
  // validation error for faithfully reporting that it has no cursor.
  cursor: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

notificationRoutes.get(
  '/:workspaceId/notifications',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);
    const { cursor, limit } = parseBody(listQuerySchema, req.query);

    const scopes = visibleScopes(roleOf(req));

    // Resolved through the same `where` as the page itself, and deliberately
    // NOT via Prisma's `cursor`. Prisma resolves `cursor` with an unfiltered
    // subquery — `SELECT "createdAt" FROM "Notification" WHERE id = $1` with no
    // workspace and no scope predicate — so a cursor naming an ADMINS_ONLY row,
    // a row in another workspace, or no row at all still steers this query.
    // That answers "does this id exist, and where does it sit in time" for rows
    // the caller may not see, which is the exact fact the mark-read endpoint
    // below goes out of its way to withhold. Worse, `skip: 1` is unconditional,
    // so an out-of-set cursor silently drops a row the caller never saw.
    const anchor = cursor
      ? await prisma.notification.findFirst({
          where: { id: cursor, workspaceId: workspace.id, scope: { in: scopes } },
          select: { id: true, createdAt: true },
        })
      : null;

    // A cursor that does not name a row this caller can see is not a page —
    // it is a malformed request, and answering it with an empty page would be
    // indistinguishable from the end of the feed. Every id the caller could
    // legitimately hold came from this endpoint's own `nextCursor`.
    if (cursor && !anchor) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown notification cursor.');
    }

    const rows = await prisma.notification.findMany({
      where: {
        workspaceId: workspace.id,
        scope: { in: scopes },
        // Keyset on the same tuple the ordering uses, so the comparison is
        // total and a page can neither repeat nor skip a row.
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      // This caller's read row and nobody else's, so the client never has to
      // reconcile two lists to answer "have I seen this".
      include: { reads: { where: { accountId: account.id } } },
      // `id` breaks the tie: two rows written in the same millisecond would
      // otherwise page unstably, repeating one and skipping another.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // the extra row tells us whether another page exists
    });

    const page = rows.slice(0, limit);

    res.json({
      success: true,
      data: {
        notifications: page.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          href: row.href,
          createdAt: row.createdAt,
          read: row.reads.length > 0,
          readAt: row.reads[0]?.readAt ?? null,
        })),
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      },
    });
  }),
);

/**
 * The badge. This is the only endpoint the dashboard polls, so it does no
 * joins and returns no rows: `reads: { none: … }` is a NOT EXISTS against the
 * (notificationId, accountId) unique index.
 */
notificationRoutes.get(
  '/:workspaceId/notifications/unread-count',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);

    const count = await prisma.notification.count({
      where: {
        workspaceId: workspace.id,
        scope: { in: visibleScopes(roleOf(req)) },
        reads: { none: { accountId: account.id } },
      },
    });

    res.json({ success: true, data: { count } });
  }),
);

const readSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

/**
 * Moves this caller's read state forward over the ids they name.
 *
 * The ids are **filtered** to what the caller can see rather than validated
 * one at a time. A 404 on an invisible id would confirm that the id names
 * something real in this workspace — the exact fact scoping exists to
 * withhold — and a 400 would say the same thing in a different tone. Filtering
 * also makes the endpoint honest about what it is: a request to advance read
 * state, whose result is "your read state is now at least this far", not "each
 * of these ids was valid". `marked` is what the database actually inserted, so
 * a caller who cares can still notice the difference.
 */
notificationRoutes.post(
  '/:workspaceId/notifications/read',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);
    const { ids } = parseBody(readSchema, req.body);

    const visible = await prisma.notification.findMany({
      where: {
        id: { in: ids },
        workspaceId: workspace.id,
        scope: { in: visibleScopes(roleOf(req)) },
      },
      select: { id: true },
    });

    // Idempotency lives at the unique index, not in a read-then-write here,
    // which two concurrent clicks would race.
    const { count: marked } = await prisma.notificationRead.createMany({
      data: visible.map((row) => ({ notificationId: row.id, accountId: account.id })),
      skipDuplicates: true,
    });

    res.json({ success: true, data: { marked } });
  }),
);

notificationRoutes.post(
  '/:workspaceId/notifications/read-all',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);

    // One set-based statement rather than "read every unread id into Node, then
    // insert them back". Measured at 30k unread rows, this is the same wall
    // clock as the two-statement version (~610 ms, nearly all of it foreign-key
    // triggers and index maintenance, which either way pays) — the win is that
    // no id is ever materialised in this process and it is one round trip
    // instead of two, not that it is faster.
    //
    // What this does NOT fix: the work is still linear in how much the caller
    // has left unread, and `Notification` has no retention policy, so the
    // anti-join scan grows with the age of the workspace. Any member can call
    // this repeatedly. Bounding it properly needs either a retention window or
    // a read watermark, both of which are product decisions; this is recorded
    // in the design doc rather than guessed at here.
    //
    // `id` is generated in SQL because the column's `cuid()` default is a
    // Prisma-level one, not a database default, and there is no row-by-row
    // round trip here to apply it. The column is a surrogate key that no
    // response ever exposes, so its format is free.
    const scopes = visibleScopes(roleOf(req));

    const marked = await prisma.$executeRaw`
      INSERT INTO "NotificationRead" ("id", "notificationId", "accountId")
      SELECT gen_random_uuid()::text, n."id", ${account.id}
      FROM "Notification" n
      WHERE n."workspaceId" = ${workspace.id}
        AND n."scope" = ANY(${scopes}::"NotificationScope"[])
        AND NOT EXISTS (
          SELECT 1 FROM "NotificationRead" r
          WHERE r."notificationId" = n."id" AND r."accountId" = ${account.id}
        )
      ON CONFLICT ("notificationId", "accountId") DO NOTHING
    `;

    res.json({ success: true, data: { marked } });
  }),
);
