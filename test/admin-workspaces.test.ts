import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, makeAccount, makeWorkspace } from './helpers.js';

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');

const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

beforeEach(async () => {
  await truncateAll();
});

describe('staff authentication on the workspace routes', () => {
  it.each(['/api/admin/workspaces', '/api/admin/workspaces/any-id'])(
    'rejects GET %s without a token',
    async (path) => {
      const res = await request(app).get(path);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    },
  );
});

describe('GET /api/admin/workspaces', () => {
  it('pages the list and reports the full total', async () => {
    const alice = await makeAccount('alice');
    await makeWorkspace(alice, 'Acme');
    await makeWorkspace(alice, 'Beta');
    await makeWorkspace(alice, 'Gamma');

    const res = await request(app).get('/api/admin/workspaces?limit=2').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(3);
  });

  it('names the owner and counts members, agents and campaigns', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Acme');
    await addMember(workspace, bob, 'MEMBER');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Agent one', workspaceId: workspace.id },
    });
    await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'Spring' } });

    const res = await request(app).get('/api/admin/workspaces').set(...staff());
    const row = res.body.data.items[0];

    expect(row.owner).toMatchObject({ email: 'alice@ezo.test' });
    expect(row.member_count).toBe(2);
    expect(row.agent_count).toBe(1);
    expect(row.campaign_count).toBe(1);
  });

  it('rejects a page number it cannot honour', async () => {
    const res = await request(app).get('/api/admin/workspaces?limit=0').set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/admin/workspaces/:id', () => {
  it('lists members with their roles', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Acme');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app).get(`/api/admin/workspaces/${workspace.id}`).set(...staff());

    expect(res.status).toBe(200);
    const members = res.body.data.members as Array<{ role: string; account: { email: string } }>;
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.account.email === 'alice@ezo.test')!.role).toBe('ADMIN');
    expect(members.find((m) => m.account.email === 'bob@ezo.test')!.role).toBe('MEMBER');
  });

  it('lists the assigned agents and the campaigns with their status', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Agent one', workspaceId: workspace.id },
    });
    // Another workspace's agent must not appear here.
    const other = await makeWorkspace(alice, 'Other');
    await prisma.agent.create({
      data: { externalId: 'ext-2', name: 'Agent two', workspaceId: other.id },
    });
    await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Spring', status: 'RUNNING' },
    });

    const res = await request(app).get(`/api/admin/workspaces/${workspace.id}`).set(...staff());

    expect(res.body.data.agents).toHaveLength(1);
    expect(res.body.data.agents[0]).toMatchObject({ name: 'Agent one', external_id: 'ext-1' });
    expect(res.body.data.campaigns).toEqual([
      expect.objectContaining({ name: 'Spring', status: 'RUNNING' }),
    ]);
  });

  it('404s an id that names nothing', async () => {
    const res = await request(app).get('/api/admin/workspaces/nope').set(...staff());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('the detail view is bounded', () => {
  it('caps the member list and still reports the true count', async () => {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Big Co');

    // 101 members in all: the owner, plus one past the cap.
    for (let i = 0; i < 100; i += 1) {
      const member = await makeAccount(`member${i}`);
      await addMember(workspace, member, 'MEMBER');
    }

    const res = await request(app).get(`/api/admin/workspaces/${workspace.id}`).set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(100);
    // The count is the database's, not the list's, so a reader can tell a
    // capped list from a complete one.
    expect(res.body.data.member_count).toBe(101);
  });
});

describe('a deleted workspace on the staff surface', () => {
  it('reports when it was deleted, on the listing and the detail', async () => {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Doomed');
    const deletedAt = new Date('2026-09-11T10:00:00.000Z');
    await prisma.workspace.update({ where: { id: workspace.id }, data: { deletedAt } });

    const listing = await request(app).get('/api/admin/workspaces').set(...staff());
    const row = listing.body.data.items.find((w: { id: string }) => w.id === workspace.id);

    // Not merely present — staff already saw it. The console has no other way
    // to tell a deleted workspace from a live one, and recovery is the only
    // path back, so the timestamp has to reach it.
    expect(row.deleted_at).toBe(deletedAt.toISOString());

    const detail = await request(app)
      .get(`/api/admin/workspaces/${workspace.id}`)
      .set(...staff());
    expect(detail.body.data.deleted_at).toBe(deletedAt.toISOString());
  });

  it('leaves a live workspace null rather than absent', async () => {
    const owner = await makeAccount('owner');
    await makeWorkspace(owner, 'Alive');

    const listing = await request(app).get('/api/admin/workspaces').set(...staff());

    expect(listing.body.data.items[0]).toHaveProperty('deleted_at', null);
  });
});

describe('GET /api/admin/workspaces?q=', () => {
  const names = (res: request.Response) =>
    (res.body.data.items as Array<{ name: string }>).map((w) => w.name);

  it('matches a name case-insensitively, on a fragment', async () => {
    const alice = await makeAccount('alice');
    await makeWorkspace(alice, 'Acme Industrial');
    await makeWorkspace(alice, 'Beta');

    const res = await request(app).get('/api/admin/workspaces?q=CME+indus').set(...staff());

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Acme Industrial']);
    expect(res.body.data.total).toBe(1);
  });

  it('matches a slug the name does not contain', async () => {
    const alice = await makeAccount('alice');
    // Built by hand rather than through `makeWorkspace`, whose slug is derived
    // from the name: a slug hit is only proof of one if the name cannot match.
    await prisma.workspace.create({
      data: {
        name: 'Northwind',
        slug: 'legacy-handle',
        color: '#6366f1',
        ownerAccountId: alice.id,
      },
    });
    await makeWorkspace(alice, 'Beta');

    const res = await request(app).get('/api/admin/workspaces?q=LEGACY-HAND').set(...staff());

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Northwind']);
    expect(res.body.data.total).toBe(1);
  });

  it('answers a query that matches nothing with an empty page and a zero total', async () => {
    const alice = await makeAccount('alice');
    await makeWorkspace(alice, 'Acme');

    const res = await request(app).get('/api/admin/workspaces?q=nothing-like-this').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('counts the filtered rows, not every workspace on the platform', async () => {
    const alice = await makeAccount('alice');
    // More than one page of noise, so a total taken without the filter is a
    // number the picker would page into emptiness behind.
    for (let i = 0; i < 30; i += 1) await makeWorkspace(alice, `Other ${i}`);
    for (let i = 0; i < 3; i += 1) await makeWorkspace(alice, `Acme ${i}`);

    const unfiltered = await request(app).get('/api/admin/workspaces').set(...staff());
    expect(unfiltered.body.data.total).toBe(33);

    const res = await request(app).get('/api/admin/workspaces?q=acme').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.total).toBe(3);
  });

  it.each([
    ['absent', '/api/admin/workspaces'],
    ['empty', '/api/admin/workspaces?q='],
    ['whitespace only', '/api/admin/workspaces?q=%20%20'],
  ])('filters nothing when the query is %s', async (_label, path) => {
    const alice = await makeAccount('alice');
    await makeWorkspace(alice, 'Acme');
    await makeWorkspace(alice, 'Beta');

    const res = await request(app).get(path).set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(2);
  });

  it('still finds a deleted workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app).get('/api/admin/workspaces?q=acme').set(...staff());

    // Deliberate: this is the staff surface, and a workspace staff cannot see
    // is one they cannot be told the truth about. The transfer service refuses
    // a deleted target on its own, so hiding it here would only turn a
    // legible refusal into a workspace that appears not to exist.
    expect(names(res)).toEqual(['Acme']);
    expect(res.body.data.total).toBe(1);
  });
});
