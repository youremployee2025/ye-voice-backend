# Campaigns — Design

Date: 2026-08-26. Scope: workspace-scoped campaigns, contacts, and CSV contact upload across `ye-voice-backend` and `ye-voice-dashboard`.

## What this slice is

A campaign is a named list of contacts to call, owned by exactly one workspace, with a status and a dialing configuration. This slice manages **campaign state only**: create a campaign, load contacts into it from a CSV, exclude contacts, move the campaign through its lifecycle, and read counts back.

**Nothing here places a call.** Starting a campaign sets its status to `RUNNING` and stops there. The dispatcher that reads `RUNNING` campaigns and dials their `PENDING` contacts is a later slice, and the schema is shaped so that it can be added without a rewrite.

Explicitly out of scope, and deliberately absent from the schema: dispatch and concurrency, per-contact eligibility windows, scheduled retries, inbound routing and DIDs, lead profiles and scoring, read models, reports, analytics, notifications, and webhooks.

Campaign state is owned by this platform. The voice provider's own campaign endpoints are not used — at dispatch time the provider is asked to place individual calls, and the campaign that groups them lives here. That keeps campaign membership, contact status, and workspace isolation under our own tenancy rules rather than a third party's.

## Isolation

Every campaign and every contact belongs to exactly one workspace. Workspace A must never observe workspace B's data.

Two distinct failures, two distinct answers:

| Request | Result | Why |
|---|---|---|
| Caller is not a member of `:workspaceId` | `403 FORBIDDEN` | `requireMembership` already answers this. A 404 would let an outsider probe which workspace ids exist. |
| Caller is a member, but `:campaignId` belongs to another workspace | `404 NOT_FOUND` | The campaign genuinely does not exist *in this workspace*. Confirming it exists elsewhere would leak across the boundary. |

The mechanism is that no query ever looks a campaign up by id alone. Every lookup is `findFirst({ where: { id, workspaceId } })`, so a foreign id returns null and becomes a 404 without a separate ownership check that somebody can later forget to write. Nested resources narrow the same way: a `CampaignContact` is found by `{ id, campaignId }` against a campaign already scoped to the workspace.

## Data model

```prisma
enum CampaignStatus         { DRAFT SCHEDULED RUNNING PAUSED COMPLETED STOPPED }
enum CampaignContactStatus  { PENDING QUEUED CALLING COMPLETED FAILED EXCLUDED }

Campaign         id, workspaceId, name, agentId?, status @default(DRAFT),
                 fromTime?, toTime?, timezone?, defaultCountry?,
                 maxAttempts @default(3), retryDelayMins @default(30),
                 createdAt, updatedAt
                 @@index([workspaceId]) @@index([agentId])

Contact          id, workspaceId, phone, name?, metadata Json @default("{}"),
                 createdAt, updatedAt
                 @@unique([workspaceId, phone]) @@index([workspaceId])

CampaignContact  id, campaignId, contactId, status @default(PENDING),
                 attempts @default(0), lastAttemptAt?, createdAt, updatedAt
                 @@unique([campaignId, contactId]) @@index([contactId])
                 @@index([campaignId, status])
```

Decisions worth stating:

- **`Contact.phone` is unique per workspace, not globally.** `@@unique([workspaceId, phone])`. Two workspaces calling the same person each own their own contact row, with their own name and their own metadata. A global unique on `phone` would make one workspace's upload silently collide with another's — the worst class of tenancy bug, because it looks like a duplicate rather than a leak.
- **`agentId` is a plain `String?` column with no relation.** The `Agent` model is being built in parallel on another branch. Declaring a foreign key now would either fail to migrate or force this branch to define `Agent` and conflict on merge. The index is in place, so adding `agent Agent @relation(...)` later is a one-line schema change plus an `ALTER TABLE ... ADD CONSTRAINT` migration. See "Stitch points".
- **Dialing settings are flat typed columns, not a JSON blob.** The dispatcher will need to ask "which campaigns are inside their dialing window right now", which is a `WHERE` clause over columns. It will also read `maxAttempts` on every retry decision. Prisma types each field, so a misspelling is a compile error instead of an `undefined` discovered at dial time.
- **`Campaign` cascades from `Workspace`; `CampaignContact` cascades from `Campaign`.** Deleting a campaign removes its membership rows but leaves the `Contact` rows alone — a contact outlives any one campaign and may be in several.
- **`Workspace` gains two back-relation fields** (`campaigns`, `contacts`). Prisma requires both sides of a relation to be declared. They emit no SQL and change no existing column.

### Statuses in this slice

`SCHEDULED` and `COMPLETED` are in the enum but no endpoint here produces them. `SCHEDULED` is where the scheduling slice will park a campaign with a future start; `COMPLETED` is what the dispatcher will set when it runs out of contacts. Both are already handled everywhere they can appear — `start` accepts `SCHEDULED` as a source state, and `DELETE` accepts `COMPLETED` — so those slices land without revisiting this code.

