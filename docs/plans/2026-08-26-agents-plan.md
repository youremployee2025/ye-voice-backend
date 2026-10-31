# Agents (Backend) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Mirror Vocobase agents into a workspace-scoped, read-only surface in `ye-voice-backend`, with staff endpoints that assign agents to workspaces. Design: `2026-08-26-agents-design.md`.

**Architecture:** A typed `fetch` client wraps the Vocobase V2 API. A sync service pulls the agent pool into a local `Agent` mirror keyed by `externalId`, never touching the `workspaceId` that maps a row to a workspace. Customer routes hang off the existing membership middleware and read the mirror; three sub-resource routes proxy live. Staff routes sit behind a shared-token guard.

**Tech stack:** existing — Express 4, TypeScript, Prisma, Zod, Vitest + Supertest. No new dependencies; `fetch` and `node:crypto` are built in.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, under the guard in `test/setup.ts`. **Every test mocks the Vocobase client with `vi.mock`** — no test may make a real network call. The live partner account is production and holds real agents; nothing in this plan writes to it.

**Environment:** `VOCOBASE_API_KEY`, `VOCOBASE_API_URL`, and `ADMIN_STAFF_TOKEN` are set in the gitignored `.env` and declared (empty) in `.env.example`. Secrets never appear in code, docs, or commits.

---

### Task 1: Prisma schema & migration

**Files:** `prisma/schema.prisma`.

1. Add the `Agent` model exactly as in the design doc (§ Data model): `externalId @unique`, nullable `workspaceId` with `onDelete: SetNull`, `name`, `status?`, `agentType?`, `voiceId?`, `voiceName?`, `language?`, `documentCount Int?`, `variables Json @default("[]")`, `rawConfig Json?`, `lastSyncedAt?`, timestamps, `@@index([workspaceId])`.
2. Add `agents Agent[]` to `Workspace`.
3. `npx prisma migrate dev --name agents_mirror`. The migration must be additive — one `CREATE TABLE`, one index, one FK. Read the generated SQL and confirm it alters no existing column. Never `migrate reset`.
4. `npm run test:prepare` to apply it to the test database.
5. Add `"Agent"` to the `TABLES` list in `test/setup.ts` so `truncateAll()` clears it — **before** `"Workspace"`, matching the existing dependency-first ordering.
6. Commit: `feat: add Agent mirror table with optional workspace assignment`.

### Task 2: Vocobase client

**Files:** Create `src/adapter/vocobase.ts`, `test/vocobase-adapter.test.ts`. Extend `src/lib/env.ts`, `src/lib/errors.ts`.

1. `src/lib/env.ts`: add `vocobaseApiKey`, `vocobaseApiUrl` (default `https://api.vocobase.com/api/v2`), `adminStaffToken`. Optional at import time so the app still boots without them — a missing key must fail on the call that needs it, not at startup.
2. `src/lib/errors.ts`: add `'UPSTREAM_ERROR'` to the `ErrorCode` union.
3. Failing tests, `fetch` stubbed via `vi.stubGlobal`: unwraps `{ success: true, data }`; turns `{ success: false, error }` into an `ApiError(502, 'UPSTREAM_ERROR')`; turns a non-2xx into the same; turns a network throw into the same; sends `Authorization: Bearer <key>`; throws when the key is unset; aborts on timeout.
4. Implement: a private `request<T>(path)` doing base-URL join, bearer header, `AbortSignal.timeout(15_000)`, envelope unwrap, error mapping. Then `listAgents({ limit, offset })`, `getAgent(id)`, `getAgentDocuments(id)`, `getAgentFunctions(id)`, `getAgentTools(id)`, `listVoices()`.
5. Types describe the fields actually observed (§ What the Vocobase API actually returns), with every optional field marked optional and unknown extras allowed. Do not model fields that were not verified.
6. Commit: `feat: add Vocobase V2 client for agent configuration`.

### Task 3: Field readers

**Files:** Create `src/lib/upstream.ts`, `test/upstream.test.ts`.

1. Failing tests: `readString(record, ['agent_name', 'name'])` returns the first non-empty string and `null` when none match, when the value is a number, and when the record is `null`; `readNumber` likewise; `readStringArray` filters non-strings and returns `[]` for a non-array.
2. Implement the three readers. They exist because the upstream mixes snake_case and camelCase and omits fields freely — every upstream read goes through them.
3. Commit: `feat: add tolerant readers for upstream field access`.

### Task 4: Sync service

**Files:** Create `src/services/agentSync.ts`, `test/agent-sync.test.ts`.

