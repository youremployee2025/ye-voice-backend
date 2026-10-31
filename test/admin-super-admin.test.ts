import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeSuperAdmin, makeWorkspace } from './helpers.js';

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

beforeEach(async () => {
  await truncateAll();
});

describe('PATCH /api/admin/accounts/:id/super-admin', () => {
  it('refuses without a token', async () => {
    const res = await request(app).patch('/api/admin/accounts/x/super-admin').send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('grants the flag and records it', async () => {
    const alice = await makeAccount('alice');
    await makeWorkspace(alice, 'Acme');

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...staff())
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.is_super_admin).toBe(true);
    expect(res.body.data).toMatchObject({ workspace_count: 1, membership_count: 1 });
    const row = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(row.isSuperAdmin).toBe(true);
    const actions = await prisma.superAdminAction.findMany();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      accountId: null,
      subjectAccountId: alice.id,
      method: 'GRANT',
      workspaceId: null,
    });
    expect(res.body.data.super_admin_granted_at).toBe(actions[0].createdAt.toISOString());
  });

  /**
   * `accountId` on this table means WHO ACTED. A grant has no identifiable
   * actor — `ADMIN_STAFF_TOKEN` is one shared secret, so the request names
   * nobody — and the account in the URL is the one the flag was done TO.
   * Writing it into `accountId` made the audit trail answer "what did Alice
   * do as super admin" with a GRANT row Alice had nothing to do with.
   */
  it('records the grant against its subject, never as something the subject did', async () => {
    const alice = await makeAccount('alice');

    await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...staff())
      .send({ enabled: true });

    const actions = await prisma.superAdminAction.findMany();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      accountId: null,
      subjectAccountId: alice.id,
      method: 'GRANT',
      workspaceId: null,
    });
  });

  it('keeps the grant out of what the subject is shown to have done', async () => {
    const alice = await makeAccount('alice');
    await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...staff())
      .send({ enabled: true });

    const acted = await request(app)
      .get(`/api/admin/super-admin-actions?accountId=${alice.id}`)
      .set(...staff());
    expect(acted.status).toBe(200);
    expect(acted.body.data.items).toHaveLength(0);

    const about = await request(app)
      .get(`/api/admin/super-admin-actions?subjectAccountId=${alice.id}`)
      .set(...staff());
    expect(about.status).toBe(200);
    expect(about.body.data.items).toHaveLength(1);
    expect(about.body.data.items[0]).toMatchObject({
      method: 'GRANT',
      account: null,
      subject_account: { id: alice.id, email: alice.email },
    });
  });

  it('is idempotent: re-granting writes no second row', async () => {
    const s = await makeSuperAdmin('staff');
    const res = await request(app)
      .patch(`/api/admin/accounts/${s.id}/super-admin`)
      .set(...staff())
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(await prisma.superAdminAction.count()).toBe(0);
  });

  it('revokes and records', async () => {
    const s = await makeSuperAdmin('staff');
    const res = await request(app)
      .patch(`/api/admin/accounts/${s.id}/super-admin`)
      .set(...staff())
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data.is_super_admin).toBe(false);
    expect(res.body.data.super_admin_granted_at).toBeNull();
    const row = await prisma.account.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.isSuperAdmin).toBe(false);
    expect((await prisma.superAdminAction.findFirst())?.method).toBe('REVOKE');
  });

  it('is 404 for an unknown account', async () => {
    const res = await request(app)
      .patch('/api/admin/accounts/nope/super-admin')
      .set(...staff())
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });

  it('rejects a body without a boolean', async () => {
    const alice = await makeAccount('alice');
    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...staff())
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(await prisma.superAdminAction.count()).toBe(0);
  });

  it('is not reachable through a Clerk session', async () => {
    const alice = await makeAccount('alice');
    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/accounts/:id super_admin_granted_at', () => {
  it('is null for an account that has never been granted', async () => {
    const alice = await makeAccount('alice');
    const res = await request(app).get(`/api/admin/accounts/${alice.id}`).set(...staff());
    expect(res.status).toBe(200);
    expect(res.body.data.is_super_admin).toBe(false);
    expect(res.body.data.super_admin_granted_at).toBeNull();
  });

  it('is the newest GRANT while the flag is on, and null once it is revoked', async () => {
    const alice = await makeAccount('alice');
    await prisma.superAdminAction.createMany({
      data: [
        { subjectAccountId: alice.id, method: 'GRANT', path: '/g', status: 200, createdAt: new Date('2026-09-01') },
        { subjectAccountId: alice.id, method: 'REVOKE', path: '/g', status: 200, createdAt: new Date('2026-09-02') },
        { subjectAccountId: alice.id, method: 'GRANT', path: '/g', status: 200, createdAt: new Date('2026-09-03') },
      ],
    });
    await prisma.account.update({ where: { id: alice.id }, data: { isSuperAdmin: true } });

    const granted = await request(app).get(`/api/admin/accounts/${alice.id}`).set(...staff());
    expect(granted.body.data.super_admin_granted_at).toBe(new Date('2026-09-03').toISOString());

    await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...staff())
      .send({ enabled: false });

    const revoked = await request(app).get(`/api/admin/accounts/${alice.id}`).set(...staff());
    expect(revoked.body.data.is_super_admin).toBe(false);
    expect(revoked.body.data.super_admin_granted_at).toBeNull();
  });
});

