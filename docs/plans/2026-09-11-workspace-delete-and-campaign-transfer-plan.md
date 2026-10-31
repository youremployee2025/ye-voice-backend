# Workspace Delete and Cross-Workspace Campaign Transfer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a workspace owner soft-delete their workspace from the dashboard, and let YE staff move a campaign — settings, contacts, DNC list and every contact's journey state — from one workspace to another from the admin console.

**Architecture:** A workspace is never row-deleted. It gains one nullable `deletedAt` column, and four read paths learn to honour it (`requireMembership`, `/api/me`, the invite loader, and `uniqueSlug` by deliberately *not* honouring it). The delete route refuses with 409 rather than auto-releasing anything. The transfer is a preview-then-apply service modelled exactly on `src/services/accountTransfer.ts`: the commit re-derives the plan inside its own transaction and compares against an `expectedContactCount` the operator confirmed. Call history and ledger rows never move — `CallAttempt.workspaceId` and `CreditTransaction.workspaceId` are documented dial-time snapshots.

**Tech Stack:** Express 4 + Prisma 6 + Postgres (backend), Vitest + supertest (tests), Next.js App Router (dashboard, client components + `useApi`; admin console, server components + `'use server'` actions).

**Design doc:** `docs/plans/2026-09-11-workspace-delete-and-campaign-transfer-design.md` — read it first. This plan implements it and does not restate its reasoning.

---

## Before you start

### Worktrees

Three repos, one feature. Per the root `CLAUDE.md`, group them under one feature folder:

**Branch from `origin/main`, not local `main`.** The backend's local `main` is
72 commits behind origin and the admin's is 11; the backend's main checkout also
sits on an unrelated feature branch. Branching from a local ref here builds this
feature on a tree from weeks ago.

```bash
cd ~/Desktop/revenue-generator/ezo/ye-voice-agent
git -C ye-voice-backend   worktree add .worktrees/workspace-delete-transfer/ye-voice-backend   -b feat/workspace-delete-and-campaign-transfer origin/main
git -C ye-voice-dashboard worktree add .worktrees/workspace-delete-transfer/ye-voice-dashboard -b feat/workspace-delete                        origin/main
git -C ye-voice-admin     worktree add .worktrees/workspace-delete-transfer/ye-voice-admin     -b feat/campaign-transfer                       origin/main
```

The paths are relative to each repo, so all three land under
`ye-voice-agent/.worktrees/workspace-delete-transfer/` beside the other
features' worktrees.

The design doc is currently **untracked** on `feat/onboard-inbound-campaign`. Copy it and this plan into the backend worktree and commit both as Task 0.

### Each worktree needs its own databases

A shared dev DB makes `prisma migrate dev` demand a reset; a shared test DB lets
another branch's migration fail this suite in files you never touched.

Postgres runs as two long-lived docker containers shared by every worktree —
`ye-dev-pg` on **:5436** and `ye-test-pg` on **:5435** — and each worktree
takes its own *database* on them, named `ye_voice_<feature>` and
`ye_test_<feature>`. Redis is one container on **:6382**, and each worktree
takes its own database *index*.

For this feature: `ye_voice_wsdel`, `ye_test_wsdel`, Redis index **14**
(0, 2–8 and 14 were free; 1, 9–13 and 15 are taken by other worktrees).

```bash
# credentials come from the main checkout's .env — do not retype them
createdb -h localhost -p 5436 -U postgres ye_voice_wsdel
createdb -h localhost -p 5435 -U postgres ye_test_wsdel
```

Then in the worktree's own `.env` (copied from the main checkout), override
exactly three lines and leave every other key alone:

```
DATABASE_URL=postgresql://postgres:<pw>@localhost:5436/ye_voice_wsdel
TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5435/ye_test_wsdel
TEST_REDIS_URL=redis://localhost:6382/14
```

`.env` is gitignored and never committed. `PROD_DATABASE_URL` and
`PROD_REDIS_URL` are carried over inert — do not point anything at them.

```bash
npx prisma migrate deploy && npm run test:prepare
```

### npm install

Do **not** run `npm install` in a worktree and commit the lockfile churn: a macOS install prunes Linux optional deps and breaks CI's `npm ci`. Use `npm ci`, and `git checkout package-lock.json` if it moves.

### The suite is flaky

Roughly 10% of full runs fail from cross-file bleed. Re-run a failure 5–10× before treating it as real. Run *your* file alone while iterating: `npx vitest run test/workspace-delete.test.ts`.

---

# Part 1 — Workspace delete (backend)

### Task 0: Land the design doc and this plan

**Files:**
- Create: `docs/plans/2026-09-11-workspace-delete-and-campaign-transfer-design.md` (copy from the main checkout)
- Create: `docs/plans/2026-09-11-workspace-delete-and-campaign-transfer-plan.md` (this file)

**Step 1: Copy both files into the worktree**

**Step 2: Commit**

```bash
git add docs/plans/2026-09-11-workspace-delete-and-campaign-transfer-*.md
git commit -m "docs: the design and plan for workspace delete and campaign transfer"
```

---

### Task 1: The `deletedAt` column

**Files:**
- Modify: `prisma/schema.prisma` — the `Workspace` model
- Create: `prisma/migrations/<timestamp>_workspace_soft_delete/migration.sql`

**Step 1: Add the column and its index**

In `model Workspace`, after `lastAgentSyncAt`:

```prisma
  /// When the owner deleted this workspace. The row survives the delete on
  /// purpose: `PhoneNumber.workspace` and `CreditTransaction.workspace` are
  /// both `onDelete: Restrict`, and both comments say why — a workspace's
  /// billing history must not evaporate exactly when somebody wants to read
  /// it. Keeping the row is what keeps those constraints satisfied.
  ///
  /// Honoured by `requireMembership`, `/api/me` and the invite loader.
  /// Deliberately NOT honoured by `uniqueSlug`: re-issuing a dead workspace's
  /// slug would make old links resolve to a stranger's workspace.
  deletedAt DateTime?
```

and in the index block:

```prisma
  @@index([ownerAccountId])
  @@index([deletedAt])
```

**Step 2: Generate the migration**

Run: `npx prisma migrate dev --name workspace_soft_delete`
Expected: a new folder under `prisma/migrations/`, `ALTER TABLE "Workspace" ADD COLUMN "deletedAt" TIMESTAMP(3);` plus the index. **Read the generated SQL** — anything beyond that ADD COLUMN and CREATE INDEX means your dev DB had drift, and the migration must be rewritten by hand.

**Step 3: Apply it to the test DB**

Run: `npm run test:prepare`
Expected: exits 0.

**Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Mark a workspace deleted with a column, not a DELETE"
```

---

### Task 2: `requireMembership` honours `deletedAt`

This one edit covers every `/api/workspaces/:workspaceId/*` route on the platform **except the recording playback route**, which a valid `?token=` lets past `requireMembership` entirely — see the design doc's enforcement section; that branch reads `deletedAt` itself. Do it before the delete route exists, so nothing is ever deletable-but-still-readable.

**Files:**
- Modify: `src/middleware/workspace.ts:27-33`
- Test: `test/workspace-delete.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, addMember, makeAccount, makeWorkspace } from './helpers.js';

const { createApp } = await import('../src/app.js');
const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

async function deletedWorkspace() {
  const owner = await makeAccount('owner');
  const workspace = await makeWorkspace(owner, 'Doomed');
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { deletedAt: new Date() },
  });
  return { owner, workspace };
}

describe('a deleted workspace is unreachable', () => {
  it('answers 403 with the same sentence a non-member gets', async () => {
    const { owner, workspace } = await deletedWorkspace();

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/members`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // Byte-identical to the non-member refusal. A distinct "this was deleted"
    // leaks which workspace ids exist, one step later than the 404 that
    // `requireMembership`'s own comment rules out.
    expect(res.body.error.message).toBe('You do not have access to this workspace.');
  });
});
```

**Step 2: Run it to verify it fails**

Run: `npx vitest run test/workspace-delete.test.ts`
Expected: FAIL — received 200.

**Step 3: Write the minimal implementation**

In `src/middleware/workspace.ts`, immediately after the `if (!member)` block:

```ts
      // The membership row survives the soft delete, so without this every
      // scoped route keeps answering normally. Same status and same sentence
      // as a non-member, for the reason this function's own comment gives
      // about 404s: "this one was deleted" leaks which ids exist too.
      if (member.workspace.deletedAt) {
        throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
      }
```

**Step 4: Run the test to verify it passes**

Run: `npx vitest run test/workspace-delete.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/middleware/workspace.ts test/workspace-delete.test.ts
git commit -m "Refuse every workspace-scoped route once the workspace is deleted"
```

---

### Task 3: The isolation sweep

Spot-checking three routes is what lets a route added next month forget the rule. Walk the router stack instead.

**Files:**
- Modify: `test/workspace-delete.test.ts`

**Step 1: Write the failing test**

Append to `test/workspace-delete.test.ts`:

```ts
/**
 * Every `/api/workspaces/:workspaceId/*` route, enumerated from the app rather
 * than listed by hand. A route added later that forgets the rule fails here,
 * not in production.
 */
