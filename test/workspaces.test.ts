import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

describe('POST /api/workspaces', () => {
  it('creates the workspace with the creator as owner and ADMIN member', async () => {
    const res = await request(app)
      .post('/api/workspaces')
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Acme Support' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Acme Support', slug: 'acme-support', role: 'ADMIN', isOwner: true });
    expect(res.body.data.color).toBeTruthy();

    const account = await prisma.account.findUniqueOrThrow({ where: { clerkUserId: 'user_alice' } });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(workspace.ownerAccountId).toBe(account.id);

    const member = await prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_accountId: { workspaceId: workspace.id, accountId: account.id } },
    });
    expect(member.role).toBe('ADMIN');
  });

  it('suffixes the slug when it collides', async () => {
    const headers = as('user_alice', 'alice@ezo.test');

    const first = await request(app).post('/api/workspaces').set(...headers).send({ name: 'Acme Support' });
    const second = await request(app).post('/api/workspaces').set(...headers).send({ name: 'Acme Support' });

    expect(first.body.data.slug).toBe('acme-support');
    expect(second.body.data.slug).toBe('acme-support-2');
  });

  it('rejects a missing or oversized name', async () => {
    const headers = as('user_alice', 'alice@ezo.test');

    const empty = await request(app).post('/api/workspaces').set(...headers).send({ name: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const long = await request(app).post('/api/workspaces').set(...headers).send({ name: 'x'.repeat(65) });
    expect(long.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/workspaces').send({ name: 'Acme' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/workspaces/:id', () => {
  it('lets an ADMIN rename the workspace', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Old Name');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('New Name');
  });

  it('forbids a MEMBER from renaming', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('forbids a non-member, without leaking existence', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAccount('mallory');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}`)
      .set(...as('user_mallory', 'mallory@ezo.test'))
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
