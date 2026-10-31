# Agent editing — Design

Date: 2026-08-27. Scope: turning the read-only agent surface of `ye-voice-backend` into a fully manageable one — create, update, tools, knowledge base, dictionaries and functions — while keeping workspace isolation exactly as strict as it is today.

Builds on `2026-08-26-agents-design.md`, which established the mirror, the assignment model and the read routes. Everything there still holds; this document only adds the write side and the one new isolation problem it creates.

## The shape of the problem

The agents slice could be read-only in the strong sense: no write route existed, so isolation reduced to a single question — *is this agent row assigned to the caller's workspace?* — answered by one `findFirst({ where: { id, workspaceId } })`.

Editing breaks that simplicity in two places.

**First, writes reach a shared upstream.** The platform holds one Vocobase partner account. Every write a workspace makes lands in a namespace every other workspace also occupies. A create must be attributed; an update must be refused unless the agent is already the caller's; a delete must not destroy something another workspace can see.

**Second, agents are not the only pool.** An agent's knowledge base, dictionaries, functions and tool connections are all **partner-level** resources upstream — not agent-level ones. `GET /dictionaries` returns every dictionary in the partner account. `GET /functions` returns every function. `GET /agent/:id/tools` returns every OAuth connection the partner holds, each with the connected account's email address, regardless of which agent was asked about.

The read-only surface got away with this because it only ever *displayed* what was already attached to one agent. An editing surface has to offer pickers — "which dictionary do you want to attach?", "which connection should this tool bind to?" — and a picker built directly on those endpoints would list workspace B's dictionary names, function endpoint URLs and connection owner emails to workspace A, and let A attach B's dictionary to its own agent.

The whole design follows from those two facts.

## Decisions

- **Every write goes through this backend.** Membership guard → verify the agent is assigned to that workspace → proxy to Vocobase → refresh that agent's mirror row, in the same request. The dashboard never calls Vocobase, and the partner key never leaves the server. This is not merely convention: it is the only place the workspace check exists.
- **The mapping rule generalises.** The `Agent.workspaceId` idea — *one upstream resource maps to at most one workspace; unmapped means invisible* — becomes a table that covers dictionaries, documents, functions and tool connections too. A picker is always upstream's list **intersected with** what this workspace owns.
- **Creating maps.** A resource created through this backend is mapped to the creating workspace in the same request. A resource that already exists upstream, created outside this platform, has no mapping and is invisible to every workspace until staff map it. Fail closed: an unknown id is a 404, never a silent success.
- **All members may edit.** Deliberately not ADMIN-gated — see § Permissions.
- **"Delete" at workspace level is unassign.** The mapping row is cleared; the upstream agent survives and returns to the unassigned pool. Real deletion is a staff act.
- **Mirror refresh is part of the write, not a follow-up.** An update that returned before refreshing would leave the caller re-reading stale configuration it had just changed, and "my edit didn't save" is the most expensive possible bug to be wrong about.

## What Vocobase's write API actually offers

Read from the published V2 reference rather than assumed, because two things constrain the UI directly.

Base URL `https://api.vocobase.com/api/v2`, `Authorization: Bearer <key>`, envelope `{ success, data | error: { code, message } }`.

| Call | Body / notes |
|---|---|
| `POST /agent` | `agent_name`, `prompt`, `voice_id`, `agent_type` **required**; ~25 optional fields. 201. 409 on duplicate name |
| `PUT /agent/:id` | every field optional, **at least one required**; only supplied fields change |
| `DELETE /agent/:id` | soft-delete upstream; removes linked document associations |
| `GET/PUT /agent/:id/dictionaries` | `{ dictionary_ids: [...] }` — idempotent set-replace, `[]` detaches all |
| `GET/POST /agent/:id/documents`, `DELETE .../:documentId` | link by id, 1–20 per call, max 100 per agent |
| `GET /agent/:id/documents/sync-status` | counts by sync state plus per-document detail |
| `GET/POST/DELETE/PATCH /agent/:id/functions/:functionId` | attach / detach / toggle |
| `GET /agent/:id/tools`, `GET /agent/:id/available-connections`, `PUT /agent/:id/tools/:slug` | tool bind state; `{ enabled, connection_id? }` |
| `POST /documents/upload` → `POST /documents/:id/confirm` | presigned URL, then confirm |
| `POST /documents/paragraph`, `POST /documents/web-link` | plain JSON, no storage round trip |
| `GET/POST/PATCH/DELETE /dictionaries` | partner-level dictionary CRUD |
| `GET/POST/PUT/DELETE /functions` | partner-level function CRUD |

