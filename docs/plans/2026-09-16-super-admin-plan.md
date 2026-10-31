# Super Admin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A staff account flagged `isSuperAdmin` can open any live workspace in the customer dashboard with owner rights, every write it makes there is recorded, and the flag is granted and its activity read from the staff console.

**Architecture:** One column on `Account` and one audit table. `requireMembership` gains a bypass branch (no membership + flag → load workspace, role ADMIN, mark request), `requireOwner` honours the mark, and a `res.on('finish')` hook records non-GET requests that used the bypass. A `/api/super-admin/workspaces` search feeds a picker in the dashboard switcher; a visiting banner shows when the active workspace is not one of the account's own. The staff console grants the flag and lists the audit rows.

**Tech Stack:** Express 5 + Prisma + zod + vitest/supertest (backend); Next 15 app router + Clerk + vitest/jsdom (dashboard); Next 15 server components + server actions + vitest (admin console).

**Design:** `docs/plans/2026-09-16-super-admin-design.md`. One deviation, decided here: both new listings use the existing **offset** `parsePagination` helper rather than a hand-rolled cursor. The design's reason for a cursor (Prisma `cursor:` bypasses `where`) is exactly why `lib/pagination.ts` was written offset-only, and both lists are staff-facing and small.

**Worktrees:** `ye-voice-agent/.worktrees/super-admin/{ye-voice-backend,ye-voice-dashboard,ye-voice-admin}`, branch `feat/super-admin` in each, off `origin/main`. Backend `.env` points at `ye_voice_super_admin` (dev) and `ye_voice_test_super_admin` (test). Run backend commands with `env -u DATABASE_URL -u TEST_DATABASE_URL` in front so an exported shell var cannot redirect them.

**Baseline (verified 2026-09-16):** backend 178 files / 3811 tests, dashboard 118 / 1978, admin 25 / 278, all green, `tsc` clean in all three.

---

## Part A — Backend (`ye-voice-backend`)

All paths relative to the backend worktree. Test command for one file:

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/<file>.test.ts
```

### Task A1: Schema, migration, test table list

**Files:**
- Modify: `prisma/schema.prisma` (`model Account` ~line 22, `model Workspace` ~line 52; append new model)
- Create: `prisma/migrations/20260916120000_super_admin/migration.sql` (via `migrate dev`)
- Modify: `test/setup.ts:178` (`TABLES`)

**Step 1: Add the column, relations and model**

In `model Account`, after `concurrencyLimit`:

```prisma
  /// Staff flag. Set only through the staff-token admin API, never through a
  /// Clerk-authenticated route. `requireMembership` treats a flagged account as
  /// an ADMIN and owner in every live workspace it is not a member of.
  isSuperAdmin      Boolean  @default(false)
  superAdminActions SuperAdminAction[]
```

In `model Workspace`, beside the other relation lists:

```prisma
  superAdminActions SuperAdminAction[]
```

At the end of the file:

```prisma
/// One row per mutating request a super admin made through the membership
/// bypass, plus one per grant and revoke. Reads are not recorded, and neither
/// are writes inside a workspace the account is a real member of.
model SuperAdminAction {
  id          String     @id @default(cuid())
  accountId   String
  account     Account    @relation(fields: [accountId], references: [id], onDelete: Cascade)
  workspaceId String?
  workspace   Workspace? @relation(fields: [workspaceId], references: [id], onDelete: SetNull)
  /// PATCH | POST | PUT | DELETE for a request; GRANT | REVOKE for the flag.
  method      String
  /// `req.originalUrl` without its query string.
  path        String
  /// Response status. A refused attempt is still worth seeing.
  status      Int
  createdAt   DateTime   @default(now())

  @@index([accountId, createdAt])
  @@index([workspaceId, createdAt])
  @@index([createdAt])
}
```

**Step 2: Create the migration**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx prisma migrate dev --name super_admin
ls prisma/migrations | tail -2
```

Expected: a new directory that sorts **after** `20260911153007_workspace_soft_delete`. If the timestamp sorts earlier, rename the directory to `20260916120000_super_admin`.

**Step 3: Add the table to the truncate list**

In `test/setup.ts`, insert before `'WorkspaceMember'`:

```ts
  // Points at Account (Cascade) and Workspace (SetNull); before both.
  'SuperAdminAction',
```

**Step 4: Prepare the test DB and confirm the suite still passes a smoke file**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npm run test:prepare
env -u DATABASE_URL -u TEST_DATABASE_URL npx tsc --noEmit
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/me.test.ts
```

Expected: tsc clean; me.test.ts passes.

**Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/setup.ts
git commit -m "feat(schema): Account.isSuperAdmin and the SuperAdminAction audit table

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A2: The membership bypass

**Files:**
- Modify: `src/types/express.d.ts`
- Modify: `src/middleware/workspace.ts:13-45` (`requireMembership`), `:69-80` (`requireOwner`)
- Modify: `test/helpers.ts` (add `makeSuperAdmin`)
- Create: `test/super-admin.test.ts`

**Step 1: Add the helper**

Append to `test/helpers.ts`:

```ts
/** A staff account carrying the flag, and a member of nothing. */
export async function makeSuperAdmin(handle: string): Promise<Account> {
  return prisma.account.create({
    data: {
      clerkUserId: `user_${handle}`,
      email: `${handle}@ezo.test`,
      name: handle,
      isSuperAdmin: true,
    },
  });
}
```

**Step 2: Write the failing tests**

`test/super-admin.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeSuperAdmin, makeWorkspace } from './helpers.js';

const app = createApp();

const staff = () => as('user_staff', 'staff@ezo.test');
const alice = () => as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
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

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_MODIFY_OWNER');
  });
});
```

Check the member route's shape before relying on the last case: `grep -n "memberRoutes.patch" -A 4 src/routes/members.routes.ts`. Adjust the path/body if it differs.

**Step 3: Run to verify they fail**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/super-admin.test.ts
```

Expected: the first, third, fourth, fifth and seventh cases fail with 403 where 200/404/409 was expected.

**Step 4: Implement**

`src/types/express.d.ts` — add inside `Request`:

```ts
      /**
       * Set by requireMembership when the caller reached this workspace through
       * the super admin bypass rather than a membership row.
       */
      superAdmin?: boolean;
```

`src/middleware/workspace.ts` — replace the body of `requireMembership` from the `findUnique` down to `next()`:

```ts
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_accountId: { workspaceId, accountId: account.id } },
        include: { workspace: true },
      });

      if (member) {
        // One question — may this caller see this workspace — so one refusal.
        // The membership row survives the soft delete, so without the second
        // clause every scoped route goes on answering for a workspace that is
        // gone.
        if (member.workspace.deletedAt) {
          throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
        }
        if (minimumRole === 'ADMIN' && member.role !== 'ADMIN') {
          throw new ApiError(403, 'FORBIDDEN', 'This action requires workspace admin access.');
        }
        req.workspace = member.workspace;
        req.role = member.role;
        req.superAdmin = false;
        next();
        return;
      }

      if (!account.isSuperAdmin) {
        // A non-member and a missing workspace yield the same 403 — a 404
        // would leak which workspace ids exist.
        throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
      }

      // The super admin bypass. A real membership above always wins, so the
      // flag is not a promotion inside workspaces the account belongs to. The
      // 404 here does not weaken the no-leak rule: that rule hides ids from
      // customers, and this caller is staff.
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!workspace || workspace.deletedAt) {
        throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
      }

      req.workspace = workspace;
      req.role = 'ADMIN';
      req.superAdmin = true;
      recordSuperAdminWrite(req, res);
      next();
```

Change the handler signature so `res` is named: `return (req: Request, res: Response, next: NextFunction) => {`.

Add below `roleOf`:

```ts
/** True when the caller reached this workspace through the super admin bypass. */
export function isSuperAdminHere(req: Request): boolean {
  return req.superAdmin === true;
}
```

Add a temporary stub (Task A3 fills it in):

```ts
function recordSuperAdminWrite(_req: Request, _res: Response): void {}
```

In `requireOwner`, change the refusal condition to:

```ts
    if (workspace.ownerAccountId !== account.id && !isSuperAdminHere(req)) {
```

and extend its doc comment with one line: *"A super admin passes: owner parity is the whole point of the flag, and the audit row says who did it."*

`serializeMembership` (`src/lib/serialize.ts:38`) — add a fourth parameter:

```ts
export function serializeMembership(
  workspace: Workspace,
  role: WorkspaceRole,
  accountId: string,
  superAdmin = false,
) {
  return {
    // ...
    isOwner: superAdmin || workspace.ownerAccountId === accountId,
```

`src/routes/workspaces.routes.ts` PATCH handler — pass the flag:

```ts
    res.json({
      success: true,
      data: serializeMembership(workspace, roleOf(req), account.id, isSuperAdminHere(req)),
    });
```

and import `isSuperAdminHere` from the middleware.

**Step 5: Run tests**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/super-admin.test.ts test/workspaces.test.ts test/members.test.ts test/isolation-hardening.test.ts test/analytics-isolation.test.ts
```

Expected: all pass. The two isolation files must pass **without edits**.

**Step 6: Commit**

```bash
git add src/types/express.d.ts src/middleware/workspace.ts src/lib/serialize.ts src/routes/workspaces.routes.ts test/helpers.ts test/super-admin.test.ts
git commit -m "feat(auth): super admin bypass in requireMembership and requireOwner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A3: Audit every bypassed write

**Files:**
- Modify: `src/middleware/workspace.ts` (replace the stub)
- Modify: `test/super-admin.test.ts`

**Step 1: Write the failing tests**

Append to `test/super-admin.test.ts`:

```ts
async function auditRows() {
  // The audit insert runs on response `finish`, after supertest has resolved.
  for (let i = 0; i < 20; i += 1) {
    const rows = await prisma.superAdminAction.findMany({ orderBy: { createdAt: 'asc' } });
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return prisma.superAdminAction.findMany();
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

  it('does not record a read', async () => {
    const owner = await makeAccount('alice');
    const ws = await makeWorkspace(owner, 'Acme');
    await makeSuperAdmin('staff');

    const res = await request(app).get(`/api/workspaces/${ws.id}/members`).set(...staff());
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.superAdminAction.count()).toBe(0);
  });

  it('does not record a write inside an own workspace', async () => {
    const s = await makeSuperAdmin('staff');
    const ws = await makeWorkspace(s, 'Mine');

    await request(app).patch(`/api/workspaces/${ws.id}`).set(...staff()).send({ name: 'z' });

    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.superAdminAction.count()).toBe(0);
  });
});
```

**Step 2: Run to verify they fail**

Expected: first two fail with `toHaveLength(1)` receiving 0.

**Step 3: Implement**

Replace the stub in `src/middleware/workspace.ts`:

```ts
import { logger } from '../lib/logger.js';

/**
 * Records a bypassed mutating request once the response is written.
 *
 * Fire-and-forget on purpose. The request has already been served when
 * `finish` fires, so this cannot be "record first, then act" — and an audit
 * table outage must not take live campaign operations down with it. A failed
 * insert is an error line naming who and where, which is the most that can be
 * said of it.
 */
function recordSuperAdminWrite(req: Request, res: Response): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;

  const account = accountOf(req);
  const workspaceId = req.workspace?.id ?? null;
  const path = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    void prisma.superAdminAction
      .create({
        data: {
          accountId: account.id,
          workspaceId,
          method: req.method,
          path,
          status: res.statusCode,
        },
      })
      .catch((err: unknown) => {
        logger.error(
          { err, accountId: account.id, workspaceId, method: req.method, path },
          'super admin audit write failed',
        );
      });
  });
}
```

Note `req.workspace` is set just before this is called in Task A2, so the id is available.

**Step 4: Run tests**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/super-admin.test.ts
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/middleware/workspace.ts test/super-admin.test.ts
git commit -m "feat(auth): record every write a super admin makes through the bypass

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A4: `/api/me` flag and `GET /api/workspaces/:workspaceId`

**Files:**
- Modify: `src/lib/serialize.ts:18` (`serializeAccount`)
- Modify: `src/routes/workspaces.routes.ts` (add GET before PATCH)
- Modify: `test/me.test.ts`, `test/super-admin.test.ts`

**Step 1: Write the failing tests**

In `test/me.test.ts`, add inside the `GET /api/me` describe:

```ts
  it('reports isSuperAdmin, false for everyone by default', async () => {
    const res = await request(app).get('/api/me').set(...as('user_alice', 'alice@ezo.test'));
    expect(res.body.data.account.isSuperAdmin).toBe(false);
  });
```

In `test/super-admin.test.ts`:

```ts
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
```

**Step 2: Run to verify they fail**

Expected: `isSuperAdmin` undefined; GET returns 404 (no route).

**Step 3: Implement**

