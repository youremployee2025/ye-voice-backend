# Agent editing (Backend) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the read-only agent surface into a manageable one — create, update, unassign, tools, knowledge base, dictionaries, functions — without weakening workspace isolation. Design: `2026-08-27-agent-editing-design.md`.

**Architecture:** The Vocobase client gains write methods. A new `WorkspaceResource` table extends the "one upstream resource maps to at most one workspace" rule from agents to the four partner-level pools. Every write route is `requireAuth → requireMembership() → agentInWorkspace → proxy → refresh mirror`, reusing the existing helpers so a new route cannot obtain an agent it is not entitled to.

**Tech stack:** existing — Express 4, TypeScript, Prisma, Zod, Vitest + Supertest, `multer` (already present for CSV upload). No new dependencies.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, under the guard in `test/setup.ts`. **Every test mocks `src/adapter/vocobase.js` with `vi.mock`** — no test may make a network call. The partner key in `.env` is live and the account holds real customer agents; nothing in this plan writes to it.

**Database:** this worktree has its own dev and test databases (`ye_voice_agent_editing`, `ye_voice_test_agent_editing`) — see the `.env`. Run prisma and vitest as `env -u DATABASE_URL -u TEST_DATABASE_URL <cmd>`, because `dotenv` will not override an already-exported variable. Never `migrate reset` anything but a local database. The production migration is additive and is shown to the user for approval before it is applied anywhere near prod.

---

## Phase 1 — Core CRUD

### Task 1.1: `WorkspaceResource` schema & migration

**Files:** `prisma/schema.prisma`, `test/setup.ts`.

1. Add `enum WorkspaceResourceKind { DOCUMENT DICTIONARY FUNCTION CONNECTION }` and the `WorkspaceResource` model exactly as in the design doc (§ Data model): `kind`, `externalId`, `workspaceId`, `name String?`, timestamps, `@@unique([kind, externalId])`, `@@index([workspaceId, kind])`, relation `onDelete: Cascade`.
2. Add `resources WorkspaceResource[]` to `Workspace`.
3. `env -u DATABASE_URL -u TEST_DATABASE_URL npx prisma migrate dev --name workspace_resources`. Read the generated SQL: it must be one `CREATE TYPE`, one `CREATE TABLE`, two indexes, one FK, and alter **no** existing column. Confirm the directory name sorts after `20260826090000_workspace_sync_cooldown`; rename it if the clock produced an earlier stamp.
4. `env -u DATABASE_URL -u TEST_DATABASE_URL npm run test:prepare`.
5. Add `'WorkspaceResource'` to `TABLES` in `test/setup.ts`, **before** `'Workspace'` (dependency-first ordering).
6. Run the full suite — it must still be 254 green.
7. Commit: `feat: map partner-level resources to a single workspace`.

### Task 1.2: Client write methods

**Files:** `src/adapter/vocobase.ts`, `test/vocobase-adapter.test.ts`.

1. Failing tests (`fetch` stubbed with `vi.stubGlobal`): a `POST` sends the JSON body and `Content-Type`; a non-2xx maps to `UPSTREAM_ERROR`; **an upstream 400 maps to `VALIDATION_ERROR` (400) carrying the redacted upstream message**; a 409 on create maps to `AGENT_NAME_TAKEN`; a 204 with an empty body resolves rather than throwing on `res.json()`.
2. Generalise `request<T>` to take `{ method, body }`. Keep the existing GET call sites unchanged.
3. Add `ErrorCode` entries from the design doc (§ Errors) to `src/lib/errors.ts`.
4. Map upstream status → local error inside `unwrap`: 400 → `VALIDATION_ERROR` with `redact(message)` truncated to 300 chars; 409 → `AGENT_NAME_TAKEN`; everything else → the existing generic `UPSTREAM_ERROR`. The redaction must be the **same** `redact()` the logger uses — do not write a second one.
5. Add `createAgent(body)`, `updateAgent(id, body)`, `deleteAgent(id)`.
6. Commit: `feat: let the platform client write, not only read`.

### Task 1.3: Agent write payload schema

**Files:** Create `src/lib/agentPayload.ts`, `test/agent-payload.test.ts`.

1. Failing tests: a create missing `prompt` is rejected; `agent_type` outside `inbound|outbound` is rejected; `max_call_duration_secs` outside 60–3600 is rejected; `background_audio_volume` outside 0–1 is rejected; an update with **no** fields is rejected; an update with one field passes and emits only that key; a field the API does not accept (`language`, `status`, `document_count`) is stripped rather than forwarded.
2. Implement two Zod schemas — `createAgentSchema`, `updateAgentSchema` — over exactly the field list in the design doc's API table. Nothing invented, nothing omitted. `.strict()` is wrong here (upstream may add fields); strip unknown keys instead.
3. Commit: `feat: validate agent payloads against the platform's field list`.

### Task 1.4: Mirror refresh helper

**Files:** `src/services/agentSync.ts`, `test/agent-sync.test.ts`.

