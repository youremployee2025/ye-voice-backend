# In-app notifications Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every workspace a feed of things that have already happened, and the dashboard a bell that says how many of them the reader has not seen — as described in `2026-08-27-notifications-design.md`.

**Architecture:** Two additive Prisma models (`Notification`, `NotificationRead`) hanging off `Workspace` and `Account`; one emitter helper that can never throw into its caller; four routes under the existing `requireAuth` + `requireMembership()` pair, all filtered by a single `visibleScopes(role)` helper; one-line `notify()` calls at event sites that already know they succeeded. On the dashboard, a slim shell top bar holding a polling bell.

**Tech Stack:** Express 4, TypeScript, Prisma, Zod, Vitest + Supertest (backend). Next.js App Router, React 19, Tailwind v4, lucide-react, Vitest + Testing Library (dashboard).

**Test safety (read first):** Backend tests run only against `TEST_DATABASE_URL`. `test/setup.ts` already refuses to run when it is unset or points at a Neon host — **do not touch either guard**. Migrations reach the test DB through `npm run test:prepare`. Never `prisma migrate reset` anything but a local database.

**Ports for manual checks:** backend dev on **3017**, dashboard dev on **3018**.

**Rules that apply to every task:**
- No query reads a notification by id alone. Every one is scoped `{ workspaceId, scope: { in: visibleScopes(role) } }`.
- `notify()` is called only on a success path, never inside a `try` that still returns 2xx.
- Customer-facing strings say "the voice platform", never the supplier's name.

---

## Backend

### Task 1: Schema & migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `test/setup.ts`

**Step 1: Add the enum and models**

Append to `prisma/schema.prisma`:

```prisma
enum NotificationScope {
  ALL_MEMBERS
  ADMINS_ONLY
}

/// Something that already happened inside a workspace. One row per event, not
/// one per recipient: who may see it is a function of current membership,
/// evaluated at read time, so a roster change never has to rewrite history.
model Notification {
  id          String            @id @default(cuid())
  workspaceId String
  /// Who may see this row. Enforced in the `where` clause of every query —
  /// never filtered in the browser, where the data has already been sent.
  scope       NotificationScope
  /// Open-ended by design: new event types land with the module that emits
  /// them, and a Postgres enum would make every one of those a migration and
  /// a merge conflict. Nothing branches on this value; it is an opaque tag.
  type        String
  /// Resolved when the event happened, not when it is read. A campaign
  /// renamed later must not retroactively rewrite the sentence about it.
  title       String
  body        String
  /// In-app path such as `/campaigns/abc`. Never an absolute URL — it is fed
  /// to the router, and a stored URL is an open redirect waiting to happen.
  href        String?
  createdAt   DateTime          @default(now())

  workspace Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  reads     NotificationRead[]

  // Every read is "this workspace, these scopes, newest first".
  @@index([workspaceId, scope, createdAt])
}

/// One person having read one notification. The row's existence *is* the read
/// state, so a new member needs no backfill: having read nothing is an empty
/// set, which is what an absent row already says.
model NotificationRead {
  id             String   @id @default(cuid())
  notificationId String
  accountId      String
  readAt         DateTime @default(now())

  notification Notification @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  account      Account      @relation(fields: [accountId], references: [id], onDelete: Cascade)

  // Makes marking read idempotent at the database rather than in a handler.
  @@unique([notificationId, accountId])
  @@index([accountId])
}
```

Add the back-relations Prisma requires (they emit no SQL):
- `Account`: `notificationReads NotificationRead[]`
- `Workspace`: `notifications Notification[]`

**Step 2: Add the tables to the test reset**

In `test/setup.ts`, `TABLES` is ordered children-first. Add `'NotificationRead'` and `'Notification'` **above** `'Workspace'` and `'Account'`, in that order.

**Step 3: Generate the migration against the LOCAL dev database**