`serializeAccount` — add `isSuperAdmin: account.isSuperAdmin,` after `imageUrl`.

`src/routes/workspaces.routes.ts` — before the PATCH:

```ts
/**
 * One workspace as the caller sees it.
 *
 * Added for the super admin picker: a workspace not in `/api/me` has to be
 * fetched on its own before the dashboard can make it active. Ordinary members
 * get exactly what `/api/me` already told them.
 */
workspaceRoutes.get(
  '/:workspaceId',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    res.json({
      success: true,
      data: serializeMembership(workspaceOf(req), roleOf(req), account.id, isSuperAdminHere(req)),
    });
  }),
);
```

Check that no other router mounted on `/api/workspaces` already claims `GET /:workspaceId` (`grep -rn "\.get(\s*'/:workspaceId'" src/routes`). None does today.

**Step 4: Run tests**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/super-admin.test.ts test/me.test.ts test/workspaces.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/serialize.ts src/routes/workspaces.routes.ts test/me.test.ts test/super-admin.test.ts
git commit -m "feat(api): expose isSuperAdmin on /api/me and add GET /api/workspaces/:id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A5: `GET /api/super-admin/workspaces`

**Files:**
- Create: `src/middleware/superAdmin.ts`
- Create: `src/routes/superAdmin.routes.ts`
- Modify: `src/app.ts:96` (mount after `meRoutes`)
- Modify: `test/super-admin.test.ts`

**Step 1: Write the failing tests**

```ts
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
});
```

**Step 2: Run to verify they fail** — every case except the first fails (404).

**Step 3: Implement**

`src/middleware/superAdmin.ts`:

```ts
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../lib/errors.js';
import { accountOf } from './auth.js';

/**
 * Admits only accounts carrying `isSuperAdmin`. Runs after `requireAuth`.
 *
 * The refusal is a 404, not a 403: to a customer the surface behind this does
 * not exist, and a 403 would say "there is something here you may not have".
 */
export function requireSuperAdmin(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!accountOf(req).isSuperAdmin) {
      next(new ApiError(404, 'NOT_FOUND', 'Not found.'));
      return;
    }
    next();
  };
}
```

`src/routes/superAdmin.routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireSuperAdmin } from '../middleware/superAdmin.js';
import { asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { paginated, parsePagination } from '../lib/pagination.js';
import { parseBody } from '../lib/validate.js';

/**
 * The super admin's own surface: what a flagged account can reach that a
 * customer cannot. Today that is one listing, the search behind the
 * dashboard's "All accounts…" picker.
 */
export const superAdminRoutes: Router = Router();

superAdminRoutes.use(requireAuth, requireSuperAdmin());

const searchSchema = z.object({ q: z.string().trim().max(200).optional() });

superAdminRoutes.get(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const account = accountOf(req);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { q } = parseBody(searchSchema, { q: req.query.q });

    const where: Prisma.WorkspaceWhereInput = {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q, mode: 'insensitive' } },
              { owner: { email: { contains: q, mode: 'insensitive' } } },
              { owner: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [workspaces, total] = await prisma.$transaction([
      prisma.workspace.findMany({
        where,
        include: {
          owner: { select: { id: true, email: true, name: true } },
          // Only this caller's row, so `isMember` is one boolean per workspace
          // rather than a second query.
          members: { where: { accountId: account.id }, select: { id: true } },
        },
        orderBy: [{ owner: { email: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.workspace.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(
        workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          color: w.color,
          createdAt: w.createdAt,
          account: w.owner,
          isMember: w.members.length > 0,
        })),
        total,
        pagination,
      ),
    });
  }),
);
```

`src/app.ts` — import and mount right after `meRoutes`:

```ts
  app.use('/api/super-admin', superAdminRoutes);
```

**Step 4: Run tests** — `test/super-admin.test.ts` all pass.

**Step 5: Commit**

