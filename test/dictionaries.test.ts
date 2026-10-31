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
  listDictionaries: vi.fn(),
  createDictionary: vi.fn(),
  updateDictionary: vi.fn(),
  getDictionary: vi.fn(),
  deleteDictionary: vi.fn(),
  getAgentDictionaries: vi.fn(),
  replaceAgentDictionaries: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();
const auth = as('user_alice', 'alice@ezo.test');

function dictionary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Dictionary ${id}`,
    term_count: 4,
    char_count: 40,
    attached_agent_count: 1,
    ...overrides,
  };
}

async function setup() {
  const alice = await makeAccount('alice');
  const workspace = await makeWorkspace(alice, 'Alice Co');
  const agent: Agent = await prisma.agent.create({
    data: { externalId: 'ext-1', name: 'Reception', workspaceId: workspace.id },
  });
  return { workspace, agent };
}

async function otherWorkspace(): Promise<Workspace> {
  const bob = await makeAccount('bob');
  return makeWorkspace(bob, 'Bob Co');
}

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /workspaces/:id/dictionaries', () => {
  it('lists only the dictionaries this workspace owns', async () => {
    const { workspace } = await setup();
    const theirs = await otherWorkspace();
    await mapResource('DICTIONARY', 'dict-mine', workspace.id);
    await mapResource('DICTIONARY', 'dict-theirs', theirs.id);
    vi.mocked(client.listDictionaries).mockResolvedValue({
      dictionaries: [
        dictionary('dict-mine', { name: 'Clinical terms' }),
        dictionary('dict-theirs', { name: 'Acme SKU list' }),
        dictionary('dict-unmapped', { name: 'Left over from setup' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/dictionaries`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Clinical terms');
    // Names are customer content — another workspace's must not appear even
    // as an unselectable row.
    expect(JSON.stringify(res.body)).not.toContain('Acme SKU list');
    expect(JSON.stringify(res.body)).not.toContain('Left over from setup');
  });

  it('reports an unreachable platform as an upstream failure, not an empty library', async () => {
    const { workspace } = await setup();
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.listDictionaries).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/dictionaries`)
      .set(...auth);

    expect(res.status).toBe(502);
  });
});

describe('POST /workspaces/:id/dictionaries', () => {
  it('creates upstream and maps the result to the workspace', async () => {
    const { workspace } = await setup();
    vi.mocked(client.createDictionary).mockResolvedValue(
      dictionary('dict-new', { name: 'Clinical terms' }),
    );

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/dictionaries`)
      .set(...auth)
      .send({ name: 'Clinical terms', terms: ['amoxicillin', 'ibuprofen'] });

    expect(res.status).toBe(201);
    const mapping = await prisma.workspaceResource.findFirst({ where: { kind: 'DICTIONARY' } });
    expect(mapping).toMatchObject({ externalId: 'dict-new', workspaceId: workspace.id });
  });

  it('rejects an empty term list rather than creating a dictionary that does nothing', async () => {
    const { workspace } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/dictionaries`)
      .set(...auth)
      .send({ name: 'Empty', terms: [] });

    expect(res.status).toBe(400);
    expect(client.createDictionary).not.toHaveBeenCalled();
  });
});

describe('PATCH and DELETE /workspaces/:id/dictionaries/:dictionaryId', () => {
  it('updates a dictionary this workspace owns', async () => {
    const { workspace } = await setup();
    await mapResource('DICTIONARY', 'dict-1', workspace.id);
    vi.mocked(client.updateDictionary).mockResolvedValue(dictionary('dict-1', { name: 'Renamed' }));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/dictionaries/dict-1`)
      .set(...auth)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateDictionary).mock.calls[0]).toEqual(['dict-1', { name: 'Renamed' }]);
  });

  it("refuses to update another workspace's dictionary, before calling upstream", async () => {
    const { workspace } = await setup();
    const theirs = await otherWorkspace();
    await mapResource('DICTIONARY', 'dict-theirs', theirs.id);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/dictionaries/dict-theirs`)
      .set(...auth)
      .send({ name: 'Mine now' });

    expect(res.status).toBe(404);
    expect(client.updateDictionary).not.toHaveBeenCalled();
  });

  it('deletes and unmaps in one action', async () => {
    const { workspace } = await setup();
    await mapResource('DICTIONARY', 'dict-1', workspace.id);
    vi.mocked(client.deleteDictionary).mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/dictionaries/dict-1`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(await prisma.workspaceResource.count({ where: { kind: 'DICTIONARY' } })).toBe(0);
  });

  it('keeps the mapping when the upstream delete fails', async () => {
    const { workspace } = await setup();
    await mapResource('DICTIONARY', 'dict-1', workspace.id);
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.deleteDictionary).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/dictionaries/dict-1`)
      .set(...auth);

    expect(res.status).toBe(502);
    // Unmapping first would hide a dictionary that still exists, and nobody
    // could reach it again.
    expect(await prisma.workspaceResource.count({ where: { kind: 'DICTIONARY' } })).toBe(1);
  });
});

describe('agent dictionary attachment', () => {
  it('lists what is attached to the agent', async () => {
    const { workspace, agent } = await setup();
    vi.mocked(client.getAgentDictionaries).mockResolvedValue({
      dictionaries: [dictionary('dict-1', { name: 'Clinical terms' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/dictionaries`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: 'dict-1', name: 'Clinical terms', term_count: 4 });
  });

  it('replaces the attached set with dictionaries this workspace owns', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DICTIONARY', 'dict-1', workspace.id);
    await mapResource('DICTIONARY', 'dict-2', workspace.id);
    vi.mocked(client.replaceAgentDictionaries).mockResolvedValue({ dictionaries: [] });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: ['dict-1', 'dict-2'] });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.replaceAgentDictionaries).mock.calls[0]).toEqual([
      'ext-1',
      ['dict-1', 'dict-2'],
    ]);
  });

  it("refuses a set containing another workspace's dictionary, before calling upstream", async () => {
    const { workspace, agent } = await setup();
    const theirs = await otherWorkspace();
    await mapResource('DICTIONARY', 'dict-mine', workspace.id);
    await mapResource('DICTIONARY', 'dict-theirs', theirs.id);

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: ['dict-mine', 'dict-theirs'] });

    expect(res.status).toBe(404);
    // The whole request fails rather than attaching the half it was entitled
    // to — a partial set-replace is not what the caller asked for.
    expect(client.replaceAgentDictionaries).not.toHaveBeenCalled();
  });

  it('accepts an empty set as "detach everything"', async () => {
    const { workspace, agent } = await setup();
    vi.mocked(client.replaceAgentDictionaries).mockResolvedValue({ dictionaries: [] });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: [] });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.replaceAgentDictionaries).mock.calls[0]).toEqual(['ext-1', []]);
  });

  it('de-duplicates before sending', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DICTIONARY', 'dict-1', workspace.id);
    vi.mocked(client.replaceAgentDictionaries).mockResolvedValue({ dictionaries: [] });

    await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: ['dict-1', 'dict-1'] });

    expect(vi.mocked(client.replaceAgentDictionaries).mock.calls[0][1]).toEqual(['dict-1']);
  });

  it('surfaces the character-limit message so the caller learns the cap was hit', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DICTIONARY', 'dict-1', workspace.id);
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.replaceAgentDictionaries).mockRejectedValue(
      new ApiError(
        400,
        'VALIDATION_ERROR',
        "Attaching these dictionaries would exceed the 10,000-char context limit.",
      ),
    );

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: ['dict-1'] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('10,000');
  });

  it("answers 404 for another workspace's agent", async () => {
    const { workspace } = await setup();
    const theirs = await otherWorkspace();
    const foreign = await prisma.agent.create({
      data: { externalId: 'ext-theirs', name: 'Theirs', workspaceId: theirs.id },
    });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${foreign.id}/dictionaries`)
      .set(...auth)
      .send({ dictionary_ids: [] });

    expect(res.status).toBe(404);
    expect(client.replaceAgentDictionaries).not.toHaveBeenCalled();
  });
});
