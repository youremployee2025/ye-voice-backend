# Super admin — design

A staff person who signs into the customer dashboard with their own Clerk
account and can open **any workspace on the platform with everything its owner
can do**, without being a member of it.

Today there is no such thing. Customer identity is Clerk → `Account` →
`WorkspaceMember` → role, and every workspace-scoped route resolves the
caller through one function, `requireMembership`
(`src/middleware/workspace.ts`). The staff console is a different system
entirely: a shared `X-Admin-Token`, no Clerk, read-only over `/api/admin/*`.
The two never meet, so a staff member who needs to see what a customer sees,
or fix something in place, has no way in short of being invited.

Decisions taken in the brainstorm (2026-09-16), not to re-litigate:

- **Grant** is a column on `Account`, set only through the staff console.
  Not an env allow-list (a change is a Render deploy, no audit), not Clerk
  metadata (outside the DB, hard to test and query).
- **Navigation** is a searchable picker grouped by account, over a new
  paginated endpoint. `/api/me` stays small; ordinary users see nothing new.
- **Audit** is a table of every write a super admin makes inside a workspace
  they are not a member of, shown read-only in the staff console.

## 1. Data model

```prisma
model Account {
  // ...
  isSuperAdmin     Boolean @default(false)
  superAdminActions SuperAdminAction[]
}

/// One row per mutating request a super admin made through the bypass, plus
/// one per grant/revoke. Reads are not recorded; own-membership writes are not
/// recorded (those are ordinary use).
model SuperAdminAction {
  id          String    @id @default(cuid())
  accountId   String
  account     Account   @relation(fields: [accountId], references: [id], onDelete: Cascade)
  workspaceId String?
  workspace   Workspace? @relation(fields: [workspaceId], references: [id], onDelete: SetNull)
  method      String    // GET never appears; PATCH | POST | PUT | DELETE, or GRANT | REVOKE
  path        String    // req.originalUrl, query string stripped
  status      Int       // response status; a 4xx is still an attempt worth seeing
  createdAt   DateTime  @default(now())

  @@index([accountId, createdAt])
  @@index([workspaceId, createdAt])
  @@index([createdAt])
}
```

No new role. `WorkspaceRole` stays `{ ADMIN, MEMBER }`. A super admin is not a
kind of member; they are an account the middleware treats as owner-equivalent
in every workspace.

The migration adds one column with a default and one empty table. It needs no
manual production SQL and no backfill.

## 2. Backend: the bypass

### `requireMembership`

One new branch. Membership is looked up exactly as today. If there is no row
**and** the account has `isSuperAdmin`, the workspace is loaded directly:

```
member found            → today's path, unchanged (own membership wins)
no member, not super    → 403 FORBIDDEN (unchanged, the no-leak rule)
no member, super admin  → load workspace by id
   missing or deletedAt → 404 NOT_FOUND
   found                → req.workspace = it; req.role = 'ADMIN'; req.superAdmin = true
```

The 404 on the super admin path is deliberate and does not weaken the no-leak
rule: that rule protects workspace ids from customers, and this caller is
staff. A soft-deleted workspace is 404 too — staff recovery is DB-level, by
the delete design, and the dashboard has no page for a dead workspace.

`minimumRole === 'ADMIN'` passes because `req.role` is `ADMIN`.

### `requireOwner`

`workspace.ownerAccountId !== account.id && !req.superAdmin` → 403. This is
what makes "everything the owner has" true: workspace delete, and any future
owner-only route, admit the super admin.

### Inline owner comparisons

`members.routes.ts:94,139` refuse to demote or remove the owner
(`CANNOT_MODIFY_OWNER`). These stay as they are. A super admin acting as
owner-equivalent must still not be able to remove the *real* owner; that
protection is for the customer, not from them.

`serializeMember` (`members.routes.ts:22-27`) and `serializeMembership`
(`serialize.ts:37-50`) compute `isOwner` from `ownerAccountId`. Both gain the
same rule: `isOwner: workspace.ownerAccountId === accountId || superAdmin`,
where the flag is threaded from the request. On every workspace-scoped
response the super admin therefore reads as `role: 'ADMIN', isOwner: true`,
and every existing dashboard gate lights up with no client logic.

Note that `serializeMember` is about *other* members in the list; the super
admin is not in that list at all (no row), so it does not need the flag. Only
`serializeMembership` and `GET /api/workspaces/:id` do.

### Billing follows the workspace, not the caller

DID rental, renewal and call charges all bill `workspace.ownerAccountId`
(`didRental.ts:146`, `dialer.ts:396`, …). Nothing changes there. A super admin
renting a number in a customer's workspace charges the customer, exactly as
the owner would. That is the point of owner parity, and it is why the audit
table records the request.

