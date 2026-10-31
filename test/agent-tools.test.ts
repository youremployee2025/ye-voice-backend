import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';
// Fixtures place a resource wherever the case needs it, which is the staff
// call's job. `claimResource` — the customer path — deliberately refuses to
// move one, so it cannot arrange a foreign-ownership case.
import { reassignResource as mapResource } from '../src/lib/workspaceResource.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  getAvailableConnections: vi.fn(),
  setAgentTool: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

/**
 * The upstream tools payload as it really arrives: camelCase, and carrying
 * every connection in the partner account rather than only this agent's.
 */
function toolRow(overrides: Record<string, unknown> = {}) {
  return {
    // Its own row id, which is NOT a connection id. Without one in the
    // fixture, a `connectionIdOf` that falls back to `id` looked correct
    // everywhere in this file.
    id: 'tool_row_1',
    toolSlug: 'google_sheets',
    toolName: 'Google Sheets',
    enabled: false,
    connectionId: 'conn-1',
    connectionStatus: 'ACTIVE',
    providerEmail: 'ops@acme.test',
    ...overrides,
  };
}

async function makeAgent(externalId: string, workspace: Workspace): Promise<Agent> {
  return prisma.agent.create({
    data: { externalId, name: `Agent ${externalId}`, workspaceId: workspace.id },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The tool PUT resolves the row's ownership before it writes, so every case
  // in this file needs an answer from upstream, not only the GET ones. Cases
  // that care about the rows set their own.
  vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
});

describe('GET /agents/:agentId/tools', () => {
  it("hides a connection mapped to another workspace, and the email attached to it", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', mine);
    await mapResource('CONNECTION', 'conn-mine', mine.id);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ connectionId: 'conn-mine', providerEmail: 'me@alice.test' }),
        toolRow({ connectionId: 'conn-theirs', providerEmail: 'them@bob.test' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].providerEmail).toBe('me@alice.test');
    // The regression this slice exists to fix: another workspace's connected
    // account address was previously served to every member of every workspace.
    expect(JSON.stringify(res.body)).not.toContain('them@bob.test');
  });

  it('hides a connection with no mapping at all', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [toolRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toEqual([]);
  });

  it('never emits the connection id it filtered on', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await mapResource('CONNECTION', 'conn-1', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [toolRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // Reading it internally to filter is required; emitting it is not, and it
    // addresses an integration record no workspace member should hold.
    expect(res.body.data[0]).not.toHaveProperty('connectionId');
    expect(JSON.stringify(res.body)).not.toContain('conn-1');
  });

  it("answers 404 for another workspace's agent, without calling upstream", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${foreign.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(client.getAgentTools).not.toHaveBeenCalled();
  });

  it('keeps a tool that is enabled on this agent visible when its connection is unmapped, with the email withheld', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow({ enabled: true, providerEmail: 'partner@ops.test' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // The agent really does call this tool on every call; hiding the row
    // misreports the agent. The connected account's address is the part the
    // workspace is not entitled to, so that is what goes.
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].toolSlug).toBe('google_sheets');
    expect(res.body.data[0].enabled).toBe(true);
    expect(res.body.data[0].owned).toBe(false);
    expect(res.body.data[0].providerEmail).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('partner@ops.test');
  });

  it("keeps a tool enabled on this agent visible when its connection is mapped to another workspace, without their email", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', mine);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ enabled: true, connectionId: 'conn-theirs', providerEmail: 'them@bob.test' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].owned).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('them@bob.test');
  });

  it('marks an enabled tool owned and keeps its email when the connection is mapped here', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await mapResource('CONNECTION', 'conn-1', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow({ enabled: true, providerEmail: 'me@alice.test' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].owned).toBe(true);
    expect(res.body.data[0].providerEmail).toBe('me@alice.test');
  });

  it('still hides a disabled, unmapped pool row even when another row is enabled', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ enabled: true }),
        toolRow({ toolSlug: 'gmail', toolName: 'Gmail', connectionId: 'conn-2', providerEmail: 'other@pool.test' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].toolSlug).toBe('google_sheets');
    expect(JSON.stringify(res.body)).not.toContain('other@pool.test');
  });
});

