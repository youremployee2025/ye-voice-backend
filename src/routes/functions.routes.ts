import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Agent } from '@prisma/client';
import {
  attachFunction,
  createFunction,
  deleteFunction,
  detachFunction,
  listFunctions,
  toggleFunction,
  updateFunction,
} from '../adapter/vocobase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { writeLimiter } from '../lib/writeLimiter.js';
import { readBoolean, readString } from '../lib/upstream.js';
import { serializeFunctions } from '../lib/serialize.js';
import {
  filterMapped,
  claimCreated,
  renameResource,
  resourceInWorkspace,
  unmapResource,
} from '../lib/workspaceResource.js';

/**
 * Callable functions.
 *
 * Partner-level upstream, like documents and dictionaries, so the library is
 * intersected rather than proxied — a function's URL names another customer's
 * internal endpoint, and its header key names describe how that endpoint is
 * authenticated.
 *
 * Defining a function and attaching one to an agent are separate acts, because
 * upstream models them separately: one definition serves any number of agents,
 * and the agent's copy carries only an enabled flag. Detaching therefore
 * leaves the definition in the library, ready to reattach.
 */
export const functionRoutes: Router = Router();

/** The platform's own constraint. Enforced here so a bad name fails with a
 *  message naming the rule rather than costing an upstream call. */
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

const HTTP_URL = /^https?:\/\//i;

const FIELD_TYPES = ['string', 'number', 'boolean', 'string[]', 'number[]', 'custom'] as const;

const schemaField = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  description: z.string().trim().min(1).max(500),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A header value is write-only. It travels in on create and update, and the
 * platform never returns it — so nothing in this file reads one back, and the
 * form above says the value is stored and not shown again rather than
 * rendering an empty box that looks like data was lost.
 */
const header = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.string().min(1).max(2_000),
});

const shared = {
  description: z.string().trim().min(1).max(500),
  url: z.string().trim().max(2_000).regex(HTTP_URL, 'url must start with http:// or https://'),
  headers: z.array(header).max(10),
  input_schema: z.array(schemaField).max(100),
  output_schema: z.array(schemaField).max(100),
  timeout: z.number().int().min(1).max(60),
  started_messages: z.array(z.string().trim().min(1).max(200)).max(5),
  error_message: z.string().trim().max(500),
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(50).regex(SNAKE_CASE, 'name must be snake_case'),
  description: shared.description,
  url: shared.url,
  headers: shared.headers.optional(),
  input_schema: shared.input_schema.optional(),
  output_schema: shared.output_schema.optional(),
  timeout: shared.timeout.optional(),
  started_messages: shared.started_messages.optional(),
  error_message: shared.error_message.optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(50).regex(SNAKE_CASE, 'name must be snake_case').optional(),
    description: shared.description.optional(),
    url: shared.url.optional(),
    headers: shared.headers.optional(),
    input_schema: shared.input_schema.optional(),
    output_schema: shared.output_schema.optional(),
    timeout: shared.timeout.optional(),
    started_messages: shared.started_messages.optional(),
    error_message: shared.error_message.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

/** Required and a real boolean: a missing one read as `false` would silently
 *  switch a working function off. */
const toggleSchema = z.object({ enabled: z.boolean() });

async function agentInWorkspace(req: Request): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: { id: req.params.agentId, workspaceId: workspaceOf(req).id },
  });

  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');

  return agent;
}

functionRoutes.get(
  '/:workspaceId/functions',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const { functions } = await listFunctions();

    const visible = await filterMapped(
      Array.isArray(functions) ? functions : [],
      'FUNCTION',
      workspaceOf(req).id,
      (row) => readString(row, ['id']),
    );

    res.json({ success: true, data: serializeFunctions(visible) });
  }),
);

functionRoutes.post(
  '/:workspaceId/functions',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);

    const created = await createFunction(body);

    const externalId = readString(created, ['id']);
    if (!externalId) {
      throw new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform did not return a function.');
    }

    await claimCreated('FUNCTION', externalId, workspaceOf(req).id, body.name);

    res.status(201).json({ success: true, data: serializeFunctions([created])[0] });
  }),
);

functionRoutes.patch(
  '/:workspaceId/functions/:functionId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(updateSchema, req.body);
    const { functionId } = req.params;

    await resourceInWorkspace('FUNCTION', functionId, workspaceOf(req).id);
    const updated = await updateFunction(functionId, body);

    if (body.name) {
      await renameResource('FUNCTION', functionId, workspaceOf(req).id, body.name);
    }

    res.json({ success: true, data: serializeFunctions([updated])[0] });
  }),
);

/**
 * Upstream first, then the mapping — unmapping a function that still exists
 * would leave it invisible to every workspace and impossible to remove.
 *
 * An upstream 404 now arrives as a 404 rather than as a 502, so deleting
 * something already gone reports what happened instead of an outage. The
 * mapping is still dropped in that case: a row pointing at nothing is worse
 * than no row.
 */
functionRoutes.delete(
  '/:workspaceId/functions/:functionId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { functionId } = req.params;

    await resourceInWorkspace('FUNCTION', functionId, workspaceOf(req).id);

    try {
      await deleteFunction(functionId);
    } catch (err) {
      // Already gone upstream. The mapping is the only thing left, and keeping
      // it would hold the unique `(kind, externalId)` slot for a function that
      // does not exist.
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      console.error(`Function ${functionId} was already absent upstream; dropping the mapping.`);
    }

    await unmapResource('FUNCTION', functionId);

    res.json({ success: true, data: { deleted: true } });
  }),
);

/**
 * Attach, toggle and detach.
 *
 * Each resolves the agent *and* the function against this workspace before
 * anything upstream is called, so neither an agent nor a definition belonging
 * to somebody else can be reached through the other.
 */
functionRoutes.post(
  '/:workspaceId/agents/:agentId/functions/:functionId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    await resourceInWorkspace('FUNCTION', req.params.functionId, workspaceOf(req).id);

    await attachFunction(agent.externalId, req.params.functionId);

    res.status(201).json({ success: true, data: { attached: true } });
  }),
);

functionRoutes.patch(
  '/:workspaceId/agents/:agentId/functions/:functionId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { enabled } = parseBody(toggleSchema, req.body);
    const agent = await agentInWorkspace(req);
    await resourceInWorkspace('FUNCTION', req.params.functionId, workspaceOf(req).id);

    const result = await toggleFunction(agent.externalId, req.params.functionId, enabled);

    res.json({ success: true, data: { enabled: readBoolean(result, ['enabled']) ?? enabled } });
  }),
);

/** Removes the function from this agent. The definition survives — deleting
 *  one is the route above, and the copy on both says which is which. */
functionRoutes.delete(
  '/:workspaceId/agents/:agentId/functions/:functionId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    await resourceInWorkspace('FUNCTION', req.params.functionId, workspaceOf(req).id);

    await detachFunction(agent.externalId, req.params.functionId);

    res.json({ success: true, data: { detached: true } });
  }),
);