describe('GET /api/admin/super-admin-actions', () => {
  it('lists newest first with account email and workspace name, filterable', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');
    await prisma.superAdminAction.createMany({
      data: [
        { accountId: s.id, workspaceId: ws.id, method: 'PATCH', path: '/a', status: 200, createdAt: new Date('2026-09-01') },
        { accountId: s.id, workspaceId: null, method: 'GRANT', path: '/g', status: 200, createdAt: new Date('2026-09-02') },
      ],
    });

    const all = await request(app).get('/api/admin/super-admin-actions').set(...staff());
    expect(all.status).toBe(200);
    expect(all.body.data.items.map((r: { method: string }) => r.method)).toEqual(['GRANT', 'PATCH']);
    expect(all.body.data.items[1]).toMatchObject({
      account: { email: 'staff@ezo.test' },
      workspace: { id: ws.id, name: 'Acme' },
    });
    expect(all.body.data.items[0].workspace).toBeNull();

    const filtered = await request(app)
      .get(`/api/admin/super-admin-actions?workspaceId=${ws.id}`)
      .set(...staff());
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.total).toBe(1);
  });

  it('searches account email and workspace name with q, on top of the id filters', async () => {
    const owner = await makeAccount('alice');
    const acme = await makeWorkspace(owner, 'Acme');
    const zed = await makeWorkspace(owner, 'Zed');
    const s = await makeSuperAdmin('staff');
    const other = await makeSuperAdmin('other');
    await prisma.superAdminAction.createMany({
      data: [
        { accountId: s.id, workspaceId: acme.id, method: 'PATCH', path: '/a', status: 200 },
        { accountId: s.id, workspaceId: zed.id, method: 'POST', path: '/z', status: 201 },
        { accountId: other.id, workspaceId: acme.id, method: 'DELETE', path: '/d', status: 200 },
      ],
    });

    const byWorkspace = await request(app).get('/api/admin/super-admin-actions?q=ACME').set(...staff());
    expect(byWorkspace.body.data.total).toBe(2);

    const byEmail = await request(app).get('/api/admin/super-admin-actions?q=other@').set(...staff());
    expect(byEmail.body.data.items.map((r: { method: string }) => r.method)).toEqual(['DELETE']);

    const both = await request(app)
      .get(`/api/admin/super-admin-actions?q=acme&accountId=${s.id}`)
      .set(...staff());
    expect(both.body.data.items.map((r: { method: string }) => r.method)).toEqual(['PATCH']);
  });

  it('refuses without a token', async () => {
    const res = await request(app).get('/api/admin/super-admin-actions');
    expect(res.status).toBe(401);
  });

  it('accounts listing carries is_super_admin', async () => {
    await makeSuperAdmin('staff');
    const res = await request(app).get('/api/admin/accounts').set(...staff());
    expect(res.body.data.items[0].is_super_admin).toBe(true);
  });
});
