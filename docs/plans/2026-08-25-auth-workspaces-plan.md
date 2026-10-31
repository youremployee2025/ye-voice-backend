# Auth & Workspaces (Backend) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the ye-voice-backend service with Clerk-verified auth, the Account → Workspace → Member tenancy model, and the full membership/invite API described in `2026-08-25-auth-workspaces-design.md`.

**Architecture:** Express + TypeScript app; Clerk JWT verification middleware resolves `clerkUserId` and upserts an `Account`; a workspace-membership middleware resolves role for `/api/workspaces/:id/*` routes; Prisma over Neon Postgres. Responses use the `{ success, data | error }` envelope.

**Tech Stack:** Node 20, Express 4, TypeScript, Prisma, `@clerk/express`, Zod (input validation), Vitest + Supertest.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`. The test setup MUST throw if that URL contains `neon.tech`. Never point tests at the `.env` `DATABASE_URL` — it is production. Use a local Postgres (e.g. `docker run -d --name ye-test-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16` → `postgresql://postgres:test@localhost:5433/postgres`).

**Auth in tests:** the Clerk middleware is factored so tests can stub identity: when `NODE_ENV=test`, an `X-Test-Clerk-User: <clerkUserId>|<email>` header is accepted instead of a JWT. This branch is compiled out of production behavior by an explicit env check at app startup.

---

### Task 1: Project scaffold

**Files:** Create `package.json`, `tsconfig.json`, `src/app.ts`, `src/server.ts`, `src/lib/env.ts`, `vitest.config.ts`, `test/setup.ts`.

1. `npm init -y`; install: `express cors zod @clerk/express @prisma/client dotenv`; dev: `typescript tsx @types/express @types/cors @types/node prisma vitest supertest @types/supertest`.
2. `tsconfig.json`: `strict`, `module: NodeNext`, `outDir: dist`, `rootDir: src`.
3. `src/lib/env.ts`: load dotenv, export required vars, throw on missing `DATABASE_URL`/`CLERK_SECRET_KEY` (skip throw when `NODE_ENV=test`).
4. `src/app.ts`: express app factory `createApp()` — `express.json()`, CORS (allow `http://localhost:3000`, credentials), `GET /health` → `{ success: true, data: { ok: true } }`. `src/server.ts` listens on `PORT ?? 3001`.
5. Scripts: `"dev": "tsx watch src/server.ts"`, `"build": "tsc"`, `"start": "node dist/server.js"`, `"test": "vitest run"`.
6. `test/setup.ts`: assert `process.env.TEST_DATABASE_URL` exists and `!includes('neon.tech')`; set `process.env.DATABASE_URL = TEST_DATABASE_URL`; export a `truncateAll()` helper (`TRUNCATE "WorkspaceInvite","WorkspaceMember","Workspace","Account" CASCADE`).
7. Write `test/health.test.ts` (supertest GET /health → 200 envelope). Run `npm test` → PASS.
8. Commit: `feat: scaffold express app with health check and test harness`.

### Task 2: Prisma schema & migration

**Files:** Create `prisma/schema.prisma`, `src/lib/prisma.ts`.

1. Schema exactly per the design doc (§ Data model): enums `WorkspaceRole`, `InviteStatus`; models `Account`, `Workspace`, `WorkspaceMember`, `WorkspaceInvite` with the stated uniques and relations (`onDelete: Cascade` from Workspace to members/invites).
2. `npx prisma migrate dev --name auth_workspaces_core` — this runs against the prod `DATABASE_URL` in `.env`; the migration is purely additive (new tables), which is acceptable. Review SQL before confirming. NEVER `migrate reset`.
3. Apply the same migration to the test DB: `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy`. Add script `"test:prepare": "DATABASE_URL=$TEST_DATABASE_URL prisma migrate deploy"`.
4. `src/lib/prisma.ts`: singleton PrismaClient.
5. Commit: `feat: add tenancy schema (Account, Workspace, WorkspaceMember, WorkspaceInvite)`.

### Task 3: Auth middleware + ensureAccount

**Files:** Create `src/middleware/auth.ts`, `src/lib/account.ts`, `test/auth.test.ts`.

