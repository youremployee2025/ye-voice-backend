import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { reassignResource } from '../src/lib/workspaceResource.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  deleteAgent: vi.fn(),
  // Assignment strips whatever the incoming workspace does not own before it
  // hands the agent over, so it reads these three and may write to them.
  getAgentDictionaries: vi.fn(),
  replaceAgentDictionaries: vi.fn(),
  detachFunction: vi.fn(),
  unlinkDocument: vi.fn(),
}));

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

async function makeAgent(externalId: string, workspace: Workspace | null = null) {
  return prisma.agent.create({
    data: {
      externalId,
      name: `Agent ${externalId}`,
      status: 'active',
      workspaceId: workspace?.id ?? null,
    },
  });
}

/** Nothing attached, which is the shape every case that is not about the
 *  handover wants. Cases that *are* about it override these. */
function nothingAttached() {
  vi.mocked(client.getAgentDictionaries).mockResolvedValue({ dictionaries: [] });
  vi.mocked(client.getAgentFunctions).mockResolvedValue({ functions: [] });
  vi.mocked(client.getAgentDocuments).mockResolvedValue({ documents: [] });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });
  vi.mocked(client.listAgents).mockResolvedValue({ agents: [] });
  nothingAttached();
});

describe('staff authentication on admin routes', () => {
  const routes: Array<[string, string]> = [
    ['get', '/api/admin/agents'],
    ['post', '/api/admin/agents/sync'],
    ['post', '/api/admin/agents/any-id/assignment'],
  ];

  for (const [method, path] of routes) {
    it(`rejects ${method.toUpperCase()} ${path} without a token`, async () => {
      const res = await (method === 'get' ? request(app).get(path) : request(app).post(path).send({}));

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it(`rejects ${method.toUpperCase()} ${path} with a wrong token`, async () => {
      const res = await (method === 'get'
        ? request(app).get(path).set('X-Admin-Token', 'nope')
        : request(app).post(path).set('X-Admin-Token', 'nope').send({}));

      expect(res.status).toBe(401);
    });
  }

  it('does not accept a Clerk identity in place of the staff token', async () => {
    await makeAccount('alice');

    const res = await request(app)
      .get('/api/admin/agents')
      .set('X-Test-Clerk-User', 'user_alice|alice@ezo.test');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/agents', () => {
  it('lists the whole pool with each agent current workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAgent('assigned', workspace);
    await makeAgent('pooled', null);

    const res = await request(app).get('/api/admin/agents').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const assigned = res.body.data.find((a: { name: string }) => a.name === 'Agent assigned');
    const pooled = res.body.data.find((a: { name: string }) => a.name === 'Agent pooled');
    expect(assigned.workspace).toMatchObject({ id: workspace.id, name: 'Alice Co' });
    expect(pooled.workspace).toBeNull();
  });

  it('exposes the upstream id to staff, who need it to match agents up', async () => {
    await makeAgent('ext-1');

    const res = await request(app).get('/api/admin/agents').set(...staff());

    expect(res.body.data[0].external_id).toBe('ext-1');
  });

  it('returns only unassigned agents for assigned=false', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAgent('assigned', workspace);
    await makeAgent('pooled', null);

    const res = await request(app).get('/api/admin/agents?assigned=false').set(...staff());

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Agent pooled');
  });

  it('returns only assigned agents for assigned=true', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAgent('assigned', workspace);
    await makeAgent('pooled', null);

    const res = await request(app).get('/api/admin/agents?assigned=true').set(...staff());

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Agent assigned');
  });

  it('rejects an assigned filter that is neither true nor false', async () => {
    const res = await request(app).get('/api/admin/agents?assigned=maybe').set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/admin/agents/sync', () => {
  it('syncs the global pool and reports counts', async () => {
    vi.mocked(client.listAgents).mockResolvedValue({
      agents: [{ id: 'ext-1', agent_name: 'Front Desk' }],
    });

    const res = await request(app).post('/api/admin/agents/sync').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ synced: 1, removed: 0 });
    expect(await prisma.agent.count()).toBe(1);
  });

  it('syncs agents into the pool unassigned', async () => {
    vi.mocked(client.listAgents).mockResolvedValue({
      agents: [{ id: 'ext-1', agent_name: 'Front Desk' }],
    });

    await request(app).post('/api/admin/agents/sync').set(...staff());

    const row = await prisma.agent.findUniqueOrThrow({ where: { externalId: 'ext-1' } });
    expect(row.workspaceId).toBeNull();
  });
});

describe('POST /api/admin/agents/:id/assignment', () => {
  it('assigns an unassigned agent to a workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1');

    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(200);
    expect(res.body.data.workspace).toMatchObject({ id: workspace.id });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId).toBe(
      workspace.id,
    );
  });

  it('moves an agent from one workspace to another', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const first = await makeWorkspace(alice, 'Alice Co');
    const second = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', first);

    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({ workspaceId: second.id });

    expect(res.status).toBe(200);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId).toBe(
      second.id,
    );
  });

  /**
   * The reason assignment is not a plain overwrite.
   *
   * Dictionaries, functions and documents are partner-level: they do not
   * belong to the agent and do not travel with it. Handing the agent over
   * without stripping them let the incoming workspace read the previous one's
   * endpoint URLs and term lists — and left the agent answering their calls
   * out of the previous tenant's knowledge base.
   */
  it("strips the previous workspace's resources before handing the agent over", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const first = await makeWorkspace(alice, 'Alice Co');
    const second = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', first);

    await reassignResource('DICTIONARY', 'dict-alice', first.id);
    await reassignResource('FUNCTION', 'fn-alice', first.id);
    await reassignResource('DOCUMENT', 'doc-alice', first.id);
    // Bob's own, already attached — must survive the move.
    await reassignResource('DICTIONARY', 'dict-bob', second.id);

    vi.mocked(client.getAgentDictionaries).mockResolvedValue({
      dictionaries: [{ id: 'dict-alice' }, { id: 'dict-bob' }],
    });
    vi.mocked(client.getAgentFunctions).mockResolvedValue({ functions: [{ id: 'fn-alice' }] });
    vi.mocked(client.getAgentDocuments).mockResolvedValue({ documents: [{ id: 'doc-alice' }] });
    vi.mocked(client.replaceAgentDictionaries).mockResolvedValue({ dictionaries: [] });

    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({ workspaceId: second.id });

    expect(res.status).toBe(200);
    // Alice's dictionary dropped, Bob's kept.
    expect(vi.mocked(client.replaceAgentDictionaries)).toHaveBeenCalledWith('ext-1', ['dict-bob']);
    expect(vi.mocked(client.detachFunction)).toHaveBeenCalledWith('ext-1', 'fn-alice');
    // Unlinked, never deleted: the file is Alice's and stays in her library.
    expect(vi.mocked(client.unlinkDocument)).toHaveBeenCalledWith('ext-1', 'doc-alice');
    expect(vi.mocked(client.deleteAgent)).not.toHaveBeenCalled();
  });

  it('does not move the agent when the strip cannot be completed', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const first = await makeWorkspace(alice, 'Alice Co');
    const second = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', first);

    await reassignResource('FUNCTION', 'fn-alice', first.id);
    vi.mocked(client.getAgentFunctions).mockResolvedValue({ functions: [{ id: 'fn-alice' }] });
    vi.mocked(client.detachFunction).mockRejectedValue(new Error('upstream down'));

    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({ workspaceId: second.id });

    // Fail-closed. An agent that stays put can be moved again in a minute; one
    // that moved carrying the previous tenant's knowledge base cannot be
    // un-moved.
    expect(res.status).toBe(502);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId).toBe(
      first.id,
    );
  });

  it('returns an agent to the pool when workspaceId is null', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({ workspaceId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.workspace).toBeNull();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId).toBeNull();
  });

  it('rejects an unknown workspace and leaves the agent as it was', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({ workspaceId: 'no-such-workspace' });

    expect(res.status).toBe(404);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId).toBe(
      workspace.id,
    );
  });

  it('returns 404 for an unknown agent', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post('/api/admin/agents/no-such-agent/assignment')
      .set(...staff())
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(404);
  });

  it('rejects a body with no workspaceId field at all', async () => {
    const agent = await makeAgent('ext-1');

    // Unassigning must be stated explicitly as null, never inferred from an
    // omitted field, or a malformed request would silently un-share an agent.
    const res = await request(app)
      .post(`/api/admin/agents/${agent.id}/assignment`)
      .set(...staff())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/admin/agents/:agentId', () => {
  it('deletes upstream and drops the mirror row when the confirm token matches', async () => {
    const agent = await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Doomed' },
    });
    vi.mocked(client.deleteAgent).mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/admin/agents/${agent.id}`)
      .set('X-Admin-Token', TOKEN)
      .send({ confirm: 'ext-1' });

    expect(res.status).toBe(200);
    expect(client.deleteAgent).toHaveBeenCalledExactlyOnceWith('ext-1');
    expect(await prisma.agent.findUnique({ where: { id: agent.id } })).toBeNull();
  });

  it('refuses without a confirm token, and touches nothing', async () => {
    const agent = await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Doomed' } });

    const res = await request(app)
      .delete(`/api/admin/agents/${agent.id}`)
      .set('X-Admin-Token', TOKEN)
      .send({});

    expect(res.status).toBe(400);
    expect(client.deleteAgent).not.toHaveBeenCalled();
    expect(await prisma.agent.findUnique({ where: { id: agent.id } })).not.toBeNull();
  });

  it('refuses a confirm token naming a different agent', async () => {
    // The token is the agent's own upstream id, so it cannot be supplied by
    // anyone who has not deliberately looked this agent up. A boolean is
    // something a misrouted script sends by accident.
    const agent = await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Doomed' } });

    const res = await request(app)
      .delete(`/api/admin/agents/${agent.id}`)
      .set('X-Admin-Token', TOKEN)
      .send({ confirm: 'ext-2' });

    expect(res.status).toBe(400);
    expect(client.deleteAgent).not.toHaveBeenCalled();
    expect(await prisma.agent.findUnique({ where: { id: agent.id } })).not.toBeNull();
  });

  it('refuses without the staff token', async () => {
    const agent = await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Doomed' } });

    const res = await request(app).delete(`/api/admin/agents/${agent.id}`).send({ confirm: 'ext-1' });

    expect(res.status).toBe(401);
    expect(client.deleteAgent).not.toHaveBeenCalled();
  });

  it('answers 404 for an agent that does not exist', async () => {
    const res = await request(app)
      .delete('/api/admin/agents/nope')
      .set('X-Admin-Token', TOKEN)
      .send({ confirm: 'ext-1' });

    expect(res.status).toBe(404);
  });

  it('keeps the mirror row when the upstream delete fails', async () => {
    const agent = await prisma.agent.create({ data: { externalId: 'ext-1', name: 'Doomed' } });
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.deleteAgent).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .delete(`/api/admin/agents/${agent.id}`)
      .set('X-Admin-Token', TOKEN)
      .send({ confirm: 'ext-1' });

    expect(res.status).toBe(502);
    // Dropping the mirror first would hide an agent that still exists upstream.
    expect(await prisma.agent.findUnique({ where: { id: agent.id } })).not.toBeNull();
  });
});
