import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Account, NotificationScope, Workspace } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

const app = createApp();

let alice: Account; // ADMIN — the owner
let bob: Account; // MEMBER
let workspace: Workspace;

/**
 * `createdAt` is stamped explicitly and strictly increasing rather than left to
 * the clock. `TIMESTAMP(3)` plus a sub-millisecond round trip means two rows
 * created in a row can genuinely tie, and the order would then fall through to
 * `id DESC` — which happens to hold for cuids, so the tests would pass for a
 * reason they never asserted. Ordering is what most of this file is about, so
 * it should not be left to luck.
 */
let clock = 0;

async function makeNotification(
  ws: Workspace,
  scope: NotificationScope,
  title: string,
  href?: string,
) {
  clock += 1000;

  return prisma.notification.create({
    data: {
      workspaceId: ws.id,
      scope,
      type: 'test.event',
      title,
      body: `${title} happened.`,
      href: href ?? null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + clock),
    },
  });
}

const asAlice = () => as('user_alice', 'alice@ezo.test');
const asBob = () => as('user_bob', 'bob@ezo.test');

beforeEach(async () => {
  await truncateAll();
  clock = 0;
  alice = await makeAccount('alice');
  bob = await makeAccount('bob');
  workspace = await makeWorkspace(alice, 'A Co');
  await addMember(workspace, bob, 'MEMBER');
});