### Audit write

Done in `requireMembership` on the super admin path only, via a `res.on(
'finish')` hook that writes `{ accountId, workspaceId, method, path, status }`
when `method !== 'GET'`. It is fire-and-forget: a failed audit insert logs an
error line and never fails the customer-facing request. The request has
already been served when the hook runs, so this cannot be "insert first, then
act"; the trade is accepted because an audit outage blocking live campaign
operations is the worse failure.

### Self-protection

- The flag is never writable through any Clerk-authenticated route. Only
  `PATCH /api/admin/accounts/:id/super-admin` (staff token) sets it.
- `accountTransfer` and `onboarding` never touch the column.
- `serializeAccount` exposes `isSuperAdmin` so `/api/me` can tell the
  dashboard; nothing else about the account changes.

## 3. Backend: new routes

### `GET /api/me`

`account.isSuperAdmin` added. `workspaces` unchanged: only real memberships.

### `GET /api/super-admin/workspaces?q=&page=&limit=`

Mounted at `/api/super-admin`, behind `requireAuth` then a new
`requireSuperAdmin` guard that answers **404** for anyone without the flag, so
the route's existence is invisible to customers.

- `q` matches `Workspace.name`, `Workspace.slug`, `Account.name`,
  `Account.email` (`contains`, case-insensitive). Empty `q` lists everything.
- Excludes `deletedAt IS NOT NULL`.
- Ordered by `(account.email, workspace.name, workspace.id)`. Paged with the
  existing offset helper in `src/lib/pagination.ts` (`page`, `limit`, `total`),
  the same as every staff listing — a Prisma `cursor:` would bypass the
  `where`, which is exactly why that helper is offset-only. `limit` is capped
  by the helper; the picker asks for 20.
- Row shape:

```json
{
  "id", "name", "slug", "color", "createdAt",
  "account": { "id", "email", "name" },
  "isMember": false
}
```

`isMember` lets the picker show that this one is already in the normal
switcher.

### `GET /api/workspaces/:id`

New — today only POST, PATCH and DELETE exist on this path. Behind
`requireMembership()`, it returns `serializeMembership(...)`; on the bypass
that is `role: 'ADMIN', isOwner: true`. It is what the dashboard calls after a
jump to hydrate the active workspace, and on reload of a remembered one.

### `PATCH /api/admin/accounts/:id/super-admin`

Body `{ enabled: boolean }`. Staff token. Writes the column and a
`SuperAdminAction` row with `method: 'GRANT' | 'REVOKE'`, `workspaceId: null`,
`path: '/api/admin/accounts/:id/super-admin'`, in one transaction. Idempotent:
enabling an already-enabled account is a 200 and no audit row.

### `GET /api/admin/super-admin-actions?accountId=&workspaceId=&page=&limit=`

Staff token. Newest first, offset-paged like the other staff listings. Joins
account email and workspace name for display.

`GET /api/admin/accounts/:id` and the accounts list gain `isSuperAdmin` so the
console can render the toggle and a badge.

## 4. Dashboard

Three files change; no page does.

### `components/workspace-provider.tsx`

- `Me.account.isSuperAdmin` added to `lib/types.ts`.
- `switchWorkspace(id)` keeps its membership guard for ordinary accounts. For
  a super admin, an id outside `me.workspaces` triggers
  `GET /api/workspaces/:id`; on 200 the result is held in a new
  `visiting: Workspace | null` state and becomes `activeWorkspace`. On 404 it
  is ignored and an error toast shows.
- `activeWorkspace` resolution: `workspaces.find(activeId) ?? visiting`.
- The remembered-workspace key already stores an id; on reload, if the id is
  not in `me.workspaces` and the account is a super admin, the provider
  re-fetches it. Ordinary accounts fall through to `workspaces[0]` as today.
- `isVisiting: boolean` exposed on the context = active workspace is not in
  `me.workspaces`.

### `components/shell/workspace-switcher.tsx`

For super admins only, one extra row at the bottom of the switch submenu:
**"All accounts…"** opening `SuperAdminPicker`, a search palette:

- Debounced input (250 ms) → `GET /api/super-admin/workspaces?q=`.
- Results rendered as `account email` heading → workspace rows beneath, in
  the API's order. Rows already in `me.workspaces` show "member".
- Enter/click → `switchWorkspace(id)` → close.
- A footer line "Showing N of M" when the page is not everything; narrowing the search is how to reach the rest.

Digit shortcuts stay bound to the ordinary list only.

