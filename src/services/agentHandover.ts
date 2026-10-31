import type { Agent } from '@prisma/client';
import {
  detachFunction,
  getAgentDictionaries,
  getAgentDocuments,
  getAgentFunctions,
  replaceAgentDictionaries,
  unlinkDocument,
} from '../adapter/vocobase.js';
import { readString } from '../lib/upstream.js';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/errors.js';

/**
 * What has to happen before an agent changes hands.
 *
 * An agent is lent to a workspace and returns to a pool, but the dictionaries,
 * functions and documents attached to it are *partner-level* — they do not
 * belong to the agent and do not move with it. Assignment was a plain
 * `workspaceId` overwrite, so an agent configured by one workspace arrived in
 * the next still carrying the previous one's material.
 *
 * That is not only a disclosure problem, though it is one — a function row
 * names an endpoint on the previous customer's network, and a dictionary is
 * their product catalogue. It is a live one: the agent goes on *using* that
 * knowledge base to answer the new workspace's calls. And it is what made the
 * pooled deletes unsafe, since a workspace deleting its own dictionary could
 * be pulling it out from under an agent now in use somewhere else.
 *
 * So the resources the incoming workspace does not own are detached before the
 * handover, and the handover is refused if that cannot be completed. Refusing
 * is the fail-closed direction: an agent that stays where it is can be moved
 * again in a minute, whereas one that moves with the previous tenant's
 * knowledge base attached cannot be un-moved.
 *
 * The resources themselves are untouched. They stay upstream, stay mapped to
 * whoever owns them, and stay usable in that workspace's own library.
 */
export async function detachForeignResources(
  agent: Agent,
  incomingWorkspaceId: string | null,
): Promise<void> {
  const owned = await ownedIds(incomingWorkspaceId);

  try {
    await detachForeignDictionaries(agent, owned);
    await detachForeignFunctions(agent, owned);
    await unlinkForeignDocuments(agent, owned);
  } catch (err) {
    if (err instanceof ApiError) throw err;

    console.error(`Could not detach foreign resources from agent ${agent.externalId}:`, err);
    throw new ApiError(
      502,
      'HANDOVER_INCOMPLETE',
      'The agent still has resources from its previous workspace and they could not be ' +
        'detached, so it was not moved. Try again.',
    );
  }
}

/** Everything the incoming workspace already owns. An unassigned agent has no
 *  incoming workspace, so nothing is owned and everything is detached. */
async function ownedIds(workspaceId: string | null): Promise<Set<string>> {
  if (!workspaceId) return new Set();

  const rows = await prisma.workspaceResource.findMany({
    where: { workspaceId },
    select: { externalId: true },
  });

  return new Set(rows.map((row) => row.externalId));
}

/**
 * A 404 from the platform means the resource — or the agent itself — is already
 * gone, which is the outcome detach exists to produce. `unwrap` passes an
 * upstream 404 through as a 404 rather than flattening it to an outage, and the
 * catch above re-throws an `ApiError` verbatim, so without this the staff
 * console refused the whole handover with a bare "Not found." Treating it as
 * done is the honest reading: nothing foreign is attached any more.
 */
function alreadyGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

async function detachForeignDictionaries(agent: Agent, owned: Set<string>): Promise<void> {
  let dictionaries: unknown;
  try {
    ({ dictionaries } = await getAgentDictionaries(agent.externalId));
  } catch (err) {
    if (alreadyGone(err)) return;
    throw err;
  }

  const attached = (Array.isArray(dictionaries) ? dictionaries : [])
    .map((row) => readString(row, ['id']))
    .filter((id): id is string => !!id);

  const keep = attached.filter((id) => owned.has(id));
  // Dictionaries are replaced as a set upstream, so one call covers however
  // many are being dropped — and skipping it entirely when nothing is foreign
  // keeps an ordinary reassignment from rewriting a set that was already right.
  if (keep.length !== attached.length) {
    try {
      await replaceAgentDictionaries(agent.externalId, keep);
    } catch (err) {
      if (alreadyGone(err)) return;
      throw err;
    }
  }
}

async function detachForeignFunctions(agent: Agent, owned: Set<string>): Promise<void> {
  let functions: unknown;
  try {
    ({ functions } = await getAgentFunctions(agent.externalId));
  } catch (err) {
    if (alreadyGone(err)) return;
    throw err;
  }

  for (const row of Array.isArray(functions) ? functions : []) {
    const id = readString(row, ['id']);
    if (!id || owned.has(id)) continue;

    // Per resource, so one row the platform has already dropped does not stop
    // the rest of the agent being stripped.
    try {
      await detachFunction(agent.externalId, id);
    } catch (err) {
      if (alreadyGone(err)) continue;
      throw err;
    }
  }
}

/**
 * Unlinked, never deleted.
 *
 * The document belongs to the workspace that uploaded it and stays in their
 * library. Deleting it here would destroy one customer's file as a side effect
 * of a staff action taken on behalf of another.
 */
async function unlinkForeignDocuments(agent: Agent, owned: Set<string>): Promise<void> {
  let documents: unknown;
  try {
    ({ documents } = await getAgentDocuments(agent.externalId));
  } catch (err) {
    if (alreadyGone(err)) return;
    throw err;
  }

  for (const row of Array.isArray(documents) ? documents : []) {
    const id = readString(row, ['id', 'document_id', 'documentId']);
    if (!id || owned.has(id)) continue;

    try {
      await unlinkDocument(agent.externalId, id);
    } catch (err) {
      if (alreadyGone(err)) continue;
      throw err;
    }
  }
}
