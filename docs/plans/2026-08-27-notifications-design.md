# In-app notifications — Design

Date: 2026-08-27. Scope: workspace-scoped in-app notifications across `ye-voice-backend` and `ye-voice-dashboard`.

## What this slice is

Something happens inside a workspace — somebody accepts an invite, a role changes, a campaign starts — and the people who ought to know about it currently find out by looking. This slice gives a workspace a feed of those events and a bell that says how many of them the reader has not seen yet.

A notification is a **fact that already happened**, recorded after the fact. It is not a task, not an approval, not a retry hook, and never a step in the action that produced it. That framing decides most of what follows.

Explicitly out of scope, and deliberately absent from the schema: email or SMS delivery, per-account notification preferences, digests, mute rules, grouping/threading, per-recipient fan-out rows, websockets or SSE, and notifications about anything the platform does not already record as having succeeded.

## The two tables

```prisma
enum NotificationScope { ALL_MEMBERS ADMINS_ONLY }

Notification      id, workspaceId, scope, type, title, body, href?, createdAt
                  @@index([workspaceId, scope, createdAt])

NotificationRead  id, notificationId, accountId, readAt
                  @@unique([notificationId, accountId]) @@index([accountId])
```

Decisions worth stating:

- **One row per notification, not one per recipient.** The event happened once, in one workspace, and the text is identical for everyone who can see it. Fanning out a row per member would multiply writes by the size of the workspace, and — worse — would have to be re-run whenever somebody joins, leaves, or changes role, which means the feed's contents would depend on the order those things happened in. A single row plus a scope keeps "who can see this" a *function of current membership*, evaluated at read time, which is the only version that stays correct as the roster moves.

- **Read state is per person, so it lives in its own table.** `NotificationRead` is a join row that exists only once somebody has read something. Absence means unread. There is no `read: false` row to create up front and no backfill when a member joins — the natural state of a new member is "has read nothing", and that is what an empty join table already says.

- **`readAt` is a column, not a flag.** It costs nothing over a boolean and answers "when did they see this", which is the question anyone debugging a complaint about the bell actually has.

- **`type` is an open-ended `String`, not an enum.** Every new event would otherwise need a migration in lockstep with the code that emits it, and the modules that will emit them are landing on separate branches right now. A Postgres enum would turn each of those into a merge conflict on a single shared type. The column is read as an opaque tag — nothing in this slice branches on its value — so an unrecognised one degrades to "a notification", not to an error. The cost is that a typo'd type is not caught by the database; the mitigation is that a typo'd type still renders correctly, because `title` and `body` carry the meaning.

- **`title` and `body` are stored text, resolved at emit time.** The alternative — storing a type plus a payload and rendering the sentence when it is read — sounds tidier and is wrong for a record of the past: a campaign renamed after the fact would retroactively rewrite the notification that announced its old name, and a deleted campaign would leave a notification that cannot render at all. The sentence is frozen when the event happens because that is when it was true.

- **`href` is an in-app path (`/campaigns/abc`), never an absolute URL.** It is fed to the router. A stored absolute URL is an open-redirect waiting for the first emitter that builds one from user input. It is nullable because some events have nowhere useful to go. `notify()` **enforces** this rather than asserting it: anything that is not a single-slash-relative path is dropped (and logged) instead of stored — protocol-relative `//host` and backslash `/\host` forms included, since both navigate off-site despite the leading slash. Dropped, not thrown, because the emitter's one hard promise is that it never fails the action that triggered it.

- **`Notification` cascades from `Workspace`; `NotificationRead` cascades from both `Notification` and `Account`.** Deleting a workspace takes its feed with it. A removed account's read rows go too — they mean nothing without the person.

- **The index is `(workspaceId, scope, createdAt)`.** Every read is "this workspace, these scopes, newest first", which is exactly that prefix.

## Scope is an access rule, not a UI hint

`ADMINS_ONLY` rows must be **invisible** to a `MEMBER` — absent from the list, uncounted in the badge, and unreachable by id. The distinction matters because the obvious implementation (fetch everything, hide some in the browser) is the one that leaks: the rows are in the JSON either way.

