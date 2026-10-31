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
  listFunctions: vi.fn(),
  createFunction: vi.fn(),
  updateFunction: vi.fn(),
  deleteFunction: vi.fn(),
  attachFunction: vi.fn(),
  detachFunction: vi.fn(),
  toggleFunction: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();
const auth = as('user_alice', 'alice@ezo.test');

const validFunction = {
  name: 'check_availability',
  description: 'Looks up open appointment slots.',
  url: 'https://api.acme.test/slots',
};

function upstreamFunction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: 'check_availability',
    description: 'Looks up open appointment slots.',
    method: 'POST',
    url: 'https://api.acme.test/slots',
    header_keys: ['X-Api-Key'],
    input_schema: [],
    output_schema: [],
    timeout: 10,
    enabled: true,
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

describe('GET /workspaces/:id/functions', () => {
  it('lists only the functions this workspace owns', async () => {
    const { workspace } = await setup();
    const theirs = await otherWorkspace();
    await mapResource('FUNCTION', 'fn-mine', workspace.id);
    await mapResource('FUNCTION', 'fn-theirs', theirs.id);
    vi.mocked(client.listFunctions).mockResolvedValue({
      functions: [
        upstreamFunction('fn-mine'),
        upstreamFunction('fn-theirs', { url: 'https://internal.bobco.test/orders' }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // A function's URL names another customer's internal endpoint.
    expect(JSON.stringify(res.body)).not.toContain('internal.bobco.test');
  });

  it('returns header key names but never a header value', async () => {
    const { workspace } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    vi.mocked(client.listFunctions).mockResolvedValue({
      functions: [
        upstreamFunction('fn-1', {
          header_keys: ['X-Api-Key'],
          // If the platform ever returned these, they must not pass through.
          headers: [{ key: 'X-Api-Key', value: 'super-secret' }],
        }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth);

    expect(res.body.data[0].header_keys).toEqual(['X-Api-Key']);
    expect(JSON.stringify(res.body)).not.toContain('super-secret');
  });
});

describe('POST /workspaces/:id/functions', () => {
  it('creates upstream and maps the result', async () => {
    const { workspace } = await setup();
    vi.mocked(client.createFunction).mockResolvedValue(upstreamFunction('fn-new'));

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth)
      .send(validFunction);

    expect(res.status).toBe(201);
    const mapping = await prisma.workspaceResource.findFirst({ where: { kind: 'FUNCTION' } });
    expect(mapping).toMatchObject({ externalId: 'fn-new', workspaceId: workspace.id });
  });

  it('rejects a name that is not snake_case, as the platform requires', async () => {
    const { workspace } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth)
      .send({ ...validFunction, name: 'Check Availability' });

    expect(res.status).toBe(400);
    expect(client.createFunction).not.toHaveBeenCalled();
  });

  it('rejects a url that is not http or https', async () => {
    const { workspace } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth)
      .send({ ...validFunction, url: 'file:///etc/passwd' });

    expect(res.status).toBe(400);
    expect(client.createFunction).not.toHaveBeenCalled();
  });

  it('rejects a timeout outside the accepted range', async () => {
    const { workspace } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth)
      .send({ ...validFunction, timeout: 120 });

    expect(res.status).toBe(400);
  });

  it('forwards header values on the way in, since that is the only time they exist', async () => {
    const { workspace } = await setup();
    vi.mocked(client.createFunction).mockResolvedValue(upstreamFunction('fn-new'));

    await request(app)
      .post(`/api/workspaces/${workspace.id}/functions`)
      .set(...auth)
      .send({ ...validFunction, headers: [{ key: 'X-Api-Key', value: 'secret' }] });

    expect(vi.mocked(client.createFunction).mock.calls[0][0]).toMatchObject({
      headers: [{ key: 'X-Api-Key', value: 'secret' }],
    });
  });
});

describe('PATCH and DELETE /workspaces/:id/functions/:functionId', () => {
  it('updates a function this workspace owns', async () => {
    const { workspace } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    vi.mocked(client.updateFunction).mockResolvedValue(upstreamFunction('fn-1'));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/functions/fn-1`)
      .set(...auth)
      .send({ description: 'Now with more slots.' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateFunction).mock.calls[0]).toEqual([
      'fn-1',
      { description: 'Now with more slots.' },
    ]);
  });

  it("refuses to update another workspace's function", async () => {
    const { workspace } = await setup();
    const theirs = await otherWorkspace();
    await mapResource('FUNCTION', 'fn-theirs', theirs.id);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/functions/fn-theirs`)
      .set(...auth)
      .send({ description: 'Mine now.' });

    expect(res.status).toBe(404);
    expect(client.updateFunction).not.toHaveBeenCalled();
  });

  it('deletes and unmaps', async () => {
    const { workspace } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    vi.mocked(client.deleteFunction).mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/functions/fn-1`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(await prisma.workspaceResource.count({ where: { kind: 'FUNCTION' } })).toBe(0);
  });

  it('keeps the mapping when the upstream delete fails', async () => {
    const { workspace } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.deleteFunction).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/functions/fn-1`)
      .set(...auth);

    expect(res.status).toBe(502);
    expect(await prisma.workspaceResource.count({ where: { kind: 'FUNCTION' } })).toBe(1);
  });
});

describe('agent function attachment', () => {
  it('attaches a function this workspace owns', async () => {
    const { workspace, agent } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    vi.mocked(client.attachFunction).mockResolvedValue({ attached: true });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/functions/fn-1`)
      .set(...auth);

    expect(res.status).toBe(201);
    expect(vi.mocked(client.attachFunction).mock.calls[0]).toEqual(['ext-1', 'fn-1']);
  });

  it("refuses to attach another workspace's function, before calling upstream", async () => {
    const { workspace, agent } = await setup();
    const theirs = await otherWorkspace();
    await mapResource('FUNCTION', 'fn-theirs', theirs.id);

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/functions/fn-theirs`)
      .set(...auth);

    expect(res.status).toBe(404);
    expect(client.attachFunction).not.toHaveBeenCalled();
  });

  it('toggles a function on the agent', async () => {
    const { workspace, agent } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    vi.mocked(client.toggleFunction).mockResolvedValue({ enabled: false });

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/functions/fn-1`)
      .set(...auth)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect(vi.mocked(client.toggleFunction).mock.calls[0]).toEqual(['ext-1', 'fn-1', false]);
  });

  it('rejects a non-boolean enabled rather than reading it as off', async () => {
    const { workspace, agent } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/functions/fn-1`)
      .set(...auth)
      .send({});

    expect(res.status).toBe(400);
    expect(client.toggleFunction).not.toHaveBeenCalled();
  });

  it('detaches without deleting the definition', async () => {
    const { workspace, agent } = await setup();
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    vi.mocked(client.detachFunction).mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/functions/fn-1`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(client.deleteFunction).not.toHaveBeenCalled();
    // The definition stays in the workspace's library, ready to reattach.
    expect(await prisma.workspaceResource.count({ where: { kind: 'FUNCTION' } })).toBe(1);
  });

  it("answers 404 for another workspace's agent", async () => {
    const { workspace } = await setup();
    const theirs = await otherWorkspace();
    const foreign = await prisma.agent.create({
      data: { externalId: 'ext-theirs', name: 'Theirs', workspaceId: theirs.id },
    });
    await mapResource('FUNCTION', 'fn-1', workspace.id);

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${foreign.id}/functions/fn-1`)
      .set(...auth);

    expect(res.status).toBe(404);
    expect(client.attachFunction).not.toHaveBeenCalled();
  });
});