1. Failing tests: `refreshAgent(externalId)` upserts the row from a fresh `getAgent` call and returns it; it does **not** write `workspaceId`; a failure propagates rather than being swallowed.
2. Export `refreshAgent(externalId): Promise<Agent>` reusing the existing `upsertAgent` and `loadVoiceNames`. Extract nothing else — the existing sync entry points keep their behaviour.
3. Add `assignAgent(externalId, workspaceId, upstream)` — the single-statement upsert the create path needs, carrying every mirrored field **plus** `workspaceId`. This is the one place sync's "never write workspaceId" rule is deliberately broken; the comment must say why (assignment at creation is the act, not a side effect of a refresh).
4. Extend the existing tenancy regression test: a sync must not create or alter any `WorkspaceResource` row either.
5. Commit: `feat: refresh one agent's mirror row on demand`.

### Task 1.5: Create, update, unassign routes

**Files:** `src/routes/agents.routes.ts`, `test/agent-write.test.ts`.

1. Failing tests, per the design doc's § Testing list:
   - create returns the local id, one `Agent` row exists with `workspaceId` set;
   - create with the local write forced to fail (`vi.spyOn(prisma.agent, 'upsert').mockRejectedValue(...)`, twice) → `AGENT_CREATED_UNASSIGNED` 502;
   - create with upstream 409 → `AGENT_NAME_TAKEN`;
   - update sends only the supplied keys, and the mirror holds the new name when the response returns;
   - **workspace A updating B's agent → 404**; same for unassign;
   - unassign clears `workspaceId`, leaves the row, and calls no upstream delete;
   - unassign with a `Campaign` row carrying `agentId` → 409 `AGENT_IN_USE`, agent still assigned;
   - a non-member → 403 before any agent lookup.
2. Implement the three handlers. Register `POST /:workspaceId/agents` **after** `/agents/sync` so nothing shadows it. Every handler that names an agent calls the existing `agentInWorkspace(req)` — do not write a second lookup.
3. Commit: `feat: create, update and unassign agents from a workspace`.

### Task 1.6: Staff hard delete

**Files:** `src/routes/admin/agents.routes.ts`, `test/admin-agents.test.ts`.

1. Failing tests: missing `confirm` → 400; `confirm` not equal to the agent's `externalId` → 400 and no upstream call; correct → upstream `deleteAgent` called once and the local row gone; unknown agent → 404.
2. Implement `DELETE /agents/:agentId` behind the existing `requireStaffToken`.
3. Commit: `feat: allow staff to delete an agent upstream behind a confirm token`.

### Task 1.7: Voice catalogue route

**Files:** `src/routes/agents.routes.ts`, `test/agents.test.ts`.

1. Failing test: any member gets the voice list, projected through an allow-list (`id`, `name`, `language`, `gender` — whatever `listVoices` actually returns, nothing more); an upstream failure → 502.
2. Implement `GET /:workspaceId/voices`. The create and settings forms cannot offer a voice picker without it.
3. Commit: `feat: expose the voice catalogue to workspaces`.

**Gate:** `npx tsc --noEmit` clean, full suite green. Update the routes table in `CLAUDE.md`.

---

## Phase 2 — Tools

### Task 2.1: Resource guard

**Files:** Create `src/lib/workspaceResource.ts`, `test/workspace-resource.test.ts`.

1. Failing tests: `resourceInWorkspace` returns a mapped row; an unmapped id 404s; another workspace's id 404s with the identical message. `mapResource` is idempotent (calling twice does not violate the unique index). `filterMapped(rows, kind, workspaceId, idOf)` keeps only mapped rows and preserves order.
2. Implement the three helpers. `filterMapped` does one `findMany` over the candidate ids — not one query per row.
3. Commit: `feat: add the workspace-resource guard`.

### Task 2.2: Tool routes

**Files:** `src/routes/agents.routes.ts`, `src/adapter/vocobase.ts`, `src/lib/serialize.ts`, `test/agent-tools.test.ts`.

1. Add `getAvailableConnections(id)` and `setAgentTool(id, slug, body)` to the client.
2. Failing tests:
   - **a connection mapped to workspace B is absent from A's `/tools` response** — including its `providerEmail`;
   - `/available-connections` returns only mapped connections;
   - `PUT /tools/:slug` with a `connection_id` mapped to B → 404;
   - with a mapped one → upstream called once with `{ enabled, connection_id }`;
   - A acting on B's agent → 404.
3. Implement. The tools serializer keeps its allow-list; `connectionId` now has to be read internally to do the intersection, so it is read from the upstream row and **still** not emitted — add a test asserting the response has no `connectionId` key.
4. Add the staff assignment endpoints (`GET /api/admin/resources`, `POST /api/admin/resources/:kind/:externalId/assignment`) — connections cannot be mapped any other way, so the tools surface is untestable end to end without them.
5. Commit: `feat: scope tool connections to the workspace that owns them`.

**Gate:** `tsc` clean, suite green.

---

## Phase 3 — Knowledge base

### Task 3.1: Document client methods

**Files:** `src/adapter/vocobase.ts`, `test/vocobase-adapter.test.ts`.