```bash
git add src/middleware/superAdmin.ts src/routes/superAdmin.routes.ts src/app.ts test/super-admin.test.ts
git commit -m "feat(api): GET /api/super-admin/workspaces search for the dashboard picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A6: Staff routes — grant/revoke and the activity list

**Files:**
- Modify: `src/lib/serialize.ts:832` (`serializeAccountForStaff`), add `serializeSuperAdminAction`
- Modify: `src/routes/admin/accounts.routes.ts` (add PATCH)
- Create: `src/routes/admin/superAdminActions.routes.ts`
- Modify: `src/routes/admin/index.ts`
- Create: `test/admin-super-admin.test.ts`

**Step 1: Write the failing tests**

`test/admin-super-admin.test.ts`:

```ts
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

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...staff())
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.is_super_admin).toBe(true);
    const row = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(row.isSuperAdmin).toBe(true);
    const actions = await prisma.superAdminAction.findMany();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ accountId: alice.id, method: 'GRANT', workspaceId: null });
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
    await request(app)
      .patch(`/api/admin/accounts/${s.id}/super-admin`)
      .set(...staff())
      .send({ enabled: false });
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

  it('is not reachable through a Clerk session', async () => {
    const alice = await makeAccount('alice');
    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/super-admin`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true });
    expect(res.status).toBe(401);
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

    const filtered = await request(app)
      .get(`/api/admin/super-admin-actions?workspaceId=${ws.id}`)
      .set(...staff());
    expect(filtered.body.data.items).toHaveLength(1);
  });

  it('accounts listing carries is_super_admin', async () => {
    await makeSuperAdmin('staff');
    const res = await request(app).get('/api/admin/accounts').set(...staff());
    expect(res.body.data.items[0].is_super_admin).toBe(true);
  });
});
```

**Step 2: Run to verify they fail**

**Step 3: Implement**

`serializeAccountForStaff` — add `is_super_admin: account.isSuperAdmin,` after `credits`.

Add to `src/lib/serialize.ts`:

```ts
export function serializeSuperAdminAction(
  row: SuperAdminAction & {
    account: { id: string; email: string; name: string | null };
    workspace: { id: string; name: string; slug: string } | null;
  },
) {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    status: row.status,
    created_at: row.createdAt,
    account: row.account,
    workspace: row.workspace,
  };
}
```

(import `SuperAdminAction` from `@prisma/client`.)

`src/routes/admin/accounts.routes.ts` — after the credits POST:

```ts
const superAdminSchema = z.object({ enabled: z.boolean() });

/**
 * The one way the flag is set. Never reachable through a Clerk session: a
 * customer who could grant this to themselves would own every workspace on
 * the platform. Idempotent, and each real change is an audit row of its own.
 */
adminAccountRoutes.patch(
  '/accounts/:accountId/super-admin',
  asyncHandler(async (req, res) => {
    const { enabled } = parseBody(superAdminSchema, req.body);
    const accountId = req.params.accountId;

    const account = await prisma.$transaction(async (tx) => {
      const current = await tx.account.findUnique({ where: { id: accountId } });
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
      if (current.isSuperAdmin === enabled) return current;

      const updated = await tx.account.update({
        where: { id: accountId },
        data: { isSuperAdmin: enabled },
      });
      await tx.superAdminAction.create({
        data: {
          accountId,
          workspaceId: null,
          method: enabled ? 'GRANT' : 'REVOKE',
          path: `/api/admin/accounts/${accountId}/super-admin`,
          status: 200,
        },
      });
      return updated;
    });

    res.json({ success: true, data: serializeAccountForStaff(account) });
  }),
);
```

`src/routes/admin/superAdminActions.routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { paginated, parsePagination } from '../../lib/pagination.js';
import { serializeSuperAdminAction } from '../../lib/serialize.js';

/** Read-only: what the super admins have done, newest first. */
export const adminSuperAdminActionRoutes: Router = Router();

adminSuperAdminActionRoutes.use(requireStaffToken);

const filterSchema = z.object({
  accountId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

adminSuperAdminActionRoutes.get(
  '/super-admin-actions',
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { accountId, workspaceId } = parseBody(filterSchema, {
      accountId: req.query.accountId,
      workspaceId: req.query.workspaceId,
    });

    const where: Prisma.SuperAdminActionWhereInput = {
      ...(accountId ? { accountId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };

    const [rows, total] = await prisma.$transaction([
      prisma.superAdminAction.findMany({
        where,
        include: {
          account: { select: { id: true, email: true, name: true } },
          workspace: { select: { id: true, name: true, slug: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.superAdminAction.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(rows.map(serializeSuperAdminAction), total, pagination),
    });
  }),
);
```

`src/routes/admin/index.ts` — import and `adminRoutes.use(adminSuperAdminActionRoutes);`.

**Step 4: Run tests**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/admin-super-admin.test.ts test/admin-accounts.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/serialize.ts src/routes/admin test/admin-super-admin.test.ts
git commit -m "feat(admin): grant/revoke super admin and list its activity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task A7: Full suite, docs, push

**Step 1: Full verification**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx tsc --noEmit
env -u DATABASE_URL -u TEST_DATABASE_URL npm test 2>&1 | tail -6
```

Expected: `Test Files 180 passed`, `Tests 3811 + new` passed. If a file unrelated to this branch fails once, re-run it alone before investigating (the suite has ~10% cross-file flake).

**Step 2: Document**

- `CLAUDE.md` (backend): under the auth/roles section add two sentences: super admin is a flag on `Account`, set only via the staff API, honoured by `requireMembership`/`requireOwner`, and every bypassed write lands in `SuperAdminAction`.
- `docs/plans/2026-08-25-auth-workspaces-design.md`: one line after the resolution chain pointing to the super admin design.
- Add a row to `docs/PROD-PROMOTION.md`'s migration table **only if that file exists in this repo** (`ls docs/PROD-PROMOTION.md`); the migration is additive and needs no manual SQL.

**Step 3: Commit and push**

```bash
git add CLAUDE.md docs
git commit -m "docs: super admin flag, bypass and audit table

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/super-admin
```

Then open the PR with `gh pr create --repo Arvind9599/ye-voice-backend --base main --fill` — body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Do not merge**: merging backend `main` is a production deploy; hand the merge command to the operator.

---

## Part B — Dashboard (`ye-voice-dashboard`)

Test command: `npx vitest run test/<file>.test.tsx`.

### Task B1: Types and the provider

**Files:**
- Modify: `lib/types.ts:3-11` (`Account`), add `SuperAdminWorkspace`
- Modify: `components/workspace-provider.tsx`
- Create: `test/workspace-provider-super-admin.test.tsx`

**Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

/**
 * A super admin may switch to a workspace `/api/me` never listed. The provider
 * fetches it on demand and holds it as the active workspace; an ordinary
 * account asking for the same id is ignored, as before.
 */

let isSuperAdmin = false;
const api = vi.fn(async (path: string) => {
  if (path === '/api/me') {
    return {
      account: { id: 'acc-1', email: 'me@ezo.test', isSuperAdmin },
      workspaces: [{ id: 'ws-own', name: 'Mine', role: 'ADMIN', isOwner: true }],
      pendingInvites: [],
    };
  }
  if (path === '/api/workspaces/ws-foreign') {
    return { id: 'ws-foreign', name: 'Theirs', role: 'ADMIN', isOwner: true };
  }
  throw new Error(`unexpected ${path}`);
});

vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/lib/api', () => ({ useApi: () => api }));

const { WorkspaceProvider, useWorkspace } = await import('@/components/workspace-provider');

let switchTo: (id: string) => void = () => {};
function Probe() {
  const { activeWorkspace, isVisiting, switchWorkspace } = useWorkspace();
  switchTo = switchWorkspace;
  return (
    <p>
      {activeWorkspace?.name ?? 'none'}:{isVisiting ? 'visiting' : 'home'}
    </p>
  );
}

afterEach(() => {
  cleanup();
  api.mockClear();
  window.localStorage.clear();
});

describe('super admin switching', () => {
  it('fetches and activates a foreign workspace for a super admin', async () => {
    isSuperAdmin = true;
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await screen.findByText('Mine:home');

    act(() => switchTo('ws-foreign'));

    await waitFor(() => expect(screen.getByText('Theirs:visiting')).toBeTruthy());
  });

  it('ignores a foreign id for an ordinary account', async () => {
    isSuperAdmin = false;
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await screen.findByText('Mine:home');

    act(() => switchTo('ws-foreign'));

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Mine:home')).toBeTruthy();
    expect(api).not.toHaveBeenCalledWith('/api/workspaces/ws-foreign');
  });

  it('switching back to an own workspace clears the visit', async () => {
    isSuperAdmin = true;
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    await screen.findByText('Mine:home');
    act(() => switchTo('ws-foreign'));
    await screen.findByText('Theirs:visiting');

    act(() => switchTo('ws-own'));

    await screen.findByText('Mine:home');
  });
});
```

**Step 2: Run to verify it fails** — `isVisiting` undefined / first case never reaches "Theirs".

**Step 3: Implement**

`lib/types.ts`:

```ts
export interface Account {
  // ...existing
  isSuperAdmin: boolean;
}

/** One row of the super admin picker. */
export interface SuperAdminWorkspace {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  createdAt: string;
  account: { id: string; email: string; name: string | null };
  isMember: boolean;
}
```

`components/workspace-provider.tsx`:

- Add `isVisiting: boolean;` to `WorkspaceContextValue`.
- Add state: `const [visiting, setVisiting] = useState<Workspace | null>(null);`
- Replace `switchWorkspace`:

```tsx
  const switchWorkspace = useCallback(
    (id: string) => {
      if (!me) return;
      if (me.workspaces.some((w) => w.id === id)) {
        setVisiting(null);
        setActiveId(id);
        writeLastWorkspace(me.account.id, id);
        return;
      }
      // A super admin may open a workspace `/api/me` never listed. Fetched on
      // demand: the bootstrap stays the size of the account's own memberships.
      if (!me.account.isSuperAdmin) return;
      void api<Workspace>(`/api/workspaces/${id}`)
        .then((workspace) => {
          setVisiting(workspace);
          setActiveId(workspace.id);
          writeLastWorkspace(me.account.id, workspace.id);
        })
        .catch(() => {
          // Gone, or never existed: stay where we are.
        });
    },
    [me, api],
  );
```

- In `load`, after `setMe(data)`, restore a remembered foreign workspace:

```tsx
      const remembered = readLastWorkspace(data.account.id);
      if (
        remembered &&
        data.account.isSuperAdmin &&
        !data.workspaces.some((w) => w.id === remembered)
      ) {
        try {
          const workspace = await api<Workspace>(`/api/workspaces/${remembered}`);
          setVisiting(workspace);
          setActiveId(workspace.id);
          return;
        } catch {
          // Falls through to the ordinary resolution below.
        }
      }
```

(place before the existing `setActiveId((current) => …)` block; note `remembered` is now declared once, so reuse it there.)

- In the `useMemo`:

```tsx
    const active =
      workspaces.find((w) => w.id === activeId) ??
      (visiting && visiting.id === activeId ? visiting : null);
    return {
      // ...
      activeWorkspace: active,
      isVisiting: active !== null && !workspaces.some((w) => w.id === active.id),
      // ...
    };
```

and add `visiting` to the dependency list.

**Step 4: Run tests**

```bash
npx vitest run test/workspace-provider-super-admin.test.tsx test/dash-layout-toast.test.tsx
npx tsc --noEmit
```

If `tsc` complains that existing test mocks of `useWorkspace` lack `isVisiting`, those mocks are untyped objects and should not; if a typed one does, add `isVisiting: false`.

**Step 5: Commit**

```bash
git add lib/types.ts components/workspace-provider.tsx test/workspace-provider-super-admin.test.tsx
git commit -m "feat(shell): super admins can switch to a workspace outside their memberships

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B2: The picker

**Files:**
- Create: `components/shell/super-admin-picker.tsx`
- Modify: `components/shell/workspace-switcher.tsx` (switch submenu, after the `Separator`)
- Create: `test/super-admin-picker.test.tsx`
- Modify: `test/workspace-switcher-grouping.test.tsx` (add one case)

**Step 1: Write the failing tests**

`test/super-admin-picker.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.fn(async (path: string) => ({
  items: [
    { id: 'ws-1', name: 'Dental', slug: 'dental', color: null, createdAt: '', isMember: false,
      account: { id: 'a1', email: 'alice@ezo.test', name: 'Alice' } },
    { id: 'ws-2', name: 'Garage', slug: 'garage', color: null, createdAt: '', isMember: true,
      account: { id: 'a2', email: 'bob@ezo.test', name: null } },
  ],
  page: 1, limit: 20, total: 2,
  _path: path,
}));
vi.mock('@/lib/api', () => ({ useApi: () => api }));

const { SuperAdminPicker } = await import('@/components/shell/super-admin-picker');

afterEach(() => {
  cleanup();
  api.mockClear();
});

describe('the super admin picker', () => {
  it('lists results grouped under the owner email and picks one', async () => {
    const onPick = vi.fn();
    render(<SuperAdminPicker onPick={onPick} onClose={vi.fn()} />);

    await screen.findByText('Dental');
    expect(screen.getByText('alice@ezo.test')).toBeTruthy();
    expect(screen.getByText('bob@ezo.test')).toBeTruthy();
    expect(screen.getByText('member')).toBeTruthy();

    fireEvent.click(screen.getByText('Dental'));
    expect(onPick).toHaveBeenCalledWith('ws-1');
  });

  it('sends the typed query after a pause', async () => {
    vi.useFakeTimers();
    try {
      render(<SuperAdminPicker onPick={vi.fn()} onClose={vi.fn()} />);
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'dent' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(api).toHaveBeenLastCalledWith('/api/super-admin/workspaces?q=dent&limit=20');
    } finally {
      vi.useRealTimers();
    }
  });
});
```

Add to `test/workspace-switcher-grouping.test.tsx` a mutable `isSuperAdmin` on the mocked `me.account`, and:

```tsx
  it('offers "All accounts…" only to a super admin', () => {
    isSuperAdmin = false;
    openSwitcher();
    expect(screen.queryByText('All accounts…')).toBeNull();
    cleanup();

    isSuperAdmin = true;
    openSwitcher();
    expect(screen.getByText('All accounts…')).toBeTruthy();
  });
```

**Step 2: Run to verify they fail**

**Step 3: Implement**

`components/shell/super-admin-picker.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useApi } from '@/lib/api';
import { AvatarBadge } from '@/components/ui/avatar-badge';
import type { SuperAdminWorkspace } from '@/lib/types';

interface Page {
  items: SuperAdminWorkspace[];
  page: number;
  limit: number;
  total: number;
}

const LIMIT = 20;

/**
 * Every workspace on the platform, for a super admin to open one.
 *
 * Grouped by the owning account's email because that is how staff know a
 * customer; the workspace name alone is often "Main". The list is a search
 * result, not a directory: it is paged at the API's cap and says how many
 * matched, so a short list is legible as "few matched" rather than "few exist".
 */
export function SuperAdminPicker({
  onPick,
  onClose,
}: {
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (debounced) params.set('q', debounced);
    params.set('limit', String(LIMIT));
    setError(null);
    api<Page>(`/api/super-admin/workspaces?${params}`)
      .then((result) => {
        if (!cancelled) setPage(result);
      })
      .catch(() => {
        if (!cancelled) setError('Could not search workspaces.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, debounced]);

  const groups = useMemo(() => {
    const byOwner = new Map<string, SuperAdminWorkspace[]>();
    for (const w of page?.items ?? []) {
      const list = byOwner.get(w.account.email) ?? [];
      list.push(w);
      byOwner.set(w.account.email, list);
    }
    return [...byOwner.entries()];
  }, [page]);

  return (
    <div role="dialog" aria-label="All accounts" className="w-[320px]">
      <label className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Search size={14} className="shrink-0 text-[var(--text-faint)]" />
        <input
          type="search"
          role="searchbox"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Search by account email or workspace"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </label>

      <div className="max-h-[360px] overflow-y-auto py-1">
        {error ? <p className="px-3 py-2 text-[12.5px] text-[var(--danger)]">{error}</p> : null}
        {page && page.items.length === 0 ? (
          <p className="px-3 py-2 text-[12.5px] text-[var(--text-muted)]">No workspaces match.</p>
        ) : null}
        {groups.map(([email, workspaces]) => (
          <div key={email} role="group" aria-label={email}>
            <p className="truncate px-3 pb-0.5 pt-1.5 text-[10.5px] font-medium uppercase tracking-[0.04em] text-[var(--text-faint)]">
              {email}
            </p>
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                role="menuitem"
                onClick={() => onPick(w.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--surface-hover)]"
              >
                <AvatarBadge name={w.name} color={w.color} size={18} />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.isMember ? (
                  <span className="text-[10.5px] text-[var(--text-faint)]">member</span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
      </div>

      {page && page.total > page.items.length ? (
        <p className="border-t border-[var(--border)] px-3 py-1.5 text-[11.5px] text-[var(--text-faint)]">
          Showing {page.items.length} of {page.total}. Narrow the search to find the rest.
        </p>
      ) : null}
    </div>
  );
}
```

`components/shell/workspace-switcher.tsx`:

- Extend `type Menu = 'closed' | 'main' | 'switch' | 'all';`
- Import `Globe` from lucide and `SuperAdminPicker`.
- In the switch submenu, after `Create or join a workspace…`:

```tsx
              {me?.account.isSuperAdmin ? (
                <MenuItem icon={<Globe size={14} />} onClick={() => setMenu('all')}>
                  All accounts…
                </MenuItem>
              ) : null}
```

- Add a third branch in the menu render: when `menu === 'all'` render `<SuperAdminPicker onPick={pick} onClose={close} />` instead of the list. Widen the dropdown class to `w-auto` for that state.
- The digit shortcut effect already checks `menu !== 'switch'`, so it stays off inside the picker.

**Step 4: Run tests**

```bash
npx vitest run test/super-admin-picker.test.tsx test/workspace-switcher-grouping.test.tsx
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add components/shell/super-admin-picker.tsx components/shell/workspace-switcher.tsx test/super-admin-picker.test.tsx test/workspace-switcher-grouping.test.tsx
git commit -m "feat(shell): 'All accounts…' picker for super admins

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B3: The visiting banner

**Files:**
- Create: `components/shell/visiting-banner.tsx`
- Modify: `app/(dash)/layout.tsx:38-43`
- Create: `test/visiting-banner.test.tsx`

**Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

let isVisiting = true;
const switchWorkspace = vi.fn();
vi.mock('@/components/workspace-provider', () => ({
  useWorkspace: () => ({
    isVisiting,
    switchWorkspace,
    workspaces: [{ id: 'ws-own', name: 'Mine' }],
    activeWorkspace: { id: 'ws-foreign', name: 'Acme Dental' },
  }),
}));

const { VisitingBanner } = await import('@/components/shell/visiting-banner');

afterEach(() => {
  cleanup();
  switchWorkspace.mockClear();
});

describe('the visiting banner', () => {
  it('names the workspace and offers a way back', () => {
    isVisiting = true;
    render(<VisitingBanner />);
    expect(screen.getByRole('status').textContent).toContain('Acme Dental');
    fireEvent.click(screen.getByRole('button', { name: 'Back to my workspaces' }));
    expect(switchWorkspace).toHaveBeenCalledWith('ws-own');
  });

  it('renders nothing at home', () => {
    isVisiting = false;
    const { container } = render(<VisitingBanner />);
    expect(container.firstChild).toBeNull();
  });
});
```

**Step 2: Run to verify it fails**

**Step 3: Implement**

`components/shell/visiting-banner.tsx`:

```tsx
'use client';

import { ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/components/workspace-provider';

/**
 * Shown the whole time a super admin is inside a workspace they are not a
 * member of. Persistent, not dismissable: every page here is a customer's, and
 * the reader should not be able to forget which one.
 */
export function VisitingBanner() {
  const { isVisiting, activeWorkspace, workspaces, switchWorkspace } = useWorkspace();
  const router = useRouter();

  if (!isVisiting || !activeWorkspace) return null;

  const home = workspaces[0];

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-[var(--warning-border)] bg-[var(--warning-bg)] px-8 py-1.5 text-[12.5px] text-[var(--warning-text)]"
    >
      <ShieldAlert size={14} className="shrink-0" />
      <p className="min-w-0 flex-1 truncate">
        Viewing <span className="font-medium">{activeWorkspace.name}</span> as super admin.
        Every change you make here is recorded.
      </p>
      <button
        type="button"
        onClick={() => (home ? switchWorkspace(home.id) : router.replace('/onboarding'))}
        className="shrink-0 font-medium underline-offset-2 hover:underline"
      >
        Back to my workspaces
      </button>
    </div>
  );
}
```

Check the warning token names exist: `grep -n "warning" app/globals.css | head`. Use whatever the theme calls its warning surface; if none, use `--surface-hover` and `--text`.

`app/(dash)/layout.tsx` — import and render `<VisitingBanner />` as the first child of the `flex min-w-0 flex-1 flex-col` column, above the chrome bar. Mock `next/navigation` in the test if the import trips jsdom (`vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))`).

**Step 4: Run tests**

```bash
npx vitest run test/visiting-banner.test.tsx test/dash-layout-toast.test.tsx
```

**Step 5: Commit**

```bash
git add components/shell/visiting-banner.tsx app/\(dash\)/layout.tsx test/visiting-banner.test.tsx
git commit -m "feat(shell): banner while a super admin is inside a customer's workspace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task B4: Full suite, docs, push

```bash
npx tsc --noEmit && npx vitest run 2>&1 | tail -5 && npm run lint
```

Expected: all green. Add to the dashboard `CLAUDE.md` role-gate table one row: *super admin — `me.account.isSuperAdmin`; opens any workspace via the switcher's "All accounts…", reads as ADMIN + owner there, banner shows.*

```bash
git add CLAUDE.md
git commit -m "docs: super admin in the dashboard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/super-admin
gh pr create --repo Arvind9599/ye-voice-dashboard --base main --fill
```

The Vercel check on this repo never passes from this account; ignore it.

---

## Part C — Staff console (`ye-voice-admin`)

### Task C1: Grant / revoke on the account page

**Files:**
- Modify: `lib/types.ts:11` (`AccountRow`), add `SuperAdminActionRow`
- Modify: `app/(console)/accounts/[id]/actions.ts` (add `setSuperAdmin`)
- Create: `app/(console)/accounts/[id]/super-admin-form.tsx`
- Modify: `app/(console)/accounts/[id]/page.tsx` (add a `Section`)
- Create: `test/super-admin-form.test.tsx`

**Step 1: Write the failing test**

Model it on `test/credit-form.test.tsx` (read it first for how the server action is mocked and how `ConfirmDialog` is driven). Cases:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const setSuperAdmin = vi.fn(async () => ({ ok: true, message: 'Granted.' }));
vi.mock('./../app/(console)/accounts/[id]/actions', () => ({ setSuperAdmin }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { SuperAdminForm } = await import('@/app/(console)/accounts/[id]/super-admin-form');

afterEach(() => {
  cleanup();
  setSuperAdmin.mockClear();
});

describe('the super admin section', () => {
  it('grant requires typing the email and states the consequence', async () => {
    render(<SuperAdminForm accountId="acc-1" email="alice@ezo.test" enabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grant super admin' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('every workspace on the platform');

    const confirm = screen.getByRole('button', { name: 'Grant' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'alice@ezo.test' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(setSuperAdmin).toHaveBeenCalledWith('acc-1', true));
  });

  it('revoke confirms without a word', async () => {
    render(<SuperAdminForm accountId="acc-1" email="alice@ezo.test" enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke super admin' }));
    await waitFor(() => expect(setSuperAdmin).toHaveBeenCalledWith('acc-1', false));
  });
});
```

Adjust the mock path to whatever `credit-form.test.tsx` uses for `./actions`.

**Step 2: Run to verify it fails**

**Step 3: Implement**

`lib/types.ts` — add `is_super_admin: boolean;` to `AccountRow`, and:

```ts
export interface SuperAdminActionRow {
  id: string;
  method: string;
  path: string;
  status: number;
  created_at: string;
  account: { id: string; email: string; name: string | null };
  workspace: { id: string; name: string; slug: string } | null;
}
```

`actions.ts` — append:

```ts
/**
 * Grants or revokes the platform-wide flag. Same shape as the credit
 * correction: server action, cookie stays server-side, backend is the truth.
 */
export async function setSuperAdmin(accountId: string, enabled: boolean): Promise<AdjustResult> {
  try {
    await apiFetch(`/api/admin/accounts/${segment(accountId)}/super-admin`, {
      method: 'PATCH',
      body: { enabled },
    });
    revalidatePath(`/accounts/${accountId}`);
    revalidatePath('/accounts');
    revalidatePath('/super-admin-activity');
    return { ok: true, message: enabled ? 'Super admin granted.' : 'Super admin revoked.' };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { ok: false, message: 'Your session has expired. Sign in again.' };
    }
    if (err instanceof ApiError) {
      return { ok: false, message: userMessage(err, 'The change was not applied.') };
    }
    throw err;
  }
}
```

`super-admin-form.tsx`:

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button, FieldError } from '@/components/ui/primitives';
import { StatusPill } from '@/components/ui/status-pill';
import { setSuperAdmin } from './actions';

/**
 * The flag that makes an account owner-equivalent in every workspace.
 *
 * Granting is the widest single permission the console can hand out, so it
 * takes the typed email. Revoking is the safe direction and takes a click.
 */
export function SuperAdminForm({
  accountId,
  email,
  enabled,
}: {
  accountId: string;
  email: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function apply() {
    setBusy(true);
    setError(null);
    const result = await setSuperAdmin(accountId, !enabled);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    setDone(result.message);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {enabled ? (
        <p className="text-[13px]">
          <StatusPill tone="warning">super admin</StatusPill>{' '}
          <span className="text-[var(--text-muted)]">
            Can open every workspace on the platform with owner rights.
          </span>
        </p>
      ) : (
        <p className="text-[13px] text-[var(--text-muted)]">
          This account has the same access as any customer.
        </p>
      )}

      <Button variant={enabled ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
        {enabled ? 'Revoke' : 'Grant super admin'}
      </Button>
      <FieldError>{error}</FieldError>
      {done ? <p className="text-[12.5px] text-[var(--text-muted)]">{done}</p> : null}

      <ConfirmDialog
        open={open}
        title={enabled ? 'Revoke super admin' : 'Grant super admin'}
        consequence={
          enabled ? (
            <>
              <strong>{email}</strong> will lose access to every workspace it is not a member of.
            </>
          ) : (
            <>
              <strong>{email}</strong> will be able to open <strong>every workspace on the
              platform</strong> with the same rights as its owner — renting numbers, running
              campaigns, deleting workspaces — without being invited.
            </>
          )
        }
        detail={enabled ? undefined : 'Every write is recorded under Super admin activity.'}
        confirmLabel={enabled ? 'Revoke super admin' : 'Grant'}
        confirmWord={enabled ? undefined : email}
        destructive={!enabled}
        busy={busy}
        error={error}
        onConfirm={() => void apply()}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
```

Check `StatusPill`'s prop name for tone (`sed -n 27,45p components/ui/status-pill.tsx`) and `Button`'s variant names (`grep -n "variant" components/ui/primitives.tsx | head`); match them.

`page.tsx` — after the Identity section, inside the same `SectionStack`:

```tsx
          <Section title="Super admin">
            <SuperAdminForm
              accountId={account.id}
              email={account.email}
              enabled={account.is_super_admin}
            />
          </Section>
```

Also, in `app/(console)/accounts/page.tsx`, show `<StatusPill>super admin</StatusPill>` beside the email for rows with `is_super_admin`.

**Step 4: Run tests**

```bash
npx vitest run test/super-admin-form.test.tsx && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add lib/types.ts "app/(console)/accounts" test/super-admin-form.test.tsx
git commit -m "feat(accounts): grant and revoke super admin with a typed confirm

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task C2: Activity page and sidebar

**Files:**
- Create: `app/(console)/super-admin-activity/page.tsx`, `loading.tsx`
- Modify: `components/shell/sidebar.tsx:8-22`
- Modify: `test/sidebar.test.tsx`

**Step 1: Write the failing test**

Add to `test/sidebar.test.tsx`:

```tsx
  it('marks Super admin activity as the page on its route', () => {
    expect(currentPage('/super-admin-activity')).toEqual(['Super admin activity']);
  });
```

**Step 2: Run to verify it fails**

**Step 3: Implement**

`sidebar.tsx` — add `{ href: '/super-admin-activity', label: 'Super admin activity' },` after the `Transfer account` entry (it is an accounts concern, so it sits with them; not indented, since it is not a sub-page of `/accounts`).

`app/(console)/super-admin-activity/page.tsx`:

```tsx
import Link from 'next/link';
import { PageHeader } from '@/components/shell/page-header';
import { Pagination } from '@/components/ui/pagination';
import { EmptyTableRow } from '@/components/ui/empty-state';
import { ClearFilters, TableToolbar } from '@/components/ui/toolbar';
import { TableFrame, Td, Th, Tr } from '@/components/ui/table';
import { date } from '@/lib/format';
import { staffFetch } from '@/lib/staff';
import type { Page, SuperAdminActionRow } from '@/lib/types';

export const metadata = { title: 'Super admin activity — YE staff console' };

export default async function SuperAdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; accountId?: string; workspaceId?: string }>;
}) {
  const { page, accountId, workspaceId } = await searchParams;

  const query = new URLSearchParams();
  if (page) query.set('page', page);
  if (accountId) query.set('accountId', accountId);
  if (workspaceId) query.set('workspaceId', workspaceId);

  const rows = await staffFetch<Page<SuperAdminActionRow>>(
    `/api/admin/super-admin-actions${query.toString() ? `?${query}` : ''}`,
  );

  return (
    <>
      <PageHeader
        title="Super admin activity"
        subtitle="Every write a super admin made inside a workspace they are not a member of, and every grant or revoke of the flag. Reads are not recorded."
      />

      {accountId || workspaceId ? (
        <TableToolbar>
          <p className="text-[13px] text-[var(--text-muted)]">Filtered.</p>
          <ClearFilters href="/super-admin-activity" />
        </TableToolbar>
      ) : null}

      <TableFrame>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Who</Th>
            <Th>What</Th>
            <Th>Workspace</Th>
            <Th align="right">Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.items.length === 0 ? (
            <EmptyTableRow colSpan={5}>No super admin activity yet.</EmptyTableRow>
          ) : (
            rows.items.map((row) => (
              <Tr key={row.id}>
                <Td>{date(row.created_at)}</Td>
                <Td>
                  <Link href={`/accounts/${row.account.id}`} className="text-[var(--accent)] hover:underline">
                    {row.account.email}
                  </Link>
                </Td>
                <Td>
                  <code className="text-[12px]">
                    {row.method} {row.path}
                  </code>
                </Td>
                <Td>
                  {row.workspace ? (
                    <Link href={`/workspaces/${row.workspace.id}`} className="text-[var(--accent)] hover:underline">
                      {row.workspace.name}
                    </Link>
                  ) : (
                    <span className="text-[var(--text-faint)]">—</span>
                  )}
                </Td>
                <Td align="right">{row.status}</Td>
              </Tr>
            ))
          )}
        </tbody>
      </TableFrame>

      <Pagination
        page={rows.page}
        limit={rows.limit}
        total={rows.total}
        basePath="/super-admin-activity"
        params={{ accountId, workspaceId }}
      />
    </>
  );
}
```

Check `EmptyTableRow`'s props (`sed -n 34,50p components/ui/empty-state.tsx`) and `Td`'s `align` prop; match them. Copy `loading.tsx` from `app/(console)/billing/loading.tsx` if one exists, else from `accounts/[id]/loading.tsx`.

On `app/(console)/workspaces/[id]/page.tsx` and `accounts/[id]/page.tsx`, add a small link "Super admin activity →" pointing at `/super-admin-activity?workspaceId=` / `?accountId=` respectively.

**Step 4: Run tests**

```bash
npx vitest run test/sidebar.test.tsx && npx tsc --noEmit && npm run lint && npm run build 2>&1 | tail -3
```

**Step 5: Commit**

```bash
git add "app/(console)/super-admin-activity" "app/(console)/workspaces/[id]/page.tsx" "app/(console)/accounts/[id]/page.tsx" components/shell/sidebar.tsx test/sidebar.test.tsx
git commit -m "feat(console): super admin activity page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task C3: Full suite, docs, push

```bash
npx tsc --noEmit && npx vitest run 2>&1 | tail -5 && npm run lint && npm run build 2>&1 | tail -2
```

Add to the admin `CLAUDE.md` page list the two new surfaces, and the rule that the grant takes the typed email.

```bash
git add CLAUDE.md
git commit -m "docs: super admin grant and activity in the console

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/super-admin
gh pr create --repo Arvind9599/ye-voice-admin --base main --fill
```

---

## Part D — End-to-end check (after all three parts)

With the backend worktree's dev server on :3001 (`npm run dev`), dashboard on :3000, admin on its port:

1. In the console, open an account, **Grant super admin**, type the email, confirm. Reload: the pill shows.
2. Sign into the dashboard as that account. Switcher → Switch workspace → **All accounts…** → search a customer email → pick a workspace. Banner appears; sidebar shows every settings entry including Billing; footer reads Owner.
3. Rename the workspace in Settings → General. In the console, `/super-admin-activity` shows `PATCH /api/workspaces/<id>` with status 200.
4. Reload the dashboard: it reopens the visited workspace with the banner.
5. Click **Back to my workspaces**: banner gone, own workspace active.
6. Revoke in the console. In the dashboard, the next request to that workspace returns 403 and "All accounts…" disappears after a refresh.

## Merge order

Backend PR first (production deploy on merge — the operator runs `gh pr merge`), then dashboard, then admin. Both frontends are inert against the old backend: `isSuperAdmin` is absent → `false`, and the console's new routes 404 → `RouteNotServedError`, which the account page already tolerates for optional sections (wrap the activity fetch the same way if you want the page to render before the backend ships).