So the scope filter lives in the `where` clause of every query, derived from the role the membership middleware already resolved:

```ts
const visibleScopes = role === 'ADMIN'
  ? ['ALL_MEMBERS', 'ADMINS_ONLY']
  : ['ALL_MEMBERS'];
```

There is exactly one place that computes this (`visibleScopes(role)`) and every query takes it, so there is no second copy for somebody to forget to update. The owner needs no special case: the owner holds an `ADMIN` `WorkspaceMember` row, which is what the middleware reads.

Two failures, two answers, matching the rest of the codebase:

| Request | Result | Why |
|---|---|---|
| Caller is not a member of `:workspaceId` | `403 FORBIDDEN` | `requireMembership` answers this. A 404 would let an outsider probe which workspace ids exist. |
| Caller is a `MEMBER` marking an `ADMINS_ONLY` id read | **silently ignored**, `200` | See below. |

The mark-read endpoint takes a list of ids, and the ids are **filtered to what the caller can see** rather than validated one by one. A 404 on an invisible id would confirm that the id names something real in this workspace, which is the fact scoping exists to withhold; a 400 would do the same. Filtering also makes the endpoint honest about what it is: a request to move read state forward, whose result is "your read state is now at least this far", not "each of these ids was valid". The response reports how many rows it actually marked, so a caller that cares can notice the difference.

### What a new member sees

A member who joins an old workspace sees the whole `ALL_MEMBERS` history as unread, because visibility is evaluated from current membership and nothing records when they joined. That is a deliberate consequence of one-row-per-notification, not an oversight, and it is worth knowing before the first busy workspace hits it. Clamping the feed to `WorkspaceMember.createdAt` is a one-line `where` addition on a column that already exists — it is left out here because it is a product decision (does a new admin want the backlog or not?) that nobody has made, and guessing it into the schema is harder to reverse than adding it later.

## Emitting

```ts
notify(workspaceId, scope, type, title, body, href?): Promise<void>
```

One function, in `src/lib/notify.ts`. Three properties, in order of importance:

1. **It never throws into the caller.** Every failure — a dead connection, a constraint violation, a bug in the emitter itself — is caught, logged, and dropped. A notification is a side effect of an action that has *already succeeded*; letting it fail that action would mean an invite acceptance rolls back because the bell could not be updated. That trade is never worth making, and the only way to be sure is for the failure path to be unreachable from the caller's stack.

2. **It is fire-and-forget.** Call sites write `void notify(...)` and do not await. The returned promise resolves — never rejects — and exists so tests can wait for the write instead of sleeping.

3. **It is called only where the event is already known to have happened.** After the transaction, after the update, on the success path, never inside a `try` whose `catch` still returns 2xx. A notification that says a role changed when it did not is worse than no notification.

Because nothing awaits it, the row can land microseconds after the response. `flushNotifications()` — a test-only seam that awaits the in-flight set — makes route tests deterministic without making production code synchronous. It is exported from the same module and documented as such.

## Emitters wired in this slice

Only events that exist on `main` today, each one line at a site that already knows it succeeded:

| Event | Scope | Site |
|---|:--:|---|
| Invite accepted | `ADMINS_ONLY` | `invites.routes.ts` — after the accept transaction |
| Invite declined | `ADMINS_ONLY` | `invites.routes.ts` — after the decline transaction |
| Member role changed | `ADMINS_ONLY` | `members.routes.ts` — after the update |
| Member removed / left | `ADMINS_ONLY` | `members.routes.ts` — after the delete |
| Campaign started / paused / resumed / stopped | `ALL_MEMBERS` | `campaigns.routes.ts` — in the transition loop, after the status update |

Notes on the choices:

- **Member changes are `ADMINS_ONLY`** because who joined, who left and who was promoted is roster management. A `MEMBER` gains nothing operational from it and the workspace gains a small privacy win.
- **Campaign lifecycle is `ALL_MEMBERS`** because a `MEMBER` can use campaigns, and "why is this campaign not dialling" is exactly the question the feed should answer for them.
- **Removal and leaving share a site but not a sentence.** The `DELETE` route serves both — an admin removing somebody and a member leaving on their own — and reporting "X was removed" when X walked out is wrong. The emitter reads `isSelf`, which the handler has already computed.
- **`resume` is included** alongside start/pause/stop. It is not a new event: it is the fourth arm of the same lifecycle loop, and a feed that shows "paused" but never "resumed" narrates a campaign that is still stopped when it is running. Omitting it would be the invention, not including it.

Deliberately **not** emitted, because the modules are not on `main`: DID renewal charged and DID released for non-payment (the phone-numbers slice). Both are `ADMINS_ONLY`/`ALL_MEMBERS` respectively per the brief and are one `notify()` line each when that branch merges. Nothing here is stubbed for them — a stub for an event that cannot fire is dead code that reads as coverage.

## API

All four routes sit under the existing `requireAuth` + `requireMembership()` pair. Any member may call all of them; scope does the rest.

| Route | Notes |
|---|---|
| `GET /api/workspaces/:id/notifications` | Cursor paginated, newest first. Each row carries `read: boolean` and `readAt`. |
| `POST /api/workspaces/:id/notifications/read` | `{ ids: string[] }`. Idempotent. Returns `{ marked }`. |
| `POST /api/workspaces/:id/notifications/read-all` | Marks every currently-visible unread row. Returns `{ marked }`. |
| `GET /api/workspaces/:id/notifications/unread-count` | `{ count }`. |

- **Pagination is a cursor**, but *not* Prisma's `cursor` option. Prisma resolves that with an unfiltered subquery — `SELECT "createdAt" FROM "Notification" WHERE id = $1`, with no `workspaceId` and no `scope` — so a cursor naming an `ADMINS_ONLY` row, a row in another workspace, or no row at all still steers the query. That is an existence-and-ordering oracle for rows the caller may not see, which is precisely what the mark-read endpoint refuses to give them; and because `skip: 1` is unconditional, an out-of-set cursor silently drops a row the caller never saw. So the cursor is resolved through the same `where` as the page itself, an unresolvable one is a `400`, and the page is keyset by hand on `(createdAt, id)`. `?cursor=` empty means page one, because a client writing `&cursor=${nextCursor ?? ''}` is reporting that it has no cursor. Offsets are still wrong for a feed being appended to while you page it.

  The campaign-contacts route (`campaigns.routes.ts`) still uses the raw Prisma `cursor` and has the same oracle. Scope is not a security boundary there — the query is already pinned to one `campaignId` — so it is left alone in this slice and noted rather than fixed silently.
- **Read state joins in, it is not a second round trip.** The list includes `reads: { where: { accountId } }` and flattens it to a boolean, so the client never has to reconcile two lists.
- **Idempotency is `createMany({ skipDuplicates: true })` against the `(notificationId, accountId)` unique.** Marking the same id twice is a no-op at the database, not a checked-then-inserted race. `marked` is the count the database reports actually inserting, so the second call honestly returns 0.
- **`unread-count` is a `count` with a `reads: { none: { accountId } }` filter** — a `NOT EXISTS` against the unique index. It is the one endpoint that gets polled, so it does no joins and returns no rows.

### What this slice does not bound

Two costs are linear in the age of a workspace and neither is capped:

- `read-all` marks every visible unread row. It is one `INSERT … SELECT … ON CONFLICT DO NOTHING`, so nothing is materialised in Node, but the database still does work proportional to the caller's unread count (~610 ms at 30 000 rows, almost all of it foreign-key triggers and index maintenance — the two-statement version measured the same, so this is a memory and round-trip win, not a speed one). Any member may call it repeatedly.
- `unread-count` scans a table with no retention policy, once a minute per open tab.

Bounding either properly means a retention window on `Notification` or a per-member read watermark. Both are product decisions that have not been made, and guessing one into the schema is harder to reverse than adding it later — the same reasoning as the joined-at clamp above. Stated here rather than discovered by the first workspace that gets busy.