1. Failing tests: request without auth → 401 `UNAUTHORIZED`; with test header → 200 and an `Account` row exists (upserted); second request reuses the row (no duplicate).
2. Implement `requireAuth`: if `NODE_ENV=test` and `X-Test-Clerk-User` present, parse `clerkUserId|email`; else use `@clerk/express` `getAuth(req)` after mounting `clerkMiddleware()`; on missing auth respond 401. Then `ensureAccount(clerkUserId, email?, name?, imageUrl?)`: `prisma.account.upsert` on `clerkUserId` (fetch email/name from Clerk API on create in prod path). Attach `req.account`.
3. Error helper `src/lib/errors.ts`: `fail(res, status, code, message)`; async route wrapper.
4. Tests pass. Commit: `feat: add Clerk auth middleware with account provisioning`.

### Task 4: GET /api/me

**Files:** Create `src/routes/me.routes.ts`, `test/me.test.ts`.

1. Failing tests: fresh account → `{ account, workspaces: [], pendingInvites: [] }`; account with a membership → workspace appears with `role`; a `PENDING` invite matching the account email appears in `pendingInvites` (with workspace name); `ACCEPTED/REVOKED` invites do not.
2. Implement: memberships joined to workspaces (`role` flattened onto each workspace object: `{ id, name, slug, color, role, isOwner }`); pending invites by `email = account.email`. Serialize `credits` via `toDisplayCredits` later — for now omit credits from `/api/me` payload beyond `account.credits.toString()`.
3. Commit: `feat: add /api/me bootstrap endpoint`.

### Task 5: Workspace creation & rename

**Files:** Create `src/routes/workspaces.routes.ts`, `src/middleware/workspace.ts`, `src/lib/slug.ts`, `test/workspaces.test.ts`.

1. Failing tests: `POST /api/workspaces {name}` → 201, creator is owner AND has ADMIN member row (single `$transaction`); slug auto-generated (`slugify(name)`, suffix `-2` on collision — test by creating twice); `PATCH /api/workspaces/:id {name}` by ADMIN → 200; by MEMBER → 403 `FORBIDDEN`; by non-member → 403.
2. `src/middleware/workspace.ts`: `requireMembership(role?: 'ADMIN')` — loads member row for `req.account` + `:id`, 403 if absent or role insufficient; attaches `req.workspace`, `req.role`.
3. Zod-validate bodies (`name: string 1..64`). Color assigned from a fixed 8-color palette by hashing the slug.
4. Commit: `feat: add workspace creation and rename with membership guard`.

### Task 6: Invites lifecycle

**Files:** Create `src/routes/invites.routes.ts`, `test/invites.test.ts`.

1. Failing tests: ADMIN invites email+role → 201 PENDING; MEMBER → 403; duplicate pending invite for same email → 409 `ALREADY_INVITED`; inviting an existing member's email → 409 `ALREADY_MEMBER`; ADMIN revoke → status REVOKED; invitee `POST /api/invites/:id/accept` with matching account email → member row created with invite role, invite ACCEPTED; mismatched email → 403 `INVITE_EMAIL_MISMATCH`; decline → DECLINED, no member row; accepting a REVOKED invite → 404.
2. Implement per design routes. Accept runs in a `$transaction` (create member + update invite), idempotency: accepting when already member → 409 `ALREADY_MEMBER`.
3. Commit: `feat: add workspace invite lifecycle (invite, revoke, accept, decline)`.

### Task 7: Members management

**Files:** Create `src/routes/members.routes.ts`, `test/members.test.ts`.

1. Failing tests: any member can `GET .../members` (owner flagged, invites included only for ADMIN); ADMIN changes a role → 200; MEMBER attempts → 403; ADMIN removes a member → 200; member self-leave (DELETE own memberId) → 200 even as MEMBER; owner cannot be demoted or removed → 400 `CANNOT_MODIFY_OWNER`; last-ADMIN safety not needed (owner is always ADMIN).
2. Implement; removal/role-change targets looked up within the workspace only.
3. Commit: `feat: add member listing, role changes, removal and self-leave`.

### Task 8: Wire-up, README, push

1. Mount all routers in `createApp()`; confirm route table matches the design doc exactly.
2. Full `npm test` green; `npm run build` clean.
3. README.md: setup, env vars, test-DB instructions.
4. Commit: `docs: add setup README`. Push `main` to origin (with the two scaffold commits) after user confirmation if not already pushed.