**The update payload is the field list, and we expose exactly it.** No invented fields, no fields the API does not accept. Notably `language` is *not* settable — it changes implicitly with `voice_id` — and `status`, `document_count` and the timestamps are read-only. The Settings surface says so rather than offering a control that cannot work.

**Adding a knowledge-base file is four upstream calls, not one.** `POST /documents/upload` returns a presigned URL and a document id; the bytes are `PUT` to that URL; `POST /documents/:id/confirm` moves the document to `ready`; `POST /agent/:id/documents` links it. Pasted text and web links skip the first three — one JSON call produces a ready document — which is why they are worth having: they are the cheap path through the same plumbing.

**`agent_name` is unique per partner.** Two workspaces cannot both have an agent called "Reception". A 409 must therefore be surfaced as its own message, not as a generic upstream failure, or the customer has no idea what to do next.

## Data model

One new table, one new enum. Both additive; nothing existing is altered.

```prisma
enum WorkspaceResourceKind {
  DOCUMENT
  DICTIONARY
  FUNCTION
  CONNECTION
}

/// Maps an upstream partner-level resource to at most one workspace — the
/// same rule `Agent.workspaceId` applies to agents, for the pools that have
/// no column of their own. A resource with no row here is invisible to every
/// workspace, exactly as an unassigned agent is.
model WorkspaceResource {
  id          String                @id @default(cuid())
  kind        WorkspaceResourceKind
  externalId  String
  workspaceId String
  /// Last known upstream label, for staff listings and for naming a resource
  /// in an error when the upstream call that would have named it failed.
  name        String?
  createdAt   DateTime              @default(now())
  updatedAt   DateTime              @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([kind, externalId])
  @@index([workspaceId, kind])
}
```

`@@unique([kind, externalId])` is the invariant, enforced by the database rather than by care: a resource cannot be mapped to two workspaces, so no query anywhere has to defend against a second row.

`onDelete: Cascade`, unlike `Agent`'s `SetNull`. The difference is deliberate. An agent is provisioned by staff and outlives the workspace it was lent to, so it returns to the pool. A dictionary or function created *by* a workspace has no meaning once that workspace is gone, and leaving orphan mapping rows pointing at a dead workspace would make the pool listings lie. The upstream resource still survives — cascade removes our mapping, not Vocobase's row — so nothing is destroyed that staff cannot recover.

The mapping is **not** a mirror. It stores an id and a label, never content. Dictionary terms, document text and function schemas stay upstream and are fetched live; caching them would create a second copy of customer data to keep correct, for a surface that is edited far more often than it is read.

## The write path

Every mutating route is the same five steps, in this order:

```
requireAuth  →  requireMembership()  →  agentInWorkspace(req)  →  proxy to Vocobase  →  refreshAgent(externalId)
```

`agentInWorkspace` is the existing helper and already does the right thing: it resolves by id *and* workspace in one query, so ownership is a precondition of holding an agent rather than a check that can be skipped. Reusing it is why no new isolation bug can be introduced by a new route — the route cannot obtain an agent it is not entitled to.

For the pooled kinds, one more guard sits alongside it:

```ts
/** Resolves an upstream resource id the caller is entitled to act on, or 404s.
 *  Unmapped and other-workspace ids are indistinguishable from nonexistent
 *  ones — the same rule the agent routes already follow. */
async function resourceInWorkspace(
  kind: WorkspaceResourceKind,
  externalId: string,
  workspaceId: string,
): Promise<WorkspaceResource>
```

And every pooled **listing** is filtered rather than proxied:

```
GET /dictionaries  (upstream, all partner rows)
   ∩  WorkspaceResource where { kind: DICTIONARY, workspaceId }
   =  what this workspace may see
```

The intersection runs on the upstream id. A dictionary present upstream but unmapped is dropped; a mapping whose upstream row has vanished is reported as absent rather than as an empty-named row, and the stale mapping is cleaned up on the next successful list.

`GET /agent/:id/tools` gets the same treatment, which closes a leak that exists today: the current read-only tools tab passes `providerEmail` through for **every** connection in the partner account, so a member of one workspace can already read the Google account addresses of every other workspace's integrations. After this slice the tools list is intersected with mapped `CONNECTION` rows, and an unmapped connection is not merely unbindable — it is not shown at all.

Connections are the one kind a workspace cannot create, because connecting one is an OAuth flow that happens outside this platform. They are staff-assigned, exactly like agents.

## Creating an agent

```
POST /agent (upstream)                        ← the only step that can leave a trace
  ↓ 201 { id, ... }
prisma.agent.upsert({ externalId })           ← mirror + assign, one write
  ↓
respond with the new local id
```

The hazard is the gap between those two steps. If the local write fails after upstream returned 201, the agent exists in the partner account, belongs to nobody, and the customer sees an error suggesting nothing happened — an orphan that will surface later as a mysterious unassigned agent in the staff pool.

Three things, in order of preference:

1. **The local write is one statement.** A single `upsert` carrying every mirrored field plus `workspaceId`. There is no multi-step local transaction to fail halfway.
2. **A failure after 201 is reconciled, not swallowed.** The handler catches it, retries the upsert once, and if that also fails records the orphan and returns `AGENT_CREATED_UNASSIGNED` (502) — a distinct code whose message tells the customer the agent was created but could not be attached, and to contact support. Reporting a plain failure would be a lie; reporting success would be worse.
3. **The staff pool listing is the backstop.** An orphan appears there as unassigned, which is a state staff already know how to resolve. The global sync will pick it up regardless.

We do not attempt a compensating upstream `DELETE`. The delete could fail too, and a failed rollback of a failed create is a strictly worse place to be than one orphan that shows up in a listing built to display exactly that.

## Removing an agent

Two different operations that a single word would conflate, so they are two endpoints with different auth.

**Unassign** — `DELETE /api/workspaces/:workspaceId/agents/:agentId`, any member. Clears `Agent.workspaceId`. The upstream agent is untouched; the row returns to the unassigned pool; call history that references it survives. The response says the agent was removed *from the workspace*, and the confirm dialog says the same, because a customer who reads "delete" and means "delete" must not be surprised either way.

It is **refused while a campaign in that workspace references the agent**:

```ts
const referencing = await prisma.campaign.count({
  where: { workspaceId, agentId: agent.id },
});
if (referencing > 0) throw new ApiError(409, 'AGENT_IN_USE', ...);
```

Counted rather than assumed from a foreign key. `Campaign.agentId` is an indexed plain column today; the relation is a separate follow-up, and a guard that only works once that lands is a guard that does not work. When the FK arrives this check stays — it produces a message naming the campaigns, which a constraint violation cannot.

**Hard delete** — `DELETE /api/admin/agents/:agentId`, staff token, body `{ confirm: "<externalId>" }`. Calls upstream `DELETE /agent/:id` and removes the local row. The confirm token is the agent's own upstream id, so it cannot be supplied by anyone who has not deliberately looked the agent up; a boolean `{ confirm: true }` is something a misrouted script can send by accident.

## Uploads

Multipart, through the backend, with `multer` already in the dependency list from the CSV upload path.

```
memoryStorage, limits: { fileSize: 25MB, files: 1 }
```

**The membership guard runs before multer, not after.** Route middleware order is the enforcement: `requireAuth, requireMembership(), upload.single('file'), handler`. Reversed, a stranger's 25MB body is buffered into this process's heap before anyone checks whether they may talk to the workspace at all — which turns an authorization check into a memory-exhaustion vector. The agent-in-workspace lookup runs inside the handler, before the first upstream call, so a probe for another workspace's agent never spends an upstream request either.

