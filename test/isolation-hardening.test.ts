import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';
import { reassignResource } from '../src/lib/workspaceResource.js';

/**
 * The rules that hold when an agent has been somewhere else first.
 *
 * A workspace's isolation used to rest on one assumption: that everything
 * attached to an agent it holds belongs to it. Staff can lend an agent from one
 * workspace to another, and the pooled resources — dictionaries, functions,
 * documents — do not move with it, so that assumption is not something the
 * schema guarantees. Each case here is a way it was false.
 */

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  getAvailableConnections: vi.fn(),
  setAgentTool: vi.fn(),
  getAgentDictionaries: vi.fn(),
  replaceAgentDictionaries: vi.fn(),
  detachFunction: vi.fn(),
  unlinkDocument: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();
const auth = as('user_alice', 'alice@ezo.test');

async function makeAgent(externalId: string, workspace: Workspace): Promise<Agent> {
  return prisma.agent.create({
    data: { externalId, name: `Agent ${externalId}`, workspaceId: workspace.id },
  });
}

/** Alice's workspace holding an agent that Bob's workspace configured first. */
async function lentAgent() {
  const alice = await makeAccount('alice');
  const bob = await makeAccount('bob');
  const mine = await makeWorkspace(alice, 'Alice Co');
  const theirs = await makeWorkspace(bob, 'Bob Co');
  const agent = await makeAgent('ext-1', mine);
  return { mine, theirs, agent };
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

describe("a function attached by the workspace that held the agent before", () => {
  it('is listed, but without the endpoint it calls', async () => {
    const { mine, theirs, agent } = await lentAgent();
    await reassignResource('FUNCTION', 'fn-theirs', theirs.id);

    vi.mocked(client.getAgentFunctions).mockResolvedValue({
      functions: [
        { id: 'fn-theirs', name: 'lookup_order', method: 'POST', url: 'https://internal.bobco.test/crm', enabled: true },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/functions`)
      .set(...auth);

    expect(res.status).toBe(200);
    // Listed: hiding it would misreport what the agent can actually call, and
    // this list is how a reader finds that out.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('lookup_order');
    expect(res.body.data[0].owned).toBe(false);
    // But the address is on another customer's network.
    expect(res.body.data[0].url).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('internal.bobco.test');
  });

  it('keeps its endpoint readable for the workspace that owns it', async () => {
    const { mine, agent } = await lentAgent();
    await reassignResource('FUNCTION', 'fn-mine', mine.id);

    vi.mocked(client.getAgentFunctions).mockResolvedValue({
      functions: [{ id: 'fn-mine', name: 'lookup_order', url: 'https://api.aliceco.test/crm', enabled: true }],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/functions`)
      .set(...auth);

    expect(res.body.data[0].owned).toBe(true);
    expect(res.body.data[0].url).toBe('https://api.aliceco.test/crm');
  });
});

describe("a dictionary attached by the workspace that held the agent before", () => {
  it('is listed with its counts, but without its terms', async () => {
    const { mine, theirs, agent } = await lentAgent();
    await reassignResource('DICTIONARY', 'dict-theirs', theirs.id);

    vi.mocked(client.getAgentDictionaries).mockResolvedValue({
      dictionaries: [
        { id: 'dict-theirs', name: 'SKUs', term_count: 2, char_count: 30, terms: ['Widgetron', 'Cogmaster'] },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${agent.id}/dictionaries`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data[0].owned).toBe(false);
    // The counts stay: they make the character budget add up and name nothing.
    expect(res.body.data[0].term_count).toBe(2);
    // A term list is a product catalogue.
    expect(res.body.data[0].terms).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('Widgetron');
  });

  it('can still be kept when the reader attaches one of their own', async () => {
    const { mine, theirs, agent } = await lentAgent();
    await reassignResource('DICTIONARY', 'dict-theirs', theirs.id);
    await reassignResource('DICTIONARY', 'dict-mine', mine.id);

    vi.mocked(client.getAgentDictionaries).mockResolvedValue({
      dictionaries: [{ id: 'dict-theirs' }],
    });
    vi.mocked(client.replaceAgentDictionaries).mockResolvedValue({ dictionaries: [] });

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: ['dict-theirs', 'dict-mine'] });

    // Requiring ownership of every id made this tab a dead end: submit what you
    // were shown plus one of your own and get a bare 404, for ever. Keeping
    // something already attached is not a way to obtain access to it — it is
    // still redacted in the listing and unusable anywhere else.
    expect(res.status).toBe(200);
    expect(vi.mocked(client.replaceAgentDictionaries)).toHaveBeenCalledWith('ext-1', [
      'dict-theirs',
      'dict-mine',
    ]);
  });

  it("still refuses an id that is neither owned nor attached", async () => {
    const { mine, theirs, agent } = await lentAgent();
    await reassignResource('DICTIONARY', 'dict-theirs', theirs.id);
    vi.mocked(client.getAgentDictionaries).mockResolvedValue({ dictionaries: [] });

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: ['dict-theirs'] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(vi.mocked(client.replaceAgentDictionaries)).not.toHaveBeenCalled();
  });
});

describe('enabling a tool', () => {
  it('is refused when no connection is named', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', mine);

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/tools/gmail`)
      .set(...auth)
      .send({ enabled: true });

    // Omitting it let upstream pick a default out of the partner account — a
    // namespace holding every other workspace's connected mailboxes. The
    // workspace could not name an id this backend would have checked, so there
    // was nothing to check.
    expect(res.status).toBe(400);
    expect(vi.mocked(client.setAgentTool)).not.toHaveBeenCalled();
  });

  it('is allowed when the connection is one this workspace owns', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', mine);
    await reassignResource('CONNECTION', 'conn-mine', mine.id);
    // The write resolves the existing binding's ownership before it applies,
    // so upstream is read on this path too. Nothing is bound yet here.
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
    vi.mocked(client.setAgentTool).mockResolvedValue({ enabled: true });

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/tools/gmail`)
      .set(...auth)
      .send({ enabled: true, connection_id: 'conn-mine' });

    expect(res.status).toBe(200);
  });

  it('still allows switching a tool off on its own', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', mine);
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
    vi.mocked(client.setAgentTool).mockResolvedValue({ enabled: false });

    const res = await request(app)
      .put(`/api/workspaces/${mine.id}/agents/${agent.id}/tools/gmail`)
      .set(...auth)
      .send({ enabled: false });

    // Disabling has no reach into another workspace's connections.
    expect(res.status).toBe(200);
  });
});

describe('the request body limit', () => {
  it('answers a too-large body with 413, not a 500', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post(`/api/workspaces/${mine.id}/agents`)
      .set(...auth)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ prompt: 'x'.repeat(2 * 1024 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a prompt at the size the payload validator advertises', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');
    vi.mocked(client.createAgent).mockResolvedValue({ id: 'ext-new', agent_name: 'Reception' });
    vi.mocked(client.getAgent).mockResolvedValue({ id: 'ext-new', agent_name: 'Reception' });
    vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });

    const res = await request(app)
      .post(`/api/workspaces/${mine.id}/agents`)
      .set(...auth)
      .send({
        agent_name: 'Reception',
        // The top of the documented range, which the 100kb default body limit
        // rejected before any route ran — as a 500, on the product's flagship
        // field.
        prompt: 'x'.repeat(110_000),
        voice_id: 'voice-1',
        agent_type: 'inbound',
      });

    expect(res.status).toBe(201);
  });

  it('answers malformed JSON with 400, not a 500', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post(`/api/workspaces/${mine.id}/agents`)
      .set(...auth)
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
});

describe('creating an agent', () => {
  it('validates variables, rather than forwarding whatever was sent', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post(`/api/workspaces/${mine.id}/agents`)
      .set(...auth)
      .send({
        agent_name: 'Reception',
        prompt: 'Answer the phone.',
        voice_id: 'voice-1',
        agent_type: 'inbound',
        // Refused on update, and — because the field was declared in the strip
        // list but not in the schema — kept and forwarded unchecked on create.
        variables: ['9 not a name', { evil: true }],
      });

    expect(res.status).toBe(400);
    expect(vi.mocked(client.createAgent)).not.toHaveBeenCalled();
  });
});
