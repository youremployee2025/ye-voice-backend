import type { WorkspaceResource, WorkspaceResourceKind } from '@prisma/client';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';

/**
 * The guard that makes a shared partner namespace safe to expose.
 *
 * Agents are isolated by `Agent.workspaceId`. Documents, dictionaries,
 * functions and tool connections have no such column, because upstream they
 * belong to the partner account rather than to an agent — listing dictionaries
 * returns every workspace's, and listing an agent's tools returns every
 * connection on the platform, each with the connected account's email address.
 *
 * So the same rule is applied from here instead: a resource is visible to
 * exactly one workspace, and a resource with no mapping is visible to none.
 * Every list intersects, every action resolves. Nothing in this file decides
 * *who is calling* — membership is settled before any of it runs.
 */

/**
 * Resolves a resource the caller is entitled to act on, or refuses.
 *
 * An unmapped id, an id mapped elsewhere, and an id that never existed all
 * produce the identical error. A different message for any of them would
 * confirm which ids name something real on the platform, which is the fact
 * isolation exists to withhold — the same reason a foreign agent 404s rather
 * than 403s.
 */
export async function resourceInWorkspace(
  kind: WorkspaceResourceKind,
  externalId: string,
  workspaceId: string,
): Promise<WorkspaceResource> {
  const resource = await prisma.workspaceResource.findFirst({
    where: { kind, externalId, workspaceId },
  });

  if (!resource) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
  }

  return resource;
}

/**
 * Records that a workspace owns a resource it just created.
 *
 * Idempotent by the unique index rather than by a prior read: the create path
 * retries, and a second attempt must land on the row the first one made rather
 * than colliding with it.
 *
 * **It will not move an existing mapping.** This is the customer-facing half,
 * and every caller reaches it holding an id upstream just returned from a
 * create — so a row that already names a *different* workspace means upstream
 * handed back something that was not new. A platform that de-duplicates on
 * create (a web link keyed by URL, a paragraph keyed by content hash, a
 * function keyed by name) would do exactly that, and an upsert that overwrote
 * `workspaceId` would then quietly transfer another customer's resource to the
 * caller — with no read beforehand, nothing would ever notice. Refusing is the
 * only safe answer, and it is loud.
 */
export async function claimResource(
  kind: WorkspaceResourceKind,
  externalId: string,
  workspaceId: string,
  name?: string | null,
): Promise<WorkspaceResource> {
  const existing = await prisma.workspaceResource.findUnique({
    where: { kind_externalId: { kind, externalId } },
  });

  if (existing && existing.workspaceId !== workspaceId) {
    console.error(
      `Upstream returned ${kind} ${externalId} to workspace ${workspaceId}, ` +
        `but it is already mapped to ${existing.workspaceId}. Refusing to move it.`,
    );
    throw new ApiError(
      409,
      'RESOURCE_ALREADY_MAPPED',
      'The voice platform returned something that already belongs elsewhere. Nothing was changed.',
    );
  }

  return prisma.workspaceResource.upsert({
    where: { kind_externalId: { kind, externalId } },
    update: { workspaceId, ...(name === undefined ? {} : { name }) },
    create: { kind, externalId, workspaceId, name: name ?? null },
  });
}

/**
 * Moves a resource to a workspace, or records it for the first time.
 *
 * The staff half, and the only place ownership may change hands. The unique
 * index guarantees there is never a second row left behind.
 */
export async function reassignResource(
  kind: WorkspaceResourceKind,
  externalId: string,
  workspaceId: string,
  name?: string | null,
): Promise<WorkspaceResource> {
  return prisma.workspaceResource.upsert({
    where: { kind_externalId: { kind, externalId } },
    update: { workspaceId, ...(name === undefined ? {} : { name }) },
    create: { kind, externalId, workspaceId, name: name ?? null },
  });
}

/** Updates the cached label of a resource this workspace already owns.
 *  Ownership is proven by the caller; this cannot change it. */
export async function renameResource(
  kind: WorkspaceResourceKind,
  externalId: string,
  workspaceId: string,
  name: string,
): Promise<void> {
  await prisma.workspaceResource.updateMany({
    where: { kind, externalId, workspaceId },
    data: { name },
  });
}

/**
 * The message every "it exists upstream but we could not record it" failure
 * uses. One sentence, so the four paths that can reach this state cannot drift
 * into telling four different stories about it.
 */
export const CREATED_UNMAPPED_MESSAGE =
  'It was created on the voice platform but could not be added to this workspace. ' +
  'Contact support rather than trying again, or you may end up with two.';

/**
 * Claims a freshly created resource, retrying once before giving up.
 *
 * The agent create path has had this since it was written; its three siblings
 * did not, and the consequence was worse there. An unmapped agent still turns
 * up in the staff pool listing and can be assigned; an unmapped dictionary,
 * function or document is visible to **nobody** — every listing intersects it
 * away, every action resolves through a guard that cannot find it — while the
 * customer's file sits upstream being billed for. So the failure is retried,
 * and if it stands the caller is told not to try again, rather than being
 * handed a bare 500 that reads like nothing happened.
 */
export async function claimCreated(
  kind: WorkspaceResourceKind,
  externalId: string,
  workspaceId: string,
  name?: string | null,
): Promise<WorkspaceResource> {
  try {
    return await claimResource(kind, externalId, workspaceId, name);
  } catch (first) {
    // A refusal is a decision, not a transient fault: retrying cannot change
    // who owns the row, and the answer must reach the caller unchanged.
    if (first instanceof ApiError) throw first;

    console.error(`Could not map newly created ${kind} ${externalId}; retrying.`, first);
    try {
      return await claimResource(kind, externalId, workspaceId, name);
    } catch (second) {
      console.error(`${kind} ${externalId} exists upstream but is unmapped.`, second);
      throw new ApiError(502, 'RESOURCE_CREATED_UNMAPPED', CREATED_UNMAPPED_MESSAGE);
    }
  }
}

/** Drops a mapping. The upstream resource is not touched — this makes it
 *  invisible to every workspace, which is what staff unassignment means. */
export async function unmapResource(
  kind: WorkspaceResourceKind,
  externalId: string,
): Promise<void> {
  await prisma.workspaceResource.deleteMany({ where: { kind, externalId } });
}

/**
 * Narrows a list of upstream rows to the ones this workspace owns.
 *
 * One query for the whole list, not one per row: these lists are proxied from
 * upstream and can carry every resource on the platform, so a per-row lookup
 * would turn one page into a hundred round trips.
 *
 * A row whose id cannot be read is dropped rather than kept. It cannot be
 * proven to belong to this workspace, and on this surface "cannot prove" and
 * "does not belong" must have the same outcome.
 */
export async function filterMapped<T>(
  rows: T[],
  kind: WorkspaceResourceKind,
  workspaceId: string,
  idOf: (row: T) => string | null,
): Promise<T[]> {
  if (rows.length === 0) return [];

  const candidates = rows.map(idOf).filter((id): id is string => typeof id === 'string' && !!id);
  if (candidates.length === 0) return [];

  const mapped = await prisma.workspaceResource.findMany({
    where: { kind, workspaceId, externalId: { in: candidates } },
    select: { externalId: true },
  });

  const visible = new Set(mapped.map((row) => row.externalId));

  return rows.filter((row) => {
    const id = idOf(row);
    return typeof id === 'string' && visible.has(id);
  });
}
