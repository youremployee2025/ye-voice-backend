# Agents — Design

Date: 2026-08-26. Scope: the agents slice of `ye-voice-backend` — mirroring Vocobase agent configuration into a workspace-scoped read-only surface, plus the staff endpoints that assign agents to workspaces.

## The shape of the problem

Voice capability comes from Vocobase's V2 partner API. The platform holds **one** partner account: a single API key, a single agent namespace. Vocobase has no concept of our workspaces, so every agent it knows about arrives as an undifferentiated pool.

Workspaces, meanwhile, must be strictly isolated. An account that owns three workspaces must see three disjoint agent lists, and an agent that belongs to nobody must be invisible to everybody.

The whole design follows from reconciling those two facts.

## Decisions

- **One internal pool, assignment on top.** Every Vocobase agent is mirrored into a local `Agent` row keyed by its Vocobase id. A nullable `workspaceId` maps a row to **at most one** workspace. No agent is ever visible from two workspaces.
- **Unassigned means invisible.** A mirrored row with `workspaceId = null` is reachable only through the staff endpoints. Customers cannot see it, list it, count it, or discover that it exists.
- **Assignment is a staff act.** Workspaces cannot create, edit, delete, or claim agents. YE provisions an agent in Vocobase, then assigns it. The customer-facing surface is read-only in the strong sense: there is no write route at all, not merely a hidden button.
- **Cache for lists, live for sub-resources.** The listing and detail views read the local mirror, so they are fast and survive a Vocobase outage. Documents, functions, and tools are fetched live on demand — they change independently of the agent record and are not worth cache invalidation.
- **The partner key never leaves the backend.** Every Vocobase call originates server-side. Neither the dashboard nor the browser ever holds it.

## What the Vocobase API actually returns

Verified against the live V2 API rather than assumed, because two things differ from what a reader might expect.

Base URL `https://api.vocobase.com/api/v2`, auth `Authorization: Bearer <key>`, envelope `{ success, data | error: { code, message } }` — the same envelope this service speaks, which makes unwrapping mechanical.

| Call | Response body under `data` |
|---|---|
| `GET /agent/all?limit&offset` | `{ agents: [...], total, limit, offset }` — `limit` caps at **100** |
| `GET /agent/:id` | the agent object directly |
| `GET /agent/:id/documents` | `{ documents: [...], total }` |
| `GET /agent/:id/functions` | `{ functions: [...] }` |
| `GET /agent/:id/tools` | `{ tools: [...] }` |
| `GET /agent/voices` | `{ voices: [...] }` |

**`/agent/all` returns complete agent objects.** A listing entry is byte-identical to that agent's `GET /agent/:id` response — same keys, same values, including `prompt`, `variables`, and every nested config block. Sync therefore costs **one request per 100 agents**, not one listing plus N detail fetches. `GET /agent/:id` remains in the client for the single-agent refresh path, where fetching one row beats re-listing the pool.

**Field casing is not uniform.** Agent fields are snake_case (`agent_name`, `voice_id`, `document_count`). The `tools` rows are camelCase (`toolSlug`, `toolName`, `connectionId`). Every read of an upstream field goes through a helper that accepts both spellings and returns `null` rather than throwing when a field is absent or the wrong type. This is not defensive habit — it is the observed shape of the API.

**Agents carry ids, not labels.** An agent has `voice_id`, never a voice name. Sync resolves those against `GET /agent/voices` once per run and stores the resolved `display_name`, so the UI can show "Anisha" instead of a UUID. An unresolvable id falls back to the raw value rather than showing a blank.

Two fields are frequently `null` in real data: `agent_type` and, for agents with no knowledge base, `document_count`. Both are modelled nullable and rendered as "not set" — never defaulted into a value that was never configured.

## Data model

```prisma
model Agent {
  id            String    @id @default(cuid())
  externalId    String    @unique   // the agent's id in Vocobase
  workspaceId   String?             // null = unassigned, visible only to staff
  name          String
  status        String?
  agentType     String?
  voiceId       String?
  voiceName     String?             // resolved from the voice catalogue at sync time
  language      String?
  documentCount Int?
  variables     Json      @default("[]")  // pre-call variable names, string[]
  rawConfig     Json?                     // last full config snapshot, for the detail view
  lastSyncedAt  DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  workspace Workspace? @relation(fields: [workspaceId], references: [id], onDelete: SetNull)

  @@index([workspaceId])
}
```

`onDelete: SetNull` is deliberate. Deleting a workspace must not delete the agent — the agent lives in Vocobase and outlives any workspace here. It returns to the unassigned pool for staff to reassign.

`documentCount` is cached rather than fetched per row: it arrives free in the listing payload, and reading it live would turn one list request into one request per agent.

`rawConfig` holds the full snapshot so the detail view can surface configuration fields without a live call. It is a display cache, not a source of truth — anything acted upon is read from Vocobase.

