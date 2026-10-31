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

async function inviteAs(workspaceId: string, actor: [string, string], body: unknown) {
  return request(app).post(`/api/workspaces/${workspaceId}/invites`).set(...actor).send(body);
}

describe('POST /api/workspaces/:id/invites', () => {
  it('lets an ADMIN invite an email', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'MEMBER',
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: 'carol@ezo.test', role: 'MEMBER', status: 'PENDING' });
  });

  it('normalises the invited email', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: '  Carol@YE.test ',
      role: 'MEMBER',
    });

    expect(res.body.data.email).toBe('carol@ezo.test');
  });

  it('forbids a MEMBER from inviting', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await inviteAs(workspace.id, as('user_bob', 'bob@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'MEMBER',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a duplicate pending invite', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const actor = as('user_alice', 'alice@ezo.test');

    await inviteAs(workspace.id, actor, { email: 'carol@ezo.test', role: 'MEMBER' });
    const res = await inviteAs(workspace.id, actor, { email: 'carol@ezo.test', role: 'MEMBER' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_INVITED');
  });

  it('rejects inviting somebody who is already a member', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');

    const res = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'bob@ezo.test',
      role: 'MEMBER',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_MEMBER');
  });
});

describe('DELETE /api/workspaces/:id/invites/:inviteId', () => {
  it('lets an ADMIN revoke a pending invite', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const created = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'MEMBER',
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/invites/${created.body.data.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    const invite = await prisma.workspaceInvite.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(invite.status).toBe('REVOKED');
  });

  it('allows re-inviting and revoking the same email again', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const actor = as('user_alice', 'alice@ezo.test');

    const first = await inviteAs(workspace.id, actor, { email: 'carol@ezo.test', role: 'MEMBER' });
    await request(app)
      .delete(`/api/workspaces/${workspace.id}/invites/${first.body.data.id}`)
      .set(...actor);

    const second = await inviteAs(workspace.id, actor, { email: 'carol@ezo.test', role: 'MEMBER' });
    expect(second.status).toBe(201);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/invites/${second.body.data.id}`)
      .set(...actor);

    expect(res.status).toBe(200);
  });
});

describe('POST /api/invites/:id/accept', () => {
  it('creates the member row and marks the invite accepted', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const created = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'ADMIN',
    });

    const res = await request(app)
      .post(`/api/invites/${created.body.data.id}/accept`)
      .set(...as('user_carol', 'carol@ezo.test'));

    expect(res.status).toBe(200);

    const carol = await prisma.account.findUniqueOrThrow({ where: { clerkUserId: 'user_carol' } });
    const member = await prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_accountId: { workspaceId: workspace.id, accountId: carol.id } },
    });
    expect(member.role).toBe('ADMIN');

    const invite = await prisma.workspaceInvite.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(invite.status).toBe('ACCEPTED');
  });

  it('refuses when the account email does not match the invite', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const created = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'MEMBER',
    });

    const res = await request(app)
      .post(`/api/invites/${created.body.data.id}/accept`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITE_EMAIL_MISMATCH');
  });

  it('refuses an invite that is no longer pending', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const actor = as('user_alice', 'alice@ezo.test');
    const created = await inviteAs(workspace.id, actor, { email: 'carol@ezo.test', role: 'MEMBER' });

    await request(app)
      .delete(`/api/workspaces/${workspace.id}/invites/${created.body.data.id}`)
      .set(...actor);

    const res = await request(app)
      .post(`/api/invites/${created.body.data.id}/accept`)
      .set(...as('user_carol', 'carol@ezo.test'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('refuses when the invitee is already a member', async () => {
    const alice = await makeAccount('alice');
    const carol = await makeAccount('carol');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const created = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'MEMBER',
    });
    await addMember(workspace, carol, 'MEMBER');

    const res = await request(app)
      .post(`/api/invites/${created.body.data.id}/accept`)
      .set(...as('user_carol', 'carol@ezo.test'));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_MEMBER');
  });
});

describe('POST /api/invites/:id/decline', () => {
  it('marks the invite declined without creating a member', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const created = await inviteAs(workspace.id, as('user_alice', 'alice@ezo.test'), {
      email: 'carol@ezo.test',
      role: 'MEMBER',
    });

    const res = await request(app)
      .post(`/api/invites/${created.body.data.id}/decline`)
      .set(...as('user_carol', 'carol@ezo.test'));

    expect(res.status).toBe(200);

    const invite = await prisma.workspaceInvite.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(invite.status).toBe('DECLINED');
    expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });
});