describe('GET /agents/:agentId/available-connections', () => {
  it('offers only connections mapped to this workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', mine);
    await mapResource('CONNECTION', 'conn-mine', mine.id);
    vi.mocked(client.getAvailableConnections).mockResolvedValue({
      connections: [
        { id: 'conn-mine', toolSlug: 'google_sheets', toolName: 'Google Sheets', status: 'ACTIVE', providerEmail: 'me@alice.test' },
        { id: 'conn-theirs', toolSlug: 'google_sheets', toolName: 'Google Sheets', status: 'ACTIVE', providerEmail: 'them@bob.test' },
      ],
    });
    void theirs;

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/available-connections`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('them@bob.test');
  });

  it('emits a connection id, since binding one requires naming it', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await mapResource('CONNECTION', 'conn-mine', workspace.id);
    vi.mocked(client.getAvailableConnections).mockResolvedValue({
      connections: [{ id: 'conn-mine', toolSlug: 'google_sheets', toolName: 'Sheets', status: 'ACTIVE' }],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/available-connections`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].id).toBe('conn-mine');
  });

  it('returns an empty list rather than an error when nothing is mapped', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAvailableConnections).mockResolvedValue({ connections: [] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/available-connections`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('PUT /agents/:agentId/tools/:slug', () => {
  it('binds a mapped connection and reports the resulting state', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await mapResource('CONNECTION', 'conn-mine', workspace.id);
    vi.mocked(client.setAgentTool).mockResolvedValue({ enabled: true });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true, connection_id: 'conn-mine' });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(vi.mocked(client.setAgentTool).mock.calls[0]).toEqual([
      'ext-1',
      'google_sheets',
      { enabled: true, connection_id: 'conn-mine' },
    ]);
  });

  it("refuses a connection mapped to another workspace, before calling upstream", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', mine);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true, connection_id: 'conn-theirs' });

    expect(res.status).toBe(404);
    expect(client.setAgentTool).not.toHaveBeenCalled();
  });

  it('allows a disable with no connection named', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.setAgentTool).mockResolvedValue({ enabled: false });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.setAgentTool).mock.calls[0][2]).toEqual({ enabled: false });
  });

  it('rejects a non-boolean enabled', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: 'yes' });

    expect(res.status).toBe(400);
    expect(client.setAgentTool).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's agent", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${foreign.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true });

    expect(res.status).toBe(404);
    expect(client.setAgentTool).not.toHaveBeenCalled();
  });
});

describe('a bound tool that has no connection at all', () => {
  it('is the workspace’s to control, not something the YE team manages', async () => {
    // A built-in — end_call, transfer — is enabled on the agent and has no
    // connection behind it. "Not a connection this workspace owns" and "not a
    // connection" are different facts, and only the first means the row is
    // managed elsewhere. Reporting the second as `owned: false` renders the
    // workspace's own built-in as someone else's integration, with its switch
    // taken away.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-builtin', workspace);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        {
          toolSlug: 'end_call',
          toolName: 'End Call',
          enabled: true,
          connectionStatus: null,
          providerEmail: null,
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].toolSlug).toBe('end_call');
    expect(res.body.data[0].owned).toBe(true);
  });

  it('stays the workspace’s even when upstream gives the row its own id', async () => {
    // `connectionIdOf` used to fall back to `id`, so a row id upstream is
    // free to add turned "no connection behind it" into "a connection this
    // workspace does not own" — and the workspace's own `end_call` rendered
    // as managed by YE, with the switch taken away.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-builtin-id', workspace);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [{ id: 'tool_row_88', toolSlug: 'end_call', toolName: 'End Call', enabled: true }],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].owned).toBe(true);
  });
});

describe('writing to a tool binding this workspace does not own', () => {
  it('is refused, and leaves the binding exactly as it was', async () => {
    // Until this check existed, the ONLY thing stopping a member from
    // switching off an YE-managed binding was the dashboard declining to
    // render a Switch — a server-side rule enforced in the browser. Neither
    // guard above fired: `{ enabled: false }` names no connection and is not
    // an enable. Ship this backend before the matching dashboard and the row
    // renders with a live switch that works.
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-unowned-put', mine);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);

    let enabled = true;
    vi.mocked(client.getAgentTools).mockImplementation(async () => ({
      tools: [toolRow({ enabled, connectionId: 'conn-theirs', providerEmail: 'them@bob.test' })],
    }));
    vi.mocked(client.setAgentTool).mockImplementation(async (_id, _slug, body) => {
      enabled = body.enabled;
      return { enabled: body.enabled };
    });

    const url = `/api/workspaces/${mine.id}/agents/${agent.id}/tools`;
    const res = await request(app)
      .put(`${url}/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false });

    // The same 404 every other unowned-resource refusal answers: which tools
    // the partner account has a connection for is exactly the fact a
    // workspace without one must not be able to learn.
    expect(res.status).toBe(404);
    expect(client.setAgentTool).not.toHaveBeenCalled();

    const after = await request(app).get(url).set(...as('user_alice', 'alice@ezo.test'));

    expect(after.body.data[0].enabled).toBe(true);
    expect(after.body.data[0].owned).toBe(false);
  });

  it('is refused even when the body names a connection this workspace does own', async () => {
    // Re-pointing someone else's binding is still writing to it.
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-repoint', mine);
    await mapResource('CONNECTION', 'conn-mine', mine.id);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow({ enabled: true, connectionId: 'conn-theirs' })],
    });

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true, connection_id: 'conn-mine' });

    expect(res.status).toBe(404);
    expect(client.setAgentTool).not.toHaveBeenCalled();
  });

  it('still lets a member switch off a binding that IS theirs', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-owned-put', workspace);
    await mapResource('CONNECTION', 'conn-1', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow({ enabled: true })],
    });
    vi.mocked(client.setAgentTool).mockResolvedValue({ enabled: false });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
  });

  it('reads one bound row of the slug as enough, when the pool holds several', async () => {
    // Upstream returns one row per connection in the whole partner account,
    // so a slug can arrive several times. The workspace's own binding being
    // among them is what makes the write theirs to make.
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-multi-put', mine);
    await mapResource('CONNECTION', 'conn-mine', mine.id);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ enabled: true, connectionId: 'conn-theirs' }),
        toolRow({ enabled: true, connectionId: 'conn-mine' }),
      ],
    });
    vi.mocked(client.setAgentTool).mockResolvedValue({ enabled: false });

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/tools/google_sheets`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false });

    expect(res.status).toBe(200);
  });
});

describe('a built-in tool through a full switch-off round trip', () => {
  it('is still listed, and still switchable, after it is disabled', async () => {
    // The candidate half used to intersect with mapped CONNECTION ids
    // unconditionally, and a built-in has no connection id to intersect on.
    // So the row vanished from the list the moment it was switched off — a
    // control that destroys itself on first use, leaving `end_call` disabled
    // on a live agent with nothing in the UI to switch it back on.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-roundtrip', workspace);

    let enabled = true;
    vi.mocked(client.getAgentTools).mockImplementation(async () => ({
      tools: [{ toolSlug: 'end_call', toolName: 'End Call', enabled, connectionStatus: null }],
    }));
    vi.mocked(client.setAgentTool).mockImplementation(async (_id, _slug, body) => {
      enabled = body.enabled;
      return { enabled: body.enabled };
    });

    const url = `/api/workspaces/${workspace.id}/agents/${agent.id}/tools`;
    const before = await request(app).get(url).set(...as('user_alice', 'alice@ezo.test'));

    expect(before.body.data).toHaveLength(1);
    expect(before.body.data[0].enabled).toBe(true);
    expect(before.body.data[0].owned).toBe(true);

    const off = await request(app)
      .put(`${url}/end_call`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false });

    expect(off.status).toBe(200);

    const after = await request(app).get(url).set(...as('user_alice', 'alice@ezo.test'));

    // Still there, still the workspace's, and now showing the state it was
    // just put into — which is what makes it switchable back on.
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].toolSlug).toBe('end_call');
    expect(after.body.data[0].enabled).toBe(false);
    expect(after.body.data[0].owned).toBe(true);
  });

  it('keeps a disabled built-in listed alongside an unowned bound row', async () => {
    // The two halves of the rule meeting in one payload: the built-in is
    // connectionless and kept, the pool row has a connection this workspace
    // does not own and is dropped because it is not attachable.
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-mixed', mine);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        { toolSlug: 'transfer_call', toolName: 'Transfer Call', enabled: false },
        toolRow({ connectionId: 'conn-theirs', providerEmail: 'them@bob.test' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].toolSlug).toBe('transfer_call');
    expect(res.body.data[0].owned).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('them@bob.test');
  });
});

describe('the order of the tools list', () => {
  it('is upstream’s, so a switch flip does not move the row', async () => {
    // The dashboard keys this list on index. Grouping bound rows ahead of
    // candidates moved a row the moment a member toggled it, which is the
    // one order change a member can cause and the worst one for an
    // index-keyed list.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-order', workspace);
    await mapResource('CONNECTION', 'conn-a', workspace.id);
    await mapResource('CONNECTION', 'conn-b', workspace.id);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ toolSlug: 'a_candidate', connectionId: 'conn-a', enabled: false }),
        { toolSlug: 'b_builtin', toolName: 'Built In', enabled: true },
        toolRow({ toolSlug: 'c_bound', connectionId: 'conn-b', enabled: true }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data.map((row: { toolSlug: string }) => row.toolSlug)).toEqual([
      'a_candidate',
      'b_builtin',
      'c_bound',
    ]);
  });
});

describe('the shape of a bound row whose connection this workspace does not own', () => {
  it('is locked, because this is the row the redaction exists for', async () => {
    // The candidate row has a `toEqual` lock in agents.test.ts; this one had
    // none, so a field added to TOOL_FIELDS for the picker would have been
    // caught there, "fixed" by adding it to that expectation, and shipped
    // unredacted on exactly the rows it must never appear on.
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-bound-unowned', mine);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({
          enabled: true,
          connectionId: 'conn-theirs',
          connectionStatus: 'ACTIVE',
          providerEmail: 'them@bob.test',
        }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        toolSlug: 'google_sheets',
        toolName: 'Google Sheets',
        enabled: true,
        connectionStatus: null,
        providerEmail: null,
        owned: false,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('them@bob.test');
    expect(JSON.stringify(res.body)).not.toContain('conn-theirs');
  });

  it('withholds the live health of a connection belonging to another customer', async () => {
    // `connectionStatus` is the OAuth health of another workspace's Google
    // account. A member with a lent agent could read it flip EXPIRED →
    // ACTIVE and watch that customer reconnect. The same reasoning that
    // removed `providerEmail` applies; an owned row keeps it, and redaction
    // only ever touches the rows that are not the reader's.
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-status', mine);
    await mapResource('CONNECTION', 'conn-mine', mine.id);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ enabled: true, connectionId: 'conn-theirs', connectionStatus: 'EXPIRED' }),
        toolRow({ enabled: true, connectionId: 'conn-mine', connectionStatus: 'ACTIVE' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].owned).toBe(false);
    expect(res.body.data[0].connectionStatus).toBeNull();
    expect(res.body.data[1].owned).toBe(true);
    expect(res.body.data[1].connectionStatus).toBe('ACTIVE');
    expect(JSON.stringify(res.body)).not.toContain('EXPIRED');
  });

  it('keeps the two rows apart when one connection is mapped and the other is not', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-two-bound', mine);
    await mapResource('CONNECTION', 'conn-mine', mine.id);
    await mapResource('CONNECTION', 'conn-theirs', theirs.id);

    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [
        toolRow({ enabled: true, connectionId: 'conn-theirs', providerEmail: 'them@bob.test' }),
        toolRow({ enabled: true, connectionId: 'conn-mine', providerEmail: 'me@alice.test' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/tools`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // Both bound rows stay — the agent calls both — but only one is theirs to
    // read. Index correlation is what decides which, so a mix is the case
    // that would expose it landing on the wrong row.
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((row: { owned: boolean }) => row.owned)).toEqual([false, true]);
    expect(res.body.data[0].providerEmail).toBeNull();
    expect(res.body.data[1].providerEmail).toBe('me@alice.test');
    expect(JSON.stringify(res.body)).not.toContain('them@bob.test');
  });
});

