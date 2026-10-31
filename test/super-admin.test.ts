import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeSuperAdmin, makeWorkspace } from './helpers.js';

const app = createApp();

const staff = () => as('user_staff', 'staff@ezo.test');
const alice = () => as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the membership bypass', () => {
  it('lets a super admin through an ADMIN-gated write in a workspace they are not in', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}`)
      .set(...staff())
      .send({ name: 'Acme Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Acme Renamed', role: 'ADMIN', isOwner: true });
  });

  it('still refuses an ordinary non-member with the same 403', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeAccount('staff'); // no flag

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}`)
      .set(...staff())
      .send({ name: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  /**
   * The no-leak rule, from the other side of the new branch.
   *
   * An ordinary caller must get the SAME refusal for a workspace that exists
   * and one that does not, or the 403 is an existence oracle over every
   * workspace id on the platform. The bypass put a 404 next to that rule, so
   * the natural tidy-up — hoisting the workspace lookup above the
   * `isSuperAdmin` check, since both branches want the row — silently turns
   * every customer's 403 into a 404. Nothing else in the suite fails if it
   * does.
   */
  it('gives an ordinary caller the same 403 whether or not the workspace exists', async () => {
    const owner = await makeAccount('bob');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeAccount('alice');

    const real = await request(app).patch(`/api/workspaces/${ws.id}`).set(...alice()).send({ name: 'x' });
    const fake = await request(app).patch('/api/workspaces/no-such-workspace').set(...alice()).send({ name: 'x' });

    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
    expect(fake.body.error.code).toBe(real.body.error.code);
    expect(fake.body.error.message).toBe(real.body.error.message);
  });

  it('answers a super admin 404 for a workspace that does not exist', async () => {
    await makeSuperAdmin('staff');

    const res = await request(app)
      .patch('/api/workspaces/nope')
      .set(...staff())
      .send({ name: 'x' });

    expect(res.status).toBe(404);
  });

  it('answers a super admin 404 for a soft-deleted workspace', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await prisma.workspace.update({ where: { id: ws.id }, data: { deletedAt: new Date() } });
    await makeSuperAdmin('staff');

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}`)
      .set(...staff())
      .send({ name: 'x' });

    expect(res.status).toBe(404);
  });

  it('records a bypassed DELETE under its own method and nested path', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');
    const bob = await makeAccount('bob');
    const membership = await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, accountId: bob.id, role: 'MEMBER' },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/members/${membership.id}`)
      .set(...staff());
    expect(res.status).toBe(200);

    // `method` and `path` are otherwise pinned by one request shape — every
    // other audit assertion is a PATCH on /api/workspaces/:id — so a
    // hardcoded 'PATCH', or a path built from `req.params.workspaceId`
    // instead of the real URL, survives the whole suite.
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: s.id,
      workspaceId: ws.id,
      method: 'DELETE',
      path: `/api/workspaces/${ws.id}/members/${membership.id}`,
      status: 200,
    });
  });

  it('passes the owner gate', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    const res = await request(app).delete(`/api/workspaces/${ws.id}`).set(...staff());

    // Nothing rented, nothing running: the delete goes through.
    expect(res.status).toBe(200);
    const row = await prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('uses a real membership when one exists, including its MEMBER role', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, accountId: s.id, role: 'MEMBER' },
    });

    // Own membership wins — the flag is not a promotion inside workspaces
    // the account genuinely belongs to.
    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}`)
      .set(...staff())
      .send({ name: 'x' });

    expect(res.status).toBe(403);
  });

  /**
   * The other half of "a real membership wins", and the one that matters most.
   *
   * A flagged account invited as ADMIN is an ADMIN here — not the owner — so
   * the owner gate still refuses it and its writes are ordinary use rather
   * than bypass. `req.superAdmin = account.isSuperAdmin` on the member branch
   * is a one-line mutation that hands owner rights to any super admin who has
   * ever been invited anywhere, and the MEMBER test above does not catch it:
   * that one is stopped by the `minimumRole` gate, which runs first.
   */
  it('refuses an owner-gated route to a super admin holding a real ADMIN membership', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, accountId: s.id, role: 'ADMIN' },
    });

    // ADMIN-gated write passes, on the strength of the membership.
    const rename = await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: 'y' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.isOwner).toBe(false);

    // The owner gate does not.
    const removed = await request(app).delete(`/api/workspaces/${ws.id}`).set(...staff());
    expect(removed.status).toBe(403);

    // And neither request was a bypass, so neither is audited.
    expect(await noAuditRows()).toBe(0);
  });

  it('cannot demote the real owner', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');
    const ownerMember = await prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: ws.id, accountId: owner.id },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/members/${ownerMember.id}`)
      .set(...staff())
      .send({ role: 'MEMBER' });

    // The route answers 400 for this, not the 409 the design sketched.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_MODIFY_OWNER');
  });
});

