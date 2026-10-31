import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

// No test may reach the real partner API — it is production and holds live
// customer agents.
vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

const validBody = {
  agent_name: 'Reception',
  prompt: 'Answer politely.',
  voice_id: 'voice-1',
  agent_type: 'inbound',
};

function upstreamAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-new',
    agent_name: 'Reception',
    status: 'active',
    voice_id: 'voice-1',
    language: 'en',
    prompt: 'Answer politely.',
    ...overrides,
  };
}

async function makeAgent(externalId: string, workspace: Workspace | null): Promise<Agent> {
  return prisma.agent.create({
    data: {
      externalId,
      name: `Agent ${externalId}`,
      status: 'active',
      workspaceId: workspace?.id ?? null,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  // `restoreAllMocks`, not `clearAllMocks`: a case that spies on a Prisma
  // method leaves that implementation in place otherwise, and the next case
  // fails somewhere it never touched.
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });
  // The routes log upstream and orphan detail on purpose; the failure paths
  // under test would otherwise fill the run with expected noise.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/workspaces/:id/agents', () => {
  it('creates upstream and assigns the result to the calling workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(validBody);

    expect(res.status).toBe(201);
    const rows = await prisma.agent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: 'ext-new', workspaceId: workspace.id });
    // The local row id, never the platform's — the same contract the read
    // routes keep.
    expect(res.body.data.id).toBe(rows[0].id);
    expect(JSON.stringify(res.body)).not.toContain('ext-new');
  });

  it('lets a MEMBER create, deliberately unlike campaigns', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send(validBody);

    expect(res.status).toBe(201);
  });

  it('forwards only the platform-accepted fields', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ ...validBody, status: 'active', document_count: 9 });

    // Plus the recording default this route applies — see the block below.
    expect(vi.mocked(client.createAgent).mock.calls[0][0]).toEqual({
      ...validBody,
      enable_recording: true,
    });
  });

  /**
   * Recording is on for every agent this platform creates.
   *
   * Applied on the route rather than on a form, so the dashboard, the V2
   * partner API and a script all get it. A default on the form would cover one
   * caller of three and leave the others on whatever the platform defaults to.
   */
  it('turns recording on for an agent created without saying', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(validBody);

    expect(vi.mocked(client.createAgent).mock.calls[0]![0]).toMatchObject({
      enable_recording: true,
    });
  });

  /** A default, not an override: a caller that has decided not to record has
   *  decided, and the field stays editable on the agent afterwards. */
  it('honours an explicit refusal to record', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ ...validBody, enable_recording: false });

    expect(vi.mocked(client.createAgent).mock.calls[0]![0]).toMatchObject({
      enable_recording: false,
    });
  });

  it('rejects a body missing a required field before calling upstream', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agent_name: 'Reception' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(client.createAgent).not.toHaveBeenCalled();
  });

  it('reports a duplicate name as its own error', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.createAgent).mockRejectedValue(
      new ApiError(409, 'AGENT_NAME_TAKEN', 'An agent with that name already exists.'),
    );

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_NAME_TAKEN');
  });

  it('reports an agent it created but could not attach, rather than a bare failure', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());
    // Both the write and its one retry fail: the orphan case.
    vi.spyOn(prisma.agent, 'upsert').mockRejectedValue(new Error('db down'));

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(validBody);

    // Not a success, and not a generic 500 either — retrying a generic failure
    // would create a second agent upstream.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AGENT_CREATED_UNASSIGNED');
  });

  it('refuses a non-member before touching upstream', async () => {
    const alice = await makeAccount('alice');
    const mallory = await makeAccount('mallory');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    void mallory;

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_mallory', 'mallory@ezo.test'))
      .send(validBody);

    expect(res.status).toBe(403);
    expect(client.createAgent).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/workspaces/:id/agents/:agentId', () => {
  it('sends only the supplied fields and refreshes the mirror in the same request', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent({ id: 'ext-1' }));
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ id: 'ext-1', agent_name: 'Renamed' }),
    );

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'new prompt' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgent).mock.calls[0]).toEqual(['ext-1', { prompt: 'new prompt' }]);
    expect(res.body.data.name).toBe('Renamed');
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).name).toBe('Renamed');
  });

  it("answers 404 for another workspace's agent, without calling upstream", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .patch(`/api/workspaces/${mine.id}/agents/${foreign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'new' });

    expect(res.status).toBe(404);
    expect(client.updateAgent).not.toHaveBeenCalled();
  });

  it('answers 404 for an unassigned agent', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const orphan = await makeAgent('ext-orphan', null);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${orphan.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'new' });

    expect(res.status).toBe(404);
  });

  it('rejects an empty update rather than forwarding it', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({});

    expect(res.status).toBe(400);
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
});

/**
 * The server declares nothing on the caller's behalf.
 *
 * It cannot: an agent's pre-call lifecycle hooks are the other half of where a
 * `{{placeholder}}` gets its value, and this service never reads them on a
 * write. Declaring every flat placeholder it can see turns a name a hook
 * already supplies into a per-call variable nothing ever fills — which trades
 * a visible "this renders empty" warning for a confident, wrong claim that a
 * value is coming. The dashboard reads `/lifecycle-hooks` and can tell the two
 * apart; the backend cannot, so it must not guess.
 */
describe('the variables an agent write sends', () => {
  it('sends none of its own on create', async () => {
    const account = await makeAccount('alice');
    const workspace = await makeWorkspace(account, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ ...validBody, prompt: 'Hi {{name}}, about {{order_id}}' });

    expect(res.status).toBe(201);
    expect(vi.mocked(client.createAgent).mock.calls[0]![0]).not.toHaveProperty('variables');
  });

  it('sends none of its own on a prompt edit, and reads nothing upstream to decide', async () => {
    const account = await makeAccount('alice');
    const workspace = await makeWorkspace(account, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent({ id: 'ext-1' }));
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent({ id: 'ext-1' }));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Hi {{name}}' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgent).mock.calls[0]![1]).not.toHaveProperty('variables');
  });

  /**
   * The caller's own list still goes through untouched. Removing the
   * derivation removed a merge, not the field — the dashboard is what declares
   * variables now, and it does it by sending them.
   */
  it('sends the caller\u2019s list exactly as given', async () => {
    const account = await makeAccount('alice');
    const workspace = await makeWorkspace(account, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ ...validBody, prompt: 'Hi {{name}}', variables: ['order_id'] });

    expect(res.status).toBe(201);
    expect(vi.mocked(client.createAgent).mock.calls[0]![0]).toMatchObject({
      variables: ['order_id'],
    });
  });
});

/**
 * A supplied `variables` is a statement about what to ADD.
 *
 * `updateAgent` is a PUT, so the array is replaced wholesale — and every
 * caller builds its list from a copy of the agent that is already old. The
 * dashboard's is the local mirror, refreshed on a fifteen-minute timer and
 * then held for as long as the page stays open, so "the names I know about"
 * is never "the names the agent has". Sent verbatim it deletes the rest, and
 * `refreshAgent` mirrors the truncation so nothing ever looks wrong.
 *
 * This is the hazard the removed derivation used to carry, and removing the
 * derivation did not remove it — it moved it to whoever sends the field.
 */
describe('a caller-supplied variables list', () => {
  const patchWith = async (body: Record<string, unknown>) => {
    const account = await makeAccount('alice');
    const workspace = await makeWorkspace(account, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent({ id: 'ext-1' }));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(body);

    return { res, sent: vi.mocked(client.updateAgent).mock.calls[0]?.[1] };
  };

  it('keeps a name added on the platform since the caller read the agent', async () => {
    // The caller declares `order_id` from the prompt it is looking at. It has
    // never seen `added_on_the_platform`, because that arrived after its copy.
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ id: 'ext-1', variables: ['callee_name', 'added_on_the_platform'] }),
    );

    const { res, sent } = await patchWith({ variables: ['callee_name', 'order_id'] });

    expect(res.status).toBe(200);
    // The caller's own order first — those are the deliberate ones — then the
    // name only the platform knew about. Nothing is dropped.
    expect(sent).toMatchObject({
      variables: ['callee_name', 'order_id', 'added_on_the_platform'],
    });
  });

  it('reads upstream for the union rather than trusting the local mirror', async () => {
    // The mirror is behind, which is the normal state: it refreshes on a timer.
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ id: 'ext-1', variables: ['only_upstream'] }),
    );

    const { sent } = await patchWith({ variables: ['from_caller'] });

    expect(sent).toMatchObject({ variables: ['from_caller', 'only_upstream'] });
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1');
  });

  it('does not duplicate a name both sides already have', async () => {
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ id: 'ext-1', variables: ['shared'] }),
    );

    const { sent } = await patchWith({ variables: ['shared', 'new_one'] });

    expect(sent).toMatchObject({ variables: ['shared', 'new_one'] });
  });

  /**
   * An explicit `null` is the documented way to empty the list. Unioning onto
   * a clear would make the clear impossible to perform.
   */
  it('honours an explicit clear', async () => {
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ id: 'ext-1', variables: ['existing'] }),
    );

    const { sent } = await patchWith({ variables: null });

    expect(sent).toMatchObject({ variables: null });
  });

  /**
   * The common edit. A body that says nothing about variables must cost no
   * extra upstream call — the union is for writes that carry the field, and
   * `refreshAgent` afterwards is the only `getAgent` a prompt-only PATCH makes.
   */
  it('reads nothing upstream when the body carries no variables', async () => {
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent({ id: 'ext-1' }));

    const { sent } = await patchWith({ prompt: 'Hi {{name}}' });

    expect(sent).not.toHaveProperty('variables');
    // `refreshAgent` only. A second call would mean the union ran regardless.
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledTimes(1);
  });

  /**
   * A read we could not make is not a reason to fail the save. The caller's
   * names are at least names somebody typed; an empty union would be the same
   * data loss by another route.
   */
  it('sends the caller\u2019s list as given when the platform cannot be read', async () => {
    vi.mocked(client.getAgent)
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValue(upstreamAgent({ id: 'ext-1' }));

    const { res, sent } = await patchWith({ variables: ['from_caller'] });

    expect(res.status).toBe(200);
    expect(sent).toMatchObject({ variables: ['from_caller'] });
  });
});

describe('DELETE /api/workspaces/:id/agents/:agentId', () => {
  it('unassigns rather than deleting, and never calls upstream', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.workspaceId).toBeNull();
    expect(client.deleteAgent).not.toHaveBeenCalled();
  });

  it('refuses while a campaign in the workspace still points at the agent', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Winter outreach', agentId: agent.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_IN_USE');
    // Naming the campaign is the whole reason this is a counted check rather
    // than a foreign-key violation.
    expect(res.body.error.message).toContain('Winter outreach');
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId).toBe(
      workspace.id,
    );
  });

  it("ignores another workspace's campaign pointing at the same agent", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', mine);
    await prisma.campaign.create({
      data: { workspaceId: theirs.id, name: 'Not mine', agentId: agent.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${mine.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
  });

  it("answers 404 for another workspace's agent", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .delete(`/api/workspaces/${mine.id}/agents/${foreign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: foreign.id } })).workspaceId,
    ).toBe(theirs.id);
  });
});
