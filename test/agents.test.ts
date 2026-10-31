import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';
import { reassignResource as mapResource } from '../src/lib/workspaceResource.js';

// No test may reach the real partner API.
vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

async function makeAgent(
  externalId: string,
  workspace: Workspace | null,
  overrides: Record<string, unknown> = {},
): Promise<Agent> {
  return prisma.agent.create({
    data: {
      externalId,
      name: `Agent ${externalId}`,
      status: 'active',
      voiceId: 'voice-1',
      voiceName: 'Anisha',
      language: 'en',
      documentCount: 2,
      variables: ['business_name'],
      rawConfig: {
        id: 'ext-secret',
        prompt: 'hello',
        transfer_enabled: true,
        partner_webhook_url: 'https://internal.example/hook',
      },
      lastSyncedAt: new Date(),
      workspaceId: workspace?.id ?? null,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });
});

describe('GET /api/workspaces/:id/agents', () => {
  it('lists this workspace agents in the documented shape', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAgent('ext-1', workspace);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      name: 'Agent ext-1',
      agent_type: null,
      status: 'active',
      voice: 'Anisha',
      language: 'en',
      document_count: 2,
    });
    expect(res.body.data[0].last_synced_at).toBeTruthy();
  });

  it('never exposes the upstream agent id', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    // The name deliberately does not echo the upstream id, so the assertion
    // catches the serializer leaking it rather than the fixture.
    const agent = await makeAgent('ext-secret', workspace, { name: 'Front Desk' });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].id).toBe(agent.id);
    expect(JSON.stringify(res.body)).not.toContain('ext-secret');
  });

  it('hides agents belonging to another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await makeAgent('mine', mine);
    await makeAgent('theirs', theirs);

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Agent mine');
  });

  it('hides unassigned agents from every workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAgent('unassigned', null);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toEqual([]);
  });

  it('lets a MEMBER read the list', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    await makeAgent('ext-1', workspace);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('forbids a non-member', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAccount('mallory');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('GET /api/workspaces/:id/agents/:agentId', () => {
  it('returns the cached configuration', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: agent.id,
      name: 'Agent ext-1',
      variables: ['business_name'],
      config: { prompt: 'hello', transfer_enabled: true },
    });
  });

  it('does not echo the upstream agent id through the config snapshot', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-secret', workspace, { name: 'Front Desk' });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('ext-secret');
  });

  it('passes through only known configuration fields, never the whole record', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // A field the platform adds later must not reach customers by default.
    expect(res.body.data.config).not.toHaveProperty('partner_webhook_url');
    expect(res.body.data.config).not.toHaveProperty('id');
  });

  it('returns 404 for an agent owned by another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const hidden = await makeAgent('theirs', theirs);

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${hidden.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // 404 rather than 403: a 403 would confirm the id names a real agent.
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unassigned agent', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const pooled = await makeAgent('unassigned', null);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${pooled.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
  });

  it('returns 404 for an id that names no agent at all', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/does-not-exist`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
  });
});

describe('agent sub-resources', () => {
  // `documents` is not here: the knowledge base is no longer a plain proxy —
  // it merges sync state and carries per-row ownership — so it is covered by
  // its own suite, including the same leak assertions made below.
  const cases = [
    [
      'functions',
      'getAgentFunctions',
      { functions: [{ id: 'f1', name: 'get_weather', enabled: true }] },
      // `id` is part of the contract: the dashboard toggles and detaches a
      // function by it, and without it both controls were inert. `owned` says
      // whether this workspace may read the endpoint — false here, because the
      // case does not map it.
      [
        {
          id: 'f1',
          name: 'get_weather',
          description: null,
          method: null,
          url: null,
          enabled: true,
          owned: false,
        },
      ],
    ],
    [
      'tools',
      'getAgentTools',
      { tools: [{ toolSlug: 'google_sheets', enabled: false, connectionId: 'conn_9' }] },
      [
        {
          toolSlug: 'google_sheets',
          toolName: null,
          enabled: false,
          connectionStatus: null,
          providerEmail: null,
          // Tools rows say whether the workspace owns the connection, the
          // same flag the attached function and dictionary rows carry.
          owned: true,
        },
      ],
    ],
  ] as const;

  for (const [suffix, method, payload, expected] of cases) {
    it(`serialises ${suffix} to the allow-listed shape`, async () => {
      const alice = await makeAccount('alice');
      const workspace = await makeWorkspace(alice, 'Alice Co');
      const agent = await makeAgent('ext-1', workspace);
      // A tools row is only visible once the connection it names belongs to
      // this workspace — upstream returns the whole partner account's.
      if (suffix === 'tools') await mapResource('CONNECTION', 'conn_9', workspace.id);
      vi.mocked(client[method]).mockResolvedValue(payload);

      const res = await request(app)
        .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/${suffix}`)
        .set(...as('user_alice', 'alice@ezo.test'));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expected);
      // The upstream id, not the local one, identifies the agent upstream.
      expect(vi.mocked(client[method])).toHaveBeenCalledWith('ext-1');
    });

    it(`returns 404 on ${suffix} for another workspace's agent without calling upstream`, async () => {
      const alice = await makeAccount('alice');
      const bob = await makeAccount('bob');
      const mine = await makeWorkspace(alice, 'Alice Co');
      const theirs = await makeWorkspace(bob, 'Bob Co');
      const hidden = await makeAgent('theirs', theirs);

      const res = await request(app)
        .get(`/api/workspaces/${mine.id}/agents/${hidden.id}/${suffix}`)
        .set(...as('user_alice', 'alice@ezo.test'));

      expect(res.status).toBe(404);
      expect(vi.mocked(client[method])).not.toHaveBeenCalled();
    });
  }

  /**
   * The property under test is not "these fields are correct" but "nothing
   * else survives". A filter would pass the first assertion and fail this one
   * the day Vocobase adds a field, which is precisely the failure this suite
   * exists to prevent.
   */
  it('drops upstream identifiers and unknown fields from every sub-resource', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const hostile = {
      agent_id: 'ext-1',
      agentId: 'ext-1',
      id: 'upstream-row-1',
      connectionId: 'conn_9',
      webhook_url: 'https://hooks.vocobase.com/secret',
      callback_token: 'rg_live_abc123',
      partner_id: 'partner_42',
    };

    vi.mocked(client.getAgentFunctions).mockResolvedValue({
      functions: [{ ...hostile, name: 'get_weather' }],
    });
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [{ ...hostile, toolSlug: 'google_sheets' }],
    });
    // Mapped so the row reaches the serializer at all; the point of this case
    // is what the serializer drops, not what the mapping filter drops.
    await mapResource('CONNECTION', 'conn_9', workspace.id);

    for (const suffix of ['functions', 'tools'] as const) {
      const res = await request(app)
        .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/${suffix}`)
        .set(...as('user_alice', 'alice@ezo.test'));

      expect(res.status).toBe(200);

      const body = JSON.stringify(res.body);
      for (const [key, secret] of Object.entries(hostile)) {
        if (suffix === 'functions' && key === 'id') continue;
        expect(body, `${suffix} leaked ${secret}`).not.toContain(secret);
      }

      for (const key of Object.keys(hostile)) {
        // `id` on a function is the resource's own id, which this workspace
        // needs in order to toggle or detach it — the same id the function
        // library already returns. Every other identifier here belongs to
        // upstream's plumbing and must not appear.
        if (suffix === 'functions' && key === 'id') continue;
        expect(res.body.data[0], `${suffix} kept key ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('drops a tools row whose connection cannot be read, rather than throwing', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: ['nonsense', null, 42] as never });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // None of these is a row. They used to fall out of the connection
    // intersect by accident; "no connection id" now means a built-in, which
    // is kept, so they are dropped for what they actually are instead. Still
    // no throw: a malformed payload costs a row, never the request.
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('yields nulls rather than throwing when a mapped row is missing fields', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await mapResource('CONNECTION', 'conn_9', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [{ connectionId: 'conn_9' }] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].toolSlug).toBeNull();
    expect(res.body.data[0].enabled).toBeNull();
  });

  it('returns an empty array when the upstream collection is absent', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentTools).mockResolvedValue({});

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('surfaces an upstream failure as 502 UPSTREAM_ERROR', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentDocuments).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('POST /api/workspaces/:id/agents/sync', () => {
  it('refreshes this workspace agents and leaves other workspaces alone', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    // Synced long ago, so the refresh is outside the cooldown.
    await makeAgent('ext-1', mine, { name: 'Stale', lastSyncedAt: new Date(Date.now() - 600_000) });
    await makeAgent('ext-2', theirs, { name: 'Theirs' });

    vi.mocked(client.getAgent).mockResolvedValue({ id: 'ext-1', agent_name: 'Fresh' });

    const res = await request(app)
      .post(`/api/workspaces/${mine.id}/agents/sync`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ synced: 1 });
    // Only this workspace's agent is fetched — a member cannot make the
    // backend walk the whole platform.
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1');
    expect(vi.mocked(client.listAgents)).not.toHaveBeenCalled();
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } })).name).toBe('Fresh');
    expect((await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-2' } })).name).toBe('Theirs');
  });

  it('reports a skipped refresh instead of spending the shared rate limit again', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAgent('ext-1', workspace);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { lastAgentSyncAt: new Date() },
    });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/sync`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ skipped: true });
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });

  it('is reachable by a MEMBER, since it refreshes a view rather than changing an agent', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/sync`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(200);
  });

  it('is not mistaken for an agent id', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/sync`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('synced');
  });

  it('forbids a non-member', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAccount('mallory');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/sync`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('GET /api/workspaces/:id/voices', () => {
  it('returns the catalogue projected to an allow-list', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.listVoices).mockResolvedValue({
      voices: [
        {
          id: 'voice-1',
          display_name: 'Anisha',
          description: 'Warm, unhurried.',
          language: 'en',
          gender: 'female',
          // Fields the catalogue may carry that a workspace has no business
          // holding — the same hazard the sub-resource allow-lists exist for.
          provider_voice_id: 'eleven-xyz',
          partner_id: 'partner-1',
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/voices`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    // No `tier` on the row, so it is untiered and offered to everybody —
    // which is why this workspace, holding no tier at all, still sees it.
    expect(res.body.data).toEqual([
      {
        id: 'voice-1',
        name: 'Anisha',
        description: 'Warm, unhurried.',
        language: 'en',
        gender: 'female',
        tier: null,
        tier_name: null,
      },
    ]);
  });

  it('reports an unreachable catalogue as an upstream failure, not an empty list', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.listVoices).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/voices`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });

  it('refuses a non-member', async () => {
    const alice = await makeAccount('alice');
    await makeAccount('mallory');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/voices`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('the config allow-list and the update payload', () => {
  /**
   * Asserted against what the serializer actually emits, not against a list of
   * names exempted by hand.
   *
   * The exemption list version of this test passed while `voice_id` was
   * unreadable on every agent: it was named as living "on the row", and it
   * does — under the key `voice`, holding the resolved display name rather than
   * the id the update payload takes. An allow-list checked against another
   * allow-list cannot catch that. Serializing a row can.
   */
  it('emits a readable value for every field a workspace is allowed to write', async () => {
    const { serializeAgentDetail } = await import('../src/lib/serialize.js');
    const { WRITABLE_AGENT_FIELDS, VISIBLE_CONFIG_KEYS } = await import(
      '../src/lib/agentPayload.js'
    ).then(async (payload) => ({
      ...payload,
      ...(await import('../src/lib/serialize.js')),
    }));

    // A row whose snapshot carries every config key the platform can send, so
    // the only reason a writable field can be missing below is the serializer.
    const row = {
      id: 'local-1',
      externalId: 'ext-1',
      workspaceId: 'ws-1',
      name: 'Reception',
      status: 'active',
      agentType: 'inbound',
      voiceId: 'voice-1',
      voiceName: 'Anisha',
      language: 'en',
      documentCount: 0,
      variables: [],
      rawConfig: Object.fromEntries(VISIBLE_CONFIG_KEYS.map((key) => [key, 'set'])),
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const detail = serializeAgentDetail(row as unknown as Parameters<typeof serializeAgentDetail>[0]);
    const config = (detail.config ?? {}) as Record<string, unknown>;

    // `agent_name` and `agent_type` are emitted under the names the read side
    // uses; every other writable field keeps its payload name.
    const alias: Record<string, string> = { agent_name: 'name', agent_type: 'agent_type' };

    const unreadable = WRITABLE_AGENT_FIELDS.filter((field) => {
      const key = alias[field] ?? field;
      return !(key in detail) && !(key in config);
    });

    expect(unreadable).toEqual([]);
  });

  it('emits the voice id as well as the voice name', async () => {
    const { serializeAgentDetail } = await import('../src/lib/serialize.js');

    const detail = serializeAgentDetail({
      id: 'local-1',
      externalId: 'ext-1',
      workspaceId: 'ws-1',
      name: 'Reception',
      status: null,
      agentType: null,
      voiceId: 'voice-1',
      voiceName: 'Anisha',
      language: null,
      documentCount: null,
      variables: [],
      rawConfig: null,
      lastSyncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof serializeAgentDetail>[0]);

    // The display name and the writable id are different values under
    // different keys, and a form needs both: one to show, one to send back.
    expect(detail.voice).toBe('Anisha');
    expect(detail.voice_id).toBe('voice-1');
  });
});

/**
 * The two structured config fields.
 *
 * Everything else on `VISIBLE_CONFIG_KEYS` is a scalar, so allowing the key
 * and allowing the value were the same act. These two are JSON the platform
 * controls, and passing one through would publish whatever it adds to that
 * shape next, to every workspace member, with no code change here and no test
 * failing. So they are rebuilt rather than filtered — and these cases are what
 * says so.
 */
describe('the structured config fields', () => {
  const row = (rawConfig: unknown) => ({
    id: 'local-1',
    externalId: 'ext-1',
    workspaceId: 'ws-1',
    name: 'Reception',
    status: 'active',
    agentType: 'inbound',
    voiceId: 'voice-1',
    voiceName: 'Anisha',
    language: 'en',
    documentCount: 0,
    variables: [],
    rawConfig,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  async function detailOf(rawConfig: unknown) {
    const { serializeAgentDetail } = await import('../src/lib/serialize.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return serializeAgentDetail(row(rawConfig) as any);
  }

  describe('transfer_destinations', () => {
    const destination = {
      key: 'sales_desk',
      label: 'Sales desk',
      number: '+919876543210',
      llmDescription: 'Pricing and new business.',
    };

    it('is readable', async () => {
      const detail = await detailOf({ transfer_destinations: [destination] });

      expect(detail.config?.transfer_destinations).toEqual([destination]);
    });

    it('is rebuilt, so a key the platform adds next does not reach the browser', async () => {
      const detail = await detailOf({
        transfer_destinations: [{ ...destination, internal_route_id: 'route-77' }],
      });

      expect(detail.config?.transfer_destinations).toEqual([destination]);
    });

    it('drops an entry that is not an object rather than emitting a hole', async () => {
      const detail = await detailOf({ transfer_destinations: [destination, 'nope', null] });

      expect(detail.config?.transfer_destinations).toEqual([destination]);
    });

    /** An absent catalogue and an emptied one are different facts, and the
     *  UI branches on which. */
    it('keeps an empty catalogue apart from an absent one', async () => {
      expect((await detailOf({ transfer_destinations: [] })).config?.transfer_destinations).toEqual(
        [],
      );
      expect((await detailOf({})).config?.transfer_destinations).toBeNull();
    });

    it('reads a malformed snapshot value as null rather than throwing', async () => {
      const detail = await detailOf({ transfer_destinations: 'corrupted' });

      expect(detail.config?.transfer_destinations).toBeNull();
    });
  });

  describe('extraction_config', () => {
    const config = {
      prompt: 'Extract the caller intent.',
      keys: [
        { name: 'intent', type: 'string', description: 'What they wanted.', analytics: true, values: ['Hot', 'Cold'] },
      ],
      includeToolLogs: false,
      inlineEnabled: true,
    };

    it('is readable', async () => {
      const detail = await detailOf({ extraction_config: config });

      expect(detail.config?.extraction_config).toEqual(config);
    });

    it('is rebuilt, so a key the platform adds next does not reach the browser', async () => {
      const detail = await detailOf({
        extraction_config: { ...config, internal_model: 'gpt-4', keys: config.keys },
      });

      expect(detail.config?.extraction_config).toEqual(config);
    });

    it('rebuilds each key, dropping anything unrecognised', async () => {
      const detail = await detailOf({
        extraction_config: {
          prompt: 'x',
          keys: [{ name: 'intent', type: 'string', internal_weight: 3 }],
        },
      });

      expect(
        (detail.config?.extraction_config as { keys: unknown[] }).keys[0],
      ).toEqual({ name: 'intent', type: 'string' });
    });

    it('reads a malformed snapshot value as null rather than throwing', async () => {
      expect((await detailOf({ extraction_config: 'corrupted' })).config?.extraction_config).toBeNull();
      expect((await detailOf({ extraction_config: [] })).config?.extraction_config).toBeNull();
    });

    it('is null on an agent that has never had one', async () => {
      expect((await detailOf({})).config?.extraction_config).toBeNull();
    });
  });

  /**
   * Removed from this surface entirely, not moved. The backend no longer
   * forwards them either, so an agent's stored values are left exactly as
   * they are and simply stop being editable here.
   */
  describe('the removed knowledge-base fields', () => {
    it.each(['kb_threshold', 'kb_include_summaries', 'kb_result_format'])(
      'no longer reads %s, even when the snapshot carries it',
      async (field) => {
        const detail = await detailOf({ [field]: 'high', prompt: 'kept' });

        expect(detail.config).not.toHaveProperty(field);
        expect(detail.config).toHaveProperty('prompt', 'kept');
      },
    );
  });
});

describe('the voice catalogue', () => {
  it('carries the tier and description the picker groups and explains by', async () => {
    const { serializeVoices } = await import('../src/lib/serialize.js');

    expect(
      serializeVoices([
        {
          id: 'voice-1',
          display_name: 'Anisha',
          description: 'Warm, unhurried.',
          language: 'en',
          gender: 'female',
          tier: 'va-1-pro',
          provider_voice_id: 'supplier-internal-id',
        },
      ]),
    ).toEqual([
      {
        id: 'voice-1',
        name: 'Anisha',
        description: 'Warm, unhurried.',
        language: 'en',
        gender: 'female',
        tier: 'va-1-pro',
        // A slug the local tier mirror does not know renders no name — the
        // slug is internal vocabulary, not a product label.
        tier_name: null,
      },
    ]);
  });
});