Run: `npx prisma migrate dev --name notifications`
Expected: a new `prisma/migrations/<ts>_notifications/migration.sql`, and `DATABASE_URL` in `.env` still pointing at the local dev Postgres. Confirm that before running.

**Step 4: Apply to the test database and verify the client**

Run: `npm run test:prepare && npx prisma generate && npx tsc --noEmit`
Expected: migrations applied, tsc exits 0.

**Step 5: Commit**

```bash
git add prisma test/setup.ts
git commit -m "Add notification and read-state tables"
```

---

### Task 2: The emitter

**Files:**
- Create: `src/lib/notify.ts`
- Test: `test/notify.test.ts`

**Step 1: Write the failing test**

Cover the three properties that matter:

```ts
it('records a notification', async () => {
  const ws = await makeWorkspace(await makeAccount('alice'), 'A Co');
  await notify(ws.id, 'ALL_MEMBERS', 'campaign.started', 'Title', 'Body', '/campaigns/1');
  const rows = await prisma.notification.findMany({ where: { workspaceId: ws.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ scope: 'ALL_MEMBERS', type: 'campaign.started', href: '/campaigns/1' });
});

it('resolves rather than rejecting when the insert fails', async () => {
  vi.spyOn(prisma.notification, 'create').mockRejectedValue(new Error('db down'));
  await expect(notify('nope', 'ALL_MEMBERS', 't', 'T', 'B')).resolves.toBeUndefined();
});

it('resolves when given a workspace that does not exist', async () => {
  await expect(notify('ws_missing', 'ALL_MEMBERS', 't', 'T', 'B')).resolves.toBeUndefined();
  // and nothing was written
});
```

Run: `npx vitest run test/notify.test.ts` → FAIL, module not found.

**Step 2: Implement**

```ts
import type { NotificationScope } from '@prisma/client';
import { prisma } from './prisma.js';

/** In-flight writes, so tests can wait for one instead of sleeping. */
const inFlight = new Set<Promise<void>>();

/**
 * Records something that has already happened.
 *
 * Fire-and-forget: call sites write `void notify(...)` and do not await. The
 * returned promise **always resolves** — every failure is caught, logged and
 * dropped — because a notification is a side effect of an action that has
 * already succeeded, and letting the bell fail an invite acceptance is never
 * the right trade.
 */
export function notify(
  workspaceId: string,
  scope: NotificationScope,
  type: string,
  title: string,
  body: string,
  href?: string,
): Promise<void> {
  const write = (async () => {
    try {
      await prisma.notification.create({
        data: { workspaceId, scope, type, title, body, href: href ?? null },
      });
    } catch (err) {
      // Deliberately terminal. Nothing upstream can act on this, and
      // rethrowing would put it in the caller's request path.
      console.error(`[notify] could not record ${type} for workspace ${workspaceId}:`, err);
    }
  })();

  inFlight.add(write);
  void write.finally(() => inFlight.delete(write));
  return write;
}

/** Test-only: awaits every write started so far. Production code never calls
 *  this — the whole point of the emitter is that nothing waits for it. */
export async function flushNotifications(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
```

Note the `try` must also cover the *synchronous* construction of the call, which wrapping the whole body in the async IIFE achieves: `notify` itself cannot throw.

**Step 3: Run → PASS. Step 4: Commit**

```bash
git commit -am "Add the notification emitter"
```

---

### Task 3: Scope helper and the list route

**Files:**
- Create: `src/routes/notifications.routes.ts`
- Modify: `src/app.ts`
- Test: `test/notifications.test.ts`

**Step 1: Write the failing tests** — the list, newest first, with read state joined on, and the scope rule:

```ts
it('hides ADMINS_ONLY rows from a MEMBER', async () => { /* … */ });
it('shows both scopes to an ADMIN', async () => { /* … */ });
it('never returns another workspace’s rows', async () => { /* … */ });
it('carries this caller’s read state, not somebody else’s', async () => { /* … */ });
it('pages newest first with a cursor', async () => { /* … */ });
```