function workspaceScopedRoutes(): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];

  // Express 4 keeps the mounted routers on `_router.stack`; each sub-router
  // carries its own `handle.stack` of routes.
  for (const layer of (app as never as { _router: { stack: never[] } })._router.stack) {
    const mounted = layer as {
      name: string;
      handle?: { stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      regexp?: RegExp;
    };
    if (mounted.name !== 'router' || !mounted.handle?.stack) continue;
    if (!mounted.regexp?.source.includes('api')) continue;

    for (const inner of mounted.handle.stack) {
      const route = inner.route;
      if (!route?.path.includes(':workspaceId')) continue;
      for (const [method, on] of Object.entries(route.methods)) {
        if (on) found.push({ method, path: route.path });
      }
    }
  }

  return found;
}

describe('isolation sweep', () => {
  it('finds the workspace-scoped routes to sweep', () => {
    // A guard on the guard: if the stack walk ever returns nothing, the sweep
    // below passes vacuously and proves the opposite of what it claims.
    expect(workspaceScopedRoutes().length).toBeGreaterThan(30);
  });

  it('refuses every workspace-scoped route on a deleted workspace', async () => {
    const { owner, workspace } = await deletedWorkspace();

    for (const { method, path } of workspaceScopedRoutes()) {
      const url = path
        .replace(':workspaceId', workspace.id)
        // Every other parameter is a child id. Any value does: the membership
        // check runs before the lookup, so the 403 must arrive first.
        .replace(/:[A-Za-z]+/g, 'x');

      const res = await (request(app) as never as Record<string, (u: string) => never>)[method](url);
      const sent = await (res as never as { set: (...h: string[]) => Promise<{ status: number; body: { error?: { code: string } } }> })
        .set(...as(owner.clerkUserId, owner.email));

      expect(
        { method, path, status: sent.status },
        `${method.toUpperCase()} ${path} answered on a deleted workspace`,
      ).toMatchObject({ status: 403 });
      expect(sent.body.error?.code).toBe('FORBIDDEN');
    }
  });
});
```

**Step 2: Run it**

Run: `npx vitest run test/workspace-delete.test.ts -t 'isolation sweep'`
Expected: PASS on both — Task 2 put the check in the one place every route goes through, plus the recording route that bypasses it. **If the second case fails, you have found another route that bypasses `requireMembership`**; fix the route, not the test. Note the sweep issues each route with no query string, so it takes the recording route's session branch and cannot see the token branch at all — that one has its own case in the same file.

**Step 3: Commit**

```bash
git add test/workspace-delete.test.ts
git commit -m "Sweep every workspace-scoped route, not three of them"
```

---

### Task 4: `/api/me` and the invite loader

**Files:**
- Modify: `src/routes/me.routes.ts:16-27`
- Modify: `src/routes/invites.routes.ts:37-52`
- Test: `test/workspace-delete.test.ts`

**Step 1: Write the failing tests**

```ts
describe('a deleted workspace disappears from the bootstrap payload', () => {
  it('is omitted from /api/me', async () => {
    const { owner, workspace } = await deletedWorkspace();
    const live = await makeWorkspace(owner, 'Live');

    const res = await request(app).get('/api/me').set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.workspaces.map((w: { id: string }) => w.id)).toEqual([live.id]);
    expect(res.body.data.workspaces.map((w: { id: string }) => w.id)).not.toContain(workspace.id);
  });

  it('omits a pending invite to it', async () => {
    const { workspace } = await deletedWorkspace();
    const invitee = await makeAccount('invitee');
    await prisma.workspaceInvite.create({
      data: { workspaceId: workspace.id, email: invitee.email, role: 'MEMBER', status: 'PENDING' },
    });

    const res = await request(app).get('/api/me').set(...as(invitee.clerkUserId, invitee.email));

    expect(res.body.data.pendingInvites).toEqual([]);
  });

  it('cannot accept a pending invite to it', async () => {
    const { workspace } = await deletedWorkspace();
    const invitee = await makeAccount('invitee');
    const invite = await prisma.workspaceInvite.create({
      data: { workspaceId: workspace.id, email: invitee.email, role: 'MEMBER', status: 'PENDING' },
    });

    const res = await request(app)
      .post(`/api/invites/${invite.id}/accept`)
      .set(...as(invitee.clerkUserId, invitee.email));

    expect(res.status).toBe(404);
    // No membership was minted in a workspace nobody can open.
    expect(
      await prisma.workspaceMember.count({ where: { workspaceId: workspace.id, accountId: invitee.id } }),
    ).toBe(0);
  });
});
```

Check the accept route's actual path in `src/routes/invites.routes.ts` before running — use whatever it registers.

**Step 2: Run to verify they fail**

Run: `npx vitest run test/workspace-delete.test.ts -t 'bootstrap'`
Expected: FAIL ×3.

**Step 3: Implement**

`src/routes/me.routes.ts` — both queries:

```ts
      prisma.workspaceMember.findMany({
        // The switcher's source of truth. Omitting the deleted one here is
        // also what makes "I deleted my last workspace" fall into the existing
        // /onboarding redirect with no new code on either side.
        where: { accountId: account.id, workspace: { deletedAt: null } },
        include: { workspace: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.workspaceInvite.findMany({
        where: { email: account.email, status: 'PENDING', workspace: { deletedAt: null } },
        include: { workspace: true },
        orderBy: { createdAt: 'asc' },
      }),
```

`src/routes/invites.routes.ts`, in `loadActionableInvite`:

```ts
  // A PENDING invite outlives the delete, and accepting one would mint a
  // membership in a workspace nobody can open. Not found, like any other
  // invite that is no longer actionable.
  if (!invite || invite.status !== 'PENDING' || invite.workspace.deletedAt) {
    throw new ApiError(404, 'NOT_FOUND', 'Invite not found.');
  }
```

**Step 4: Run to verify they pass**

Run: `npx vitest run test/workspace-delete.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/me.routes.ts src/routes/invites.routes.ts test/workspace-delete.test.ts
git commit -m "Hide a deleted workspace from the switcher and from its invites"
```

---

### Task 5: `requireOwner`

**Files:**
- Modify: `src/middleware/workspace.ts`
- Test: `test/workspace-delete.test.ts`

**Step 1: Write the failing test**

```ts
describe('only the owner may delete', () => {
  it('refuses an invited ADMIN who is not the owner', async () => {
    const owner = await makeAccount('owner');
    const admin = await makeAccount('admin');
    const workspace = await makeWorkspace(owner, 'Theirs');
    await addMember(workspace, admin, 'ADMIN');

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(admin.clerkUserId, admin.email));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({
      deletedAt: null,
    });
  });
});
```

**Step 2: Run to verify it fails**

Expected: FAIL — 404, the route does not exist yet.

**Step 3: Implement the middleware**

Append to `src/middleware/workspace.ts`:

```ts
/**
 * Asserts the caller owns `:workspaceId`, not merely that they administer it.
 *
 * A separate middleware rather than a parameter on `requireMembership`: "is an
 * admin" and "is the owner" are different questions, and that function only
 * answers the first. Runs after it, and reads what it attached.
 *
 * Stricter than the rename beside it on purpose. An invited admin must not be
 * able to erase the workspace out from under the person whose account is
 * billed for its DIDs and its calls.
 */
export function requireOwner(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);

    if (workspace.ownerAccountId !== account.id) {
      next(
        new ApiError(
          403,
          'FORBIDDEN',
          'Only the workspace owner can do this.',
        ),
      );
      return;
    }

    next();
  };
}
```

**Step 4: Leave the test failing until Task 6 adds the route.** Note it in the commit message.

**Step 5: Commit**

```bash
git add src/middleware/workspace.ts
git commit -m "Ask whether the caller owns the workspace, not whether they administer it"
```

---

### Task 6: The delete route and its blockers

> **`details` is a SIBLING of `error`, not nested inside it.** `fail()` in
> `src/lib/errors.ts:152-155` writes `body.details`, with the comment "never
> nested inside it — the dashboard reads it there". Assert
> `res.body.details.phoneNumbers`, and read it the same way in the dashboard.
> `res.body.error.details` is `undefined`.
>
> **`CreditTransactionType` has no `USAGE` member.** The real ones are
> `CALL_USAGE`, `TEST_SESSION_USAGE`, `DID_PURCHASE`, `ADJUSTMENT`, … — check
> the enum in `prisma/schema.prisma` before writing a ledger fixture.


**Files:**
- Modify: `src/lib/errors.ts` — new codes
- Modify: `src/routes/workspaces.routes.ts`
- Test: `test/workspace-delete.test.ts`

**Step 1: Write the failing tests**

```ts
describe('the blockers', () => {
  async function owned() {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Mine');
    return { owner, workspace };
  }

  const del = (workspace: { id: string }, owner: { clerkUserId: string; email: string }) =>
    request(app).delete(`/api/workspaces/${workspace.id}`).set(...as(owner.clerkUserId, owner.email));

  it('refuses while a DID is rented, and names it', async () => {
    const { owner, workspace } = await owned();
    const did = await makePhoneNumber(workspace, '+918000', 'ASSIGNED');

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_PHONE_NUMBERS');
    // The list, not just the count: the dashboard renders a specific
    // instruction, and releasing a DID is irreversible so the reader has to
    // see exactly which numbers they are being asked to give up.
    expect(res.body.details.phoneNumbers).toEqual([
      { id: did.id, did: did.did },
    ]);
  });

  it('refuses while a campaign is RUNNING, and names it', async () => {
    const { owner, workspace } = await owned();
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Live one', status: 'RUNNING' },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_LIVE_CAMPAIGNS');
    expect(res.body.details.campaigns).toEqual([
      { id: campaign.id, name: 'Live one', status: 'RUNNING' },
    ]);
  });

  it('refuses a DRAFT campaign that is scheduled to start', async () => {
    const { owner, workspace } = await owned();
    await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        name: 'Tomorrow',
        status: 'DRAFT',
        scheduledStartAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_LIVE_CAMPAIGNS');
  });

  it('refuses while a call is in flight', async () => {
    const { owner, workspace } = await owned();
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Winding down', status: 'PAUSED' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919000000001' },
    });
    const cc = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        workspaceId: workspace.id,
        accountId: owner.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
      },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_CALLS_IN_FLIGHT');
    expect(res.body.details.inFlight).toBe(1);
  });

  it('refuses while a test session is ACTIVE', async () => {
    const { owner, workspace } = await owned();
    const agent = await makeAgent(workspace, 'receptionist');
    await prisma.testSession.create({
      data: {
        workspaceId: workspace.id,
        accountId: owner.id,
        agentId: agent.id,
        startedByAccountId: owner.id,
        status: 'ACTIVE',
      },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_ACTIVE_TEST_SESSION');
  });

  it('nothing is released or stopped by a refusal', async () => {
    const { owner, workspace } = await owned();
    const did = await makePhoneNumber(workspace, '+918000', 'ASSIGNED');

    await del(workspace, owner);

    // Releasing a DID returns it to the shared pool where anyone may rent it,
    // so it stays a separate deliberate act rather than a side effect of a
    // differently-named button.
    expect(await prisma.phoneNumber.findUnique({ where: { id: did.id } })).toMatchObject({
      workspaceId: workspace.id,
      status: 'ASSIGNED',
    });
  });
});

