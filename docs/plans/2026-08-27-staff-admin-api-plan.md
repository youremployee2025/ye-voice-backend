# Staff Admin API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the account, workspace, credit and overview endpoints the YE staff console needs to `/api/admin/*`, as described in `2026-08-27-staff-admin-api-design.md`.

**Architecture:** One new Prisma model (`CreditTransaction`) and a credits library, then three route modules — accounts, workspaces, overview — mounted on the existing `/api/admin` chain behind `requireStaffToken`. Every list is offset-paginated through one shared helper; every count comes from the database, never from `.length` on a loaded relation. One write exists: a credit adjustment, transactional, never negative.

**Tech Stack:** Express 4, TypeScript, Prisma, Zod. Vitest + Supertest.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`; `test/setup.ts` refuses a Neon host. Migrations reach the test DB through `npm run test:prepare` — never `prisma migrate reset`, and never `migrate dev` against `DATABASE_URL` without showing the SQL first.

**Applies to every task:** staff routes return the standard envelope, mount under `/api/admin`, and each new router calls `requireStaffToken` itself so a mounting mistake cannot open a hole.

---

### Task 1: Credits library

**Files:** Create `src/lib/credits.ts`, `test/credits.test.ts`

Display credits are decimal strings; internal units are BigInt at 10000x. `toInternalCredits` parses a non-negative decimal (≤4 places, in `int8` range, no exponent/sign/separators) and throws otherwise; `toDisplayCredits` formats with the sign handled outside the digits. A separate `parseSignedCredits` accepts a leading `-` for the adjustment route.

Tests: round-trips, `"0.07"` does not lose precision, 5 decimal places rejected, out-of-range rejected, `-0.0001` formats as `-0.0001`, `"1e3"`/`"+1"`/`" "` rejected.

Commit: `feat: add the credit unit library`.

### Task 2: CreditTransaction schema & migration

**Files:** Modify `prisma/schema.prisma`, `test/setup.ts`; create `prisma/migrations/*/migration.sql`

Add `enum CreditTransactionType { DID_PURCHASE DID_RENEWAL DID_RELEASE DID_RELEASE_NONPAYMENT ADJUSTMENT }` — the full set the phone-numbers branch defines, so a merge is additive rather than a rename — and `model CreditTransaction` with `id, accountId, amount BigInt, type, reference String?, note String?, createdAt`, relation `onDelete: Restrict`, indexes `[accountId, createdAt]` and `[type, createdAt]`. Add `creditTransactions CreditTransaction[]` to `Account`. Add `'CreditTransaction'` to the head of `TABLES` in `test/setup.ts`.

Generate the migration with `prisma migrate dev --create-only` against the **local dev** DB, show the SQL, apply to the test DB with `npm run test:prepare`.

Commit: `feat: add the credit transaction ledger`.

### Task 3: Pagination helper

**Files:** Create `src/lib/pagination.ts`, `test/pagination.test.ts`

`parsePagination(query)` → `{ page, limit, skip, take }` from `?page=`/`?limit=`, defaults 1/25, limit capped at 100, non-integers and values < 1 rejected as `VALIDATION_ERROR` (a silently-ignored bad page returns the wrong rows). `paginated(items, total, page, limit)` builds the response shape.

Commit: `feat: add offset pagination for staff listings`.

### Task 4: Staff serializers

**Files:** Modify `src/lib/serialize.ts`; covered by the route tests

`serializeAccountForStaff` (adds `clerk_user_id`, `credits` as display string, counts), `serializeWorkspaceForStaff`, `serializeMemberForStaff`, `serializeLedgerRow`. Credits are display strings everywhere.

Commit: `feat: serialize accounts, workspaces and ledger rows for staff`.

### Task 5: Accounts list & detail

**Files:** Create `src/routes/admin/accounts.routes.ts`, `test/admin-accounts.test.ts`; modify `src/app.ts`

`GET /accounts` — page of accounts ordered `createdAt desc`, `?search=` matching email or name `contains`, mode insensitive; each row carries `_count.ownedWorkspaces` and `_count.memberships`. `GET /accounts/:id` — owned workspaces, memberships with role and workspace, balance, and the 20 most recent ledger rows. Unknown id → 404.

Tests first: unauthenticated → 401 for both; a page of 3 with `limit=2` reports `total: 3`; search matches a fragment of an email and excludes non-matches; detail lists owned and joined workspaces separately; unknown id 404s.

Commit: `feat: add staff account listing and detail`.

### Task 6: Credit adjustment

**Files:** Modify `src/routes/admin/accounts.routes.ts`, `src/lib/errors.ts`; extend `test/admin-accounts.test.ts`

`POST /accounts/:id/credits` with `{ amount: signed decimal string, note: non-empty, reference?: string }`. One `prisma.$transaction`: read the account `FOR UPDATE`-equivalent (re-read inside the transaction), reject a deduction below zero with 422 `INSUFFICIENT_CREDITS`, then `update` the balance and `create` the ledger row. Responds with the new balance and the row.

Add `'INSUFFICIENT_CREDITS'` to `ErrorCode`.

Tests first: a grant raises the balance and writes one `ADJUSTMENT` row carrying the note; a deduction lowers it; a deduction of exactly the balance is allowed and lands on zero; a deduction of one unit more is 422, the balance is unchanged **and no ledger row is written**; an empty note is 400; a malformed amount is 400; an unknown account is 404.

Commit: `feat: adjust account credits transactionally`.

### Task 7: Workspaces list & detail

**Files:** Create `src/routes/admin/workspaces.routes.ts`, `test/admin-workspaces.test.ts`; modify `src/app.ts`

`GET /workspaces` — page ordered `createdAt desc` with owner email and `_count` of members, agents and campaigns. DID count is included only when the model exists on this branch; until then the field is absent rather than zero, so the console can tell "none" from "not built yet". `GET /workspaces/:id` — members with roles, agents, campaigns (name and status only), and DIDs when present. Unknown id → 404.

Tests first: 401 unauthenticated; counts are right with two members and one campaign; detail returns members with roles and campaigns with status; unknown id 404s.

Commit: `feat: add staff workspace listing and detail`.

### Task 8: Global ledger

**Files:** Modify `src/routes/admin/accounts.routes.ts` (or a `billing.routes.ts`), extend tests

`GET /credit-transactions` — paginated, `createdAt desc`, `?accountId=` and `?type=` filters, each row carrying its account's email. An unknown `type` value is a 400, not an empty list.

Commit: `feat: add the global credit ledger listing`.

### Task 9: Overview

**Files:** Create `src/routes/admin/overview.routes.ts`, `test/admin-overview.test.ts`; modify `src/app.ts`

`GET /overview` — account and workspace counts, agents split assigned/unassigned, campaigns grouped by status, DIDs grouped by status when the model exists, and credits outstanding as `_sum` over account balances rendered as a display string. Statuses absent from the data appear as `0`, not missing keys — a console that hides an empty bucket reads as if the bucket does not exist.

Commit: `feat: add the staff platform overview`.

### Task 10: Docs & gates

**Files:** Modify `CLAUDE.md`

Add the staff route table, the credits/ledger note, and the phone-numbers merge warning. Run `npx tsc --noEmit` and `npx vitest run`; both green before the PR.

Commit: `docs: document the staff admin API`.