The migration is purely additive: one new table, one new nullable relation. It touches no existing column.

## Sync

```
listVoices()  ─┐
               ├─→ upsert by externalId ─→ mark absent rows status="removed"
listAgents() ──┘   (never writes workspaceId)
```

1. Fetch the voice catalogue once; build an `id → display_name` map.
2. Page `GET /agent/all` at `limit=100` until fewer than `limit` rows come back, collecting every agent.
3. Upsert each by `externalId`. **The update branch never writes `workspaceId`** — assignment is staff-owned state, and a sync that clobbered it would silently un-share every agent. This is the single most important line in the service.
4. Any local row whose `externalId` was absent from the listing gets `status = "removed"`. Rows are not deleted: a removed agent may still be referenced by past calls, and a Vocobase outage that returned a short list must not destroy local state.

Two entry points share this machinery. A **global** sync refreshes the whole pool. A **workspace** sync refreshes only that workspace's rows and never marks anything removed — a workspace's partial view is not evidence that an agent vanished from the pool.

## Routes

Customer-facing, under the existing membership middleware. Any member may read; there is no role gate, because there is nothing here to protect from a `MEMBER` that an `ADMIN` should see instead.

```
GET  /api/workspaces/:workspaceId/agents                          → cached rows for this workspace
GET  /api/workspaces/:workspaceId/agents/:agentId                 → cached config + fields
GET  /api/workspaces/:workspaceId/agents/:agentId/documents       → live
GET  /api/workspaces/:workspaceId/agents/:agentId/functions       → live
GET  /api/workspaces/:workspaceId/agents/:agentId/tools           → live
POST /api/workspaces/:workspaceId/agents/sync                     → refresh this workspace's rows
```

`/agents/sync` registers before `/agents/:agentId`, or Express matches the literal `sync` as an agent id.

List rows are shaped `{ id, name, agent_type, status, voice, language, document_count, last_synced_at }`.

`:agentId` is the **local row id**, not the Vocobase id. The dashboard has no use for the upstream identifier, and not exposing it keeps the integration boundary inside the backend. Every handler resolves the row with `where: { id, workspaceId }` — a single query that makes ownership a precondition of finding anything.

**An agent belonging to another workspace returns 404, not 403.** A 403 would confirm the id names a real agent somewhere, which is exactly the fact isolation exists to withhold. Unassigned agents 404 for the same reason.

Staff endpoints, under a separate auth:

```
POST /api/admin/agents/sync                    → sync the global pool
GET  /api/admin/agents?assigned=false          → pool listing with current workspace
POST /api/admin/agents/:id/assignment          → { workspaceId } | { workspaceId: null }
```

Assignment is one endpoint in both directions: a workspace id assigns, an explicit `null` returns the agent to the pool. Reassignment is a plain overwrite, since an agent maps to at most one workspace by construction.

## Staff authentication

`/api/admin/*` is not Clerk-authenticated — it serves YE operators, not customer accounts. A request carries `X-Admin-Token`, compared against `ADMIN_STAFF_TOKEN` with `crypto.timingSafeEqual` so a wrong token costs the same time as a right one regardless of where it first differs. Lengths are compared before the buffers, because `timingSafeEqual` throws on a length mismatch.

A missing or empty `ADMIN_STAFF_TOKEN` denies every request. An unset secret must never mean an open door.

## Errors

Existing `{ success: false, error: { code, message } }` envelope, existing helpers. One new code, `UPSTREAM_ERROR` → HTTP 502, for a Vocobase call that fails or times out. The distinction matters to the dashboard: 502 means "Vocobase is unreachable, retry" while 404 means "this agent is not yours", and a UI that conflates them tells the user the wrong story.

Adapter failures never surface raw upstream text to the customer.

## Testing

Vitest and Supertest against `TEST_DATABASE_URL`, under the existing guard that refuses to run against a hosted database. The Vocobase client is replaced with `vi.mock` in every test — **no test performs a real network call**, so the suite is deterministic, runs offline, and cannot mutate the live partner account.

The cases that matter:

- **Isolation** — workspace A requesting workspace B's agent gets 404, on the detail route and on all three live proxies.
- **Invisibility** — an unassigned agent appears in no workspace listing and 404s on direct request.
- **Assignment survives sync** — a sync that returns changed config for an assigned agent updates the fields and leaves `workspaceId` intact. This is the regression that would silently break tenancy, so it is tested directly rather than implied.
- **Removal marking** — a row absent from the listing becomes `status="removed"` and is not deleted.
- **Pagination** — a pool larger than one page is fully collected.
- **Staff auth** — absent, wrong, and correct tokens; and a request rejected when the environment sets no token at all.
- **Shaping** — a null `agent_type`, an unresolvable `voice_id`, and camelCase `tools` rows all survive without throwing.