describe('GET /api/workspaces/:id/notifications', () => {
  it('shows a MEMBER only the ALL_MEMBERS rows', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'Everyone sees this');
    await makeNotification(workspace, 'ADMINS_ONLY', 'Admins only');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asBob());

    expect(res.status).toBe(200);
    expect(res.body.data.notifications.map((n: { title: string }) => n.title)).toEqual([
      'Everyone sees this',
    ]);
  });

  it('shows an ADMIN both scopes', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'Everyone sees this');
    await makeNotification(workspace, 'ADMINS_ONLY', 'Admins only');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.notifications.map((n: { title: string }) => n.title)).toEqual([
      'Admins only',
      'Everyone sees this',
    ]);
  });

  it('orders newest first', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'first');
    await makeNotification(workspace, 'ALL_MEMBERS', 'second');
    await makeNotification(workspace, 'ALL_MEMBERS', 'third');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asBob());

    expect(res.body.data.notifications.map((n: { title: string }) => n.title)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('carries this caller’s read state, not somebody else’s', async () => {
    const seen = await makeNotification(workspace, 'ALL_MEMBERS', 'read by alice');
    await makeNotification(workspace, 'ALL_MEMBERS', 'read by nobody');
    await prisma.notificationRead.create({
      data: { notificationId: seen.id, accountId: alice.id },
    });

    const forAlice = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asAlice());
    const forBob = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asBob());

    const readFlags = (res: { body: { data: { notifications: { title: string; read: boolean }[] } } }) =>
      Object.fromEntries(res.body.data.notifications.map((n) => [n.title, n.read]));

    expect(readFlags(forAlice)).toEqual({ 'read by alice': true, 'read by nobody': false });
    expect(readFlags(forBob)).toEqual({ 'read by alice': false, 'read by nobody': false });
  });

  it('reports readAt for a row this caller has read', async () => {
    const seen = await makeNotification(workspace, 'ALL_MEMBERS', 'seen');
    await prisma.notificationRead.create({
      data: { notificationId: seen.id, accountId: bob.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asBob());

    expect(res.body.data.notifications[0].readAt).toEqual(expect.any(String));
  });

  it('never returns another workspace’s rows', async () => {
    const other = await makeWorkspace(await makeAccount('carol'), 'C Co');
    await makeNotification(other, 'ALL_MEMBERS', 'not yours');
    await makeNotification(workspace, 'ALL_MEMBERS', 'yours');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...asBob());

    expect(res.body.data.notifications.map((n: { title: string }) => n.title)).toEqual(['yours']);
  });

  it('answers 403 to somebody who is not a member', async () => {
    await makeAccount('mallory');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: expect.any(String) },
    });
  });

  it('pages with a cursor, newest first, without repeating a row', async () => {
    for (const title of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      await makeNotification(workspace, 'ALL_MEMBERS', title);
    }

    const first = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?limit=2`)
      .set(...asBob());

    expect(first.body.data.notifications.map((n: { title: string }) => n.title)).toEqual(['n5', 'n4']);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(
        `/api/workspaces/${workspace.id}/notifications?limit=2&cursor=${first.body.data.nextCursor}`,
      )
      .set(...asBob());

    expect(second.body.data.notifications.map((n: { title: string }) => n.title)).toEqual(['n3', 'n2']);
  });

  it('reports a null cursor on the last page', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'only one');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?limit=5`)
      .set(...asBob());

    expect(res.body.data.nextCursor).toBeNull();
  });

  it('does not let a MEMBER page into ADMINS_ONLY rows', async () => {
    await makeNotification(workspace, 'ADMINS_ONLY', 'a1');
    await makeNotification(workspace, 'ALL_MEMBERS', 'm1');
    await makeNotification(workspace, 'ADMINS_ONLY', 'a2');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?limit=50`)
      .set(...asBob());

    expect(res.body.data.notifications.map((n: { title: string }) => n.title)).toEqual(['m1']);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('refuses a cursor naming an ADMINS_ONLY row, rather than paging from it', async () => {
    const hidden = await makeNotification(workspace, 'ADMINS_ONLY', 'a1');
    await makeNotification(workspace, 'ALL_MEMBERS', 'm1');
    await makeNotification(workspace, 'ALL_MEMBERS', 'm2');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?cursor=${hidden.id}`)
      .set(...asBob());

    // Prisma's own `cursor` resolves through an unfiltered subquery, so this
    // would otherwise answer "everything older than a1" — telling a MEMBER both
    // that the id is real and where in time it sits.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a cursor naming another workspace’s row', async () => {
    const other = await makeWorkspace(await makeAccount('dave'), 'D Co');
    const theirs = await makeNotification(other, 'ALL_MEMBERS', 'not yours');
    await makeNotification(workspace, 'ALL_MEMBERS', 'mine');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?cursor=${theirs.id}`)
      .set(...asBob());

    expect(res.status).toBe(400);
  });

  it('refuses a cursor naming no row at all, rather than reporting an empty page', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'm1');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?cursor=does_not_exist`)
      .set(...asBob());

    // An empty page here would be indistinguishable from the end of the feed,
    // and the difference between the two is exactly what the oracle read.
    expect(res.status).toBe(400);
  });

  it('skips no visible row when hidden rows sit between the pages', async () => {
    // Interleaved so that every page boundary for a MEMBER falls next to a row
    // they cannot see. This guards the hand-rolled keyset that replaced
    // Prisma's `cursor`: the `OR` on (createdAt, id) has to be a total
    // comparison, or a boundary next to a hidden row repeats or drops one.
    // (It does not reproduce the old `skip: 1` bug — reaching that needed a
    // cursor outside the visible set, which is now a 400 above.)
    await makeNotification(workspace, 'ALL_MEMBERS', 'm1');
    await makeNotification(workspace, 'ADMINS_ONLY', 'a1');
    await makeNotification(workspace, 'ALL_MEMBERS', 'm2');
    await makeNotification(workspace, 'ADMINS_ONLY', 'a2');
    await makeNotification(workspace, 'ALL_MEMBERS', 'm3');

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const res: request.Response = await request(app)
        .get(
          `/api/workspaces/${workspace.id}/notifications?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        )
        .set(...asBob());

      expect(res.status).toBe(200);
      seen.push(...res.body.data.notifications.map((n: { title: string }) => n.title));
      cursor = res.body.data.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['m3', 'm2', 'm1']);
  });

  it('treats an empty cursor as the first page', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'm1');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?cursor=`)
      .set(...asBob());

    // A client building `&cursor=${nextCursor ?? ''}` is saying it has no
    // cursor, not naming one that does not exist.
    expect(res.status).toBe(200);
    expect(res.body.data.notifications.map((n: { title: string }) => n.title)).toEqual(['m1']);
  });

  it('rejects a limit outside the allowed range', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications?limit=500`)
      .set(...asBob());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/workspaces/:id/notifications/unread-count', () => {
  it('counts only what this caller has not read', async () => {
    const seen = await makeNotification(workspace, 'ALL_MEMBERS', 'seen');
    await makeNotification(workspace, 'ALL_MEMBERS', 'unseen');
    await prisma.notificationRead.create({
      data: { notificationId: seen.id, accountId: bob.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asBob());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ count: 1 });
  });

  it('excludes ADMINS_ONLY rows from a MEMBER’s count', async () => {
    await makeNotification(workspace, 'ADMINS_ONLY', 'a1');
    await makeNotification(workspace, 'ADMINS_ONLY', 'a2');
    await makeNotification(workspace, 'ALL_MEMBERS', 'm1');

    const forBob = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asBob());
    const forAlice = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asAlice());

    expect(forBob.body.data).toEqual({ count: 1 });
    expect(forAlice.body.data).toEqual({ count: 3 });
  });

  it('counts per account — one person reading does not clear another’s', async () => {
    const one = await makeNotification(workspace, 'ALL_MEMBERS', 'one');
    await prisma.notificationRead.create({
      data: { notificationId: one.id, accountId: alice.id },
    });

    const forAlice = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asAlice());
    const forBob = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asBob());

    expect(forAlice.body.data).toEqual({ count: 0 });
    expect(forBob.body.data).toEqual({ count: 1 });
  });

  it('does not count another workspace’s rows', async () => {
    const other = await makeWorkspace(await makeAccount('carol'), 'C Co');
    await makeNotification(other, 'ALL_MEMBERS', 'not yours');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asBob());

    expect(res.body.data).toEqual({ count: 0 });
  });

  it('answers 403 to somebody who is not a member', async () => {
    await makeAccount('mallory');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...as('user_mallory', 'mallory@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('POST /api/workspaces/:id/notifications/read', () => {
  it('marks the given rows read for this caller only', async () => {
    const one = await makeNotification(workspace, 'ALL_MEMBERS', 'one');
    const two = await makeNotification(workspace, 'ALL_MEMBERS', 'two');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [one.id, two.id] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marked: 2 });

    const rows = await prisma.notificationRead.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.accountId === bob.id)).toBe(true);
  });

  it('is idempotent — a second call marks nothing and does not move readAt', async () => {
    const one = await makeNotification(workspace, 'ALL_MEMBERS', 'one');

    const first = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [one.id] });
    const readAt = (await prisma.notificationRead.findFirstOrThrow()).readAt;

    const second = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [one.id] });

    expect(first.body.data).toEqual({ marked: 1 });
    expect(second.body.data).toEqual({ marked: 0 });
    await expect(prisma.notificationRead.count()).resolves.toBe(1);
    expect((await prisma.notificationRead.findFirstOrThrow()).readAt).toEqual(readAt);
  });

  it('ignores an ADMINS_ONLY id a MEMBER names directly', async () => {
    // The load-bearing case: knowing the id must not make the row actionable,
    // and the answer must not confirm that the id names anything real.
    const hidden = await makeNotification(workspace, 'ADMINS_ONLY', 'admins only');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [hidden.id] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marked: 0 });
    await expect(prisma.notificationRead.count()).resolves.toBe(0);
  });

  it('marks the visible ids in a mixed list and ignores the rest', async () => {
    const visible = await makeNotification(workspace, 'ALL_MEMBERS', 'visible');
    const hidden = await makeNotification(workspace, 'ADMINS_ONLY', 'hidden');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [visible.id, hidden.id] });

    expect(res.body.data).toEqual({ marked: 1 });
    const rows = await prisma.notificationRead.findMany();
    expect(rows.map((r) => r.notificationId)).toEqual([visible.id]);
  });

  it('ignores an id belonging to another workspace', async () => {
    const other = await makeWorkspace(await makeAccount('carol'), 'C Co');
    const foreign = await makeNotification(other, 'ALL_MEMBERS', 'not yours');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [foreign.id] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marked: 0 });
    await expect(prisma.notificationRead.count()).resolves.toBe(0);
  });

  it('ignores an id that does not exist at all', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: ['nope_not_a_real_id'] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marked: 0 });
  });

  it('rejects a body with no ids', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...asBob())
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 403 to somebody who is not a member', async () => {
    await makeAccount('mallory');
    const one = await makeNotification(workspace, 'ALL_MEMBERS', 'one');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read`)
      .set(...as('user_mallory', 'mallory@ezo.test'))
      .send({ ids: [one.id] });

    expect(res.status).toBe(403);
    await expect(prisma.notificationRead.count()).resolves.toBe(0);
  });
});

