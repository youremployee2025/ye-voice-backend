import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

// The client is mocked in every test — sync must never touch the real
// partner API, which is production and holds live agents.
vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
}));

const { getAgent, listAgents, listVoices } = await import('../src/adapter/vocobase.js');
const { assignAgent, refreshAgent, syncAllAgents, syncWorkspaceAgents } = await import(
  '../src/services/agentSync.js'
);

const mockedGetAgent = vi.mocked(getAgent);
const mockedListAgents = vi.mocked(listAgents);
const mockedListVoices = vi.mocked(listVoices);

/** An agent as the listing returns it — full config, snake_case. */
function upstreamAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-1',
    agent_name: 'Salon Receptionist',
    status: 'active',
    agent_type: null,
    voice_id: 'voice-1',
    language: 'en',
    document_count: 2,
    variables: ['business_name', 'city'],
    prompt: 'You are a receptionist.',
    ...overrides,
  };
}

/** One full page then a short page, which is how the client detects the end. */
function pages(...batches: Record<string, unknown>[][]) {
  mockedListAgents.mockReset();
  batches.forEach((agents) => {
    mockedListAgents.mockResolvedValueOnce({ agents, total: 0, limit: 100, offset: 0 });
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  mockedListVoices.mockResolvedValue({
    voices: [{ id: 'voice-1', display_name: 'Anisha', tier: 'va-pro' }],
  });
});

describe('syncAllAgents', () => {
  it('inserts a new agent with its cached configuration', async () => {
    pages([upstreamAgent()]);

    const result = await syncAllAgents();

    expect(result).toMatchObject({ synced: 1, removed: 0 });

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row).toMatchObject({
      name: 'Salon Receptionist',
      status: 'active',
      agentType: null,
      voiceId: 'voice-1',
      language: 'en',
      documentCount: 2,
      workspaceId: null,
    });
    expect(row.variables).toEqual(['business_name', 'city']);
    expect(row.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('mirrors an inbound-enabled agent as inboundEnabled true', async () => {
    pages([upstreamAgent({ inbound: { enabled: true } })]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.inboundEnabled).toBe(true);
  });

  it('mirrors an agent with no inbound key as inboundEnabled false, without throwing', async () => {
    // The default payload carries no `inbound` key at all. A missing face is
    // off, not an error — the column is non-null with a false default.
    pages([upstreamAgent()]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.inboundEnabled).toBe(false);
  });

  it('stores the full configuration snapshot for the detail view', async () => {
    pages([upstreamAgent({ transfer_enabled: true, max_call_duration_secs: 600 })]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.rawConfig).toMatchObject({ transfer_enabled: true, max_call_duration_secs: 600 });
  });

  it('resolves the voice id into a display name', async () => {
    pages([upstreamAgent()]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.voiceName).toBe('Anisha');
  });

  /**
   * The tier rides along with the display name because the catalogue response
   * carries both. Resolving it at dial time instead would be one upstream
   * request per call, against a rate limit every customer on the partner
   * account shares.
   */
  it("records the tier the agent's voice is sold in", async () => {
    pages([upstreamAgent()]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.voiceTierSlug).toBe('va-pro');
  });

  it('records no tier for a voice the catalogue lists without one', async () => {
    mockedListVoices.mockResolvedValue({ voices: [{ id: 'voice-1', display_name: 'Anisha' }] });
    pages([upstreamAgent()]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    // Null is "outside the tier system", never "free" — the dialer prices it
    // off the account's default tier rather than at nothing.
    expect(row.voiceTierSlug).toBeNull();
  });

  it('records no tier when the catalogue could not be read at all', async () => {
    mockedListVoices.mockRejectedValue(new Error('voices down'));
    pages([upstreamAgent()]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.voiceTierSlug).toBeNull();
  });

  it('falls back to the raw voice id when the catalogue does not list it', async () => {
    mockedListVoices.mockResolvedValue({ voices: [] });
    pages([upstreamAgent()]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.voiceName).toBe('voice-1');
  });

  it('still syncs agents when the voice catalogue is unavailable', async () => {
    mockedListVoices.mockRejectedValue(new Error('voices down'));
    pages([upstreamAgent()]);

    const result = await syncAllAgents();

    expect(result.synced).toBe(1);
    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.voiceName).toBe('voice-1');
  });

  it('keeps an assigned agent in its workspace when its config changes', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Old Name', workspaceId: workspace.id },
    });

    pages([upstreamAgent({ agent_name: 'New Name' })]);
    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.name).toBe('New Name');
    expect(row.workspaceId).toBe(workspace.id);
  });

  it('marks a locally known agent removed when the listing no longer has it', async () => {
    await prisma.agent.create({
      data: { externalId: 'gone', name: 'Retired Agent', status: 'active' },
    });

    pages([upstreamAgent()]);
    const result = await syncAllAgents();

    expect(result.removed).toBe(1);
    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'gone' } });
    expect(row.status).toBe('removed');
  });

  it('keeps the workspace assignment of a removed agent rather than orphaning it', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'gone', name: 'Retired', workspaceId: workspace.id },
    });

    pages([upstreamAgent()]);
    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'gone' } });
    expect(row.workspaceId).toBe(workspace.id);
  });

  it('collects every page when the pool exceeds one request', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      upstreamAgent({ id: `ext-${i}`, agent_name: `Agent ${i}` }),
    );
    pages(firstPage, [upstreamAgent({ id: 'ext-last', agent_name: 'Last' })]);

    const result = await syncAllAgents();

    expect(result.synced).toBe(101);
    expect(mockedListAgents).toHaveBeenCalledTimes(2);
    expect(mockedListAgents).toHaveBeenNthCalledWith(2, { limit: 100, offset: 100 });
  });

  it('refuses to mark anything removed when the listing comes back empty', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Live', status: 'active', workspaceId: workspace.id },
    });
    await prisma.agent.create({ data: { externalId: 'ext-2', name: 'Also live', status: 'active' } });

    // A rotated or mis-scoped key returns a successful but empty listing. An
    // empty pool and a broken integration are indistinguishable from here, so
    // the safe reading is to change nothing rather than retire every agent.
    pages([]);
    const result = await syncAllAgents();

    expect(result.removed).toBe(0);
    expect(await prisma.agent.count({ where: { status: 'active' } })).toBe(2);
  });

  it('refuses to mark anything removed when the listing was truncated', async () => {
    await prisma.agent.create({
      data: { externalId: 'beyond-the-cap', name: 'Real Agent', status: 'active' },
    });

    // Every page comes back full, so the walk hits its page cap without ever
    // seeing a short page. The collected list is then only a prefix of the
    // pool, and treating absence from it as deletion would mass-mark live
    // agents removed. maxPages is lowered so this costs two pages, not a
    // hundred.
    const fullPage = Array.from({ length: 100 }, (_, i) => upstreamAgent({ id: `ext-${i}` }));
    mockedListAgents.mockReset();
    mockedListAgents.mockResolvedValue({ agents: fullPage, total: 0, limit: 100, offset: 0 });

    const result = await syncAllAgents({ maxPages: 2 });

    expect(result.removed).toBe(0);
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'beyond-the-cap' } })).status).toBe(
      'active',
    );
  });

  it('skips a listing entry with no id rather than inventing one', async () => {
    pages([upstreamAgent(), { agent_name: 'Nameless', id: null }]);

    const result = await syncAllAgents();

    expect(result.synced).toBe(1);
    expect(await prisma.agent.count()).toBe(1);
  });

  it('names an agent by its id when the listing carries no name', async () => {
    pages([{ id: 'ext-1' }]);

    await syncAllAgents();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.name).toBe('ext-1');
  });

  it('leaves the mirror untouched when the listing fails', async () => {
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Existing', status: 'active' } });
    mockedListAgents.mockReset();
    mockedListAgents.mockRejectedValue(new Error('upstream down'));

    await expect(syncAllAgents()).rejects.toThrow();

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.status).toBe('active');
  });
});

