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

describe('GET /api/me', () => {
  it('reports isSuperAdmin, false for everyone by default', async () => {
    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));
    expect(res.body.data.account.isSuperAdmin).toBe(false);
  });

  it('returns an empty bootstrap for a brand-new account', async () => {
    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.account).toMatchObject({ email: 'alice@ezo.test' });
    expect(res.body.data.account.credits).toBe('0');
  });

  it('reports credits in display units, the same as /billing', async () => {
    // '0' is the one balance where the internal and display encodings agree,
    // which is why a bare `.toString()` here survived until a second endpoint
    // reported the same number 10000x smaller.
    const account = await makeAccount('alice');
    await prisma.account.update({ where: { id: account.id }, data: { credits: 5_000_000n } });

    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.account.credits).toBe('500');
    expect(res.body.data.workspaces).toEqual([]);
    expect(res.body.data.pendingInvites).toEqual([]);
  });

  it('lists workspaces the account belongs to, with role and ownership', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const owned = await makeWorkspace(alice, 'Alice Co');
    const joined = await makeWorkspace(bob, 'Bob Co');
    await addMember(joined, alice, 'MEMBER');

    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    const workspaces = res.body.data.workspaces;
    expect(workspaces).toHaveLength(2);

    const ownedResult = workspaces.find((w: { id: string }) => w.id === owned.id);
    expect(ownedResult).toMatchObject({
      id: owned.id,
      name: 'Alice Co',
      slug: owned.slug,
      role: 'ADMIN',
      isOwner: true,
    });

    const joinedResult = workspaces.find((w: { id: string }) => w.id === joined.id);
    expect(joinedResult).toMatchObject({ id: joined.id, role: 'MEMBER', isOwner: false });
  });

  it('surfaces pending invites matching the account email', async () => {
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(bob, 'Bob Co');
    await prisma.workspaceInvite.create({
      data: {
        workspaceId: workspace.id,
        email: 'alice@ezo.test',
        role: 'MEMBER',
        status: 'PENDING',
        invitedById: bob.id,
      },
    });

    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data.pendingInvites).toHaveLength(1);
    expect(res.body.data.pendingInvites[0]).toMatchObject({
      role: 'MEMBER',
      workspace: { id: workspace.id, name: 'Bob Co' },
    });
  });

  it('ignores invites that are not pending, and invites for other people', async () => {
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(bob, 'Bob Co');
    await prisma.workspaceInvite.createMany({
      data: [
        {
          workspaceId: workspace.id,
          email: 'alice@ezo.test',
          role: 'MEMBER',
          status: 'ACCEPTED',
          invitedById: bob.id,
        },
        {
          workspaceId: workspace.id,
          email: 'alice@ezo.test',
          role: 'MEMBER',
          status: 'REVOKED',
          invitedById: bob.id,
        },
        {
          workspaceId: workspace.id,
          email: 'carol@ezo.test',
          role: 'MEMBER',
          status: 'PENDING',
          invitedById: bob.id,
        },
      ],
    });

    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data.pendingInvites).toEqual([]);
  });
});