describe('POST /api/workspaces/:id/notifications/read-all', () => {
  it('marks everything this caller can see', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'one');
    await makeNotification(workspace, 'ALL_MEMBERS', 'two');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read-all`)
      .set(...asBob());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marked: 2 });

    const count = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asBob());
    expect(count.body.data).toEqual({ count: 0 });
  });

  it('leaves ADMINS_ONLY rows unread for a MEMBER, and unread for the admin', async () => {
    await makeNotification(workspace, 'ADMINS_ONLY', 'admins only');
    await makeNotification(workspace, 'ALL_MEMBERS', 'everyone');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read-all`)
      .set(...asBob());

    expect(res.body.data).toEqual({ marked: 1 });

    const forAlice = await request(app)
      .get(`/api/workspaces/${workspace.id}/notifications/unread-count`)
      .set(...asAlice());
    expect(forAlice.body.data).toEqual({ count: 2 });
  });

  it('is idempotent', async () => {
    await makeNotification(workspace, 'ALL_MEMBERS', 'one');

    const first = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read-all`)
      .set(...asBob());
    const second = await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read-all`)
      .set(...asBob());

    expect(first.body.data).toEqual({ marked: 1 });
    expect(second.body.data).toEqual({ marked: 0 });
    await expect(prisma.notificationRead.count()).resolves.toBe(1);
  });

  it('does not touch another workspace’s rows', async () => {
    const other = await makeWorkspace(bob, 'B Co');
    await makeNotification(other, 'ALL_MEMBERS', 'elsewhere');
    await makeNotification(workspace, 'ALL_MEMBERS', 'here');

    await request(app)
      .post(`/api/workspaces/${workspace.id}/notifications/read-all`)
      .set(...asBob());

    const elsewhere = await request(app)
      .get(`/api/workspaces/${other.id}/notifications/unread-count`)
      .set(...asBob());
    expect(elsewhere.body.data).toEqual({ count: 1 });
  });
});