describe('syncWorkspaceAgents', () => {
  it('fetches each of its own agents directly, never listing the pool', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Stale', workspaceId: workspace.id } });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ agent_name: 'Fresh' }));

    const result = await syncWorkspaceAgents(workspace.id);

    expect(result.synced).toBe(1);
    expect(mockedGetAgent).toHaveBeenCalledWith('ext-1');
    // Paging the whole pool would let any member trigger a platform-wide scan
    // against a rate-limited API, at a cost that grows with the platform.
    expect(mockedListAgents).not.toHaveBeenCalled();
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } })).name).toBe('Fresh');
  });

  it('never touches an agent belonging to another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Mine', workspaceId: mine.id } });
    await prisma.agent.create({ data: { externalId: 'ext-2', name: 'Theirs', workspaceId: theirs.id } });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ agent_name: 'Fresh' }));

    await syncWorkspaceAgents(mine.id);

    expect(mockedGetAgent).toHaveBeenCalledTimes(1);
    expect(mockedGetAgent).toHaveBeenCalledWith('ext-1');
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-2' } })).name).toBe('Theirs');
  });

  it('keeps the workspace assignment while refreshing config', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Stale', workspaceId: workspace.id } });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ agent_name: 'Fresh' }));

    await syncWorkspaceAgents(workspace.id);

    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } })).workspaceId).toBe(
      workspace.id,
    );
  });

  it('marks nothing removed, since one workspace sees only part of the pool', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Mine', status: 'active', workspaceId: workspace.id },
    });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ status: 'active' }));

    const result = await syncWorkspaceAgents(workspace.id);

    expect(result.removed).toBe(0);
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } })).status).toBe('active');
  });

  it('reports how many agents failed rather than calling a total outage a success', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Mine', workspaceId: workspace.id } });
    await prisma.agent.create({ data: { externalId: 'ext-2', name: 'Also mine', workspaceId: workspace.id } });
    mockedGetAgent.mockRejectedValue(new Error('upstream down'));

    // Silently returning synced: 0 would tell the user the refresh worked.
    const result = await syncWorkspaceAgents(workspace.id);

    expect(result).toMatchObject({ synced: 0, failed: 2 });
  });

  it('skips an agent the platform no longer has and keeps syncing the rest', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({ data: { externalId: 'gone', name: 'Gone', workspaceId: workspace.id } });
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Stale', workspaceId: workspace.id } });
    mockedGetAgent.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new Error('404 from upstream');
      return upstreamAgent({ agent_name: 'Fresh' });
    });

    // One dead agent must not deny the workspace a refresh of the others.
    const result = await syncWorkspaceAgents(workspace.id);

    expect(result.synced).toBe(1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } })).name).toBe('Fresh');
  });

  it('skips a refresh that follows too closely on the last one', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Fresh', workspaceId: workspace.id },
    });
    // The cooldown is workspace state, and records the last *attempt*.
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { lastAgentSyncAt: new Date() },
    });
    mockedGetAgent.mockResolvedValue(upstreamAgent());

    // The route is a plain button click for any member; without a cooldown one
    // person can spend a partner rate limit every other workspace shares.
    const result = await syncWorkspaceAgents(workspace.id);

    expect(result).toMatchObject({ synced: 0, skipped: true });
    expect(mockedGetAgent).not.toHaveBeenCalled();
  });

  it('refreshes again once the cooldown has passed', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Stale', workspaceId: workspace.id },
    });
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { lastAgentSyncAt: new Date(Date.now() - 10 * 60_000) },
    });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ agent_name: 'Fresh' }));

    const result = await syncWorkspaceAgents(workspace.id);

    expect(result.synced).toBe(1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } })).name).toBe('Fresh');
  });

  it('does nothing when the workspace has no agents', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const result = await syncWorkspaceAgents(workspace.id);

    expect(result).toEqual({ synced: 0, removed: 0 });
    expect(mockedGetAgent).not.toHaveBeenCalled();
    expect(mockedListAgents).not.toHaveBeenCalled();
  });
});