**Step 2: Implement**

```ts
const scopeQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * The single place that decides what a role may see. Every query takes its
 * result; there is no second copy to forget to update.
 */
function visibleScopes(role: WorkspaceRole): NotificationScope[] {
  return role === 'ADMIN' ? ['ALL_MEMBERS', 'ADMINS_ONLY'] : ['ALL_MEMBERS'];
}
```

List handler: `findMany({ where: { workspaceId, scope: { in: visibleScopes(role) } }, include: { reads: { where: { accountId } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...cursor })`, then flatten each row to `{ id, type, title, body, href, createdAt, read: row.reads.length > 0, readAt: row.reads[0]?.readAt ?? null }`.

`orderBy` carries `id` as a tiebreaker: two rows written in the same millisecond would otherwise page unstably.

Register in `src/app.ts`: `app.use('/api/workspaces', notificationRoutes);`

**Step 3: Run → PASS. Step 4: Commit.**

---

### Task 4: unread-count

**Files:** same route module; extend `test/notifications.test.ts`.

**Step 1: Failing tests** — counts only unread, only visible scopes, per account.

**Step 2: Implement**

```ts
const count = await prisma.notification.count({
  where: {
    workspaceId: workspace.id,
    scope: { in: visibleScopes(role) },
    reads: { none: { accountId: account.id } },
  },
});
```

No joins, no rows — this is the endpoint that gets polled.

**Step 3: Run → PASS. Step 4: Commit.**

---

### Task 5: mark-read and read-all

**Files:** same route module; extend `test/notifications.test.ts`.

**Step 1: Failing tests**

- marking twice returns `{ marked: n }` then `{ marked: 0 }`, and leaves one row per (notification, account);
- the second call does not move `readAt`;
- a `MEMBER` passing a known `ADMINS_ONLY` id gets `200 { marked: 0 }` and no row is created;
- an id from another workspace is likewise ignored, not 404'd;
- `read-all` marks every visible unread row and is idempotent;
- `read-all` for a `MEMBER` leaves `ADMINS_ONLY` rows unread.

**Step 2: Implement**

```ts
const readSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

// Filtered, not validated one by one: a 404 on an invisible id would confirm
// that the id names something real here, which is what scoping withholds.
const visible = await prisma.notification.findMany({
  where: { id: { in: ids }, workspaceId: workspace.id, scope: { in: visibleScopes(role) } },
  select: { id: true },
});

const { count: marked } = await prisma.notificationRead.createMany({
  data: visible.map((n) => ({ notificationId: n.id, accountId: account.id })),
  skipDuplicates: true, // idempotency, at the unique index rather than in a handler
});
```

`read-all` is the same insert over `where: { …, reads: { none: { accountId } } }`.

**Step 3: Run → PASS. Step 4: Commit.**

---

### Task 6: Wire the emitters

**Files:**
- Modify: `src/routes/invites.routes.ts`, `src/routes/members.routes.ts`, `src/routes/campaigns.routes.ts`
- Test: `test/notification-emitters.test.ts`

**Step 1: Failing tests.** For each event: perform the action over HTTP, `await flushNotifications()`, assert one row with the right scope, type and href. Plus the load-bearing one:

```ts
it('does not fail the action when the notification cannot be written', async () => {
  vi.spyOn(prisma.notification, 'create').mockRejectedValue(new Error('db down'));
  const res = await request(app).post(`/api/invites/${invite.id}/accept`).set(...as('bob', 'bob@ezo.test'));
  expect(res.status).toBe(200);
  await expect(prisma.workspaceMember.findFirst({ where: { accountId: bob.id } })).resolves.not.toBeNull();
});
```

**Step 2: Add one line per site, after the success.**

