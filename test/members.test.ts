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

async function memberId(workspaceId: string, accountId: string): Promise<string> {
  const member = await prisma.workspaceMember.findUniqueOrThrow({
    where: { workspaceId_accountId: { workspaceId, accountId } },
  });
  return member.id;
}

describe('GET /api/workspaces/:id/members', () => {
  it('lists members with the owner flagged, including invites for an ADMIN', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    await prisma.workspaceInvite.create({
      data: { workspaceId: workspace.id, email: 'carol@ezo.test', role: 'MEMBER', invitedById: alice.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/members`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(2);

    const owner = res.body.data.members.find((m: { isOwner: boolean }) => m.isOwner);
    expect(owner).toMatchObject({ role: 'ADMIN', account: { email: 'alice@ezo.test' } });
    expect(res.body.data.pendingInvites).toHaveLength(1);
  });

  it('hides pending invites from a MEMBER', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    await prisma.workspaceInvite.create({
      data: { workspaceId: workspace.id, email: 'carol@ezo.test', role: 'MEMBER', invitedById: alice.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/members`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.members).toHaveLength(2);
    expect(res.body.data.pendingInvites).toEqual([]);
  });

  it('forbids a non-member', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await makeAccount('mallory');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/members`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/workspaces/:id/members/:memberId', () => {
  it('lets an ADMIN promote a member', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, bob.id)}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ADMIN');
  });

  it('forbids a MEMBER from changing roles', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, bob.id)}`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(403);
  });

  it('refuses to demote the owner', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'ADMIN');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, alice.id)}`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ role: 'MEMBER' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_MODIFY_OWNER');
  });

  it('will not touch a member of another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');

    const res = await request(app)
      .patch(`/api/workspaces/${mine.id}/members/${await memberId(theirs.id, bob.id)}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ role: 'MEMBER' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/workspaces/:id/members/:memberId', () => {
  it('lets an ADMIN remove a member', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, bob.id)}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });

  it('lets a MEMBER remove themselves', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, bob.id)}`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(200);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });

  it('forbids a MEMBER from removing somebody else', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const carol = await makeAccount('carol');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    await addMember(workspace, carol, 'MEMBER');

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, carol.id)}`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(403);
  });

  it('refuses to remove the owner', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'ADMIN');

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${await memberId(workspace.id, alice.id)}`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_MODIFY_OWNER');
  });
});
