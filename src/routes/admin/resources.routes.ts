import { Router } from 'express';
import { z } from 'zod';
import type { Workspace, WorkspaceResource } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { reassignResource, unmapResource } from '../../lib/workspaceResource.js';

/**
 * Staff view of the pooled resources.
 *
 * Documents, dictionaries and functions map themselves when a workspace
 * creates one, so these endpoints are mostly a way to see and correct that.
 * **Tool connections are different**: connecting one is an OAuth flow that
 * happens outside this platform, so a workspace can never map one for itself
 * and this is the only route by which a connection becomes visible to anybody
 * — exactly as agent assignment is for agents.
 */
export const adminResourceRoutes: Router = Router();

adminResourceRoutes.use(requireStaffToken);

const KINDS = ['DOCUMENT', 'DICTIONARY', 'FUNCTION', 'CONNECTION'] as const;

/** Named explicitly rather than accepted as free text: a kind outside this set
 *  would produce a mapping nothing ever reads, which looks like it worked. */
const kindSchema = z.enum(KINDS);

/** One page of the staff listing. Deliberately small — this is an operator
 *  tool, and a shorter page is a faster one to read as well as to fetch. */
const PAGE_SIZE = 100;

const listQuerySchema = z.object({
  kind: kindSchema.optional(),
  /** The `next_cursor` from a previous page. */
  cursor: z.string().min(1).max(64).optional(),
});

/**
 * `null` means "return this resource to the pool" and must be stated. Treating
 * a missing field as null would let a malformed request un-share a resource,
 * the same hazard the agent assignment endpoint guards against.
 */
const assignmentSchema = z.object({
  workspaceId: z.string().min(1).nullable(),
});

function serializeForStaff(resource: WorkspaceResource & { workspace: Workspace }) {
  return {
    kind: resource.kind,
    external_id: resource.externalId,
    name: resource.name,
    workspace: {
      id: resource.workspace.id,
      name: resource.workspace.name,
      slug: resource.workspace.slug,
    },
    created_at: resource.createdAt,
  };
}

adminResourceRoutes.get(
  '/resources',
  asyncHandler(async (req, res) => {
    const { kind, cursor } = parseBody(listQuerySchema, req.query);

    // Bounded. This grows with every dictionary, function, document and
    // connection every workspace owns, and an unbounded `findMany` with a join
    // is a page that works until the day it does not.
    const resources = await prisma.workspaceResource.findMany({
      where: kind ? { kind } : {},
      include: { workspace: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = resources.slice(0, PAGE_SIZE);

    res.json({
      success: true,
      data: page.map(serializeForStaff),
      // The id to pass back as `cursor`, or null at the end. Absent rather
      // than a page count: counting the table to render a footer is the other
      // query that gets slower every day.
      meta: { next_cursor: resources.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null },
    });
  }),
);

adminResourceRoutes.post(
  '/resources/:kind/:externalId/assignment',
  asyncHandler(async (req, res) => {
    const kind = kindSchema.safeParse(req.params.kind);
    if (!kind.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `kind must be one of: ${KINDS.join(', ')}.`,
      );
    }

    const { workspaceId } = parseBody(assignmentSchema, req.body);
    const { externalId } = req.params;

    if (workspaceId === null) {
      await unmapResource(kind.data, externalId);
      res.json({ success: true, data: { kind: kind.data, external_id: externalId, workspace: null } });
      return;
    }

    // Checked before the write so a typo in the workspace id fails loudly
    // rather than being rejected by the foreign key as a 500.
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) {
      throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
    }

    // A resource maps to at most one workspace by construction, so
    // reassignment is a plain overwrite and needs no unlink step.
    const resource = await reassignResource(kind.data, externalId, workspaceId);

    res.json({ success: true, data: serializeForStaff({ ...resource, workspace }) });
  }),
);