| Site | Scope | Type | Sentence |
|---|:--:|---|---|
| invite accept | `ADMINS_ONLY` | `invite.accepted` | "{email} joined the workspace" |
| invite decline | `ADMINS_ONLY` | `invite.declined` | "{email} declined the invitation" |
| role change | `ADMINS_ONLY` | `member.role_changed` | "{email} is now an admin / a member" |
| member delete (`isSelf`) | `ADMINS_ONLY` | `member.left` | "{email} left the workspace" |
| member delete (removed) | `ADMINS_ONLY` | `member.removed` | "{email} was removed from the workspace" |
| campaign transition | `ALL_MEMBERS` | `campaign.{action}ed` | "{name} was started / paused / resumed / stopped", href `/campaigns/{id}` |

The campaign loop already iterates `TRANSITIONS`, so this is one `void notify(...)` after `prisma.campaign.update`, using the action name — not four copies.

Member routes have `isSelf` in scope already; use it rather than recomputing.

**Step 3: Run → PASS. Step 4: Commit.**

---

### Task 7: Docs

Update `CLAUDE.md` with a Notifications section: the two tables, the scope rule, the four routes, the emitter contract, and the list of events not yet wired because their modules have not merged. Commit.

---

## Dashboard

### Task 8: Types and the bell's data layer

**Files:**
- Modify: `lib/types.ts`
- Create: `components/shell/notification-bell.tsx`

Types: `NotificationScope`, `AppNotification` (`id, type, title, body, href: string | null, createdAt, read, readAt`), `NotificationPage` (`{ notifications, nextCursor }`), `UnreadCount` (`{ count }`).

Named `AppNotification` because `Notification` is a DOM global — shadowing it in a file that may one day touch the Web Notifications API is a trap.

### Task 9: The bell

**Files:** `components/shell/notification-bell.tsx`, `app/(dash)/layout.tsx`

Behaviour, in the order it matters:

1. **Active workspace only.** Read `activeWorkspace?.id`. Hold it in a ref updated every render and check it after every await — the agents page's `isCurrent()` pattern, and for the same reason: switching workspaces does not unmount this component. Reset count, list, error and open state whenever the id changes.
2. **Poll the count.** `POLL_INTERVAL_MS = 60_000`, a named constant with the reasoning beside it. Skip the tick while `document.hidden`; refetch immediately on `visibilitychange` back to visible.
3. **Badge fails closed.** On a count error, render **no** badge — never `0`. `0` claims "nothing new", which a failed request cannot know.
4. **Dropdown fetches the list on open**, with its own loading and error states. Empty ("No notifications yet") and failed ("Could not load notifications" + retry) are different messages.
5. **A row** shows title, body, `relativeTime(createdAt)` (already in `lib/format.ts`), and an unread dot that is a shape, not a colour. Clicking marks read optimistically, rolls back on failure, then routes to `href` if present.
6. **Mark all as read** in the dropdown header, hidden when nothing is unread.
7. Click-away and Escape close, `aria-haspopup="menu"` / `aria-expanded`, matching `workspace-switcher.tsx`.

Layout: a slim top bar in `(dash)/layout.tsx` above `<main>`, holding the bell alone.

### Task 10: The workspace-switch test

**Files:** `test/notification-bell.test.tsx`

In the style of `test/agents-stale-guard.test.tsx`: a count request for workspace A resolving *after* a switch to B must not paint A's badge under B, and the bell must show B's own count once it arrives.

### Task 11: Docs

Update the dashboard `CLAUDE.md` — the shell top bar, the bell, polling interval and the fail-closed badge rule. Commit.

---

## Gates

Backend: `npx tsc --noEmit` clean, `npm test` green.
Dashboard: `npx tsc --noEmit` clean, `npm run build` succeeds, `npm test` green.

Before opening either PR: `git fetch origin && git merge origin/main`, keeping **both** sides' additions where a concurrent slice touched the same file (`app.ts` route registration, `test/setup.ts` table list, `CLAUDE.md` sections, `lib/types.ts`), then re-run every gate above.

Then `gh pr create --base main` in each repo. Do not merge.