1. Failing tests, `vi.mock('../src/adapter/vocobase.js')`:
   - inserts a new row from a listing entry, mapping every cached field;
   - resolves `voiceName` from the voice catalogue, and falls back to the raw id when the catalogue lacks it;
   - **an existing assigned row keeps its `workspaceId` after a sync that changes its name** — the tenancy regression test;
   - a row whose `externalId` is absent from the listing becomes `status="removed"` and still exists;
   - paginates: a 100-row first page plus a short second page yields 100 + n rows and stops;
   - `syncWorkspaceAgents` refreshes only that workspace's rows and marks nothing removed;
   - an upstream failure propagates as `UPSTREAM_ERROR` and leaves the mirror untouched.
2. Implement `syncAllAgents()` and `syncWorkspaceAgents(workspaceId)`. The upsert's `update` branch must omit `workspaceId` entirely — not set it to its current value, omit it.
3. Return `{ synced, removed }` counts.
4. Commit: `feat: sync Vocobase agents into the local mirror`.

### Task 5: Workspace agent routes

**Files:** Create `src/routes/agents.routes.ts`, `test/agents.test.ts`. Extend `src/lib/serialize.ts`, `src/app.ts`.

1. `src/lib/serialize.ts`: `serializeAgentSummary` → `{ id, name, agent_type, status, voice, language, document_count, last_synced_at }`; `serializeAgentDetail` adds `variables` and `raw_config`.
2. Failing tests:
   - a member lists only this workspace's agents; agents of another workspace and unassigned agents are absent;
   - **workspace A requesting workspace B's agent id → 404**, on detail and on all three sub-resource routes;
   - an unassigned agent → 404;
   - a non-member → 403 (membership middleware, before any agent lookup);
   - documents / functions / tools return the unwrapped arrays from the mocked client;
   - an upstream failure on a sub-resource → 502 `UPSTREAM_ERROR`;
   - `POST .../agents/sync` refreshes only this workspace's rows.
3. Implement. Every handler resolves the agent with `findFirst({ where: { id, workspaceId } })` — ownership is part of the lookup, never a separate check that could be forgotten. Register `/agents/sync` **before** `/agents/:agentId`.
4. Mount in `src/app.ts` under `/api/workspaces`.
5. Commit: `feat: add workspace-scoped agent listing, detail and live sub-resources`.

### Task 6: Staff token middleware

**Files:** Create `src/middleware/adminToken.ts`, `test/admin-auth.test.ts`.

1. Failing tests: no header → 401; wrong token → 401; correct token → passes; **token of a different length → 401 and does not throw**; `ADMIN_STAFF_TOKEN` unset or empty → 401 even when the header matches it.
2. Implement `requireStaffToken`: read `X-Admin-Token`; reject when the configured secret is empty; compare lengths, then `crypto.timingSafeEqual` over `Buffer.from(…, 'utf8')`.
3. Commit: `feat: add staff token guard for admin routes`.

### Task 7: Admin agent routes

**Files:** Create `src/routes/admin/agents.routes.ts`, `test/admin-agents.test.ts`. Extend `src/app.ts`.

1. Failing tests:
   - `POST /api/admin/agents/sync` syncs the global pool and returns counts;
   - `GET /api/admin/agents` lists every agent with its workspace (`null` when unassigned);
   - `?assigned=false` returns only unassigned rows; `?assigned=true` only assigned;
   - `POST /api/admin/agents/:id/assignment { workspaceId }` assigns; a second call with a different workspace reassigns;
   - `{ workspaceId: null }` unassigns;
   - an unknown `workspaceId` → 404, and the agent stays as it was;
   - an unknown agent id → 404;
   - every route without a valid staff token → 401.
2. Implement. Zod-validate the assignment body as `{ workspaceId: z.string().nullable() }` — `null` is a meaningful value here, so it must be explicit in the schema rather than conflated with a missing field.
3. Mount under `/api/admin` behind `requireStaffToken`.
4. Commit: `feat: add staff endpoints for agent pool listing and assignment`.

### Task 8: Documentation

**Files:** `CLAUDE.md`, `.env.example`, `README.md`.

1. `CLAUDE.md`: add the agent routes to the route conventions section; note the Vocobase client path and that the partner key is server-side only; correct the environment section, which still describes `DATABASE_URL` as production although local development and tests now run against local Postgres.
2. `.env.example`: confirm `VOCOBASE_API_KEY`, `VOCOBASE_API_URL`, `ADMIN_STAFF_TOKEN` are present and empty.
3. Commit: `docs: document the agent routes and Vocobase configuration`.

### Task 9: Verify

1. `npm test` — every test green, including the 39 that existed before this slice.
2. `npm run build` — clean.
3. Report route list, test count, and anything the API forced a deviation on.
