import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Agent } from '@prisma/client';
import {
  createDictionary,
  deleteDictionary,
  getAgentDictionaries,
  listDictionaries,
  replaceAgentDictionaries,
  updateDictionary,
} from '../adapter/vocobase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { writeLimiter } from '../lib/writeLimiter.js';
import { readString } from '../lib/upstream.js';
import { serializeAttachedDictionaries, serializeDictionaries } from '../lib/serialize.js';
import {
  filterMapped,
  claimCreated,
  renameResource,
  resourceInWorkspace,
  unmapResource,
} from '../lib/workspaceResource.js';

/**
 * Speech-recognition dictionaries.
 *
 * A dictionary is partner-level upstream, so `GET /dictionaries` returns every
 * workspace's — names and term counts that are customer content. The library
 * route therefore intersects rather than proxies, and a dictionary another
 * workspace owns is not shown even as an unselectable row: seeing that "Acme
 * SKU list" exists is itself the leak.
 *
 * Attachment is an idempotent **set-replace** upstream, not add/remove, which
 * is why the surface above this is a replace flow with a confirmation rather
 * than a pair of buttons.
 */
export const dictionaryRoutes: Router = Router();

const MAX_TERMS = 500;

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  // At least one: a dictionary with no terms changes nothing about
  // recognition, so creating one is always a mistake worth reporting.
  terms: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_TERMS),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    terms: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_TERMS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

const replaceSchema = z.object({
  dictionary_ids: z.array(z.string().min(1)).max(50),
});

async function agentInWorkspace(req: Request): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: { id: req.params.agentId, workspaceId: workspaceOf(req).id },
  });

  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');

  return agent;
}

dictionaryRoutes.get(
  '/:workspaceId/dictionaries',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const { dictionaries } = await listDictionaries();

    const visible = await filterMapped(
      Array.isArray(dictionaries) ? dictionaries : [],
      'DICTIONARY',
      workspaceOf(req).id,
      (row) => readString(row, ['id']),
    );

    res.json({ success: true, data: serializeDictionaries(visible) });
  }),
);

dictionaryRoutes.post(
  '/:workspaceId/dictionaries',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);

    const created = await createDictionary(body);

    const externalId = readString(created, ['id']);
    if (!externalId) {
      throw new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform did not return a dictionary.');
    }

    // Mapped immediately: an unmapped dictionary is invisible to every
    // workspace, including the one that just made it.
    await claimCreated('DICTIONARY', externalId, workspaceOf(req).id, body.name);

    res.status(201).json({ success: true, data: serializeDictionaries([created])[0] });
  }),
);

dictionaryRoutes.patch(
  '/:workspaceId/dictionaries/:dictionaryId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(updateSchema, req.body);
    const { dictionaryId } = req.params;

    await resourceInWorkspace('DICTIONARY', dictionaryId, workspaceOf(req).id);
    const updated = await updateDictionary(dictionaryId, body);

    if (body.name) {
      await renameResource('DICTIONARY', dictionaryId, workspaceOf(req).id, body.name);
    }

    res.json({ success: true, data: serializeDictionaries([updated])[0] });
  }),
);

/**
 * Deletes upstream, then drops the mapping.
 *
 * That order, not the reverse: unmapping first and then failing upstream would
 * leave a dictionary that still exists and that no workspace can see, so
 * nobody could delete or reuse it.
 */
dictionaryRoutes.delete(
  '/:workspaceId/dictionaries/:dictionaryId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { dictionaryId } = req.params;

    await resourceInWorkspace('DICTIONARY', dictionaryId, workspaceOf(req).id);

    try {
      await deleteDictionary(dictionaryId);
    } catch (err) {
      // Already gone upstream: drop the mapping rather than leave a row
      // holding the unique slot for something that does not exist.
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      console.error(`Dictionary ${dictionaryId} was already absent upstream; dropping the mapping.`);
    }

    await unmapResource('DICTIONARY', dictionaryId);

    res.json({ success: true, data: { deleted: true } });
  }),
);

dictionaryRoutes.get(
  '/:workspaceId/agents/:agentId/dictionaries',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { dictionaries } = await getAgentDictionaries(agent.externalId);
    const rows = Array.isArray(dictionaries) ? dictionaries : [];

    /**
     * Not intersected — hiding a row would misreport what the agent actually
     * listens for — but not passed through whole either.
     *
     * An agent is lent between workspaces by staff, and its attached
     * dictionaries do not move with it, so this list can genuinely hold
     * another customer's. Their **terms** are a product catalogue, so they are
     * withheld and the row says `owned: false`. The counts stay: they make the
     * character budget add up and name nothing.
     */
    const owned = await prisma.workspaceResource.findMany({
      where: {
        kind: 'DICTIONARY',
        workspaceId: workspaceOf(req).id,
        externalId: { in: rows.map((row) => readString(row, ['id']) ?? '').filter(Boolean) },
      },
      select: { externalId: true },
    });

    res.json({
      success: true,
      data: serializeAttachedDictionaries(rows, new Set(owned.map((row) => row.externalId))),
    });
  }),
);

/**
 * Replaces the agent's whole dictionary set.
 *
 * Every id is checked against the mapping **before** the upstream call, as a
 * set rather than one at a time. A request naming one dictionary the caller is
 * not entitled to fails whole: attaching only the entitled half would silently
 * produce a configuration nobody asked for, and a set-replace has no partial
 * meaning.
 *
 * **Entitled means owned *or* already attached to this agent.** An agent can
 * be lent between workspaces by staff with its dictionaries still attached, so
 * the listing above can legitimately show one this workspace does not own.
 * Requiring ownership of every id then made the tab a dead end: the reader
 * submits what they were shown plus one of their own and gets a bare 404, with
 * no way to add anything ever again — while the only alternative open to the
 * UI, dropping the unowned id, would silently detach it. Keeping something
 * that is already attached is not a way to obtain access to it; it remains
 * unreadable in the listing and unusable anywhere else.
 */
dictionaryRoutes.put(
  '/:workspaceId/agents/:agentId/dictionaries',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { dictionary_ids: requested } = parseBody(replaceSchema, req.body);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    // Upstream de-duplicates silently; doing it here keeps the request sent
    // and the request received the same shape, which matters when reading logs.
    const ids = [...new Set(requested)];

    if (ids.length > 0) {
      const owned = await prisma.workspaceResource.findMany({
        where: { kind: 'DICTIONARY', workspaceId, externalId: { in: ids } },
        select: { externalId: true },
      });

      const entitled = new Set(owned.map((row) => row.externalId));

      if (entitled.size !== ids.length) {
        // Only now, and only for the shortfall: an id already on this agent is
        // one the caller is allowed to keep. Read after the ownership check so
        // the common case still costs one query and no upstream call.
        const { dictionaries } = await getAgentDictionaries(agent.externalId);
        for (const row of Array.isArray(dictionaries) ? dictionaries : []) {
          const id = readString(row, ['id']);
          if (id) entitled.add(id);
        }
      }

      if (ids.some((id) => !entitled.has(id))) {
        // The same 404 an unknown id gets: which of them was the problem is
        // exactly what a caller probing another workspace wants to learn.
        throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
      }
    }

    const { dictionaries } = await replaceAgentDictionaries(agent.externalId, ids);

    res.json({
      success: true,
      data: serializeDictionaries(Array.isArray(dictionaries) ? dictionaries : []),
    });
  }),
);
