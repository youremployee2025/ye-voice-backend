import { Prisma, type Agent } from '@prisma/client';
import { getAgent, listAgents, listVoices, type UpstreamRecord } from '../adapter/vocobase.js';
import { prisma } from '../lib/prisma.js';
import { readBoolean, readNumber, readRecord, readString, readStringArray } from '../lib/upstream.js';
import { NOT_REMOVED } from '../lib/agentVisibility.js';

/**
 * Pulls agent configuration from Vocobase into the local mirror.
 *
 * Two entry points with different cost shapes. A global sync pages the listing,
 * which already returns complete agent objects — one request per hundred agents
 * and no per-agent follow-up. A workspace sync fetches only the agents that
 * workspace owns, so a customer-triggered refresh never scans all of Vocobase.
 *
 * The invariant that matters: sync owns configuration, staff own assignment.
 * The upsert below must never write `workspaceId`, or a routine refresh would
 * silently un-share every agent in Vocobase.
 */

/** Upstream caps `limit` at 100. */
const PAGE_SIZE = 100;

/** Backstop against an upstream that never returns a short page. */
const MAX_PAGES = 100;

export interface SyncOptions {
  /** Page-walk backstop. Overridable so the truncation path can be tested
   *  without forcing a hundred real pages through the mirror. */
  maxPages?: number;
}

export interface AgentSyncResult {
  synced: number;
  removed: number;
  /** Agents whose refresh failed. Non-zero means the result is partial. */
  failed?: number;
  /** Set when removal detection was skipped because the listing was unusable. */
  truncated?: boolean;
  /** Set when the refresh was inside the cooldown and no upstream call was made. */
  skipped?: boolean;
}

/**
 * Minimum gap between workspace refreshes.
 *
 * The refresh route is a button click available to any member, and it fans out
 * one upstream request per agent against a rate limit every workspace on the
 * platform shares. Configuration changes rarely enough that a minute of
 * staleness costs nothing, while an unthrottled button costs everyone.
 */
const WORKSPACE_SYNC_COOLDOWN_MS = 60_000;

/**
 * The fraction of the currently-live mirror a listing must account for before
 * its absences are believed. Set well below any plausible real churn in a
 * single run — agents are provisioned by hand — so it only ever fires on a
 * listing that is wrong rather than one that is merely smaller.
 */
const MIN_LISTING_COVERAGE = 0.5;

/**
 * Voice id → what the catalogue says about it. Empty when the catalogue could
 * not be read.
 *
 * The tier rides along with the name because the catalogue response carries
 * both and this is the only place the product reads it. Resolving a voice's
 * tier at dial time instead would mean an upstream request per call, against a
 * rate limit every customer on the partner account shares.
 */
type VoiceFacts = Map<string, { name: string | null; tier: string | null }>;

async function loadVoiceFacts(): Promise<VoiceFacts> {
  const facts: VoiceFacts = new Map();

  try {
    const { voices } = await listVoices();
    for (const voice of voices ?? []) {
      const id = readString(voice, ['id']);
      if (!id) continue;

      facts.set(id, {
        name: readString(voice, ['display_name', 'displayName', 'name']),
        tier: readString(voice, ['tier']),
      });
    }
  } catch (err) {
    // A missing catalogue costs readable voice names and the tier, not the
    // sync itself. A null tier is not "untiered" — see `dialerPricing.ts`,
    // which falls back to the account's default tier rather than to free.
    console.error('Could not load the voice catalogue; falling back to voice ids.', err);
  }

  return facts;
}

/**
 * Walks the listing until a short page ends it.
 *
 * `complete` says whether the walk actually reached the end. Hitting the page
 * cap means the collected list is only a prefix of the pool, and the caller
 * must not treat absence from a prefix as deletion.
 */