Likewise `QUEUED` and `CALLING` are contact states only the dispatcher can set. This slice writes `PENDING` on upload and `EXCLUDED` on removal, and reads all six.

## Phone numbers

Every phone number entering the system is canonicalized to E.164 by a single module before it is stored, using `libphonenumber-js/max` and gated on `isValid()`.

The `/max` entry point is deliberate. The default export ships `min` metadata, whose `isValid()` degrades to little more than a length check in several countries — with it, every 10-digit string validates in India, `5555555555` included. `max` carries the full per-type patterns. The extra metadata size is irrelevant server-side and it is the only reason to use this library rather than a regular expression.

Shape is not validity, and this is the trap the module exists to avoid: prepending a bare `+` to the Indian national number `9109518550` produces `+9109518550`, which satisfies `/^\+[1-9]\d{1,14}$/` and is therefore accepted by a regex check — but it is really country code +91 followed by an 8-digit stub. It is not a phone number. Stored, it fails at dial time, far from the upload that created it.

So:

- Input carrying its own country (`+919876543210`, or `00919876543210`) always keeps it. A default country can never override an explicit one.
- Digit-only input that already contains a country code is accepted (`919876543210` → `+919876543210`). Providers and spreadsheet exports drop the `+` constantly; rejecting these would fail ordinary CSVs for no benefit. This does not reintroduce guessing, because the result must still be parser-valid: `9109518550` → `+9109518550` is invalid and stays rejected.
- A bare national number (`9876543210`) has no country in it. It is interpreted **only** against the campaign's `defaultCountry`, an explicit ISO-3166 alpha-2 the operator sets on the campaign. When `defaultCountry` is null, such a row is rejected with its row number and told to include the country code.
- Letters, extensions, or an interior `+` are rejected outright rather than stripped. Silently deleting characters is how a vanity number becomes a different dial target.

A known limit, accepted deliberately: applying a default country to national-format input is an interpretation, not a proof. India's fixed-line pattern is broad enough that a US national number like `4155551234` validates as an Indian fixed line under `defaultCountry: 'IN'`. No parser can resolve that — a bare 10-digit string genuinely has no country in it. The campaign-level setting at least makes the interpretation the operator's stated intent rather than a constant buried in the code, and leaving it null forces every row to carry its own country code.

## CSV upload

`POST .../campaigns/:campaignId/contacts:upload`, `multipart/form-data`, one `file` field, 10 MB cap, memory storage.

Parsing rules:

- A header row is required. Without it the first contact would be consumed as column names.
- A `phone` column is mandatory; its absence is a `400 CSV_PHONE_COLUMN_MISSING` for the file as a whole, because no row can succeed.
- A `name` column is optional and maps to `Contact.name`.
- **Every other column becomes a key in `Contact.metadata`**, which is what a later slice will feed to the agent as per-call variables. Columns are kept verbatim rather than mapped, so a CSV drives the variables without a separate mapping step.
- Row-level problems never fail the file. An unparseable phone, or a blank one, is reported in `invalid[]` with its row number (counting the header as row 1, so numbers match what a spreadsheet shows) and the rest of the file still loads.

Writing:

- Each valid row upserts a `Contact` on `(workspaceId, phone)` — new phone inserts, known phone updates name and metadata. Re-uploading a corrected CSV refreshes contacts rather than erroring.
- The contact is then attached to the campaign as a `CampaignContact` with status `PENDING`. The `@@unique([campaignId, contactId])` makes the same phone appearing twice in one file, or in a second upload to the same campaign, a **duplicate** rather than an error or a double-dial.
- Upload is permitted while the campaign is `DRAFT` or `PAUSED`. A `RUNNING` campaign is left alone by this slice on purpose: once a dispatcher exists, appending rows to a live campaign needs a concurrency story this slice does not have.

Response: `{ added, duplicates, invalid: [{ row, phone, reason }] }`.

## Lifecycle

Four endpoints, each a guarded transition. An attempt from a status the transition does not allow is `409 INVALID_CAMPAIGN_TRANSITION` — not a silent no-op, because "pause" landing on an already-stopped campaign means the operator is looking at stale state and should be told.

| Action | From | To | Extra guards |
|---|---|---|---|
| `start` | `DRAFT`, `SCHEDULED` | `RUNNING` | `agentId` set; at least one `PENDING` contact |
| `pause` | `RUNNING` | `PAUSED` | — |
| `resume` | `PAUSED` | `RUNNING` | `agentId` set |
| `stop` | `DRAFT`, `SCHEDULED`, `RUNNING`, `PAUSED` | `STOPPED` | — |

`start` requires at least one `PENDING` contact because a campaign with nothing to dial is not running, it is misconfigured, and the operator should learn that at the click rather than from an empty report. `resume` deliberately does **not** carry that requirement: a campaign paused near its end can legitimately have every contact already in flight, and refusing to resume it would be wrong. Both require `agentId`, since a campaign with no agent has nothing to dial *with*.

`stop` is terminal and does not rewrite contact statuses. A stopped campaign's contacts stay `PENDING`, which is exactly what they are — never attempted — and no dispatcher will pick them up, because it selects on campaign status.