Nothing rate-limits these routes either: `createRateLimiter` is mounted on `/api/admin` only, which is true of every customer route in the codebase. That is a pre-existing gap, not one this slice introduces — but `unread-count` is the first endpoint *designed* for unattended polling, which is the point at which it starts to matter.
- **`/notifications/unread-count` and `/notifications/read-all` are literal paths**, and no `/notifications/:id` route exists, so there is no ordering hazard of the kind that made `/agents/sync` have to be registered first. Should a detail route ever be added, it goes last.

## Dashboard

A bell in the app shell, on every page.

The shell currently has no header — `(dash)/layout.tsx` is a sidebar plus `<main>`, and each page draws its own title block. So this slice adds a slim top bar that holds the bell and nothing else. It does not take over page titles; those stay where they are.

**The bell reflects the active workspace only.** This is the requirement most likely to be quietly broken, because switching workspaces does not navigate — the component is never unmounted, so state left behind from the previous workspace stays on screen and a request in flight for it can resolve afterwards and paint over the new one. Both are handled the same way the agents surface handles them: every piece of state (count, list, error) is reset when `activeWorkspace.id` changes, and every response is discarded unless the workspace it was requested for is still the one on screen. This is the behaviour the dashboard test covers, because it is the one manual QA cannot reliably reach.

- **Polling, not websockets.** A `GET` returning `{ count }` every 60 seconds. The interval is a named constant with the reasoning next to it. Polling pauses while the tab is hidden (`document.visibilitychange`) and refetches immediately on return, so a backgrounded tab costs nothing and a foregrounded one is never a minute stale.
- **The badge fails closed.** If the count request fails, the badge is **removed**, not shown as `0` — `0` is a claim ("nothing new") that a failed request has no standing to make. The dropdown says the count could not be loaded and offers a retry.
- **An empty feed and a failed feed never share a message.** "No notifications yet" is a fact about the workspace; "Could not load notifications" is a fact about the request. Conflating them tells a reader nothing happened when something may have.
- **A row shows title, body, relative time, and an unread dot.** Clicking it marks it read and, if it has an `href`, routes there. Read state updates optimistically and rolls back if the request fails — a dot that vanishes on a failed write would lie.
- **Unread is not conveyed by colour alone.** The dot is a shape, and the row carries `aria-label` text naming its state.
- **Mark all as read** sits in the dropdown header and is hidden — not disabled — when there is nothing unread, matching the repo's stance that a greyed control promises a capability.

## Prod database

The two tables are a single additive migration: two `CREATE TABLE`s, one `CREATE TYPE`, the indexes, and the foreign keys. Nothing existing is altered — no column added to `Workspace` or `Account`, no data rewritten — so it is safe to apply to a live database, and equally safe to leave unapplied while the code that reads it is not yet deployed.

The SQL is generated against the local dev database and reviewed before it goes anywhere else. **It is not applied to production in this slice.**

## Test plan

Backend, against `TEST_DATABASE_URL` only (the Neon guard in `test/setup.ts` stays exactly as it is; `truncateAll` gains the two new tables, children first):

1. **Scope visibility.** A `MEMBER` listing a workspace holding both scopes sees only `ALL_MEMBERS` rows; their unread count excludes `ADMINS_ONLY`; and marking an `ADMINS_ONLY` id by id succeeds with `marked: 0` and creates no read row — the id is not actionable even when it is known. An `ADMIN` in the same workspace sees both.
2. **Read-state idempotency.** Marking the same ids twice returns `marked: n` then `marked: 0`, leaves exactly one `NotificationRead` row per pair, and does not move `readAt`. `read-all` twice behaves the same. Read state is per account: A reading does not mark B's.
3. **A failing emitter never fails its caller.** With `notification.create` forced to reject, accepting an invite still returns 200 and still creates the membership row; the emitter's own promise resolves rather than rejecting; and nothing reaches an unhandled rejection handler.
4. Isolation: notifications from another workspace never appear, and the list is scoped by `workspaceId` in the query, not filtered afterwards.

Dashboard: the workspace-switch guard on the bell — a count request for workspace A resolving after a switch to B must not paint A's badge under B — in the style of the existing stale-guard test.