describe('the delete itself', () => {
  it('marks the row deleted and leaves the ledger resolvable', async () => {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Mine');
    const ledger = await prisma.creditTransaction.create({
      data: { accountId: owner.id, workspaceId: workspace.id, amount: -100n, type: 'CALL_USAGE' },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);

    const after = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    expect(after?.deletedAt).toBeInstanceOf(Date);

    // The assertion that the Restrict FKs were respected rather than worked
    // around: the ledger row still resolves the workspace it snapshotted.
    const row = await prisma.creditTransaction.findUnique({
      where: { id: ledger.id },
      include: { workspace: true },
    });
    expect(row?.workspace?.id).toBe(workspace.id);
  });

  it('keeps the slug taken', async () => {
    const owner = await makeAccount('owner');
    const workspace = await prisma.workspace.create({
      data: { name: 'Acme', slug: 'acme', color: '#6366f1', ownerAccountId: owner.id,
        members: { create: { accountId: owner.id, role: 'ADMIN' } } },
    });
    await request(app).delete(`/api/workspaces/${workspace.id}`).set(...as(owner.clerkUserId, owner.email));

    const res = await request(app)
      .post('/api/workspaces')
      .set(...as(owner.clerkUserId, owner.email))
      .send({ name: 'Acme' });

    // Re-issuing a dead workspace's slug would make old links resolve to a
    // stranger's workspace.
    expect(res.body.data.slug).not.toBe('acme');
  });

  it('is idempotent enough to be safe: a second delete is a 403', async () => {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Mine');
    const first = () => request(app).delete(`/api/workspaces/${workspace.id}`).set(...as(owner.clerkUserId, owner.email));

    expect((await first()).status).toBe(200);
    // requireMembership rejects before the handler, so the second click gets
    // the same refusal every other route now gives.
    expect((await first()).status).toBe(403);
  });
});
```

Add `makeAgent` and `makePhoneNumber` to the file's imports from `./helpers.js`.

**Step 2: Run to verify they fail**

Run: `npx vitest run test/workspace-delete.test.ts`
Expected: FAIL — 404 on every delete.

**Step 3: Add the error codes**

In `src/lib/errors.ts`, before `| 'INTERNAL_ERROR'`:

```ts
  // Workspace delete. Each names a different thing the owner has to deal with
  // first, and each carries the offending list in `details` — a flat "you
  // cannot delete this" leaves the reader hunting for what is in the way.
  // Nothing here is auto-released or auto-stopped: releasing a DID returns it
  // to the shared pool irreversibly, and stopping a campaign mid-dial is not
  // something a button named Delete should do on the reader's behalf.
  | 'WORKSPACE_HAS_PHONE_NUMBERS'
  | 'WORKSPACE_HAS_LIVE_CAMPAIGNS'
  | 'WORKSPACE_HAS_CALLS_IN_FLIGHT'
  | 'WORKSPACE_HAS_ACTIVE_TEST_SESSION'
```

**Step 4: Implement the route**

In `src/routes/workspaces.routes.ts`, import `requireOwner` and `IN_FLIGHT`:

```ts
import { requireMembership, requireOwner, roleOf, workspaceOf } from '../middleware/workspace.js';
import { IN_FLIGHT } from '../lib/concurrency.js';
```

and append:

```ts
/**
 * Deleting a workspace — a soft delete, and the only one in this service.
 *
 * `PhoneNumber.workspace` and `CreditTransaction.workspace` are both
 * `onDelete: Restrict`, and any workspace that has ever placed a call or
 * rented a DID holds ledger rows. Clearing that for a row-level DELETE means
 * deleting the ledger or nulling its snapshot — the two things those comments
 * exist to forbid. The row survives and is marked instead, which is exactly
 * what keeps those constraints satisfied.
 *
 * Presented to the customer as permanent: no trash, no restore endpoint, no
 * purge job. Recovery is a staff action against the database — an escape hatch
 * for support rather than a promised feature.
 *
 * Background jobs need no filter of their own, and that is a consequence of the
 * blockers rather than luck: the dispatcher reads only RUNNING campaigns,
 * didRenewal only rented DIDs, the schedule scanner only `scheduledStartAt`,
 * and inbound only fires on a claimed DID. Every one is a precondition this
 * route refuses on, so a deleted workspace is invisible to all of them by
 * construction — which is why loosening a blocker here is never a local change.
 */
workspaceRoutes.delete(
  '/:workspaceId',
  requireAuth,
  requireMembership('ADMIN'),
  requireOwner(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);

    const [phoneNumbers, liveCampaigns, inFlight, activeTestSessions] = await Promise.all([
      prisma.phoneNumber.findMany({
        where: { workspaceId: workspace.id },
        select: { id: true, did: true },
        orderBy: { did: 'asc' },
      }),
      prisma.campaign.findMany({
        // `scheduledStartAt` as well as the statuses: a DRAFT with a start time
        // set is a campaign that will begin dialing on its own, and deleting
        // the workspace under it is how a scheduled start fails overnight with
        // nobody watching.
        where: {
          workspaceId: workspace.id,
          OR: [{ status: { in: ['RUNNING', 'SCHEDULED'] } }, { scheduledStartAt: { not: null } }],
        },
        select: { id: true, name: true, status: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.callAttempt.count({ where: { workspaceId: workspace.id, ...IN_FLIGHT } }),
      prisma.testSession.count({ where: { workspaceId: workspace.id, status: 'ACTIVE' } }),
    ]);

    // Reported one at a time, most-fixable first. All four at once reads as a
    // wall rather than a next step, and the first is the only one the reader
    // can act on without waiting.
    if (phoneNumbers.length) {
      throw new ApiError(
        409,
        'WORKSPACE_HAS_PHONE_NUMBERS',
        `This workspace still rents ${phoneNumbers.length === 1 ? 'a phone number' : `${phoneNumbers.length} phone numbers`}. Release ${phoneNumbers.length === 1 ? 'it' : 'them'} from Settings → Phone numbers first.`,
        { phoneNumbers },
      );
    }

    if (liveCampaigns.length) {
      throw new ApiError(
        409,
        'WORKSPACE_HAS_LIVE_CAMPAIGNS',
        `${liveCampaigns.length === 1 ? 'A campaign is' : `${liveCampaigns.length} campaigns are`} running or scheduled to start. Stop ${liveCampaigns.length === 1 ? 'it' : 'them'} first.`,
        { campaigns: liveCampaigns },
      );
    }

    if (inFlight) {
      throw new ApiError(
        409,
        'WORKSPACE_HAS_CALLS_IN_FLIGHT',
        `${inFlight === 1 ? 'A call is' : `${inFlight} calls are`} still connected. Wait for ${inFlight === 1 ? 'it' : 'them'} to finish.`,
        { inFlight },
      );
    }

    if (activeTestSessions) {
      throw new ApiError(
        409,
        'WORKSPACE_HAS_ACTIVE_TEST_SESSION',
        'A test session is still running. Wait for it to finish.',
        { activeTestSessions },
      );
    }

    // `deletedAt: null` in the guard, not just the id. Two clicks land as one
    // delete rather than moving the timestamp a second time — and the second
    // request is refused by `requireMembership` on the next call regardless.
    await prisma.workspace.updateMany({
      where: { id: workspace.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    res.json({ success: true, data: { id: workspace.id } });
  }),
);
```

Import `ApiError` in that file if it is not already imported.

**Step 5: Run to verify they pass**

Run: `npx vitest run test/workspace-delete.test.ts`
Expected: PASS, including the Task 5 owner case.

**Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/errors.ts src/routes/workspaces.routes.ts test/workspace-delete.test.ts
git commit -m "Let a workspace owner delete their workspace, and name what is in the way"
```

---

### Task 7: The straggler grep

**Files:** none necessarily — this is a check that may produce fixes.

**Step 1: Find every read of `workspace` that should now filter**

```bash
grep -rn "prisma.workspace.find\|prisma.workspace.count" src/ scripts/ | grep -v deletedAt
```

`scripts/` matters: the battle and conformance harnesses assert contracts too, and `tsc` and `npm test` stay green while they go stale.

**Step 2: Decide each hit deliberately, and write the decision down**

Expected outcomes, all three legitimate:
- **Staff/admin reads** (`src/routes/admin/*`) — deliberately unfiltered. Staff must be able to see a deleted workspace; that is the recovery path. Add a one-line comment saying so where it is not obvious.
- **`uniqueSlug`** (`src/lib/slug.ts:61`) — deliberately unfiltered, and Task 6's test pins it.
- **Customer-facing reads** — must filter. Any you find that do not are bugs; write a case in `test/workspace-delete.test.ts` first.

**Step 3: Commit whatever it produced**

```bash
git commit -am "Say which workspace reads deliberately still see a deleted one"
```

---

# Part 2 — Campaign transfer (backend)

### Task 8: `describeCampaignTransfer` — the preview

**Files:**
- Create: `src/services/campaignTransfer.ts`
- Test: `test/campaign-transfer.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';
import {
  CampaignNotFoundError,
  CampaignRunningError,
  ContactCountChangedError,
  SameWorkspaceError,
  TargetWorkspaceDeletedError,
  WorkspaceNotFoundError,
  describeCampaignTransfer,
  transferCampaign,
} from '../src/services/campaignTransfer.js';

beforeEach(async () => {
  await truncateAll();
});

async function scene() {
  const account = await makeAccount('owner');
  const source = await makeWorkspace(account, 'Source');
  const target = await makeWorkspace(account, 'Target');
  const agent = await makeAgent(source, 'closer');
  const did = await makePhoneNumber(source, '+918000', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: source.id,
      name: 'Q3 outreach',
      status: 'PAUSED',
      agentId: agent.id,
      phoneNumberId: did.id,
    },
  });
  await prisma.campaignPhoneNumber.create({
    data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
  });
  return { account, source, target, agent, did, campaign };
}

async function addContact(
  workspaceId: string,
  campaignId: string | null,
  phone: string,
  fields: Record<string, unknown> = {},
) {
  const contact = await prisma.contact.create({
    data: { workspaceId, phone, ...fields },
  });
  if (campaignId) {
    await prisma.campaignContact.create({ data: { campaignId, contactId: contact.id } });
  }
  return contact;
}

describe('describeCampaignTransfer', () => {
  it('splits the contacts into ones the target already holds and ones it does not', async () => {
    const { source, target, campaign, agent, did } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');
    await addContact(source.id, campaign.id, '+919000000002');
    // The target already knows this person.
    await addContact(target.id, null, '+919000000002', { name: 'Known' });

    const plan = await describeCampaignTransfer(campaign.id, target.id);

    expect(plan.source).toMatchObject({ id: source.id, name: 'Source' });
    expect(plan.target).toMatchObject({ id: target.id, name: 'Target' });
    expect(plan.counts).toMatchObject({ contacts: 2, contactsExisting: 1, contactsCreated: 1 });
    expect(plan.detaching).toMatchObject({ agentName: agent.name, phoneNumbers: [did.did] });
  });

  it('counts the attempts staying behind', async () => {
    const { source, campaign, target } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        workspaceId: source.id,
        accountId: account.id,
        attemptNo: 1,
        status: 'COMPLETED',
      },
    });

    const plan = await describeCampaignTransfer(campaign.id, target.id);

    expect(plan.counts.attemptsStaying).toBe(1);
  });

  it('refuses a campaign that does not exist', async () => {
    const { target } = await scene();
    await expect(describeCampaignTransfer('nope', target.id)).rejects.toThrow(CampaignNotFoundError);
  });

  it('refuses a target that does not exist', async () => {
    const { campaign } = await scene();
    await expect(describeCampaignTransfer(campaign.id, 'nope')).rejects.toThrow(WorkspaceNotFoundError);
  });

  it('refuses a target that is the source', async () => {
    const { campaign, source } = await scene();
    await expect(describeCampaignTransfer(campaign.id, source.id)).rejects.toThrow(SameWorkspaceError);
  });

  it('refuses a deleted target', async () => {
    const { campaign, target } = await scene();
    await prisma.workspace.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      TargetWorkspaceDeletedError,
    );
  });

  it('refuses a RUNNING campaign', async () => {
    const { campaign, target } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });
    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      CampaignRunningError,
    );
  });

  it('refuses while a call is in flight', async () => {
    const { source, campaign, target } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        workspaceId: source.id,
        accountId: account.id,
        attemptNo: 1,
        status: 'RINGING',
      },
    });

    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      CampaignRunningError,
    );
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run test/campaign-transfer.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the service's read half**

Create `src/services/campaignTransfer.ts`:

```ts
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { IN_FLIGHT } from '../lib/concurrency.js';

/**
 * Moving one campaign from one workspace to another — a staff action, not a
 * customer one.
 *
 * ## What does not move
 *
 * Call history and ledger rows stay with the source. `CallAttempt.workspaceId`
 * is a dial-time snapshot, exactly as `CreditTransaction` snapshots its
 * workspace, and both comments say why: deriving either later would make a
 * campaign's billing history follow whoever owns the workspace now. Rewriting
 * them is ruled out by the same contract that rules out hard-deleting a
 * workspace.
 *
 * ## What moves for free
 *
 * `CampaignContact`, `DoNotCall`, `CallAttempt` and `CampaignPhoneNumber` are
 * keyed by `campaignId` alone with no workspace column, so they follow the
 * campaign with no write at all. Only `Contact` needs remapping, because it is
 * workspace-scoped and unique on `(workspaceId, phone)`.
 *
 * ## Preview then apply
 *
 * Modelled on `accountTransfer.ts`, and for the same reason: the commit calls
 * `describeCampaignTransfer` **inside its own transaction** and writes from
 * what it returns. Two code paths would let the confirm step promise something
 * the write does not do, and on an operation with no undo the confirm step is
 * the only protection there is.
 */

export class CampaignNotFoundError extends Error {
  constructor() {
    super('That campaign does not exist.');
    this.name = 'CampaignNotFoundError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super('The target workspace does not exist.');
    this.name = 'WorkspaceNotFoundError';
  }
}

export class SameWorkspaceError extends Error {
  constructor() {
    super('The campaign is already in that workspace.');
    this.name = 'SameWorkspaceError';
  }
}

export class TargetWorkspaceDeletedError extends Error {
  constructor() {
    super('The target workspace has been deleted. Nothing can be moved into it.');
    this.name = 'TargetWorkspaceDeletedError';
  }
}

/** Live, in either sense: dialing, scheduled, or holding a line. Staff stop the
 *  campaign first; the transfer does not stop it for them, because a campaign
 *  halted by a move is a campaign nobody decided to halt. */
export class CampaignRunningError extends Error {
  constructor(readonly reason: 'status' | 'in-flight') {
    super(
      reason === 'status'
        ? 'This campaign is running or scheduled to start. Stop it before moving it.'
        : 'This campaign still has calls connected. Wait for them to finish.',
    );
    this.name = 'CampaignRunningError';
  }
}

/** The campaign gained or lost contacts between the preview and the confirm.
 *  Refused rather than applied: the plan the operator reviewed must be the plan
 *  that ran, and a move of a different thing is worse than a move refused. */
export class ContactCountChangedError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `This campaign had ${expected} contacts when the preview was taken and has ${actual} now. Nothing was moved — review it again.`,
    );
    this.name = 'ContactCountChangedError';
  }
}

export interface CampaignTransferPlan {
  campaign: { id: string; name: string; status: string };
  source: { id: string; name: string };
  target: { id: string; name: string };
  counts: {
    contacts: number;
    /** Already present in the target, matched on phone. Their rows are reused
     *  untouched — see `transferCampaign`. */
    contactsExisting: number;
    contactsCreated: number;
    doNotCall: number;
    /** Stays with the source. The number the dialog must make unmissable. */
    attemptsStaying: number;
  };
  detaching: {
    agentName: string | null;
    /** The dial roster's DIDs, by number. */
    phoneNumbers: string[];
  };
}

type Reader = Prisma.TransactionClient | typeof prisma;

/** Rows per statement. The schema contemplates 100,000-contact campaigns, and
 *  `campaignTopup.ts` documents both traps this shares: a parameter list no
 *  driver enjoys, and a lock held longer than the dispatcher can wait. */
const CHUNK_SIZE = 1000;

/**
 * Prisma's interactive-transaction default is 5 seconds, and a large remap
 * beats it — which surfaces as a P2028 and a 500 on a request that was doing
 * exactly what it was asked to. Same number `campaignTopup.ts` settled on.
 */
const TRANSFER_TRANSACTION_TIMEOUT_MS = 30_000;

export async function describeCampaignTransfer(
  campaignId: string,
  targetWorkspaceId: string,
  client: Reader = prisma,
): Promise<CampaignTransferPlan> {
  const campaign = await client.campaign.findUnique({
    where: { id: campaignId },
    include: {
      workspace: { select: { id: true, name: true } },
      agent: { select: { name: true } },
      dialNumbers: {
        include: { phoneNumber: { select: { did: true } } },
        orderBy: { position: 'asc' },
      },
    },
  });

  if (!campaign) throw new CampaignNotFoundError();
  if (campaign.workspaceId === targetWorkspaceId) throw new SameWorkspaceError();

  const target = await client.workspace.findUnique({
    where: { id: targetWorkspaceId },
    select: { id: true, name: true, deletedAt: true },
  });

  if (!target) throw new WorkspaceNotFoundError();
  if (target.deletedAt) throw new TargetWorkspaceDeletedError();

  if (
    campaign.status === 'RUNNING' ||
    campaign.status === 'SCHEDULED' ||
    campaign.scheduledStartAt !== null
  ) {
    throw new CampaignRunningError('status');
  }

  const inFlight = await client.callAttempt.count({
    where: { campaignId: campaign.id, ...IN_FLIGHT },
  });
  if (inFlight) throw new CampaignRunningError('in-flight');

  // Phones, not contact ids: the remap is keyed on phone because that is what
  // `Contact`'s unique is keyed on.
  const phones = (
    await client.campaignContact.findMany({
      where: { campaignId: campaign.id },
      select: { contact: { select: { phone: true } } },
    })
  ).map((row) => row.contact.phone);

  const existing = phones.length
    ? await client.contact.count({
        where: { workspaceId: target.id, phone: { in: phones } },
      })
    : 0;

  const [doNotCall, attemptsStaying] = await Promise.all([
    client.doNotCall.count({ where: { campaignId: campaign.id } }),
    client.callAttempt.count({ where: { campaignId: campaign.id } }),
  ]);

  return {
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    source: campaign.workspace,
    target: { id: target.id, name: target.name },
    counts: {
      contacts: phones.length,
      contactsExisting: existing,
      contactsCreated: phones.length - existing,
      doNotCall,
      attemptsStaying,
    },
    detaching: {
      agentName: campaign.agent?.name ?? null,
      phoneNumbers: campaign.dialNumbers.map((row) => row.phoneNumber.did),
    },
  };
}
```

**Step 4: Run to verify the preview cases pass**

Run: `npx vitest run test/campaign-transfer.test.ts -t describeCampaignTransfer`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/campaignTransfer.ts test/campaign-transfer.test.ts
git commit -m "Describe what moving a campaign between workspaces would do"
```

---

### Task 9: `transferCampaign` — the write

> **Two traps in the fixtures below, both verified against the schema:**
>
> - `CallAttempt` requires **`accountId`** and **`attemptNo`** — neither has a
>   default, and `attemptNo` is half of `@@unique([campaignContactId, attemptNo])`.
>   A fixture missing them throws a Prisma validation error, not an assertion
>   failure, so it reads as a broken test rather than a broken plan.
> - **`tsconfig.json` excludes `test/`**, so `npx tsc --noEmit` never typechecks
>   a test file. A green `tsc` says nothing about the fixtures here; only
>   running vitest does.


**Files:**
- Modify: `src/services/campaignTransfer.ts`
- Modify: `test/campaign-transfer.test.ts`

**Step 1: Write the failing tests**

```ts
describe('transferCampaign', () => {
  it('moves the campaign and lands it inert', async () => {
    const { source, target, campaign, did } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');

    await transferCampaign(campaign.id, target.id, 1);

    const after = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: { dialNumbers: true, inboundClaims: true },
    });

    expect(after.workspaceId).toBe(target.id);
    expect(after.agentId).toBeNull();
    expect(after.phoneNumberId).toBeNull();
    expect(after.dialNumbers).toEqual([]);
    expect(after.inboundClaims).toEqual([]);
    expect(after.status).toBe('PAUSED');
    expect(after.haltReason).toBe(
      'Moved from Source by YE staff. Set an agent and a phone number before resuming.',
    );

    // The DID itself is untouched — it is the source's rental, and moving it
    // would change which account is billed while the ledger says otherwise.
    expect(await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).toMatchObject({
      workspaceId: source.id,
      status: 'ASSIGNED',
    });
  });

  it('creates a contact in the target when it holds no matching phone', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001', {
      name: 'Asha',
      tags: ['warm'],
      metadata: { city: 'Pune' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    const moved = await prisma.contact.findUniqueOrThrow({
      where: { workspaceId_phone: { workspaceId: target.id, phone: '+919000000001' } },
    });
    expect(moved).toMatchObject({ name: 'Asha', tags: ['warm'], metadata: { city: 'Pune' } });

    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(cc.contactId).toBe(moved.id);
  });

  it('reuses the target contact UNCHANGED when it already holds the phone', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001', {
      name: 'Source name',
      tags: ['source-tag'],
      metadata: { from: 'source' },
    });
    const theirs = await addContact(target.id, null, '+919000000001', {
      name: 'Their name',
      tags: ['their-tag'],
      metadata: { from: 'target' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    // The target's own record of a person is not the source's to overwrite,
    // and a silent merge is the failure nobody notices afterward.
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      name: 'Their name',
      tags: ['their-tag'],
      metadata: { from: 'target' },
    });

    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(cc.contactId).toBe(theirs.id);
  });

  it('leaves the source contacts in place', async () => {
    const { source, target, campaign } = await scene();
    const mine = await addContact(source.id, campaign.id, '+919000000001');

    await transferCampaign(campaign.id, target.id, 1);

    // They may back other campaigns that are not moving, and the source's own
    // CallAttempt history references them.
    expect(await prisma.contact.findUnique({ where: { id: mine.id } })).not.toBeNull();
  });

  it('carries every contact journey field across unchanged', async () => {
    const { source, target, campaign } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const callbackAt = new Date('2026-10-01T09:30:00.000Z');
    const nextEligibleAt = new Date('2026-10-01T09:00:00.000Z');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id, contactId: contact.id },
      data: {
        attempts: 2,
        callbackCount: 1,
        followUpCount: 1,
        armKind: 'CALLBACK',
        callbackAt,
        nextEligibleAt,
        status: 'PENDING',
        disposition: 'no-answer',
      },
    });

    await transferCampaign(campaign.id, target.id, 1);

    expect(
      await prisma.campaignContact.findFirstOrThrow({ where: { campaignId: campaign.id } }),
    ).toMatchObject({
      attempts: 2,
      callbackCount: 1,
      followUpCount: 1,
      armKind: 'CALLBACK',
      callbackAt,
      nextEligibleAt,
      status: 'PENDING',
      disposition: 'no-answer',
    });
  });

  it('carries the DNC list across', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');
    await prisma.doNotCall.create({
      data: { campaignId: campaign.id, phone: '+919000000009', reason: 'asked not to be called' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    // Keyed by campaignId alone, so it follows for free — asserted because
    // "for free" is exactly the kind of claim that stops being true.
    expect(await prisma.doNotCall.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it('leaves the call history and the ledger reading source', async () => {
    const { account, source, target, campaign } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    const attempt = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        workspaceId: source.id,
        accountId: account.id,
        attemptNo: 1,
        status: 'COMPLETED',
      },
    });
    const ledger = await prisma.creditTransaction.create({
      data: { accountId: account.id, workspaceId: source.id, amount: -100n, type: 'CALL_USAGE' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    expect(await prisma.callAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      workspaceId: source.id,
    });
    expect(
      await prisma.creditTransaction.findUniqueOrThrow({ where: { id: ledger.id } }),
    ).toMatchObject({ workspaceId: source.id });
  });

  it('refuses on contact-count drift and writes nothing', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');
    await addContact(source.id, campaign.id, '+919000000002');

    await expect(transferCampaign(campaign.id, target.id, 1)).rejects.toThrow(
      ContactCountChangedError,
    );

    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      workspaceId: source.id,
      status: 'PAUSED',
    });
    expect(await prisma.contact.count({ where: { workspaceId: target.id } })).toBe(0);
  });

  it('remaps across the chunk boundary', async () => {
    const { source, target, campaign } = await scene();
    const COUNT = 1050;

    await prisma.contact.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        workspaceId: source.id,
        phone: `+9190000${String(i).padStart(5, '0')}`,
      })),
    });
    const contacts = await prisma.contact.findMany({ where: { workspaceId: source.id } });
    await prisma.campaignContact.createMany({
      data: contacts.map((c) => ({ campaignId: campaign.id, contactId: c.id })),
    });

    await transferCampaign(campaign.id, target.id, COUNT);

    // Exercised rather than assumed: at 1,000 rows per statement this is two
    // chunks, and an off-by-one in the batching loses the tail silently.
    expect(await prisma.contact.count({ where: { workspaceId: target.id } })).toBe(COUNT);

    const remapped = await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id },
      select: { contact: { select: { workspaceId: true } } },
    });
    expect(remapped).toHaveLength(COUNT);
    expect(remapped.every((row) => row.contact.workspaceId === target.id)).toBe(true);
  }, 60_000);
});
```

**Step 2: Run to verify they fail**

Run: `npx vitest run test/campaign-transfer.test.ts -t transferCampaign`
Expected: FAIL — `transferCampaign` is not exported.

**Step 3: Implement the write**

Append to `src/services/campaignTransfer.ts`:

```ts
export async function transferCampaign(
  campaignId: string,
  targetWorkspaceId: string,
  expectedContactCount: number,
): Promise<CampaignTransferPlan> {
  return prisma.$transaction(
    async (tx) => {
      // Re-derived inside the transaction rather than trusted from the preview
      // the operator saw: minutes may have passed, and every blocker must hold
      // now rather than then.
      const plan = await describeCampaignTransfer(campaignId, targetWorkspaceId, tx);

      // The drift check. A campaign that gained contacts between preview and
      // confirm is a different thing from the one that was reviewed.
      if (plan.counts.contacts !== expectedContactCount) {
        throw new ContactCountChangedError(expectedContactCount, plan.counts.contacts);
      }

      const links = await tx.campaignContact.findMany({
        where: { campaignId },
        select: { id: true, contact: { select: { phone: true, name: true, email: true, tags: true, metadata: true } } },
      });

      const phones = links.map((link) => link.contact.phone);

      // Which phones the target already knows. Read in chunks for the same
      // reason the writes are: an `IN` list of 100,000 is not a query.
      const known = new Map<string, string>();
      for (let i = 0; i < phones.length; i += CHUNK_SIZE) {
        const rows = await tx.contact.findMany({
          where: { workspaceId: targetWorkspaceId, phone: { in: phones.slice(i, i + CHUNK_SIZE) } },
          select: { id: true, phone: true },
        });
        for (const row of rows) known.set(row.phone, row.id);
      }

      // Reused UNTOUCHED. The target's own record of a person is not the
      // source's to overwrite, and a silent merge of name, tags or metadata is
      // unreviewable afterward — which is why there is no update here at all.
      const toCreate = links.filter((link) => !known.has(link.contact.phone));

      for (let i = 0; i < toCreate.length; i += CHUNK_SIZE) {
        await tx.contact.createMany({
          data: toCreate.slice(i, i + CHUNK_SIZE).map((link) => ({
            workspaceId: targetWorkspaceId,
            phone: link.contact.phone,
            name: link.contact.name,
            email: link.contact.email,
            tags: link.contact.tags,
            metadata: link.contact.metadata as Prisma.InputJsonValue,
          })),
        });
      }

      if (toCreate.length) {
        const createdPhones = toCreate.map((link) => link.contact.phone);
        for (let i = 0; i < createdPhones.length; i += CHUNK_SIZE) {
          const rows = await tx.contact.findMany({
            where: {
              workspaceId: targetWorkspaceId,
              phone: { in: createdPhones.slice(i, i + CHUNK_SIZE) },
            },
            select: { id: true, phone: true },
          });
          for (const row of rows) known.set(row.phone, row.id);
        }
      }

      // One UPDATE per link. No collision is possible on
      // `@@unique([campaignId, contactId])`: the source contacts are already
      // distinct by phone, so they map to distinct target contacts.
      for (const link of links) {
        const contactId = known.get(link.contact.phone);
        if (!contactId) {
          // Unreachable unless the two loops above disagree. Loud rather than
          // a silently-skipped contact.
          throw new Error(`No target contact for ${link.contact.phone} — nothing moved.`);
        }
        await tx.campaignContact.update({ where: { id: link.id }, data: { contactId } });
      }

      // The dial roster is the source's DIDs, and the inbound claims only
      // exist while RUNNING — deleted defensively, since a claim surviving a
      // move would pin one workspace's DID to another workspace's campaign.
      await tx.campaignPhoneNumber.deleteMany({ where: { campaignId } });
      await tx.campaignInboundClaim.deleteMany({ where: { campaignId } });

      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          workspaceId: targetWorkspaceId,
          // The agent and the number are the source's. The campaign lands
          // incomplete and the customer re-picks both; moving the DIDs instead
          // would silently change which account is billed for those rentals
          // while the ledger says otherwise.
          agentId: null,
          phoneNumberId: null,
          status: 'PAUSED',
          haltReason: `Moved from ${plan.source.name} by YE staff. Set an agent and a phone number before resuming.`,
        },
      });

      return plan;
    },
    { timeout: TRANSFER_TRANSACTION_TIMEOUT_MS },
  );
}
```

**Step 4: Run to verify they pass**

Run: `npx vitest run test/campaign-transfer.test.ts`
Expected: PASS. The chunk-boundary case is slow — its own 60s timeout is on the `it`.

**Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/services/campaignTransfer.ts test/campaign-transfer.test.ts
git commit -m "Move a campaign between workspaces, leaving its history behind"
```

---

### Task 10: The admin routes

**Files:**
- Create: `src/routes/admin/campaigns.routes.ts`
- Modify: `src/routes/admin/index.ts`
- Modify: `src/lib/errors.ts`
- Test: `test/admin-campaign-transfer.test.ts` (create)

**Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

beforeEach(async () => {
  await truncateAll();
});

async function scene() {
  const account = await makeAccount('owner');
  const source = await makeWorkspace(account, 'Source');
  const target = await makeWorkspace(account, 'Target');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: source.id, name: 'Q3', status: 'PAUSED' },
  });
  return { source, target, campaign };
}

describe('staff authentication', () => {
  it.each([
    ['get', '/api/admin/campaigns/any/transfer-preview?target=any'],
    ['post', '/api/admin/campaigns/any/transfer'],
  ])('refuses %s %s without the staff token', async (method, path) => {
    const res = await (request(app) as never as Record<string, (u: string) => Promise<{ status: number }>>)[method](path);
    expect(res.status).toBe(401);
  });
});

describe('GET transfer-preview', () => {
  it('returns the plan', async () => {
    const { source, target, campaign } = await scene();

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview?target=${target.id}`)
      .set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      source: { id: source.id, name: 'Source' },
      target: { id: target.id, name: 'Target' },
      counts: { contacts: 0, attemptsStaying: 0 },
    });
  });

  it('maps a RUNNING campaign to 409', async () => {
    const { target, campaign } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview?target=${target.id}`)
      .set(...staff());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_NOT_TRANSFERABLE');
  });

  it('maps a missing campaign to 404', async () => {
    const { target } = await scene();
    const res = await request(app)
      .get(`/api/admin/campaigns/nope/transfer-preview?target=${target.id}`)
      .set(...staff());
    expect(res.status).toBe(404);
  });

  it('400s without a target', async () => {
    const { campaign } = await scene();
    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview`)
      .set(...staff());
    expect(res.status).toBe(400);
  });
});