`DELETE` is allowed only from `DRAFT`, `STOPPED`, or `COMPLETED`. A `RUNNING` or `PAUSED` campaign is live work; deleting it is a `409`. Stop it first.

## Routes

All under `requireAuth` + `requireMembership`. Reads are open to any member; everything that mutates requires `ADMIN`.

```
GET    /api/workspaces/:workspaceId/campaigns                      member   list, ?status=, with contact counts
POST   /api/workspaces/:workspaceId/campaigns                      ADMIN    create → DRAFT
GET    /api/workspaces/:workspaceId/campaigns/:campaignId          member   detail
PATCH  /api/workspaces/:workspaceId/campaigns/:campaignId          ADMIN    name, agentId, dialing config
DELETE /api/workspaces/:workspaceId/campaigns/:campaignId          ADMIN    DRAFT/STOPPED/COMPLETED only
POST   .../campaigns/:campaignId/contacts:upload                   ADMIN    multipart CSV
GET    .../campaigns/:campaignId/contacts                          member   paginated, ?status=
DELETE .../campaigns/:campaignId/contacts/:campaignContactId       ADMIN    → EXCLUDED
POST   .../campaigns/:campaignId/start                             ADMIN
POST   .../campaigns/:campaignId/pause                             ADMIN
POST   .../campaigns/:campaignId/resume                            ADMIN
POST   .../campaigns/:campaignId/stop                              ADMIN
GET    .../campaigns/:campaignId/stats                             member   counts by contact status
```

Removing a contact sets `EXCLUDED` rather than deleting the row. The row is the record that this person was on this list, and after a dispatcher exists it will also carry attempt history. Deleting it would let the same phone be re-added by the next upload and dialed again, which is the outcome the operator was trying to prevent.

Responses use the existing `{ success, data | error: { code, message } }` envelope. New error codes: `INVALID_CAMPAIGN_TRANSITION`, `CAMPAIGN_NOT_DELETABLE`, `CAMPAIGN_AGENT_REQUIRED`, `CAMPAIGN_REQUIRES_PENDING_CONTACTS`, `CSV_FILE_REQUIRED`, `CSV_PARSE_ERROR`, `CSV_PHONE_COLUMN_MISSING`, `CAMPAIGN_CONTACTS_LOCKED`.

## Dashboard

- **List** — dense table: name, status pill, agent, contact count, created. Status filter tabs. "New campaign" (ADMIN) opens a name-only modal; everything else is configured on the detail page.
- **Detail** — header with name, status pill, and the lifecycle buttons valid for the current status (ADMIN). Three tabs:
  - *Overview*: dialing window, timezone, default country, retry settings, `agentId`.
  - *Contacts*: CSV dropzone → result summary including per-row errors; paginated table with status pills; exclude action.
  - *Stats*: counts by contact status, as plain numbers.
- **MEMBER** sees every page read-only: no create, no upload, no lifecycle buttons, no exclude, and the Overview form is disabled rather than hidden — a member should be able to see how a campaign is configured.

The agent column and the Overview agent field show the raw `agentId` (or `—`) for now, and become a picker at stitch time.

## Testing

Vitest + Supertest against `TEST_DATABASE_URL`, guarded as the existing suite is.

- **Isolation** — a member of A requesting B's campaign by id gets 404; a non-member of B gets 403; list never returns another workspace's rows; a nested contact id from another campaign 404s.
- **CSV** — happy path with extra columns landing in metadata; missing `phone` column; unparseable and blank phones reported with correct row numbers while good rows still load; duplicate phone within one file and across two uploads counted as duplicates; a bare national number rejected without `defaultCountry` and accepted with it; `+9109518550` rejected.
- **Per-workspace phone uniqueness** — the same phone uploaded in two workspaces creates two contacts and neither upload reports a duplicate.
- **Transitions** — the full matrix, each invalid pair asserting 409; `start` without an agent and without pending contacts; `resume` with no pending contacts succeeding.
- **Role gating** — MEMBER can read every GET and is refused on every mutation with 403.

The dashboard's MEMBER read-only behaviour is verified by driving the running app in a browser as an ADMIN and then as a MEMBER.

## Stitch points

Things this branch deliberately leaves open for a later commit:

1. **`Campaign.agentId` → real foreign key.** Once the `Agent` model lands, add the relation and a migration adding the constraint. Decide then whether deleting an agent is `Restrict` (a campaign wired to it blocks the delete) or `SetNull`.
2. **Agent picker in the UI**, replacing the raw-id text input and the raw-id list column.
3. **Dispatcher** — reads `RUNNING` campaigns, respects `fromTime`/`toTime`/`timezone`, moves contacts `PENDING → QUEUED → CALLING → COMPLETED|FAILED`, honours `maxAttempts`/`retryDelayMins`, and sets `COMPLETED` when a campaign runs dry.
4. **Scheduling** — the path that puts a campaign into `SCHEDULED`.