25MB rather than the 50MB the upstream permits: the file is held whole in memory here on its way to the presigned URL, and the cap is a property of this process, not of Vocobase's storage. MIME type is validated against the upstream's own allow-list before anything is buffered upstream, so an unsupported file fails here with a readable message instead of failing at `confirm` with a generic one.

A document created this way is mapped `DOCUMENT → workspace` immediately, then linked to the agent. If the link fails, the document is mapped but unlinked — visible in that workspace's library, attachable again, not an orphan.

## Permissions

**Every workspace member may create agents, edit every part of their configuration, and remove one from the workspace.** MEMBER and ADMIN are equal on this surface.

This is a deliberate deviation from the gating used elsewhere in this service. Campaigns reserve create/update/delete for ADMIN; members and invites, roles and billing are ADMIN-only throughout. Agents are not, and the reason is that an agent's prompt is the product's actual working material — the thing the people using the platform are here to iterate on. Requiring an admin to change a sentence in a prompt would make the product unusable for the team that operates it, and would push everyone to be made an admin, which is a worse outcome for every other permission in the matrix.

The blast radius is bounded by design: unassign returns an agent to the pool rather than destroying it, hard delete is staff-only, and nothing on this surface can spend credits or reach another workspace.

If that trade turns out wrong for a given deployment, it is one guard: adding `requireMembership('ADMIN')` to the tool-configuration and unassign routes restricts them without touching anything else. That is recorded here, and in the repo `CLAUDE.md` permission matrix, so a later reader sees a decision rather than an oversight.

| Action | Owner/ADMIN | MEMBER |
|--------|:-----------:|:------:|
| Create an agent | ✅ | ✅ |
| Edit prompt, settings, tools, KB, dictionaries, functions | ✅ | ✅ |
| Remove an agent from the workspace | ✅ | ✅ |
| Delete an agent upstream | ❌ | ❌ |

## Routes

Customer-facing, all under `requireAuth` + `requireMembership()`. Existing read routes unchanged.

```
POST   /api/workspaces/:wid/agents                          create + assign + mirror
PATCH  /api/workspaces/:wid/agents/:aid                     update (partial) + refresh
DELETE /api/workspaces/:wid/agents/:aid                     unassign (409 if a campaign uses it)

GET    /api/workspaces/:wid/agents/:aid/tools               attached, ∩ mapped connections
GET    /api/workspaces/:wid/agents/:aid/available-connections   ∩ mapped connections
PUT    /api/workspaces/:wid/agents/:aid/tools/:slug         { enabled, connection_id? }

GET    /api/workspaces/:wid/agents/:aid/documents           linked, with sync status
POST   /api/workspaces/:wid/agents/:aid/documents:upload    multipart, ≤25MB
POST   /api/workspaces/:wid/agents/:aid/documents:text      { name, content }
POST   /api/workspaces/:wid/agents/:aid/documents:link      { name, url }
DELETE /api/workspaces/:wid/agents/:aid/documents/:docId    unlink

GET    /api/workspaces/:wid/agents/:aid/dictionaries        attached
GET    /api/workspaces/:wid/dictionaries                    library, ∩ mapped
POST   /api/workspaces/:wid/dictionaries                    create + map
PUT    /api/workspaces/:wid/agents/:aid/dictionaries        { dictionary_ids } set-replace

GET    /api/workspaces/:wid/agents/:aid/functions           active on this agent
GET    /api/workspaces/:wid/functions                       library, ∩ mapped
POST   /api/workspaces/:wid/functions                       create + map
PATCH  /api/workspaces/:wid/functions/:fid                  update
DELETE /api/workspaces/:wid/functions/:fid                  delete + unmap
POST   /api/workspaces/:wid/agents/:aid/functions/:fid      attach
PATCH  /api/workspaces/:wid/agents/:aid/functions/:fid      { enabled }
DELETE /api/workspaces/:wid/agents/:aid/functions/:fid      detach

GET    /api/workspaces/:wid/voices                          voice catalogue (for the picker)
```

