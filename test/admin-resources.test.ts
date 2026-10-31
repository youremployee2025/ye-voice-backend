import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
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
  deleteAgent: vi.fn(),
}));

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const app = createApp();

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

/**
 * A tool connection is the one pooled kind a workspace cannot create for
 * itself — connecting one is an OAuth flow outside this platform. These
 * endpoints are therefore the only way one becomes visible to anybody.
 */
describe('POST /api/admin/resources/:kind/:externalId/assignment', () => {
  it('maps a connection to a workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post('/api/admin/resources/CONNECTION/conn-1/assignment')
      .set('X-Admin-Token', TOKEN)
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(200);
    const rows = await prisma.workspaceResource.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'CONNECTION', externalId: 'conn-1', workspaceId: workspace.id });
  });

  it('returns a connection to the pool on an explicit null', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('CONNECTION', 'conn-1', workspace.id);

    const res = await request(app)
      .post('/api/admin/resources/CONNECTION/conn-1/assignment')
      .set('X-Admin-Token', TOKEN)
      .send({ workspaceId: null });

    expect(res.status).toBe(200);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  it('refuses an omitted workspaceId, so a malformed request cannot un-share', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('CONNECTION', 'conn-1', workspace.id);

    const res = await request(app)
      .post('/api/admin/resources/CONNECTION/conn-1/assignment')
      .set('X-Admin-Token', TOKEN)
      .send({});

    expect(res.status).toBe(400);
    expect(await prisma.workspaceResource.count()).toBe(1);
  });

  it('reassigns rather than creating a second mapping', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const first = await makeWorkspace(alice, 'Alice Co');
    const second = await makeWorkspace(bob, 'Bob Co');
    await mapResource('CONNECTION', 'conn-1', first.id);

    await request(app)
      .post('/api/admin/resources/CONNECTION/conn-1/assignment')
      .set('X-Admin-Token', TOKEN)
      .send({ workspaceId: second.id });

    const rows = await prisma.workspaceResource.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(second.id);
  });

  it('rejects a kind outside the four the platform pools', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post('/api/admin/resources/AGENT/conn-1/assignment')
      .set('X-Admin-Token', TOKEN)
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(400);
  });

  it('rejects a workspace id that names nothing, rather than failing on the key', async () => {
    const res = await request(app)
      .post('/api/admin/resources/CONNECTION/conn-1/assignment')
      .set('X-Admin-Token', TOKEN)
      .send({ workspaceId: 'no-such-workspace' });

    expect(res.status).toBe(404);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  it('refuses without the staff token', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .post('/api/admin/resources/CONNECTION/conn-1/assignment')
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(401);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });
});

describe('GET /api/admin/resources', () => {
  it('lists mappings with their workspace, filtered by kind', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('CONNECTION', 'conn-1', workspace.id, 'Sheets (ops@acme.test)');
    await mapResource('DICTIONARY', 'dict-1', workspace.id, 'Clinical terms');

    const res = await request(app)
      .get('/api/admin/resources?kind=CONNECTION')
      .set('X-Admin-Token', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      kind: 'CONNECTION',
      external_id: 'conn-1',
      name: 'Sheets (ops@acme.test)',
      workspace: { id: workspace.id, name: 'Alice Co' },
    });
  });

  it('lists every kind when none is named', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('CONNECTION', 'conn-1', workspace.id);
    await mapResource('DICTIONARY', 'dict-1', workspace.id);

    const res = await request(app).get('/api/admin/resources').set('X-Admin-Token', TOKEN);

    expect(res.body.data).toHaveLength(2);
  });

  it('rejects an unknown kind rather than silently listing everything', async () => {
    const res = await request(app)
      .get('/api/admin/resources?kind=NONSENSE')
      .set('X-Admin-Token', TOKEN);

    expect(res.status).toBe(400);
  });
});