1. Add `createDocumentUpload(body)`, `confirmDocument(id)`, `createParagraphDocument(body)`, `createWebLinkDocument(body)`, `linkDocuments(agentId, ids)`, `unlinkDocument(agentId, docId)`, `getDocumentSyncStatus(agentId)`.
2. Add `putToPresignedUrl(url, buffer, mimeType)` — a bare `fetch` **not** carrying the partner key. Failing test: the request to the storage URL has no `Authorization` header. Sending the partner credential to a storage host because the helper was reused is exactly the mistake this test exists to prevent.
3. Commit: `feat: add knowledge-base document calls`.

### Task 3.2: Upload route

**Files:** `src/routes/agents.routes.ts`, `test/agent-documents.test.ts`.

1. Failing tests: a non-member's multipart request is rejected **before** the file is read (drive the middleware chain directly and assert the handler never ran); oversize → 413; disallowed MIME → 415 with no upstream call; success → presign, PUT, confirm, link, and a `WorkspaceResource` DOCUMENT row mapped to the workspace; a link failure leaves the document mapped but unlinked, and says so.
2. Implement with `multer({ storage: memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } })`. Middleware order is `requireAuth, requireMembership(), upload.single('file'), handler` — the guard before the buffering, and a comment saying why.
3. Commit: `feat: upload knowledge-base files through the backend`.

### Task 3.3: Text, link, list, delete

**Files:** `src/routes/agents.routes.ts`, `test/agent-documents.test.ts`.

1. Failing tests: `documents:text` and `documents:link` create + map + link in one call; the list merges `GET /documents` with `GET /documents/sync-status` so each row carries its sync state; unlink of a document mapped to B → 404; unlink of a mapped one calls upstream once.
2. Implement. The list is agent-scoped upstream already, but the mapping filter still runs — a document linked to this agent by staff outside the platform is shown read-only rather than hidden, so intersect for *actions*, not for display, and test that distinction.
3. Commit: `feat: add text and link sources, sync status and unlink`.

**Gate:** `tsc` clean, suite green.

---

## Phase 4 — Dictionaries

### Task 4.1: Dictionary routes

**Files:** `src/adapter/vocobase.ts`, Create `src/routes/dictionaries.routes.ts`, `test/dictionaries.test.ts`, `src/app.ts`.

1. Client: `listDictionaries()`, `createDictionary(body)`, `updateDictionary(id, body)`, `deleteDictionary(id)`, `getAgentDictionaries(id)`, `replaceAgentDictionaries(id, ids)`.
2. Failing tests: the library lists only mapped dictionaries; create maps to the caller's workspace; replace with an id mapped to B → 404 **before** the upstream call; replace with `[]` detaches; an upstream `DICTIONARY_CHAR_LIMIT_EXCEEDED` 400 surfaces its message (redacted) so the customer learns the 10,000-char cap was hit.
3. Implement. Validate every id in the replace body against the mapping first, as a set — one query, not one per id.
4. Commit: `feat: manage speech dictionaries per workspace`.

**Gate:** `tsc` clean, suite green.

---

## Phase 5 — Functions

### Task 5.1: Function routes

**Files:** `src/adapter/vocobase.ts`, Create `src/routes/functions.routes.ts`, `test/functions.test.ts`, `src/app.ts`.

1. Client: `listFunctions()`, `createFunction(body)`, `updateFunction(id, body)`, `deleteFunction(id)`, `attachFunction(agentId, fid)`, `detachFunction(agentId, fid)`, `toggleFunction(agentId, fid, enabled)`.
2. Zod schema over the documented function fields (`name` snake_case, `description`, `url`, `headers`, `input_schema`, `output_schema`, `timeout` 1–60, `started_messages` ≤5, `error_message`). Header **values** are write-only: the upstream returns `header_keys` only, and the serializer must never invent a value field.
3. Failing tests: library lists only mapped functions; create maps; attach of a function mapped to B → 404; toggle and detach likewise; delete unmaps; a function attached to an agent in another workspace → 404.
4. Commit: `feat: manage callable functions per workspace`.

**Gate:** `tsc` clean, full suite green. Update `CLAUDE.md`: routes table, the `WorkspaceResource` note, and the permission matrix row recording the deliberate all-members deviation.

---

## Phase 6 — UI

Lives in the dashboard repo: `ye-voice-dashboard/docs/plans/2026-08-27-agent-editing-design.md` and `-plan.md`. Do not start it until the backend gates are green, since the UI is written against these exact response shapes.

---

## Manual verification (once, at the end)

The partner key is live. Exactly one throwaway agent, named `zz-ezo-dev-scratch`, created through the API, used to exercise update / tools / KB / dictionary / functions, then hard-deleted through the staff endpoint. **Never mutate a pre-existing agent. Never call anything under `calls`, `campaigns start`, or `dids/map`.** Record what was run and its outcome in the PR description.

## Production migration

Additive only. Show the generated SQL to the user and wait for explicit approval before applying it to production. Nothing in this plan applies a migration outside the local dev and test databases.