describe('sync safety guards', () => {
  it('keeps throttling a workspace whose every agent fails to refresh', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'gone', name: 'Gone', workspaceId: workspace.id },
    });
    mockedGetAgent.mockRejectedValue(new Error('404 from upstream'));

    const first = await syncWorkspaceAgents(workspace.id);
    expect(first).toMatchObject({ synced: 0, failed: 1 });

    // The agent's `lastSyncedAt` is still null, because nothing succeeded.
    // Deriving the cooldown from it therefore left this workspace permanently
    // unthrottled: every click fanned out again against the shared partner
    // limit, for as long as the agent stayed unreachable.
    const second = await syncWorkspaceAgents(workspace.id);

    expect(second).toMatchObject({ skipped: true });
    expect(mockedGetAgent).toHaveBeenCalledTimes(1);
  });

  it('retires an agent whose status was never set', async () => {
    // `status` is nullable and upstream omits it often. Written as
    // `status: { not: 'removed' }` the predicate is SQL `status <> 'removed'`,
    // which is NULL for a NULL status and therefore does not match — so these
    // agents were exempt from removal forever while the run reported success.
    await prisma.agent.create({ data: { externalId: 'gone', name: 'No Status' } });
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Present' } });

    pages([upstreamAgent()]);
    const result = await syncAllAgents();

    expect(result.removed).toBe(1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'gone' } })).status).toBe(
      'removed',
    );
  });

  it('fans out once when several refreshes arrive together', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'One', workspaceId: workspace.id },
    });
    mockedGetAgent.mockResolvedValue(upstreamAgent());

    // Read-then-act would let all five observe the same pre-cooldown state and
    // all five fan out; the window has to be claimed, not merely observed.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => syncWorkspaceAgents(workspace.id)),
    );

    expect(results.filter((r) => r.skipped)).toHaveLength(4);
    expect(mockedGetAgent).toHaveBeenCalledTimes(1);
  });

  it('refuses removal when a complete listing covers a fraction of the mirror', async () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      await prisma.agent.create({ data: { externalId: id, name: id.toUpperCase() } });
    }

    // Complete and non-empty, so neither existing guard fires — but a key
    // scoped to the wrong partner looks exactly like this, and believing it
    // retires three live agents.
    pages([upstreamAgent({ id: 'a' })]);

    const result = await syncAllAgents();

    expect(result).toMatchObject({ removed: 0, truncated: true });
    expect(await prisma.agent.count({ where: { status: 'removed' } })).toBe(0);
  });

  it('still retires agents when the listing covers most of the mirror', async () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      await prisma.agent.create({ data: { externalId: id, name: id.toUpperCase() } });
    }
    pages([upstreamAgent({ id: 'a' }), upstreamAgent({ id: 'b' }), upstreamAgent({ id: 'c' })]);

    const result = await syncAllAgents();

    expect(result).toMatchObject({ removed: 1 });
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'd' } })).status).toBe(
      'removed',
    );
  });

  it('ends the walk instead of looping when upstream ignores the offset', async () => {
    const page = Array.from({ length: 100 }, (_, i) => upstreamAgent({ id: `ext-${i}` }));
    // Every request returns page 0. Without a no-progress check this runs to
    // the page cap and issues maxPages * 100 redundant upserts.
    mockedListAgents.mockResolvedValue({ agents: page, total: 100, limit: 100, offset: 0 });

    const result = await syncAllAgents({ maxPages: 10 });

    expect(mockedListAgents).toHaveBeenCalledTimes(2);
    expect(result.synced).toBe(100);
    expect(result.truncated).toBe(true);
    expect(await prisma.agent.count()).toBe(100);
  });
});