Sub-resource actions use `:` verbs (`documents:upload`) rather than nested path segments, so no literal ever has to be registered before a `:id` pattern to stay reachable — the failure mode `/agents/sync` already had to be defended against.

Staff, under `X-Admin-Token`:

```
DELETE /api/admin/agents/:agentId                 { confirm: "<externalId>" }
GET    /api/admin/resources?kind=&assigned=       pool listing across all four kinds
POST   /api/admin/resources/:kind/:externalId/assignment    { workspaceId } | { workspaceId: null }
```

Assignment mirrors the agent endpoint exactly, `null` explicit for the same reason: an omitted field must not be able to un-share a resource.

## Errors

Existing envelope and helpers. New codes:

| Code | Status | Means |
|---|---|---|
| `AGENT_NAME_TAKEN` | 409 | upstream rejected a duplicate `agent_name` |
| `AGENT_IN_USE` | 409 | a campaign in this workspace references the agent |
| `AGENT_CREATED_UNASSIGNED` | 502 | upstream created it; local assignment failed |
| `UPLOAD_TOO_LARGE` | 413 | over the size cap |
| `UNSUPPORTED_FILE_TYPE` | 415 | MIME type outside the upstream allow-list |
| `RESOURCE_NOT_FOUND` | 404 | an id not mapped to this workspace |

The adapter's rule that upstream wording is logged and never returned stays — with one carefully bounded exception. A **validation** failure (upstream 400) is the one case where the upstream's message is the only thing that tells the customer what to fix: "prompt must be 120000 characters or fewer" cannot be reconstructed here without duplicating every upstream limit and then drifting from it. So a 400 is surfaced as `VALIDATION_ERROR` carrying the upstream message, **after** passing through the same `redact()` the adapter already applies to log output, and capped in length. Every other status keeps the generic message.

That is a real widening of what reaches a customer's screen and it is written down rather than left implicit: the redaction is the control, and it is the same code path that protects the logs, so the two cannot drift apart.

## Testing

Vitest and Supertest against `TEST_DATABASE_URL`, under the existing guard. **Every test mocks the Vocobase client with `vi.mock` — no test makes a network call**, so the suite is offline, deterministic, and cannot touch the live partner account.

The cases that carry the design:

- **Isolation, per write route.** Workspace A attempting each of create/update/unassign/tool/document/dictionary/function against workspace B's agent gets 404. One test per route, not one shared test — a new route that forgets `agentInWorkspace` must fail something.
- **Pool isolation.** A dictionary mapped to B does not appear in A's library, cannot be attached to A's agent, and 404s when addressed directly. Same for functions and connections.
- **Connections are not creatable.** No customer route maps a `CONNECTION`; only the staff endpoint does.
- **`providerEmail` does not leak.** A connection mapped to B is absent from A's tools response — the regression this slice fixes, tested directly.
- **Create maps.** A successful create produces exactly one `Agent` row with `workspaceId` set and `externalId` from upstream.
- **Create reconciles.** With the local write forced to fail, the response is `AGENT_CREATED_UNASSIGNED`, not a success and not a bare 500.
- **Unassign is not deletion.** After unassign the `Agent` row still exists with `workspaceId = null`, and no upstream delete was called.
- **Unassign is blocked by a campaign.** A campaign row with `agentId` set → 409, and the agent stays assigned.
- **Hard delete requires the right token.** Wrong `confirm` → 400, agent untouched; correct → upstream `DELETE` called once.
- **Upload order.** A non-member's multipart request is rejected without the file being read — asserted by driving the middleware chain, since the point is *when* the check runs, not that it happens.
- **Upload cap and type.** Oversize → 413; disallowed MIME → 415, with no upstream call made.
- **Mirror refresh.** An update whose upstream response changes `agent_name` leaves the mirror holding the new name in the same request.
- **Sync still never assigns.** The existing regression test stays and is extended: a sync must not write `WorkspaceResource` either.
- **Validation passthrough is redacted.** An upstream 400 whose message contains the partner key surfaces with the key masked.