describe('the tools route’s 404 set', () => {
  // The lifecycle-hooks route pins all three; this one pinned only the
  // foreign case, so "unassigned" and "nonexistent" were free to diverge
  // into a 500 or, worse, a call to upstream that confirms the id exists.
  const cases = ['foreign', 'unassigned', 'nonexistent'] as const;

  for (const kind of cases) {
    it(`answers an identical 404 for a ${kind} agent, without calling upstream`, async () => {
      const alice = await makeAccount('alice');
      const bob = await makeAccount('bob');
      const mine = await makeWorkspace(alice, 'Alice Co');

      let agentId = 'cl00000000000000000000000';
      if (kind === 'foreign') {
        const theirs = await makeWorkspace(bob, 'Bob Co');
        agentId = (await makeAgent('ext-theirs', theirs)).id;
      } else if (kind === 'unassigned') {
        agentId = (
          await prisma.agent.create({
            data: { externalId: 'ext-unassigned', name: 'Unassigned', workspaceId: null },
          })
        ).id;
      }

      const res = await request(app)
        .get(`/api/workspaces/${mine.id}/agents/${agentId}/tools`)
        .set(...as('user_alice', 'alice@ezo.test'));

      expect(res.status).toBe(404);
      expect(client.getAgentTools).not.toHaveBeenCalled();
    });
  }
});