const SETTLE_MS = 500;

/**
 * The audit insert is fire-and-forget off the response's `close`, so it lands
 * after supertest has resolved. Polls for the first row, then waits out a
 * settle window before returning.
 *
 * The settle is not belt-and-braces: returning on the first row makes every
 * `toHaveLength(1)` below assert "at least one row existed when I looked",
 * which is a different claim. A second `res.on('finish', ...)` beside the
 * existing `close` listener — the obvious belt-and-braces edit — writes two
 * rows per bypassed write and a short-circuiting helper cannot see it.
 */
async function auditRows() {
  for (let i = 0; i < 20; i += 1) {
    const rows = await prisma.superAdminAction.findMany({ orderBy: { createdAt: 'asc' } });
    if (rows.length > 0) {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return prisma.superAdminAction.findMany({ orderBy: { createdAt: 'asc' } });
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return prisma.superAdminAction.findMany({ orderBy: { createdAt: 'asc' } });
}

/**
 * For the negative case. A spy that was never called proves nothing here —
 * `create` fires inside the `close` callback, not at hook registration — so
 * "no row" has to be asserted after the same window a row would have landed in.
 */
async function noAuditRows() {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return prisma.superAdminAction.count();
}

describe('the audit trail', () => {
  it('records a bypassed write with method, path, workspace and status', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');

    await request(app).patch(`/api/workspaces/${ws.id}?x=1`).set(...staff()).send({ name: 'y' });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: s.id,
      workspaceId: ws.id,
      method: 'PATCH',
      path: `/api/workspaces/${ws.id}`,
      status: 200,
    });
  });

  it('records a refused write too, with its status', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: '' });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(400);
  });

  // The hook is registered (or not) before the handler runs, so once the
  // response is back, a spy that was never called is proof rather than a
  // race that a fixed sleep happened to win.
  it('records 499 when the client hangs up before the response is written', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    // Hold the handler mid-write so the socket can be torn down while the
    // request is still in flight; the handler then finishes into a dead
    // socket, which is exactly the case `finish` never reports.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const update = prisma.workspace.update.bind(prisma.workspace);
    vi.spyOn(prisma.workspace, 'update').mockImplementationOnce(async (args) => {
      await held;
      return update(args);
    });

    // `test/setup.ts` memoises this into the one listening server supertest
    // also uses, so it is neither listened on nor closed here.
    const server = http.createServer(app);
    if (!server.listening) await once(server, 'listening');
    const { port } = server.address() as { port: number };
    {
      const body = JSON.stringify({ name: 'y' });
      const [header, value] = staff();
      const client = http.request({
        port,
        method: 'PATCH',
        path: `/api/workspaces/${ws.id}`,
        headers: {
          [header]: value,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      client.on('error', () => undefined);
      client.end(body);

      // Wait until the handler is parked inside the held update, then hang up.
      for (let i = 0; i < 40 && (prisma.workspace.update as unknown as { mock: { calls: unknown[] } }).mock.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      client.destroy();
      await new Promise((r) => setTimeout(r, 50));
      release();

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ workspaceId: ws.id, method: 'PATCH', status: 499 });
    }
  });

  /**
   * The abort that `once('close')` cannot catch. Everything above the hook —
   * the Clerk lookup, the account upsert, the membership read, the workspace
   * read — is awaited, and a socket that died during any of it has already
   * fired `close` by the time the hook is attached. The handler still runs,
   * so without a catch-up the write commits and leaves no trace at all.
   */
  it('records 499 when the client hangs up before the audit hook is attached', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');

    // The bypass's own workspace read is the last await before the hook, so
    // parking here puts the teardown strictly ahead of the attach.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const findUnique = prisma.workspace.findUnique.bind(prisma.workspace);
    let parked = false;
    vi.spyOn(prisma.workspace, 'findUnique').mockImplementationOnce(async (args) => {
      parked = true;
      await held;
      return findUnique(args);
    });

    const server = http.createServer(app);
    if (!server.listening) await once(server, 'listening');
    const { port } = server.address() as { port: number };

    const body = JSON.stringify({ name: 'renamed-after-hangup' });
    const [header, value] = staff();
    const client = http.request({
      port,
      method: 'PATCH',
      path: `/api/workspaces/${ws.id}`,
      headers: {
        [header]: value,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    client.on('error', () => undefined);
    client.end(body);

    for (let i = 0; i < 40 && !parked; i += 1) await new Promise((r) => setTimeout(r, 25));
    client.destroy();
    await new Promise((r) => setTimeout(r, 50));
    release();

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: s.id,
      workspaceId: ws.id,
      method: 'PATCH',
      status: 499,
    });

    // 499 is only worth recording because the write behind it landed.
    const after = await prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(after?.name).toBe('renamed-after-hangup');
  });

  it('does not record a read', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');
    const create = vi.spyOn(prisma.superAdminAction, 'create');

    const res = await request(app).get(`/api/workspaces/${ws.id}/members`).set(...staff());
    expect(res.status).toBe(200);

    expect(await noAuditRows()).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not record a write inside an own workspace', async () => {
    const s = await makeSuperAdmin('staff');
    const ws = await makeWorkspace(s, 'Mine');
    const create = vi.spyOn(prisma.superAdminAction, 'create');

    const res = await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: 'z' });
    expect(res.status).toBe(200);

    expect(await noAuditRows()).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * The escape from a pinned role, made visible.
   *
   * "Own membership wins" holds inside one request and is not a containment
   * boundary across two: `DELETE /:workspaceId/members/:memberId` lets anyone
   * leave, so a flagged account pinned to MEMBER can drop its own row and
   * take the bypass on the very next request. That is not a privilege it did
   * not already hold platform-wide — it is the transition being silent that
   * mattered, because self-removal runs on the member path, which records
   * nothing. The audit trail now shows the step out before the bypass writes
   * that follow it.
   */
  it('records a super admin removing their own membership, and the bypass it opens', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const s = await makeSuperAdmin('staff');
    const membership = await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, accountId: s.id, role: 'MEMBER' },
    });

    // Pinned to MEMBER, the ADMIN gate refuses — this is the rule holding.
    const pinned = await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: 'x' });
    expect(pinned.status).toBe(403);

    const left = await request(app)
      .delete(`/api/workspaces/${ws.id}/members/${membership.id}`)
      .set(...staff());
    expect(left.status).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: s.id,
      workspaceId: ws.id,
      method: 'DELETE',
      path: `/api/workspaces/${ws.id}/members/${membership.id}`,
      status: 200,
    });

    // And the bypass is now open, which is the point of recording the step.
    const after = await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: 'x' });
    expect(after.status).toBe(200);
  });

  it('does not record an ordinary member leaving a workspace', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    const bob = await makeAccount('bob');
    const membership = await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, accountId: bob.id, role: 'MEMBER' },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/members/${membership.id}`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(res.status).toBe(200);

    expect(await noAuditRows()).toBe(0);
  });

  it('serves the request and logs when the audit insert fails', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');
    const create = vi
      .spyOn(prisma.superAdminAction, 'create')
      .mockRejectedValueOnce(new Error('db down'));
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const res = await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: 'y' });
    expect(res.status).toBe(200);

    for (let i = 0; i < 20 && error.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ws.id, method: 'PATCH' }),
      'super admin audit write failed',
    );
    expect(await prisma.superAdminAction.count()).toBe(0);
  });
});

describe('GET /api/workspaces/:workspaceId', () => {
  it('returns a foreign workspace to a super admin as ADMIN and owner', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    const res = await request(app).get(`/api/workspaces/${ws.id}`).set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: ws.id, name: 'Acme', role: 'ADMIN', isOwner: true });
  });

  it('returns an own workspace with the real role and ownership', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');

    const res = await request(app).get(`/api/workspaces/${ws.id}`).set(...alice());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'ADMIN', isOwner: true });
  });

  it('is 403 for a non-member', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeAccount('staff');

    const res = await request(app).get(`/api/workspaces/${ws.id}`).set(...staff());
    expect(res.status).toBe(403);
  });

  it('/api/me lists only real memberships for a super admin', async () => {
    const owner = await makeAccount('alice');
    await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    const res = await request(app).get('/api/me').set(...staff());

    expect(res.body.data.account.isSuperAdmin).toBe(true);
    expect(res.body.data.workspaces).toEqual([]);
  });
});

describe('GET /api/super-admin/workspaces', () => {
  it('is 404 for an ordinary account, as if the route did not exist', async () => {
    await makeAccount('alice');
    const res = await request(app).get('/api/super-admin/workspaces').set(...alice());
    expect(res.status).toBe(404);
  });

  it('lists every live workspace with its owner, ordered by owner email then name', async () => {
    const bob = await makeAccount('bob');
    const alice = await makeAccount('alice');
    await makeWorkspace(bob, 'Zeta');
    await makeWorkspace(alice, 'Beta');
    await makeWorkspace(alice, 'Alpha');
    const gone = await makeWorkspace(alice, 'Gone');
    await prisma.workspace.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await makeSuperAdmin('staff');

    const res = await request(app).get('/api/super-admin/workspaces').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((w: { name: string }) => w.name)).toEqual(['Alpha', 'Beta', 'Zeta']);
    expect(res.body.data.items[0].account).toMatchObject({ email: 'alice@ezo.test' });
    expect(res.body.data.items[0].isMember).toBe(false);
    expect(res.body.data.total).toBe(3);
  });

  it('searches workspace name, slug, owner name and owner email', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    await makeWorkspace(alice, 'Dental');
    await makeWorkspace(bob, 'Garage');
    await makeSuperAdmin('staff');

    const byOwner = await request(app).get('/api/super-admin/workspaces?q=BOB@').set(...staff());
    expect(byOwner.body.data.items.map((w: { name: string }) => w.name)).toEqual(['Garage']);

    const byName = await request(app).get('/api/super-admin/workspaces?q=dent').set(...staff());
    expect(byName.body.data.items.map((w: { name: string }) => w.name)).toEqual(['Dental']);
  });

  it('marks workspaces the super admin is really a member of', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'Dental');
    const s = await makeSuperAdmin('staff');
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, accountId: s.id, role: 'MEMBER' } });

    const res = await request(app).get('/api/super-admin/workspaces').set(...staff());
    expect(res.body.data.items[0].isMember).toBe(true);
  });

  it('rejects a bad limit', async () => {
    await makeSuperAdmin('staff');
    const res = await request(app).get('/api/super-admin/workspaces?limit=x').set(...staff());
    expect(res.status).toBe(400);
  });

  it('answers 404 before validation, so a bad query never confirms the route exists', async () => {
    await makeAccount('alice');
    const res = await request(app).get('/api/super-admin/workspaces?limit=x').set(...alice());
    expect(res.status).toBe(404);
  });
});