### `components/shell/visiting-banner.tsx`

Rendered in the shell above the page content whenever `isVisiting`:

> Viewing **Acme Dental** as super admin. Owner: owner@acme.com.
> Every change you make here is recorded. [Back to my workspaces]

"Back" switches to the first own workspace (or `/onboarding` if none, which
the provider already handles).

Nothing else changes. The sidebar, page gates and settings pages all read
`activeWorkspace.role` / `isOwner`, which the backend reports as
owner-equivalent.

## 5. Staff console

### Account detail page

Under the existing tiers/credits sections, a **Super admin** section:

- Off: "This account has the same access as any customer." + **Grant super
  admin** button.
- On: badge, "Granted <date>", + **Revoke** button.

Grant opens `ConfirmDialog` with the consequence stated first:

> This account will be able to open **every workspace on the platform** with
> the same rights as its owner — including renting numbers, running campaigns
> and deleting workspaces — without being invited. Every write is recorded
> under Super admin activity.

`confirmWord` is the account's email. Revoke confirms without a word. Both are
server actions calling the PATCH route, then `revalidatePath`.

The accounts list shows a small "super admin" pill on flagged rows.

### `/super-admin-activity`

New sidebar entry under the operations group. A table: when, who (email),
what (`method path`), where (workspace name → link to `/workspaces/[id]`),
status. Filters: account, workspace. Uses `Pagination`, `Toolbar`,
`SearchField` from `components/ui`. Read-only.

## 6. Error handling

| Situation | Response |
|---|---|
| Super admin opens a missing or deleted workspace | 404 `NOT_FOUND` |
| Non-super-admin calls `/api/super-admin/*` | 404 `NOT_FOUND` |
| Bad page / limit on either list | 400 `VALIDATION_ERROR` |
| Audit insert fails | request succeeds; `logger.error` with account, path |
| Super admin tries to remove/demote the real owner | 400 `CANNOT_MODIFY_OWNER` (unchanged) |
| Grant on unknown account | 404 |
| Dashboard reload with a remembered id that is now 404 | falls back to own first workspace |

## 7. Testing

**Backend** — `test/super-admin.test.ts`, using `makeAccount` / `makeWorkspace`
helpers and a new `makeSuperAdmin(handle)`:

- read route (`GET /api/workspaces/:id`) → 200, `role ADMIN`, `isOwner true`
- ADMIN-gated write (e.g. rename) → 200
- owner-gated route (`DELETE /api/workspaces/:id`) → 200
- missing workspace → 404; soft-deleted → 404
- non-super-admin non-member → still 403 (regression)
- audit row written for a write, not for a read, not for a write in an own
  workspace; carries `status`
- audit insert failure (mocked) → request still 200
- cannot demote the real owner → 409
- `GET /api/super-admin/workspaces`: 404 for ordinary account; search by each
  of the four fields; excludes deleted; paging; bad limit 400
- `PATCH /api/admin/accounts/:id/super-admin`: sets flag, writes GRANT row,
  idempotent, refuses without staff token
- `GET /api/admin/super-admin-actions`: order, filters
- `test/isolation-hardening.test.ts` and `test/analytics-isolation.test.ts`
  must pass **untouched**. That is the proof no ordinary caller gained access.

**Dashboard** — mocked `useWorkspace` pattern from
`test/sidebar-billing-gate.test.tsx`:

- switcher shows "All accounts…" only when `isSuperAdmin`
- picker calls the endpoint with the query and renders grouped rows
- banner renders only when `isVisiting`, names the workspace and owner
- provider: super admin `switchWorkspace` to a foreign id fetches and
  activates it; ordinary account is ignored

**Admin console** — toggle section renders the right state, grant requires
the email confirm word, activity page renders rows and filters.

## 8. Rollout

Three PRs, in order:

1. **backend** `feat/super-admin` — migration, middleware, routes, tests.
   Merging is a Render production deploy; the migration is additive and safe
   to run unattended.
2. **dashboard** `feat/super-admin` — inert until the backend deploys
   (`isSuperAdmin` is simply absent → `false`).
3. **admin console** `feat/super-admin` — same.

First grant: the operator flags their own account through the console, signs
into the dashboard, and opens a test workspace. Nothing is granted by the
migration.

## Out of scope

- Impersonating a specific customer *user* (acting as them, with their name on
  the record). The super admin acts as themselves; the audit row says so.
- A hand-off from the staff console into the dashboard. The console has no
  Clerk session to hand over; the super admin signs into the dashboard
  normally.
- Read-only "view as" mode. Owner parity was the ask.
- Recording reads.