async function fetchPool(maxPages: number): Promise<{ agents: UpstreamRecord[]; complete: boolean }> {
  const collected: UpstreamRecord[] = [];
  const ids = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    const { agents } = await listAgents({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    const batch = agents ?? [];

    // An upstream that ignores `offset` re-serves page 0 forever. Without this
    // the walk runs to the page cap, issues `maxPages * PAGE_SIZE` redundant
    // upserts, and exits truncated — so removal detection is disabled and the
    // cause is invisible. A page that adds nothing new ends the walk instead.
    let added = 0;
    for (const agent of batch) {
      const id = readString(agent, ['id']);
      if (!id || ids.has(id)) continue;
      ids.add(id);
      collected.push(agent);
      added += 1;
    }

    if (batch.length < PAGE_SIZE) return { agents: collected, complete: true };

    if (added === 0) {
      console.error(
        `Agent listing page ${page} repeated ids already seen; ending the walk as incomplete.`,
      );
      return { agents: collected, complete: false };
    }
  }

  return { agents: collected, complete: false };
}

/** Prisma's unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** The columns sync owns. `workspaceId` is deliberately not among them. */
function cachedFields(agent: UpstreamRecord, externalId: string, voiceFacts: VoiceFacts) {
  const voiceId = readString(agent, ['voice_id', 'voiceId']);
  const voice = voiceId ? voiceFacts.get(voiceId) : undefined;

  return {
    // An unnamed agent is still worth listing, so it falls back to its id
    // rather than being skipped or shown blank.
    name: readString(agent, ['agent_name', 'name']) ?? externalId,
    status: readString(agent, ['status']),
    agentType: readString(agent, ['agent_type', 'agentType']),
    voiceId,
    voiceName: voice?.name ?? voiceId,
    // Which tier this agent's voice is sold in, so the dialer can price a
    // minute without an upstream read. A platform fact, refreshed by sync —
    // the tier's PRICE is YE's and lives on `Tier`, which sync never touches.
    voiceTierSlug: voice?.tier ?? null,
    language: readString(agent, ['language']),
    // Whether this agent holds a second, inbound configuration upstream —
    // mirrored from `inbound.enabled`, which the agent read returns on every
    // agent. Configuration, so sync owns it. A missing `inbound` key is off,
    // not unknown: the column is non-null and a face nobody has enabled is off.
    inboundEnabled: readBoolean(readRecord(agent, ['inbound']), ['enabled']) ?? false,
    documentCount: readNumber(agent, ['document_count', 'documentCount']),
    variables: readStringArray(agent, ['variables']) as Prisma.InputJsonValue,
    rawConfig: agent as Prisma.InputJsonValue,
    lastSyncedAt: new Date(),
  };
}

async function upsertAgent(
  agent: UpstreamRecord,
  externalId: string,
  voiceFacts: VoiceFacts,
): Promise<void> {
  const fields = cachedFields(agent, externalId, voiceFacts);

  try {
    await prisma.agent.upsert({
      where: { externalId },
      // `workspaceId` is omitted, not set — assignment is staff-owned state and
      // a sync that touched it would break workspace isolation.
      update: fields,
      create: { externalId, ...fields },
    });
  } catch (err) {
    // `upsert` is find-then-write, not atomic: a staff pool sync and a member
    // workspace sync touching the same agent can both miss the row and both
    // take the `create` branch, and the loser hits the unique index on
    // `externalId`. The row it collided with is the one it wanted, so the
    // update it should have run is still the right write.
    if (!isUniqueViolation(err)) throw err;

    await prisma.agent.update({ where: { externalId }, data: fields });
  }
}

/**
 * Rewrites one agent's mirror row from a fresh fetch.
 *
 * Called at the end of every write, in the same request. An update that
 * returned before refreshing would leave the caller re-reading the
 * configuration it had just changed — and "my edit didn't save" is the most
 * expensive thing on this surface to be wrong about.
 *
 * A failure propagates. Swallowing it would report a stale row as fresh, which
 * is the same lie in a quieter voice.
 */
export async function refreshAgent(externalId: string): Promise<Agent> {
  const [voiceFacts, upstream] = await Promise.all([loadVoiceFacts(), getAgent(externalId)]);

  await upsertAgent(upstream, externalId, voiceFacts);

  return prisma.agent.findUniqueOrThrow({ where: { externalId } });
}

/**
 * Mirrors a just-created agent **and** assigns it, in one write.
 *
 * This is the single place the "sync never writes `workspaceId`" rule is
 * deliberately broken, and the distinction is worth stating: there, assignment
 * is state a refresh happened to be near and must not touch. Here, assignment
 * *is* the act — the workspace asked for this agent to exist and it has no
 * meaning unassigned.
 *
 * One statement on purpose. The gap between the upstream create returning and
 * this landing is the only window in which an orphan can be produced, so there
 * is no multi-step local transaction that could fail halfway through it.
 */
export async function assignAgent(
  externalId: string,
  workspaceId: string,
  upstream: UpstreamRecord,
): Promise<Agent> {
  const voiceFacts = await loadVoiceFacts();
  const fields = cachedFields(upstream, externalId, voiceFacts);

  return prisma.agent.upsert({
    where: { externalId },
    update: { ...fields, workspaceId },
    create: { externalId, ...fields, workspaceId },
  });
}

/**
 * Refreshes the whole pool. Agents Vocobase no longer lists are marked
 * `removed` rather than deleted: past calls still reference them, and a short
 * page caused by an upstream hiccup must not destroy local state.
 */
export async function syncAllAgents({ maxPages = MAX_PAGES }: SyncOptions = {}): Promise<AgentSyncResult> {
  const [voiceFacts, pool] = await Promise.all([loadVoiceFacts(), fetchPool(maxPages)]);

  const seen: string[] = [];

  for (const agent of pool.agents) {
    const externalId = readString(agent, ['id']);
    if (!externalId) continue;

    await upsertAgent(agent, externalId, voiceFacts);
    seen.push(externalId);
  }

  // Removal is only sound against a complete listing. A truncated walk would
  // mark every agent past the cap removed — silent data loss dressed up as a
  // successful sync — so the pass is skipped and the shortfall is reported.
  if (!pool.complete) {
    console.error(
      `Agent listing exceeded ${maxPages * PAGE_SIZE} rows; skipping removal detection this run.`,
    );
    return { synced: seen.length, removed: 0, truncated: true };
  }

  // An empty listing is refused outright. A genuinely empty pool and a broken
  // integration — rotated key, key scoped to the wrong partner, an upstream
  // regression — look identical from here, and `notIn: []` matches every row,
  // so proceeding would retire the entire mirror and report success.
  if (seen.length === 0) {
    console.error('Agent listing returned no agents; skipping removal detection this run.');
    return { synced: 0, removed: 0, truncated: true };
  }

  // The zero case is only the extreme of the failure it guards against. A key
  // scoped to the wrong partner, or an upstream filter regression, returns a
  // listing that is complete and non-empty but covers a fraction of the pool —
  // which passes both guards above and retires the rest while reporting
  // success. So a run that would retire most of the mirror is refused too, and
  // the shortfall reported the same way a truncated walk is. Restoring a
  // wrongly-retired mirror is manual; a skipped removal pass costs one run.
  const live = await prisma.agent.count({ where: NOT_REMOVED });

  if (live > 0 && seen.length < live * MIN_LISTING_COVERAGE) {
    console.error(
      `Agent listing covered ${seen.length} of ${live} live agents, below the ` +
        `${MIN_LISTING_COVERAGE} floor; skipping removal detection this run.`,
    );
    return { synced: seen.length, removed: 0, truncated: true };
  }

  const { count } = await prisma.agent.updateMany({
    where: { externalId: { notIn: seen }, ...NOT_REMOVED },
    data: { status: 'removed' },
  });

  return { synced: seen.length, removed: count };
}

/**
 * Refreshes one workspace's agents, fetching each directly.
 *
 * Deliberately not a pool listing: this endpoint is reachable by any member,
 * and paging the whole platform would let one workspace's refresh cost grow
 * with the total number of agents — and spend a rate limit shared by everyone.
 * Fetching what the caller owns keeps the cost proportional to the caller.
 *
 * Nothing is marked removed here. A workspace sees only part of the pool, so
 * an agent's absence from its list is not evidence Vocobase dropped it.
 */
export async function syncWorkspaceAgents(workspaceId: string): Promise<AgentSyncResult> {
  const owned = await prisma.agent.findMany({
    where: { workspaceId },
    select: { externalId: true },
  });

  if (owned.length === 0) return { synced: 0, removed: 0 };

  // Claim the cooldown before doing any work, in one conditional write.
  //
  // Two properties, and both were missing when this read the agent rows. The
  // window is *claimed*, not merely observed, so N simultaneous clicks produce
  // one fan-out rather than N — `updateMany` takes a row lock, so exactly one
  // of them matches. And the stamp records the attempt, so a workspace whose
  // agents all fail to refresh is still throttled; keying off a successful
  // `lastSyncedAt` meant one dead agent disabled the cooldown permanently.
  const cutoff = new Date(Date.now() - WORKSPACE_SYNC_COOLDOWN_MS);
  const claimed = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      OR: [{ lastAgentSyncAt: null }, { lastAgentSyncAt: { lt: cutoff } }],
    },
    data: { lastAgentSyncAt: new Date() },
  });

  if (claimed.count === 0) return { synced: 0, removed: 0, skipped: true };

  const voiceFacts = await loadVoiceFacts();
  let synced = 0;
  let failed = 0;

  for (const { externalId } of owned) {
    try {
      await upsertAgent(await getAgent(externalId), externalId, voiceFacts);
      synced += 1;
    } catch (err) {
      // One agent Vocobase no longer serves must not deny the workspace a
      // refresh of the others — but the shortfall is counted, never swallowed.
      // Reporting a total outage as `synced: 0` would tell the caller their
      // refresh succeeded.
      console.error(`Could not refresh agent ${externalId}:`, err);
      failed += 1;
    }
  }

  return { synced, removed: 0, failed };
}