describe('POST transfer', () => {
  it('moves it', async () => {
    const { target, campaign } = await scene();

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id, expectedContactCount: 0 });

    expect(res.status).toBe(200);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      workspaceId: target.id,
      status: 'PAUSED',
    });
  });

  it('maps drift to 409 CONCURRENT_MODIFICATION', async () => {
    const { source, target, campaign } = await scene();
    const contact = await prisma.contact.create({
      data: { workspaceId: source.id, phone: '+919000000001' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id, expectedContactCount: 0 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_MODIFICATION');
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      workspaceId: source.id,
    });
  });

  it('400s without expectedContactCount', async () => {
    const { target, campaign } = await scene();
    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id });
    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run test/admin-campaign-transfer.test.ts`
Expected: FAIL — 404s.

**Step 3: Add the error code**

In `src/lib/errors.ts`, beside the other staff codes:

```ts
  // A campaign staff cannot move right now — running, scheduled, holding a
  // line, or pointed at a target that is itself or has been deleted. One code
  // and the service's own sentence: the operator acts on the sentence, and
  // splitting it four ways would be four codes the console renders identically.
  | 'CAMPAIGN_NOT_TRANSFERABLE'
```

`CONCURRENT_MODIFICATION` already exists — reuse it for drift, as `accountTransfer` does.

**Step 4: Write the route**

Create `src/routes/admin/campaigns.routes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import {
  CampaignNotFoundError,
  CampaignRunningError,
  ContactCountChangedError,
  SameWorkspaceError,
  TargetWorkspaceDeletedError,
  WorkspaceNotFoundError,
  describeCampaignTransfer,
  transferCampaign,
} from '../../services/campaignTransfer.js';

/**
 * Moving a campaign between workspaces — the one staff write that crosses a
 * tenancy boundary on the customer's data rather than on their account.
 *
 * The service owns the rules; this file owns the HTTP. A typed error maps to
 * one status and one sentence here, so a rule is never expressed twice.
 */
export const adminCampaignRoutes: Router = Router();

// Redundant with the mount in `index.ts`, and deliberately so — that file's
// comment is the house rule: a router that guards itself cannot be mounted
// somewhere else and arrive open.
adminCampaignRoutes.use(requireStaffToken);

const previewSchema = z.object({ target: z.string().min(1) });

const transferSchema = z.object({
  targetWorkspaceId: z.string().min(1),
  /** The drift check, and required rather than defaulted: a missing count is
   *  an operator who did not review a preview, and defaulting it to the live
   *  number would move whatever the campaign happens to hold now. */
  expectedContactCount: z.number().int().min(0),
});

function asApiError(err: unknown): ApiError | null {
  if (err instanceof CampaignNotFoundError || err instanceof WorkspaceNotFoundError) {
    return new ApiError(404, 'NOT_FOUND', err.message);
  }
  if (
    err instanceof CampaignRunningError ||
    err instanceof SameWorkspaceError ||
    err instanceof TargetWorkspaceDeletedError
  ) {
    return new ApiError(409, 'CAMPAIGN_NOT_TRANSFERABLE', err.message);
  }
  if (err instanceof ContactCountChangedError) {
    return new ApiError(409, 'CONCURRENT_MODIFICATION', err.message);
  }
  return null;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const mapped = asApiError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

adminCampaignRoutes.get(
  '/campaigns/:campaignId/transfer-preview',
  asyncHandler(async (req, res) => {
    const { target } = parseBody(previewSchema, req.query);

    const plan = await run(() => describeCampaignTransfer(req.params.campaignId!, target));

    res.json({ success: true, data: plan });
  }),
);

adminCampaignRoutes.post(
  '/campaigns/:campaignId/transfer',
  asyncHandler(async (req, res) => {
    const { targetWorkspaceId, expectedContactCount } = parseBody(transferSchema, req.body);

    const result = await run(() =>
      transferCampaign(req.params.campaignId!, targetWorkspaceId, expectedContactCount),
    );

    res.json({ success: true, data: result });
  }),
);
```

In `src/routes/admin/index.ts`, add the import and the `adminRoutes.use(adminCampaignRoutes);` line beside its siblings.

**Step 5: Run to verify they pass**

Run: `npx vitest run test/admin-campaign-transfer.test.ts`
Expected: PASS.

**Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/routes/admin/campaigns.routes.ts src/routes/admin/index.ts src/lib/errors.ts test/admin-campaign-transfer.test.ts
git commit -m "Give staff a preview and an apply for moving a campaign"
```

---

### Task 11: Full backend suite

**Step 1: Run everything**

Run: `npm test`
Expected: green. **Re-run any failure 5–10× before investigating** — roughly 10% of full runs fail from cross-file bleed. A failure in a file you did not touch that does not reproduce alone is the known flake, not your change.

**Step 2: If a failure does reproduce alone, fix it before moving on.** The likeliest real one is a test elsewhere that creates a workspace and now trips the `deletedAt` filter, or one that counted `/api/me` workspaces.

**Step 3: Commit any fixes**

---

# Part 3 — Dashboard (workspace delete)

Work in `ye-voice-dashboard`. Its dev server needs the backend worktree running on 3001; watch for port collisions with the main checkout.

### Task 12: Promote the confirm dialog

**Files:**
- Create: `components/ui/confirm-dialog.tsx` (moved from `app/(dash)/settings/phone-numbers/confirm-dialog.tsx`)
- Modify: `app/(dash)/settings/phone-numbers/page.tsx` and any other importer

**Step 1: Move the file**

```bash
git mv "app/(dash)/settings/phone-numbers/confirm-dialog.tsx" components/ui/confirm-dialog.tsx
```

**Step 2: Update the doc comment**

Its current comment says "the confirmation in front of every action that moves money", which stops being true. Replace the first line with:

```tsx
/**
 * The confirmation in front of an action that cannot be taken back.
 *
 * Renting spends the owner's credits, releasing forfeits the rest of a paid
 * month, deleting a workspace ends access to everything in it. So the dialog's
 * job is to put the facts the decision needs in front of the reader *before*
 * the click, rather than leaving them to be discovered afterward.
 */
```

**Step 3: Fix every importer**

```bash
grep -rn "confirm-dialog" app components | cat
```

Repoint each to `@/components/ui/confirm-dialog`.

**Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

**Step 5: Commit**

```bash
git add -A
git commit -m "Move the confirm dialog out of the phone-numbers page"
```

---

### Task 13: The General settings page

**Files:**
- Create: `app/(dash)/settings/general/page.tsx`
- Modify: `components/shell/sidebar.tsx:44-48`
- Modify: `lib/api.ts` — new `ApiErrorCode` members

**Step 1: Add the nav entry**

`components/shell/sidebar.tsx`, as the **first** `SETTINGS_NAV` entry:

```tsx
const SETTINGS_NAV = [
  // No `adminOnly`: a MEMBER can read the workspace name, so unlike Billing
  // this page has a readable half.
  { href: '/settings/general', label: 'General', icon: Settings },
  { href: '/settings/members', label: 'Members', icon: Users },
  ...
];
```

Import `Settings` from `lucide-react`.

**Step 2: Add the error codes to the client's union**

`lib/api.ts`, in `ApiErrorCode`:

```ts
  // Workspace delete. Each names a different thing to clear first, and each
  // carries the offending list in the response so the page can name it.
  | 'WORKSPACE_HAS_PHONE_NUMBERS'
  | 'WORKSPACE_HAS_LIVE_CAMPAIGNS'
  | 'WORKSPACE_HAS_CALLS_IN_FLIGHT'
  | 'WORKSPACE_HAS_ACTIVE_TEST_SESSION'
```

**Step 3: Write the page**

Create `app/(dash)/settings/general/page.tsx`. It is a client component, modelled on `app/(dash)/settings/members/page.tsx`:

- **Rename**, at the top: an `Input` seeded from `activeWorkspace.name`, a Save button calling `api(`/api/workspaces/${id}`, { method: 'PATCH', body: { name } })`, then `refresh()`. Gated on `activeWorkspace.role === 'ADMIN'`; a MEMBER sees the name read-only. **This is the first caller `PATCH /api/workspaces/:id` has ever had** — check the round trip by hand.
- **Danger zone**, below, visually separated with a `--danger`-toned border.
- The delete button gates on `activeWorkspace.isOwner`, which `serializeMembership` already returns — no API change. A non-owner sees it **disabled with a line naming the owner**, not hidden: hiding it leaves an admin hunting for an option that exists. (`/api/me` returns `isOwner` but not the owner's name — render "Only the workspace owner can delete this workspace." rather than inventing a name the payload does not carry.)
- Clicking it opens `ConfirmDialog` with `tone="danger"`, carrying:
  - the workspace name typed to confirm, feeding the existing `disabled` prop,
  - a plain count of what becomes unreachable — N campaigns, N contacts, N calls — read from whatever the dashboard already has (`/api/workspaces/:id/campaigns` and `/api/workspaces/:id/contacts` both expose totals; check their shapes and reuse rather than adding an endpoint),
  - the sentence **"This is permanent."** and nothing softer.
- On a 409, render the blocker's own `details` as the specific instruction: the numbers as a list with a link to `/settings/phone-numbers`, the campaigns as a list with a link per campaign. Keep the dialog open — the reader has work to do and closing it loses the message.
- On success: `refresh()`, and let the provider's existing logic pick the next workspace or bounce to `/onboarding` (`components/workspace-provider.tsx:88-96`). Add no redirect of your own.

**Step 4: Verify by hand**

Run the backend worktree (`npm run dev`) and `npm run dev` here. Walk: rename saves; a MEMBER sees it read-only; a non-owner ADMIN sees the delete disabled; a workspace with a rented DID refuses and names the number; releasing it then lets the delete through; the switcher drops it; deleting your last workspace lands on `/onboarding`.

**Step 5: Commit**

```bash
npx tsc --noEmit && npm run lint
git add -A
git commit -m "Give rename and delete a home in Settings → General"
```

---

# Part 4 — Admin console (campaign transfer)

Work in `ye-voice-admin`. Mutations here are `'use server'` actions calling `apiFetch`, so the staff token stays in the httpOnly cookie — see `app/(console)/accounts/[id]/actions.ts`.

### Task 14: The transfer action

**Files:**
- Create: `app/(console)/workspaces/[id]/actions.ts`
- Modify: `lib/types.ts` — the plan's shape

**Step 1: Add the type**

`lib/types.ts`:

```ts
export interface CampaignTransferPlan {
  campaign: { id: string; name: string; status: string };
  source: { id: string; name: string };
  target: { id: string; name: string };
  counts: {
    contacts: number;
    contactsExisting: number;
    contactsCreated: number;
    doNotCall: number;
    attemptsStaying: number;
  };
  detaching: { agentName: string | null; phoneNumbers: string[] };
}
```

**Step 2: Write the actions**

Create `app/(console)/workspaces/[id]/actions.ts`, modelled on `app/(console)/accounts/[id]/actions.ts` — `'use server'`, `apiFetch`, `revalidatePath`, and the same `UnauthorizedError` / `ApiError` mapping that returns `{ ok, message }` rather than throwing:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError, segment, UnauthorizedError } from '@/lib/api';
import { userMessage } from '@/lib/errors';
import type { CampaignTransferPlan } from '@/lib/types';

export type PreviewResult =
  | { ok: true; plan: CampaignTransferPlan }
  | { ok: false; message: string };

export async function previewCampaignTransfer(
  campaignId: string,
  targetWorkspaceId: string,
): Promise<PreviewResult> { /* GET …/transfer-preview?target=… */ }

export async function moveCampaign(
  campaignId: string,
  targetWorkspaceId: string,
  expectedContactCount: number,
  sourceWorkspaceId: string,
): Promise<{ ok: boolean; message: string }> {
  // POST …/transfer, then revalidate BOTH workspace pages — the campaign left
  // one page and arrived on the other, and a stale source page still listing
  // it is how staff move the same campaign twice.
}
```

**Step 3: Commit**

```bash
git add -A
git commit -m "Add the staff actions behind a campaign transfer"
```

---

### Task 15: The Move dialog

**Files:**
- Create: `app/(console)/workspaces/[id]/move-campaign.tsx`
- Modify: `app/(console)/workspaces/[id]/page.tsx:184-216`

**Step 1: Add a target-workspace picker source**

The dialog needs to search workspaces. `GET /api/admin/workspaces` is paginated and has no search parameter — check `parsePagination` and the listing route before assuming. **If there is no search, add `?q=` to `src/routes/admin/workspaces.routes.ts` in the backend worktree first, with a test in `test/admin-workspaces.test.ts`, and commit it there.** A picker that can only page through every workspace on the platform is not a picker.

**Step 2: Write the dialog**

`'use client'`. Two steps, as `credit-form.tsx` does: pick the target and preview, then confirm.

The preview renders as plain sentences, and two facts must be unmissable because they are what surprises people afterward:

- *"N calls and their billing history stay with &lt;source&gt;."*
- *"The agent and N phone numbers are removed. Someone in &lt;target&gt; must set an agent and a number before this campaign can run."*

Pass the preview's `counts.contacts` straight into `moveCampaign` as `expectedContactCount` — that is the whole point of the drift check, and recomputing it client-side would defeat it.

**Step 3: Wire the table**

In `app/(console)/workspaces/[id]/page.tsx`, add a fourth `<Th>` and a `<Td>` per row rendering `<MoveCampaign campaign={campaign} sourceWorkspaceId={workspace.id} />`. Bump the empty state's `colSpan` from 3 to 4.

**Step 4: Fix the stale empty state**

Its hint reads *"Campaigns are created by the workspace's own members, not from here"*, which stops being true once staff can move one in:

```tsx
                  hint="Campaigns are created by the workspace's own members. Staff can move one in from another workspace."
```

**Step 5: Verify by hand**

Backend worktree running. Move a campaign with contacts in both states — some the target already holds, some it does not. Confirm the source page no longer lists it, the target page does, its status is PAUSED with the halt reason, and the call history still reads source.

**Step 6: Commit**

```bash
npx tsc --noEmit && npm run lint
git add -A
git commit -m "Let staff move a campaign from the workspace it is listed on"
```

---

# Part 5 — Finishing

### Task 16: Cross-repo check

**Step 1: Backend suite, several times**

Run: `npm test` — at least twice fully green before you believe it.

**Step 2: Both frontends**

Run in each: `npx tsc --noEmit && npm run lint && npm run build`

**Step 3: The lockfiles**

```bash
git status --short | grep package-lock.json
```

Expected: nothing. If a lockfile moved, `git checkout package-lock.json` — a macOS `npm install` prunes Linux optional deps and breaks CI's `npm ci`.

**Step 4: Update the design doc's status**

`docs/plans/2026-09-11-workspace-delete-and-campaign-transfer-design.md`, line 4: `Status: designed, not built` → `Status: built — <date>`.

---

### Task 17: The PRs

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch.

Order matters, and the backend goes first: **merging backend `main` is a production deploy on Render.** A dashboard or console build that ships ahead of its routes gets 404s from a page that looks finished.

1. Backend PR. Merge, wait for the Render deploy to come up green.
2. Dashboard PR and admin PR, in either order.

The merge command is classifier-blocked from this session — hand the `gh pr merge` line to the operator to run with `!`, and pass `--repo` since the worktrees are not the default checkout.

---

# Review notes for whoever executes this

Things a green suite will not catch, drawn from what has bitten this codebase before:

- **The isolation sweep can pass vacuously.** Task 3's first case exists only to prove the stack walk found routes. If you change the walk, keep that guard.
- **A fixture can encode a state the product cannot produce.** Task 9's journey-state case sets `armKind: 'CALLBACK'` with a `callbackAt` — a real pairing. Do not write a fixture with a `callbackAt` and `armKind: 'FRESH'` to make an assertion easier; it tests a row the dialer never writes.
- **`expectedContactCount` must come from the preview the operator saw.** If the dialog ever recomputes it, the drift check is decorative.
- **The contact remap's reuse case is the one that matters.** A merge that overwrites a target contact's name is invisible until a customer notices their own data changed. Task 9 asserts name, tags and metadata are all untouched — keep all three.
- **`tsc` does not prove a Prisma change landed.** After Task 1, confirm `deletedAt` actually exists in the test DB (`npm run test:prepare`), not merely in the schema file.