describe('refreshAgent', () => {
  it('rewrites the mirror row from a fresh fetch', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Old Name', workspaceId: workspace.id },
    });
    mockedListVoices.mockResolvedValue({ voices: [{ id: 'voice-1', display_name: 'Anisha' }] });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ agent_name: 'New Name' }));

    const refreshed = await refreshAgent('ext-1');

    expect(refreshed.name).toBe('New Name');
    expect(refreshed.voiceName).toBe('Anisha');
  });

  it('leaves the assignment alone, the same as a sync does', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Old Name', workspaceId: workspace.id },
    });
    mockedListVoices.mockResolvedValue({ voices: [] });
    mockedGetAgent.mockResolvedValue(upstreamAgent({ agent_name: 'New Name' }));

    const refreshed = await refreshAgent('ext-1');

    expect(refreshed.workspaceId).toBe(workspace.id);
  });

  it('propagates an upstream failure rather than reporting a stale row as fresh', async () => {
    mockedListVoices.mockResolvedValue({ voices: [] });
    mockedGetAgent.mockRejectedValue(new Error('upstream down'));

    await expect(refreshAgent('ext-1')).rejects.toThrow('upstream down');
  });
});

describe('assignAgent', () => {
  it('mirrors a newly created agent and assigns it in one write', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    mockedListVoices.mockResolvedValue({ voices: [{ id: 'voice-1', display_name: 'Anisha' }] });

    const agent = await assignAgent('ext-new', workspace.id, upstreamAgent({ id: 'ext-new' }));

    expect(agent.workspaceId).toBe(workspace.id);
    expect(agent.name).toBe('Salon Receptionist');
    expect(agent.voiceName).toBe('Anisha');
    expect(await prisma.agent.count()).toBe(1);
  });

  it('claims an agent that is already mirrored but unassigned', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Orphan', workspaceId: null } });
    mockedListVoices.mockResolvedValue({ voices: [] });

    const agent = await assignAgent('ext-1', workspace.id, upstreamAgent());

    expect(agent.workspaceId).toBe(workspace.id);
    expect(await prisma.agent.count()).toBe(1);
  });
});

describe('sync and workspace resources', () => {
  it('never creates or alters a resource mapping', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await prisma.workspaceResource.create({
      data: { kind: 'DICTIONARY', externalId: 'dict-1', workspaceId: workspace.id },
    });
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Mine', workspaceId: workspace.id },
    });
    mockedListVoices.mockResolvedValue({ voices: [] });
    pages([upstreamAgent()]);

    await syncAllAgents();

    const mappings = await prisma.workspaceResource.findMany();
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ externalId: 'dict-1', workspaceId: workspace.id });
  });
});
