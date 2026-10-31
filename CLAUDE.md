# CLAUDE.md — ye-voice-backend

API backend for the YE voice-agent platform, built on Vocobase infrastructure. Express + TypeScript + Prisma (Postgres) + Redis. Consumed by `ye-voice-dashboard` (customer app) and `ye-voice-admin` (YE staff app).

## Stack & commands

```bash
npm install
npm run dev        # dev API server (port 3001)
npm run dev:worker # dev queue workers, no HTTP — see Background workers
npm run build && npm run start
npm run start:worker                   # the workers, as their own process
npx prisma generate
npx prisma migrate dev --name <name>   # local dev DB; NEVER `migrate reset` anything but local
npm test                               # Vitest; runs only against TEST_DATABASE_URL
npm run test:prepare                   # apply migrations to the test DB
npx prisma studio
npm run conformance                    # campaign-engine conformance suite; see docs/2026-08-31-campaign-conformance-report.md
npm run battle                         # queue battle test: load, two instances, crash recovery
```

The conformance suite drives the real dial engine on a virtual clock against
the local upstream mock (`../vocobase-mock`, sibling checkout) and grades the
behavior matrix in `docs/plans/2026-08-31-campaign-conformance-design.md`. It
needs the dedicated sim database `ye_voice_conformance` on `localhost:5436`
(migrations deployed) and free ports 3941/4021; it hard-aborts on anything
else. Re-run it after any dialer change — a green table is the campaign
engine's acceptance gate.

The **battle test** is the other half and answers what a virtual clock cannot:
the engine on a real clock, at load, across more than one process. Three
scenarios — multi-campaign concurrency with a utilisation floor, two instances
against one Redis and one Postgres with a SIGKILL mid-run, and queue-failure
semantics — over eleven runs. It needs the dedicated `ye_voice_battle`
database on `localhost:5436`, free ports 4041/3961/3962, and Redis database 11
or 12, all pinned in `scripts/battle-lib.ts` and refused otherwise. It flushes
its Redis database between runs. See
`docs/2026-08-31-queue-workers-battle-report.md`.

## Auth

- **Clerk** verifies the caller: middleware validates the Clerk JWT and yields a `clerkUserId`. Clerk does nothing else — no Organizations, no roles.
- First authenticated request auto-provisions an `Account` row for the Clerk user.
- Workspace-scoped routes then resolve membership: `clerkUserId → Account → WorkspaceMember(workspaceId) → role`, attached to `req` as `{ account, workspace, role }`. Missing membership → 403.
- **Super admin** is a flag on `Account` (`isSuperAdmin`), set only through the staff API (`PATCH /api/admin/accounts/:id/super-admin`) — never from a Clerk session. `requireMembership` admits a flagged account with no membership row into any live workspace as ADMIN (404 for a missing or deleted one), and `requireOwner` honours the same mark; a real membership always wins over the flag. Every non-GET request served through that bypass lands in `SuperAdminAction` — read-shaped POSTs (campaign preview, contact search, agents/sync) included, because the rule is "non-GET", not "mutated something" — as do grants and revokes. **One column, two roles:** `accountId` is who ACTED and `subjectAccountId` is who a grant was done TO, and at most one is ever set — a grant records a null actor because the staff console holds one shared token and naming the recipient there attributed the grant to its beneficiary. The recorder fires on `res.once('close')` **and again directly when `res.destroyed` is already true at attach time**: everything above the hook is awaited, `once` does not replay an event that already fired, and without the catch-up an actor could suppress their own audit row by hanging up. **"A real membership wins" is a presentation rule, not a containment boundary** — it holds within one request, and anyone may leave a workspace, so a flagged MEMBER can drop its own row and take the bypass on the next request; that is not refused (the flag already grants it platform-wide) but the self-removal IS recorded, so the trail never begins mid-escalation. A new owner-only route must gate with `requireOwner()` / `isSuperAdminHere(req)` rather than an inline `ownerAccountId === account.id` compare, which the bypass cannot see. Design: `docs/plans/2026-09-16-super-admin-design.md`.
- Admin routes (`/api/admin/*`) use a separate staff auth, consumed only by ye-voice-admin: an `X-Admin-Token` header compared against `ADMIN_STAFF_TOKEN` in constant time (`src/middleware/adminToken.ts`). An unconfigured token rejects every request — a missing secret must not mean an open door.
- `/api/admin/*` is rate limited ahead of that guard (`src/middleware/rateLimit.ts`), on two budgets: `ADMIN_AUTH_FAILURE_MAX` caps rejected tokens, `ADMIN_RATE_LIMIT_MAX` caps everything. The counter is in-process: with N instances the effective ceiling is N × the cap. Move it to shared storage before mounting it on customer traffic.

## Data model (tenancy core)

```
Account          id, clerkUserId (unique), email, name, credits (BigInt), createdAt
Workspace        id, name, ownerAccountId → Account
WorkspaceMember  id, workspaceId, accountId, role (ADMIN | MEMBER), unique(workspaceId, accountId)
WorkspaceInvite  id, workspaceId, email, role, status, invitedByAccountId
Agent            id, externalId (unique), workspaceId?, name, status, voiceId/voiceName,
                 language, documentCount, variables, rawConfig, lastSyncedAt
```

**Agents** are configured in Vocobase and mirrored here, keyed by the Vocobase
agent id. One partner account means one undifferentiated pool, so a nullable
`workspaceId` maps each agent to **at most one** workspace:

- `workspaceId = null` — unassigned. Invisible to every workspace; reachable
  only through `/api/admin/*`. Workspaces cannot create or claim agents.
- Sync owns configuration, staff own assignment. The sync upsert **never
  writes `workspaceId`** — a refresh that touched it would silently un-share
  every agent.
- Deleting a workspace sets the column null (`SetNull`); the agent returns to
  the pool rather than being destroyed.
- Agents Vocobase stops listing are marked `status = "removed"`, never
  deleted.

**Pooled resources.** Documents, dictionaries, functions and tool connections
are partner-level upstream, not agent-level: listing dictionaries returns every
workspace's, and listing an agent's tools returns every connection on the
platform with the connected account's email on each. `WorkspaceResource`
applies the agent rule to those four:

```
WorkspaceResource  id, kind (DOCUMENT|DICTIONARY|FUNCTION|CONNECTION),
                   externalId, workspaceId, name?
                   unique(kind, externalId)   ← one workspace, enforced by the DB
```

- A resource created through this backend is mapped to the creating workspace
  in the same request. No mapping means invisible to every workspace, exactly
  as an unassigned agent is.
- Every pooled **library listing** intersects upstream's rows with the mapping
  (`filterMapped`); every pooled **action** resolves through
  `resourceInWorkspace`, which 404s identically for foreign, unmapped and
  nonexistent ids.
- **Agent-scoped listings redact rather than intersect.** The dictionaries,
  functions and documents attached to *one agent* — and the tools **bound** to
  one — are listed whole, because hiding a row would misreport what the agent
  actually listens for and calls — but a row this workspace does not own
  arrives with `owned: false` and its identifying content blanked: a
  function's `url` (an address on another customer's network), a dictionary's
  `terms` (their catalogue), a tool's `providerEmail` (the connected account)
  **and its `connectionStatus`** (the live OAuth health of that account — a
  member with a lent agent could otherwise watch another customer's Google
  connection flip EXPIRED → ACTIVE and know when they reconnected).
  Counts stay; they name nothing and the character budget needs them. An
  *owned* row keeps all of it, redaction never having touched it, so a member
  still gets a health signal everywhere they are entitled to one.
  - The blanked-field list lives beside the allow-list it shadows, in
    `serialize.ts` (`redactUnowned` and `TOOL_SENSITIVE`), so that adding a
    field to a projection puts the question "and on a redacted row?" in front
    of whoever adds it. Do not hand-roll a redaction in a route.
  - Only *bound* rows are kept-and-redacted. **Attach candidates still
    intersect** the mapping: a workspace with nothing mapped has genuinely
    nothing to attach, and that is a true empty rather than a hidden one.
  - `owned: false` means "a connection, and not this workspace's". A row with
    no connection behind it at all — a built-in like `end_call` — is `owned:
    true`: it is the workspace's to switch, and calling it unowned hands them
    their own tool labelled as someone else's. **That carve-out applies to
    both halves.** Intersecting the candidate half alone dropped a built-in
    the moment it was switched off — the row left the list, and the control
    that switched it off was the last one able to switch it back on.
  - The rule is one predicate (`toolOwnership` in `agents.routes.ts`), asked
    once per payload and used by both the listing and the tool `PUT`, so the
    ownership a member is shown and the ownership the server enforces cannot
    drift apart.
- **Ownership is claimed, never taken.** `claimResource` (the customer path,
  reached only with an id upstream just minted) refuses if the id already
  belongs to another workspace — a platform that de-duplicates on create would
  otherwise transfer someone else's resource silently. `reassignResource` is
  the staff path and the only one that may move a mapping; `renameResource`
  can relabel but not move.
- **An agent is stripped before it changes hands.** `detachForeignResources`
  (`services/agentHandover.ts`) runs on staff reassignment and on staff
  onboarding (`services/onboarding.ts`) and detaches
  everything the incoming workspace does not own — fail-closed, so an agent
  that cannot be stripped is not moved. Without it a lent agent arrived
  carrying the previous tenant's knowledge base and went on answering calls
  out of it. Documents are unlinked, never deleted: the file is still theirs.
- **A create that cannot be recorded says so.** `claimCreated` retries once and
  then answers 502 `RESOURCE_CREATED_UNMAPPED`, whose message says not to try
  again. An unmapped agent still shows in the staff pool; an unmapped
  dictionary, function or document is visible to nobody and billed to someone,
  so the three sibling paths need this more than the agent path does.
- `CONNECTION` is the one kind a workspace cannot create — connecting an
  integration is an OAuth flow outside this platform — so connections are
  staff-assigned, like agents.
- `onDelete: Cascade`, unlike `Agent`'s `SetNull`: an agent is lent to a
  workspace and outlives it, while a dictionary that workspace created has no
  meaning once it is gone. The upstream resource still survives; only the
  mapping goes.
- The mapping is **not** a mirror. It holds an id and a label, never content.

**Error mapping is part of isolation.** `unwrap` in the adapter passes an
upstream 404 through as a 404 (a resource already gone is not an outage, and
flattening it to 502 stopped callers cleaning up the row pointing at it), and
answers 409 with `NAME_TAKEN` — *"that name is already in use"*, never "an
agent with that name exists", because the colliding agent is usually another
workspace's and confirming it would make create a name-enumeration oracle over
the whole partner account. The 400 passthrough still carries upstream's wording
so a caller learns what to fix, but runs through `scrubIdentifiers` first: the
credential redaction never protected another workspace's entity ids. A write
whose response never arrives is 502 `UPSTREAM_WRITE_UNCONFIRMED` rather than
"could not reach the platform" — for a create the second reads as *nothing
happened*, and the caller retries into a duplicate.

**Body and upload limits are sized from what the routes accept.**
`express.json({ limit: '1mb' })`, because `agentPayload` allows a 120,000-char
prompt and a pasted knowledge source allows 200,000 — at the 100kb default the
product's flagship field was unusable in the top sixth of its documented range,
and failed as a 500. `errorHandler` maps body-parser's own failures to 413
`PAYLOAD_TOO_LARGE` and 400 `MALFORMED_JSON`. The upload route bounds `fields`,
`parts` and `fieldSize` as well as `fileSize`: multer leaves the first two at
`Infinity`, so a request with no file at all was bounded by nothing.

**Every write route is rate limited** (`lib/writeLimiter.ts`, 120/min per
workspace, applied after `requireMembership` so an unauthenticated caller
cannot spend a workspace's budget, and before multer so a body is not buffered
first). Each write spends calls against a partner rate limit every customer on
the platform shares.

Permission matrix (owner and ADMIN are equivalent inside a workspace):

| Action | Owner/ADMIN | MEMBER |
|--------|:-----------:|:------:|
| Use agents/campaigns/sessions | ✅ | ✅ |
| **Create/edit agents, tools, KB, dictionaries, functions** | ✅ | ✅ |
| **Remove an agent from the workspace** | ✅ | ✅ |
| Invite members / change roles | ✅ | ❌ |
| Manage billing / view credits admin | ✅ | ❌ |
| Rename/delete workspace | ✅ | ❌ |

**The two bold rows are a deliberate deviation, not an oversight.** Everywhere
else in this service a write is ADMIN-only — campaigns, members, invites,
billing. The agent surface is not, because an agent's prompt is the working
material of this product: requiring an admin to change a sentence in one would
make the product unusable for the team that operates it, and would push
everyone toward being made an admin, which is worse for every other row in this
table. The blast radius is bounded by design — removal returns an agent to the
pool rather than destroying it, upstream deletion is staff-only, and nothing on
the surface spends credits or reaches another workspace. Narrowing it later is
one `requireMembership('ADMIN')` on the routes concerned.

All product resources (agents, campaigns, calls, documents…) carry a `workspaceId` and every query filters by it. Never trust a workspaceId from the body alone — it comes from the resolved membership.

## Campaigns

A campaign is a named list of contacts to call, owned by one workspace, with a
status and a dialing configuration. Starting one now **reaches the platform and
begins dialing** — see [Outbound dialing](#outbound-dialing) for the gates
`start` enforces and what the sweep does with a `RUNNING` campaign.

```
Campaign         id, workspaceId, name, description?, status,
                 agentId? → Agent,
                 phoneNumberId? → PhoneNumber   ← legacy head of the rotation
                 fromTime?, toTime?, timezone?, dialDays Int[], defaultCountry?,
                 retryCount, cooldownMinutes, retryDelaysMinutes Int[],
                 concurrencyLimit, retryConcurrency, callbackEnabled,
                 variableMap Json?, rrCursor,
                 leadBucketKey?, wonBuckets String[],
                 stoppedAt?, scheduledStartAt?, scheduleError?,
                 totalContacts, completedCount, failedCount, skippedCount,
                 startedAt?, pausedAt?, completedAt?
CampaignPhoneNumber
                 id, campaignId, phoneNumberId, position
                 unique(campaignId, phoneNumberId)
                 unique(campaignId, position)
Contact          id, workspaceId, phone (E.164), name?, email?,
                 tags String[], metadata Json
                 unique(workspaceId, phone)   ← per workspace, not global
CampaignContact  id, campaignId, contactId, status, attempts, lastAttemptAt?,
                 nextEligibleAt?, callbackAt?, callbackCount, lastSessionId?,
                 disposition?, answeredBy?
                 unique(campaignId, contactId)
```

`CampaignStatus` is `DRAFT | RUNNING | PAUSED | COMPLETED | STOPPED |
CREDIT_EXHAUSTED`, plus a `SCHEDULED` that **nothing writes any more** — a
scheduled start lives in `scheduledStartAt` so a restart cannot lose it — but
Postgres cannot drop an enum member, so `start` and `stop` still accept it as a
from-state for rows written before the column existed.

`CampaignContactStatus` is `PENDING | QUEUED | CALLING | COMPLETED | FAILED |
EXCLUDED | SKIPPED`:

| Status | Meaning |
|---|---|
| `PENDING` | waiting — fresh, cooling down, or armed for a promised callback |
| `QUEUED` | claimed by the dispatcher; a dial is being placed, or is in flight |
| `CALLING` | inert. Nothing writes it; every read treats it as live beside `QUEUED` |
| `COMPLETED` / `FAILED` | settled |
| `SKIPPED` | swept out by the campaign — stopped, or the retry budget lowered |
| `EXCLUDED` | an operator removed this contact |

The last two are deliberately different words for what looks like one thing.
`SKIPPED` is something the campaign did; `EXCLUDED` is something a person did,
and only the second decrements `totalContacts` — a contact swept out of a
stopped queue is still on the list somebody uploaded.

**`CampaignContact.attempts` counts RETRIES CONSUMED, not dials made.** The
first dial does not increment it and neither does a callback; only the retry
re-arm at resolution time does, and it is compared against `Campaign.retryCount`
which counts the same thing. Anything reading it as "calls placed" is wrong by
one on every contact, and by more on any contact that was called back. The dial
ordinal is `CallAttempt.attemptNo`, derived as `MAX(attemptNo) + 1` per contact
and unique per contact — which is what makes it the dial mutual-exclusion token.

| Route | Role | Notes |
|-------|:----:|-------|
| `GET /api/workspaces/:id/campaigns` | member | `?status=`; contact counts, a per-campaign `outcomes` and `leadBuckets` |
| `POST /api/workspaces/:id/campaigns` | ADMIN | creates a `DRAFT` |
| `GET /api/workspaces/:id/campaigns/:cid` | member | |
| `PATCH /api/workspaces/:id/campaigns/:cid` | ADMIN | gated by status — see [Editing a campaign](#editing-a-campaign) |
| `DELETE /api/workspaces/:id/campaigns/:cid` | ADMIN | any status; `CallAttempt` history survives |
| `POST .../campaigns/:cid/duplicate` | ADMIN | `{ name? }` → a fresh `DRAFT`, 201 |
| `POST .../campaigns/:cid/contacts:upload` | ADMIN | multipart CSV; any campaign that was not stopped |
| `POST .../campaigns/:cid/contacts` | ADMIN | top-up: exactly one of `contactIds`, `tagFilter`, `selectAll` |
| `GET .../campaigns/:cid/contacts` | member | `?status=`, `?queue=`, `?search=` (phone or name, ≤100 chars), `?limit=` (≤100, def 50), `?offset=` |
| `GET .../campaigns/:cid/contacts/:ccid/journey` | member | one contact's whole history |
| `DELETE .../campaigns/:cid/contacts/:ccid` | ADMIN | marks `EXCLUDED`, does not delete |
| `POST .../campaigns/:cid/{start,pause,resume,stop}` | ADMIN | guarded, invalid → 409 |
| `POST .../campaigns/:cid/complete` | ADMIN | relabels a `STOPPED` campaign |
| `POST .../campaigns/:cid/schedule` | ADMIN | `{ startAt }`, `DRAFT` only |
| `DELETE .../campaigns/:cid/schedule` | ADMIN | clears the schedule and its error, any status |
| `GET .../campaigns/:cid/stats` | member | counts, dispositions, credits, and a live dialer block |
| `GET .../campaigns/:cid/attempts` | member | paginated; allow-listed projection |
| `GET .../campaigns/:cid/inbound-calls` | member | the calls an inbound-facing campaign received, newest first; `?page`, `?limit`; empty on OUTBOUND |
| `GET .../campaigns/:cid/inbound-activity` | member | when those calls arrived, as a UTC quarter-hour grid; `?days` (1-90, def 14); zeroes on OUTBOUND |
| `GET /api/workspaces/:id/contacts` | member | the library, for the top-up picker: `?search=`, `?excludeCampaignId=`, `?limit=` (≤100, def 50), `?offset=` |
| `GET /api/workspaces/:id/contacts/tags` | member | every tag in the workspace's library, for the by-tag panel |
| `GET /api/workspaces/:id/do-not-call` | member | the workspace's opt-out list: `?search=` (phone), `?limit=` (≤100, def 50), `?offset=` |
| `DELETE /api/workspaces/:id/do-not-call/:rowId` | ADMIN | unlists a number. Does NOT re-open contacts already settled `EXCLUDED` |

The do-not-call list is written by the dialer off a model's answer, read
loosely, and is workspace-wide, permanent, and checked by the claim in every
lane of every campaign — current and future. Those two routes exist because
read-only automation with that reach and no way to inspect or undo it means one
hallucinated extraction bars a number for ever, with production SQL as the only
remedy. Unlisting makes the number dialable again on the next pass; the
`CampaignContact` rows the exclusion already settled stay `EXCLUDED`, which is
the same word an operator's own remove writes and is the top-up's to reverse.

Isolation: every campaign lookup is `findFirst({ where: { id, workspaceId } })`
via `campaignInWorkspace()`. An id from another workspace finds nothing and
404s. A workspace the caller is not a member of still answers 403, from the
membership middleware. Never look a campaign up by id alone.

Phone numbers are canonicalized in `src/lib/phone.ts` — full parser metadata,
gated on validity rather than shape, and never guessing a country code from a
constant. A number with no country of its own is interpreted only against the
campaign's `defaultCountry`, and rejected when that is unset.

### Inbound campaigns

An `INBOUND` campaign answers on the DIDs it claims and never dials; `BOTH`
does both. Three rules hold the inbound half together, and each was a bug
before it was a rule:

- **The routing webhook (`POST /webhooks/vocobase/inbound-route`) writes
  nothing before it responds.** The platform holds a live caller for at most
  `timeout_ms` while it waits, and the user hears every millisecond as ring
  time. `decideInboundRoute` makes the decision from reads alone and hands the
  arrival write back as a thunk; the handler runs it AFTER `res.json`,
  best-effort. `flushInboundArrivals()` is the test seam. Do not put a write,
  an upstream call or the job queue on this path.

  The budget is **three logical reads, six round trips** — count the round
  trips, not the `await`s. The schema has no `relationJoins` preview feature,
  so Prisma loads every relation as its own query: the number lookup fans out
  to `PhoneNumber` + `CampaignInboundClaim` + `Campaign`, the contact lookup to
  `CampaignContact` + `Contact`, and `goalSnapshot` is a sixth. All six are
  index-backed (`PhoneNumber.did`, the claim PK, the campaign PK,
  `Contact @@unique([workspaceId, phone])`, `CampaignContact
  @@index([campaignId, status])`, `CampaignContactGoal.campaignContactId`) and
  that is the property to preserve. Adding a nested `select` is not free here.
- **The settle is the source of truth, not the arrival.** `session.completed`
  finds the arrival row by call id, session id, or the open row for that
  caller on that DID; when none exists and the completion is explicitly
  inbound on a DID a campaign holds a claim on, it recreates the row from the
  claim (dated end minus duration) rather than logging an unknown call.
- **The two events do not share an id, and the row carries both namespaces.**
  The routing policy carries ONLY the carrier's `provider_call_id`
  (`upstreamCallId`); `session.completed` carries only Vocobase's own
  `call.call_id` (`upstreamPhoneCallId`) and `session_id`. The settle stamps
  the two it learns, and that stamping is what makes a REDELIVERED completion
  settle the same row instead of fabricating a second one — the number-based
  fallback cannot match twice, because the first delivery closed the row, and
  every idempotency guard on the charge is keyed on the row id, so a second row
  is a second debit. `upstreamPhoneCallId` is also the only one of the two that
  `GET /calls/:id` accepts, so it is what the calls tab links to.
- **Billing goes before enrichment.** The settle charges, then enrols, re-bases
  and records the goal. Everything after the charge is allowed to fail; the
  minutes already happened, so none of it may sit between the call and its
  debit.
- **Strangers are enrolled at settle, on `INBOUND` campaigns only.** A caller
  nobody uploaded becomes a `Contact` (upserted on workspace + phone) and a
  `CampaignContact` settled `COMPLETED`, carrying **the call's own
  disposition** — not a hardcoded `completed`, which would report a greeting
  hangup as a conversation and feed `last_outcome: completed` into that
  caller's next prompt. `BOTH` keeps the uploaded list as the dial list and
  enrols nobody. Enrolment is idempotent; a second call reuses the row.

  What makes an enrolled caller undiallable is the **status**, not the
  campaign's type — `type` is not in `MID_CAMPAIGN_EDITABLE_FIELDS`, so it is
  locked only while the campaign is RUNNING/PAUSED/CREDIT_EXHAUSTED and a
  STOPPED `INBOUND` campaign can be switched to `BOTH` and restarted. Nothing
  moves a settled row back to `PENDING`, and that is the invariant to keep.

**What an inbound-facing campaign reports.** `outcomes.inbound` on the list
and `inbound` on `/stats` carry `{ calls, callers, unknownCalls, talkSecs,
lastCallAt }` from one grouped statement over `CampaignInboundCall`
(`src/lib/campaignInboundStats.ts`); `/stats` adds `credits`, summed from the
ledger on the inbound call's id as `reference` so a shortfall never counts.
Both are **absent** on an `OUTBOUND` campaign, never zeroed. The contacts
endpoint carries `inbound: { calls, talkSecs, lastCallAt }` per row on
inbound-facing campaigns, and `GET .../inbound-calls` pages the calls
themselves. `/stats` also carries **`billedCalls`** beside `credits` — the
denominator that figure is actually over, which on a campaign holding imported
history is not `calls`: 135 of the 137 calls on the first campaign this ran
were billed on the platform before YE existed, so `25.9 credits` against
`137 calls` read as arithmetic that does not work while every figure was
right. The outbound `outcomes` block, the ring and the lead buckets still read
`CallAttempt` only — an inbound call is not a dial.

**The `inbound` block on the campaign analytics report** (`campaignAnalytics`,
`src/services/analytics.ts`) is the range-scoped counterpart, and it exists
because every other figure that report produces for an INBOUND campaign is a
truthful zero about dialing. Three rules a reader needs:

- **Present only for an inbound-facing campaign**, so BOTH gets it beside its
  dialing figures. **Absent, never zeroed, on OUTBOUND** — a zero would assert
  that a campaign which answers calls took none. Spread into the literal rather
  than assigned, because a bare `undefined` key is dropped by `JSON.stringify`
  and still answers `'inbound' in report`.
- **Ranged and grouped on `arrivedAt`**, not `startedAt` (there is none) and not
  `endedAt`. A call that arrives at 23:58 and hangs up at 00:04 belongs to the
  first day: the question is when the phone rang. `arrivedAt` is also never
  null, so an open call is on the chart rather than missing until it settles.
- **Credits come from the ledger**, joined on the inbound call's id as
  `reference` and pinned to the owner account — `CreditTransaction` has no index
  on `reference` alone, only `@@unique([accountId, reference])`, so an unpinned
  join is a full scan of the production ledger. The range is the CALL's arrival,
  never the ledger row's own clock: a charge lands after its call, so scoping on
  the ledger's timestamp would drop the last day's calls out of the money column
  while leaving them in the call count beside it.

`ALL_TIME` is the sentinel the lifetime callers pass (`/stats`, the campaign
list). `avgTalkSecs` divides by the calls that HAVE a duration, and both it and
`creditsSpent` are `null` rather than `0` when there is nothing to divide or
nothing was charged.

**`GET .../inbound-activity` is when those calls ARRIVED**, as a grid of
fixed buckets rather than a per-day series, because the Overview draws two
charts off it — today hour by hour, and the last fortnight day by day.

- **Fifteen minutes, and the grid is UTC carrying no time zone.** Every IANA
  offset is a whole multiple of fifteen minutes, so a local hour anywhere is
  exactly four buckets and a local day exactly ninety-six; one grid answers both
  charts, where bucketing by day here would need a second grouping for the
  hourly half — and two groupings of one window is how two charts on one page
  come to disagree about which calls happened when. A zone is not needed here
  rather than unavailable: `resolvePgTimeZone` would resolve one safely, and
  this path does not ask the question.
- **`floor(extract(epoch from "arrivedAt") / 900)` takes the BARE column**, the
  rule `inboundSeries` writes down at length: `arrivedAt` is a naive timestamp
  already holding UTC, and Postgres reads a `timestamp without time zone`'s
  epoch as UTC regardless of the session's `TimeZone`. An `AT TIME ZONE` on
  either side would make the grid depend on the connection.
- **The payload is bounded by the WINDOW, never by the call volume** — a
  fortnight is 1,440 integers whether the DID took ten calls or ten thousand.
  Shipping arrival timestamps would have been simpler and would have grown
  without limit on exactly the campaigns that most need the chart.
- **`days + 1` days of buckets come back, and the extra day is at the FRONT.**
  A caller assembling `days` whole LOCAL days out of a UTC grid needs slack to
  reach back past its own midnight, so `since` is one day earlier than the
  window asked for while `until` is the current bucket's end with no slack
  after it — there are no future arrivals to leave room for. `days` echoes the
  number ASKED FOR, so a client that slices `buckets.slice(0, days * 96)` takes
  the wrong end: use `since`/`until`, which are both on the wire.
- **`outcomes` is the agent's own verdict over the `days` asked for**, NOT over
  the slack day beside them. The grid carries the slack and no client draws it;
  counted in the breakdown it put a verdict total on the card that the bars
  beside it, under the same stated window, could not add up to. Whole UTC days
  rather than the reader's local ones, because this route takes no zone — so
  the two windows can still sit up to fourteen hours out of step at the far
  edge, and both describe "the last N days" to within a partial day. Exact
  agreement would need the caller's zone.
- **`firstCallAt` is lifetime beside the window, and workspace-scoped.**
  "Nobody rang this fortnight" and "nobody has ever rung this number" want
  different sentences on the page, and a window of zeroes cannot tell them
  apart. It is scoped to the workspace like the two reads beside it, which
  matters because `GET .../inbound-calls` is scoped on `campaignId` ALONE: on a
  campaign whose history was written under a different workspace — a
  reassigned DID, or a staff transfer, neither of which remaps
  `CampaignInboundCall` — the calls list shows the history and these three
  answer empty. Fails closed, never leaks, and the two ought to be made to
  agree.
- `days` is **clamped, truncated, and junk falls back to 14** rather than
  400ing: this is a chart, and the shape of the URL is not something the reader
  chose or can fix. A bare `?days=` reads as absent rather than as the minimum.
  The truncation is load-bearing — a fractional `days` would take `since` off
  the bucket grid and land every row one bucket out.

**A live inbound campaign's numbers are locked.** `PATCH` refuses a
`phoneNumberIds` change on a RUNNING, PAUSED or CREDIT_EXHAUSTED inbound-facing
campaign with **400 `CAMPAIGN_INBOUND_NUMBERS_LOCKED`**. The DID claim is taken
once, in `runInboundStart`, and released at pause and stop; nothing re-claims on
a settings save, so the change would leave `CampaignInboundClaim` on the old
number while the campaign answered a DID its own settings no longer named.
Refused rather than made to re-claim, because the claim is all-or-nothing across
every DID and retaking it mid-flight means a window answering on neither. Keyed
on `changedBy`, so resubmitting the numbers a campaign already holds is not a
change — the dashboard posts the whole form back on every save.

### What a waiting contact is waiting for

> **`armKind` is the answer to "why is this row's clock set, right now", and it
> is the only answer.** Written by every re-arm path, and meaningful only while
> `status = PENDING` — every reader pairs the two, and a settled row keeps
> whatever it last carried. `FRESH` is waiting for nothing more specific than
> its turn, `RETRY` is a number that did not pick up, `FOLLOW_UP` a
> conversation waiting on its second half, `RESUME` a call the engine chose to
> place again because the line dropped, and `CALLBACK` a time a person on the
> phone actually named.

The load-bearing distinction is `RESUME` against `CALLBACK`. **A resume is not
a promise**, and nothing customer-facing may describe one as something the lead
asked for — not the queue tabs, not `callbackPending` on the journey, not
`callbacksPending` in stats, and not the attempt `kind` an operator reads back
months later.

The column exists because nothing already on the row could answer the question.
`followUpCount` is a lifetime tally, so a plain retry of a contact that was once
followed up read as a follow-up for ever. And `nextEligibleAt == callbackAt` —
the pair that used to be called "the sole marker of an armed callback" — was
briefly widened to cover the immediate resume, on the argument that both are a
time somebody is owed; that is precisely what made a dial the engine chose
indistinguishable from one a person asked for, everywhere at once. Both
questions are about the arming in force *now*, so they get a column that says
so.

**`callbackAt` therefore keeps its narrow meaning**: written by a real promise
and by nothing else, and kept afterwards as history. A retry, a follow-up and
an immediate resume all move `nextEligibleAt` alone. So the
presence of `callbackAt` proves somebody was once promised a call, never that
they are still owed one — which is the whole reason the question is asked of
`armKind` instead.

Readers: the dispatcher's claim lanes and its retry-budget exemption
(`CALLBACK` only — a `RESUME` is **not** exempt), the retry-lowering sweep's
exemption, the `?queue=` filters, the journey and stats. Writers: every re-arm
path, plus the launch give-back (three branches, below), which preserves the
arming a transient failure interrupted rather than resetting it.

**The lanes are budgeted, not just ordered.** The callback lane draws from the
whole pass budget, because a promise outranks a reservation — bounded, since
2026-09-07, by `Campaign.retrySharePercent`: the urgent lanes (`CALLBACK` and
`RESUME`) may take at most `100 - retrySharePercent` of any pool the pass
divides, so a herd of promises falling due on one instant cannot take every
line while retries wait. At the column default of 0 the bound is the whole
pool and nothing changes. The resume lane draws from the **retry** reservation
and shares it with retries, so a burst of dropped calls cannot take every slot
and starve fresh contacts.

**The resume lane is behind `IMMEDIATE_RESUME_ENABLED`, off by default since
2026-09-08.** The `immediate_callback_needed` extraction over-reports drops —
one- and two-second calls came back flagged — so `wantsResume`
(`src/lib/immediateResume.ts`), the one rule both `resolveOutcome` and the
re-extraction planner ask, answers false for every note while the switch is off.
A reported drop then takes the FOLLOW_UP lane on the retry ladder, exactly as a
`flexible` does, and `lastImmediateAt` is never stamped. Rows already armed
`RESUME` are not rewritten: the lane still claims them. Everything below
describes the lane when the switch is on.

**A resume fires once an hour, not once a gap.** `CampaignContact.lastImmediateAt`
is stamped by every immediate re-arm with the instant the note said
`immediate`. A second immediate inside `IMMEDIATE_REPEAT_WINDOW_MINUTES` (60,
fixed in `src/lib/campaignConfig.ts`, deliberately not a campaign knob) of that
stamp is armed a whole window out from *now* — still `RESUME`, still spending a
dial — and moves the stamp, so a line that keeps dropping is rung on the gap,
then hourly. One that lands after the window has closed is a fresh drop on
`IMMEDIATE_CALLBACK_MINUTES` again. A follow-up or retry between two drops
leaves the stamp alone.

**The three-clause negation is gone with the pair, and that is a reason in
itself.** "Not armed" against the timestamps was `callbackAt IS NULL OR
nextEligibleAt IS NULL OR nextEligibleAt <> callbackAt`, spelled out because
SQL's `NOT (a = b)` is NULL when either side is NULL and a NULL predicate
excludes the row — so the short form silently dropped exactly the contacts the
query existed to find, and every new reader had to be told. `armKind` is
`NOT NULL` with a default, so the negation is one inequality
(`armKind <> 'CALLBACK'`) with no null arm to lose a row down. If a pair
comparison ever comes back, so does the three-clause rule.

### The dialing policy

Owned by `src/lib/campaignConfig.ts`, for create and update alike, and
deliberately **not** by the route's zod schema: these fields clamp,
cross-reference each other, or need an error naming the exact bound, and two
places deciding the same range is how the create path and the update path come
to accept different campaigns.

| Field | Rule |
|---|---|
| `retryCount` | integer in [0,20]. **Retries after the first call**, not dials. 0 means one call and no more |
| `cooldownMinutes` | integer in [1,10080]. The wait when the ladder has no entry. 0 is refused — it is a redial the instant a call hangs up |
| `retryDelaysMinutes` | ≤20 entries, each in [0,10080]. Element *i* is the wait before retry *i+1*; entries that run out fall back to `cooldownMinutes`. 0 IS legal here and means "on the next tick" |
| `concurrencyLimit` | integer, **clamped** to [1,50] — historical behaviour of this field, kept. Not a capacity grant: `Account.concurrencyLimit` is what YE sells and is the ceiling that actually binds, so a campaign set to 50 on an account allotted 8 dials 8. `clampCampaignConfig` (the duplicate path) reads the same constant rather than spelling the bound out again |
| `retryConcurrency` | integer in [0, the *merged* final `concurrencyLimit`]. Lowering the limit below a stored reservation without also lowering the reservation is refused, in a message naming both |
| `goalEnabled` | **accepted, stored, and read by nothing.** Follow-ups are always on since 2026-09-06: every campaign chases an unfinished conversation until its dial budget runs out. Unlike `callbackEnabled` below, the value IS still written — the column is honest compatibility storage — but the API answers `true` whatever it holds, because a payload echoing a stored `false` would tell an older dashboard build that a campaign does not follow people up when it does |
| `maxTotalDials`, `immediateCallbackMinutes` | **accepted, bounds-checked, stored, and read by nothing.** Same release, same reason. What replaced each: the dial ceiling is `totalDialsFor` (`retryCount + maxGoalFollowUps + 1`) in `src/lib/dialBudget.ts`, and the resume gap is the fixed `IMMEDIATE_CALLBACK_MINUTES` (3). The API answers both with those effective values |
| `maxGoalFollowUps` | integer in [0,15]. **LIVE again since 2026-09-09**: how many more calls a contact gets once somebody has ANSWERED, spent by every dial after that first conversation — answered or not. 0 settles an unfinished conversation at once. Echoed as stored, and mid-campaign editable. See [Two lanes](#two-lanes-two-budgets-and-a-daily-cap) |
| `followUpDelayHours` | integer in [1,168]. **LIVE again since 2026-09-09**: the wait between follow-ups, rolled into the dialing window. The retry ladder times no-answers only |
| `maxDialsPerDay` | integer in [1,10], default 2. **New 2026-09-09**: the most placed dials one contact may take in one calendar day of the campaign's `timezone`. Every arm counts except a `CALLBACK` the person asked for. Enforced by the claim alone — a contact at the cap waits for the next local day and is never settled by it |
| `callbackEnabled` | **accepted and ignored; callbacks cannot be turned off.** The type is still checked — a non-boolean is a 400, because `"false"` is a truthy string and a body carrying it was built by something that believes the switch still exists — but the value is discarded and never written, on create and on update alike. The switch is off every screen and every stored `false` is backfilled, so the only body still carrying the field is a dashboard from before that release; a 400 would fail a save the operator did make, and storing the value would recreate one campaign at a time exactly the state the backfill cleared. The validator stays whole, so re-adding a control is putting the write back rather than writing it again |
| `dialDays` | ≤7 integers in [0,6], each named at most once. Refused rather than deduped, the rule `wonBuckets` follows. **`null` is accepted as an alias for `[]`** and normalised in the schema, so nothing downstream sees one and the column stays `NOT NULL` — every other window field is nullable, and a form clearing the whole window sends four nulls |
| `variableMap` | flat object, CSV header → agent variable; **values** match `^[a-zA-Z_][a-zA-Z0-9_]*$`. `null` clears, as SQL NULL, so `variable_map IS NULL` stays a reliable "no mapping" |
| `leadBucketKey` | one of the extraction key names the campaign's agent declares, checked against the agent the request *leaves behind*. `null` clears. Refused when the campaign has no agent |
| `wonBuckets` | ≤40 names, each ≤100 chars, non-blank, unique **case-insensitively**. Free text — a bucket is whatever a model wrote, and pinning a key's answers is optional. Refused when the merged row would have won buckets and no `leadBucketKey` |

**Reject, don't clamp** is the rule everywhere except the two exceptions above
and `duplicate`, which re-clamps every copied number: nobody typed those values
into that request, and refusing the copy would leave the operator unable to make
one at all over a value they cannot see.

#### Two lanes, two budgets, and a daily cap

**A contact is in one of two lanes, and history decides which: whether anybody
has ever answered.** `hasSpokenAttempt` over the goal attempt log is the
question, asked in `resolveContact`, and the first answer moves a contact into
the follow-up lane **for good**.

| Lane | Who | Budget | Wait | Runs out → |
|---|---|---|---|---|
| **Retry** | a number nobody has answered | `retryCount` | `retryDelaysMinutes[attempts] ?? cooldownMinutes` | `FAILED` |
| **Follow-up** | a contact somebody answered | `maxGoalFollowUps` | `followUpDelayHours`, rolled into the window | settle, `goalAchieved = false` |

**The retries are forfeited the moment somebody picks up.** A reached contact's
`attempts` is frozen wherever it stopped, the claim exempts a `FOLLOW_UP` row
from the retry clause, and `maxGoalFollowUps` is the only budget it still
spends. That is the honest reading of what each number means: the ladder says
how patient to be with a *number*, and a conversation that happened is not
evidence the number is unreachable — it is evidence a *person* is there, whom
one goes back to less often and further apart.

**A follow-up that goes unanswered spends a follow-up**, not a retry. It is a
missed follow-up, and putting it back on the minutes ladder beside a number
that has never picked up is exactly the complaint this replaced.

`maxGoalFollowUps = 0` settles a reached-but-incomplete contact at once. There
is no on/off switch; zero is the off position.

**The absolute ceiling is `retryCount + maxGoalFollowUps + 1`**
(`totalDialsFor`, `src/lib/dialBudget.ts`), which the API reports as
`maxTotalDials`. No contact can reach it — the two budgets are never spent by
the same contact — so it is the cap over both lanes rather than a budget of its
own, and it is the one bound a promised `CALLBACK` does not escape.

**`maxDialsPerDay` (1–10, default 2) caps placed dials against one contact in
one calendar day of the campaign's own timezone**, from `localDayStart`
(`src/lib/dialingWindow.ts`). Counted in the campaign's zone because "two calls
a day" is a promise about the *callee's* day: counted in UTC it would roll over
at 05:30 in India, mid-morning. An armed `CALLBACK` is exempt, and a `callback`
attempt is not counted.

**The cap is enforced by the claim and by nothing else, and it settles
nothing.** A contact at its cap has run out of *nothing* — it is simply not
their turn again today — so unlike the two budgets there is no sweep beside it
and no settle: the row waits for the next local midnight and is claimable
again. A sweep that read the cap would end a person's campaign over a clock
that resets in hours.

Each budget has its own sweep for a lowered value, because the claim's refusal
alone would leave the row PENDING for ever and the campaign unable to complete:
`sweepContactsOverRetryBudget` (which exempts `FOLLOW_UP` and `CALLBACK`) and
`sweepContactsOverFollowUpBudget` (which touches `FOLLOW_UP` only), both in
`src/lib/campaignLifecycle.ts`, plus `settleContactsOverDialBudget` for the
ceiling. All three run on the PATCH that can move either budget.

What is still retired, and what came back:

| Column | Status |
|---|---|
| `goalEnabled` | **retired.** Always on; the API answers `true` whatever it holds |
| `maxTotalDials` | **retired.** The API answers `totalDialsFor(campaign)` |
| `immediateCallbackMinutes` | **retired.** The gap is the fixed `IMMEDIATE_CALLBACK_MINUTES` (3), and the once-an-hour throttle beside it is unchanged |
| `maxGoalFollowUps` | **live again since 2026-09-09**, 0–15, echoed as stored. The follow-up lane's budget |
| `followUpDelayHours` | **live again since 2026-09-09**, 1–168, echoed as stored. The follow-up lane's wait |
| `maxDialsPerDay` | **new 2026-09-09**, 1–10, default 2, echoed as stored |

All three live ones are mid-campaign editable, for the reason `retryCount` is:
the dispatcher re-reads them on its next pass and none of them contradicts a
call already placed.

The ladder is still indexed by the **retry** counter and not by the dial
ordinal, so a contact that spent two retries before anybody answered still
indexes the rung it is actually on — though after that answer it never waits
the ladder again.

**Every campaign's agent carries the call-note set.** `prepareCampaignAgent` has
one branch now, run at start, at resume, and by the boot sweep in
`campaignAgentSweep`, which re-prepares every RUNNING campaign. That sweep is
load-bearing for the 2026-09-06 deploy in particular: a campaign that was
RUNNING with the switch off has no call-note set at all, and until the sweep
reaches its agent every call it places leaves no note, books no callback and
hears no opt-out.

### The lifecycle

| Action | From | What it does |
|---|---|---|
| **start** | DRAFT, SCHEDULED | every gate in [Campaign start](#campaign-start-now-reaches-the-platform), concurrency overrides validated against the merged state, `startedAt` stamped, schedule columns cleared; then ensures the callback extraction key |
| **pause** | RUNNING | `pausedAt` |
| **resume** | PAUSED, CREDIT_EXHAUSTED | the identical gate list `start` runs, plus concurrency overrides; clears `pausedAt`. The only door back to RUNNING besides start and the scanner |
| **stop** | DRAFT, SCHEDULED, RUNNING, PAUSED, CREDIT_EXHAUSTED | one transaction: lock the campaign, sweep `PENDING → SKIPPED` (+`skippedCount`), `stoppedAt = completedAt = now`. In-flight contacts are left alone — live calls finish |
| **complete** | STOPPED only | a pure relabel. 400 if already COMPLETED; **409 with the live count** while any contact is `QUEUED`; 409 on a lost status race. `completedAt` is untouched — that *is* when it stopped running — and `stoppedAt` stays set |
| **delete** | any status | lock, delete. Contacts and rotation rows cascade; `CallAttempt` history survives with its campaign pointers nulled, because it is also the phone bill |
| **duplicate** | any status | copy **by omission**, re-validate the agent and numbers as they are *now*, re-clamp every number, name `"<name> (Copy)"`. No contacts, no results, → DRAFT, 201 |
| **schedule** | DRAFT | `{ startAt }`, must parse and be future. Checks **nothing else** — "schedule now, upload tonight" is a thing operators do, and every other gate runs when it fires |
| **top-up** | anything not stopped | dedupes against existing rows, `totalContacts += added`; a COMPLETED campaign re-opens to **PAUSED** |

Three of those refuse on `stoppedAt` rather than on the status — top-up, the CSV
upload and callback booking — because `complete` relabels STOPPED to COMPLETED
and a status-keyed rule would be a two-click bypass of itself. The column is
written once by `stop` and never cleared, precisely so it cannot be.

Every writer that can add work to a campaign takes the **campaign row
`FOR UPDATE` first**: stop, the retry sweep, top-up, the exclude, the callback
re-arm and the dispatcher's completion pass. Postgres runs READ COMMITTED, so a
count and a status re-check take no row locks, and without the shared order a
callback booking slips between the completion pass's count and its write —
stranding a promised call on a campaign that has announced itself finished.

`CREDIT_EXHAUSTED` is its own status rather than PAUSED: the operator did not
stop this campaign, the balance did, and `resume` has to know to re-run the
estimate. Both the dispatcher's pre-launch float check and the charge-time
shortfall write it.

**`Campaign.haltReason` is why it is not dialing, in the customer's words.**
Every writer of PAUSED, CREDIT_EXHAUSTED and STOPPED sets it — the dialer's
pauses write the same body their notification carries (`pauseCampaign`,
`pauseForPlatformCredit`, the shortfall path), a person's pause or stop writes
`Paused by <email>.` / `Stopped by <email>.` — and start, resume and the
callback re-open clear it. The campaign page prints it; the notification is the
history. Never add a status-keyed sentence to the dashboard for a state this
column can carry: two sources for one answer is how they come to disagree.

**A dial that produced nothing explains itself in one sentence**, `failure_reason`
on the attempts feed and `failureReason` on the journey, from
`src/lib/attemptReason.ts` — in the settle's own precedence: the reaper's
verdict, a platform fault (`error_code` or a `SYSTEM_ERROR` end reason, on a
call neither answered nor heard — `platformFaultOnRow`, the same predicate the
settle and the budget use), a refused launch, a blocked disposition, a verdict
on the number from either field (`INVALID_NUMBER` / `BLOCKED`, or the Q.850
cause 1/3/22/28 — read LIVE, since the platform reports 3/22/28 as
`NOT_CONNECTED`), and last the carrier-moment
[`end_call_reason`](#end_call_reason) sentences (`NETWORK_ERROR`, `REJECTED`,
`CANCELED`, `NOT_CONNECTED`). The dashboard prints the sentence and nothing
else about the cause; no code or token reaches a screen — including the
timeline's `ended` detail, which carries the reason's label, never its token.
Null when the disposition already says it all.

### Editing a campaign

`PATCH` is gated on what the body would actually **change**, never on what it
merely contains — the dashboard sends the whole form back on every save, so a
presence rule would refuse every edit to a campaign that has left DRAFT,
including the ones it means to allow.

- **DRAFT** — everything. Nothing has been dialed, so nothing can be
  contradicted.
- **RUNNING / PAUSED / CREDIT_EXHAUSTED** — `retryCount`, `cooldownMinutes`,
  `retryDelaysMinutes`, `concurrencyLimit`, `retryConcurrency`,
  `phoneNumberIds`, `callbackEnabled` and the goal knobs only. Every one of
  them is re-read by the dispatcher on its next pass and stamped onto nothing,
  which is the whole rule: they describe the calls that have NOT been placed.
  The agent and the variable map decide what a call already placed was placed
  against, and there is no honest way to apply a change to those
  retroactively — which is why the agent keeps its own 409 and these do not.

  RUNNING is on this list deliberately. A campaign an operator has to stop in
  order to give it another line is a campaign they stop, and the two settings
  that most often need changing mid-flight — how fast it dials and which
  numbers it dials from — cost nothing to change on the next tick.

  `retryConcurrency` is not optional company for `concurrencyLimit`. It is a
  reservation INSIDE the limit and the validator refuses lowering the limit
  below a reservation the body leaves alone, so listing the limit alone would
  let an operator raise it and never lower it again.

  The dashboard no longer sends `callbackEnabled`, and the API no longer writes
  it: it is accepted and ignored, so callbacks cannot be turned off from
  anywhere. It stays on the allow-list so a stray API call — or a dashboard
  deployed before this release, posting the whole form back — is the no-op it
  should be rather than a confusing 409, and the validator discards the value
  so it is a no-op in the row as well as in the gate.
- **An additive `variableMap`, in any status that was not stopped** — the CSV
  importer's import → assign → save-mapping flow has to survive a re-upload
  landing on a campaign that finished while the operator was in the file picker.
  Additive is what makes it safe: every existing key survives with an identical
  value, and `null` is a clear rather than an add.
- **The lead-bucket settings, in every status.** `leadBucketKey` and
  `wonBuckets` are never named by the change list, so a request that touches
  only them reaches the gate with nothing changed. They contradict no call
  already placed: membership is computed at read time out of what each call
  extracted, so choosing a key re-reads history rather than changing what any
  call did — and a campaign that finished last week is exactly the one worth
  sorting. A request that *also* carries a locked field is still refused, and
  the refusal names that field alone.
- **Everything else** is read-only, and the refusal **names the offending
  fields** — a field that appears to save and does not is the worst of the three
  outcomes.

Supplying `retryCount` also runs the SKIPPED sweep in the same transaction:
`PENDING` contacts whose `attempts` already exceed the new budget become
`SKIPPED`, armed callbacks exempt, `skippedCount` moved with them. Without it
those rows sit PENDING forever — never dialed, never finished, counted as
remaining work by the completion pass, so the campaign can never complete
either.

### The agent a campaign dials with

`Campaign.agentId` is a nullable foreign key to the local `Agent` mirror,
`ON DELETE SET NULL` — an agent is the platform's record and a campaign is the
customer's, so a campaign must not be able to pin an agent row in place, and one
left without an agent refuses to start, which is accurate.

**A set `agentId` does not mean the workspace still has that agent.** Staff
unassign by setting `Agent.workspaceId = null`, an UPDATE the constraint cannot
see, and agents are never deleted — sync marks them `status = "removed"` — so
`ON DELETE SET NULL` almost never fires. A foreign key guarantees the row
exists; it has no opinion on whose it is — nor on whether it is still live.
**Two** UPDATEs the constraint cannot see, so **four** states where the column
shows two:

| State | `agentId` | In workspace | Not retired |
|---|---|---|---|
| Not set | null | — | — |
| Assigned | set | yes | yes |
| Unavailable — reassigned | set | no | — |
| Unavailable — retired | set | yes | no |

Both unavailable states are read as one by every surface: same refusal, same
`agent: null` on the wire, same remedy. They are distinguished in this table
only because each is reached by a different write, and forgetting the second is
what lets a retired agent look assigned.

The rule lives in **one** place — `agentIsUsable()` and `NOT_REMOVED` in
`src/lib/agentVisibility.ts` — used by the assignment check, the start gate and
the serializer. Three copies of a rule eventually say three different things,
and here the disagreement would be a payload that calls an agent assigned while
Start refuses it.

`NOT_REMOVED` is written NULL-safely (`status IS NULL OR status <> 'removed'`).
The naive `status: { not: 'removed' }` is SQL that evaluates to NULL for a NULL
status and matches nothing — upstream omits `status` often, so it would make
every unsynced agent unpickable.

So ownership is re-resolved wherever it matters, never inferred from
`agentId != null`:

- **`PATCH`** runs `assertAgentAssignable()` (`src/lib/campaign.ts`) before
  writing. Nothing found is **422 `CAMPAIGN_AGENT_NOT_FOUND`**. A nonexistent
  id, an unassigned agent, another workspace's agent and a retired one share one
  status, one message, and no agent name — separate answers would let a caller
  sort ids into real and unreal by watching the status code. Input malformed *in
  shape* is refused by the schema as a 400 before reaching here, which leaks
  nothing: the caller knows what they sent. 422 rather than 400 because the body
  is well-formed; it is the referent that is wrong. `agentId: null` always
  succeeds and skips the lookup.
- **A RUNNING campaign's agent is locked** (409 `CAMPAIGN_AGENT_LOCKED`).
  `start` checks the agent once and nothing looks again, so without this a
  single PATCH could clear a running campaign's agent and void the invariant
  through the same handler that enforces it. Resubmitting the agent it already
  holds is not a change and is not refused.
- **`start` / `resume`** re-resolve too, from the row `campaignInWorkspace`
  already joined rather than a second query — a second read is taken at a
  different instant, so the gate and the response could disagree within one
  request. A campaign whose agent has left the workspace or been retired fails
  with the existing **409 `CAMPAIGN_AGENT_REQUIRED`**, the same as one that
  never had an agent. The remedy is identical, so a second code would only ask
  the operator to distinguish situations with one fix.
- **Staff unassignment** (`POST /admin/agents/:id/assignment`) returns
  `orphanedRunningCampaigns`: how many RUNNING campaigns just lost the agent
  they were dialing with. Reported, not refused — staff must be able to move an
  agent, but should not learn the cost from the customer.
- **Serialization** embeds `agent: { id, name, status } | null` via
  `CAMPAIGN_INCLUDE`, joined in the same query so a list of any length is one
  round trip. Prisma cannot put a `where` on a to-one include, so the relation
  returns the agent whatever workspace it now sits in: `serializeCampaign`
  selects `workspaceId`, compares it, and emits `null` rather than another
  workspace's agent name. `agentId` is emitted verbatim either way — nulling it
  would make "unavailable" indistinguishable from "not set" on the wire.

### The number a campaign dials from

`Campaign.phoneNumberId` is a nullable foreign key to `PhoneNumber`,
`ON DELETE SET NULL`, for the same reason `agentId` is: a DID is the platform's
record and a campaign is the customer's, so a campaign must not be able to pin a
number row in place.

**Selection here; the dialer acts on it.** This surface still calls nothing
upstream — no mapping, no routing, no validation probe. `start` is what reaches
the platform, with `POST /voicelink/call-ready`, and the sweep is what reads
the column.

A DID is assignable to a campaign when it is **this workspace's** and **still
held**, which means `status` is `ASSIGNED` or `PAST_DUE`. `PAST_DUE` counts: the
enum's own comment says the number still belongs to them and still rings, and
excluding it would let a declined card silently unpick a campaign's caller id.
`UNASSIGNED` and `RELEASED_NONPAYMENT` both mean the number is back in the
shared pool, which belongs to nobody.

The rule lives in one place — `HELD_STATUSES`, `IS_HELD` and
`phoneNumberIsUsable()` in `src/lib/phoneNumberVisibility.ts` — a SQL half for
lookups and an in-memory half for a joined row, so the assignment check and the
serializer cannot drift apart. It deliberately does **not** reuse
`agentIsUsable`: the two rules share a shape and not their content (an agent
turns on a free-text `status` that may be null, a number on a closed enum that
never is), and one checker taking either could be handed the wrong rule with
nothing to catch it.

Both conditions are checked even though today's release path happens to clear
`workspaceId` as well as setting the status. `status` and `workspaceId` are two
columns that must agree and nothing in the database makes them; checking the one
that actually names the state keeps this rule from depending on every future
release path remembering to clear the other.

- **`PATCH`** runs `assertPhoneNumberAssignable()` (`src/lib/campaign.ts`).
  Nothing found is **422 `CAMPAIGN_PHONE_NUMBER_NOT_FOUND`** — one status, one
  message, no DID — for a nonexistent id, a pool number, one released for
  non-payment and another workspace's alike. The enumeration argument is
  stronger here than for agents: what is being probed is a set of real-world
  phone numbers. `phoneNumberId: null` always succeeds and skips the lookup.
- **A live campaign's numbers are editable, and its agent is not.** The lock
  the numbers used to carry is gone: `resolveDialRotation` re-reads the
  attachments on every dispatcher pass, so a new list lands on the next tick,
  and what a call already placed went out from is on its own attempt row. The
  agent keeps its 409 because `start` checks it once and nothing looks again.
  Both still compare against the stored value through `changedBy()`, so
  resubmitting the numbers a campaign already holds, in the order it holds
  them, is not a change.
- **What a live campaign may not do is end up with NO number** (409
  `CAMPAIGN_NEEDS_PHONE_NUMBER`). With attachments and none usable the
  dispatcher HOLDS, and with none at all it has nothing to dial from: either
  way the campaign stays RUNNING, places no calls, and says nothing anywhere
  about why the count stopped moving. Keyed on the requested list being empty
  rather than on "would leave nothing usable" — a deactivated DID is a
  supplier-side fact that may resolve itself by the next pass, and refusing the
  save over it would block the operator from fixing the very thing they opened
  the form for. DRAFT is exempt; `start` is the gate there.
- **`start` REQUIRES a caller number** (409 `CAMPAIGN_PHONE_NUMBER_REQUIRED`).
  The campaigns slice deferred this to the dialer, and the answer is yes:
  `from_number` must name a number active on the connection, so a campaign
  without one would dial from whatever the connection defaults to — some other
  customer's published business number.
- **Serialization** embeds `phoneNumber: { id, did } | null` via
  `CAMPAIGN_INCLUDE`, through the same usability filter and for the same reason
  the agent needs one: Prisma cannot put a `where` on a to-one include, so an
  unfiltered join would print a DID somebody else now rents. `phoneNumberId` is
  emitted verbatim either way. Two fields only — not `status`, not price, not
  renewal date; a campaign shows a number, and a summary that grew because the
  phone-numbers page needed a field would quietly widen this payload too.

### The rotation

A campaign may attach up to **twenty** DIDs through `CampaignPhoneNumber`, and
**the order they were attached in IS the rotation order** — the operator's list
is the answer, and inventing a second ordering would make the UI's list a lie.
Rotating matters for two reasons the customer feels: one number placing hundreds
of calls an hour gets flagged by carriers, and a callee who declined one number
answers another.

`Campaign.phoneNumberId` survives as the **legacy pointer at position 0**, kept
in sync by create, update and duplicate, so readers that predate the join table
keep working and a campaign written before it still dials. `rotationOf()` reads
the join rows and falls back to the pointer, which is exactly what the
dispatcher does — reporting an empty rotation beside a populated pointer would
tell the dashboard the campaign dials from nothing.

The list is replaced wholesale rather than reconciled row by row: a diff would
have to invent an order for whatever it kept, and a partial rewrite collides
with `unique(campaignId, position)` the moment two numbers swap places. A
duplicate id is refused rather than de-duplicated, for the same reason the order
is load-bearing.

`src/services/dialerNumbers.ts` resolves what a campaign has to dial from on
each pass, and returns **four** states rather than two, because "nothing to dial
from" has two causes with opposite remedies:

| State | Meaning | The sweep does |
|---|---|---|
| `rotating` | attachments exist, at least one usable | rotate over them |
| `legacy` | no attachments; the old pointer names a usable number | dial from it |
| `held` | attachments exist and none is usable | **hold this pass**, pause nothing |
| `none` | nothing configured, or the pointer names a number that is gone | pause the campaign |

`held` deliberately does not fall back to the legacy pointer: it may well be the
very number that was just released. And the rotation is resolved **before** the
claim, so a campaign with nothing to dial from holds its queue where it is
rather than claiming contacts it will fail one by one — a failed launch is an
attempt row, a log line and, on some branches, a consumed retry.

### The dialing window

`fromTime`, `toTime` and `timezone` are independently nullable and
independently `PATCH`-able. The API validates each in isolation — `HH:MM` shape,
IANA zone — and enforces **no cross-field rule**: no `from < to`, no
both-or-neither.

`dialDays` is the fourth field and says which weekdays the campaign may dial
on, `0` = Sunday, read in `timezone`. **Empty means every day, and so does a
full seven** — one state with one reading, which is what let the column arrive
without touching a single existing campaign. `null` is a third spelling of the
same thing, normalised to `[]` in the schema so no reader ever meets it.
"Never dial" is deliberately inexpressible: that is a paused campaign, and
saying it twice in two vocabularies is how the two come to disagree.

Because all three spell one state, **`changedBy` compares day lists through
`restrictedDays`** rather than over the raw arrays: re-spelling every-day —
ticking the seventh box on a paused campaign, or a dashboard that sends `[]`
where the row holds a full week — narrows nothing and is not refused with
`CAMPAIGN_CONFIG_LOCKED`.

A stored list that names days and restricts to none — `[7]`, a list of floats —
is **`incomplete`**, not unrestricted. The API refuses such a list on the way
in, so it can only arrive by another route, and reading "I cannot tell which
days" as "every day" is the one direction this window never fails in.

**An overnight window belongs to the calendar day of each instant, not to the
day it opened on.** A window of `22:00`–`02:00` restricted to Friday dials
Friday 00:00–02:00 and Friday 22:00–24:00 — two spans on Friday — and nothing
at all on Saturday morning. That is deliberate: the alternative, "the day the
window opened", puts a call at 01:00 on a date the clock has already left, and
the dispatcher would have to know when a call *started* to say whether it may
place it. The dashboard should word its day picker as "days we call on", not
"nights that start on".

All four are DRAFT-only, together. Days belong with the hours beside them, and
a campaign that has already dialed people on Saturdays cannot honestly be told
it never dials on Saturdays.

That is a decision, and it still holds for `PATCH`. What a window *means* is
decided by `src/lib/dialingWindow.ts` instead — see [Outbound
dialing](#outbound-dialing). A **partial** window (one end without the other,
or hours with no timezone) is refused by `start` and pauses a running campaign,
which is the fail-closed reading: an operator who set one end was expressing a
restriction, and treating that as "any hour" is how a campaign rings somebody
at 3am.

## Phone numbers & credits

YE holds one telephony connection with Vocobase; DIDs are imported or
purchased **there** by an YE super-admin. `PhoneNumber` is the local
inventory of what that connection owns, and renting one is **internal**:
nothing is bought upstream, `dids/map` is never called, no routing is created.
A rented DID is a row with a `workspaceId` and a charge in the ledger — it is
not yet a number that rings. Attaching one to an agent or campaign is a later
slice.

```
PhoneNumber        id, did (E.164, unique), externalId?, provider?, countryCode?,
                   numberType?, providerStatus?, providerExpiresAt?, rawProvider,
                   status (UNASSIGNED | ASSIGNED | PAST_DUE | RELEASED_NONPAYMENT),
                   workspaceId?, monthlyPriceCredits?, rentedPriceCredits?,
                   rentedAt?, nextRenewalAt?, pastDueSince?, lastSyncedAt
CreditTransaction  id, accountId, workspaceId?, phoneNumberId?, amount (signed),
                   type, note?, reference?, createdAt
```

**Sync owns provider facts; renting and staff own tenancy and billing.** The
sync upsert never writes `workspaceId`, `status`, `monthlyPriceCredits`,
`rentedPriceCredits`, `rentedAt`, `nextRenewalAt` or `pastDueSince` — the same
invariant the agent mirror holds. A refresh that touched them would un-rent
numbers customers pay for and leave the ledger recording charges for nothing.

**Two prices, and the difference matters.** `monthlyPriceCredits` is the
*catalog* price: what the number costs the next workspace to rent it, editable
by staff at any time. `rentedPriceCredits` is the price the current renter
agreed to, captured by the same conditional write that claims the number.
Renewals charge the snapshot (`chargePriceOf`), never the catalog
(`priceOf`) — reading the catalog at renewal made a rental's cost a live value,
so re-pricing a DID or correcting the global default silently re-billed
everybody already renting one.

The only upstream call this surface makes is `GET /voicelink/dids/purchased`,
a paged read. `did_number` arrives as a JSON *number* today, but is read
through `readPhoneValue`, which also accepts E.164 and formatted strings and
hands them to `src/lib/phone.ts`; a JSON *number* must still be a safe integer,
because a float truncates into a different valid-looking number. The provider
id reads through `readIdentifier` and may be any string — `externalId` is
`String?`. A number that will not canonicalize is skipped, counted **and
logged**, never stored with a fabricated `+`. The page walk trusts the reported
`last_page` over a short page, and reports `truncated` when it stops at the
backstop, so a partial mirror never looks like a complete one.
`expiry_date` is Vocobase's rental to YE and is recorded as
`providerExpiresAt` — unrelated to `nextRenewalAt`, which is YE's rental to a
workspace. Rows Vocobase stops listing are left alone: reconciling a DID that
vanished while a workspace is paying for it needs a policy nobody has written.
They are **named**, though — `DidSyncResult.unseenAssigned` lists every rented
DID upstream no longer serves, and logs it. The sweep consults no provider fact,
so without that a lapsed number bills its renter monthly, forever, in silence.
A refresh never writes `null` over a fact upstream merely omitted, and never
rewrites `did` under a live rental — the ledger renders that number, so
changing it rewrites what every past charge appears to have been for.

**Money.** `src/lib/credits.ts` owns the 10000x multiplier and is the only
place it appears; values crossing the API are decimal strings, never floats.
`src/services/didRental.ts`, `src/services/dialerOutcome.ts` and
`src/services/testSessionOutcome.ts` move credits for usage;
`src/routes/admin/accounts.routes.ts` (staff adjustments),
`src/services/onboarding.ts` (the opening balance) and
`src/services/accountTransfer.ts` (one balance moving between accounts) are the
staff-written paths, and those six are the only modules that move credits. Every
balance change is a **conditional write** inside a transaction — never a
read followed by a write. Postgres runs READ COMMITTED, so two transactions
can both read "unowned" or "can afford it"; a conditional write takes a row
lock and matches nothing once the precondition is consumed, which is what
makes a double rental and a negative balance unreachable rather than unlikely.

- Charged to the **workspace owner's** account, not the ADMIN who clicked.
- Full price at purchase, no proration; `nextRenewalAt` is one calendar month
  out, day-clamped by `src/lib/billingCycle.ts` (`Date.setMonth` overflows 31
  January into March, which is a free month per short month).
- Releasing is **not refunded** — enforced by the absence of any credit
  statement in `releasePhoneNumber`, and said in the UI before the click.
- Staff assignment is **free**: an operational override, not a sale, so no
  charge row is written. Taking a DID *away* from a workspace is different —
  it needs `force: true` and writes a zero-amount `DID_RELEASE` on the losing
  workspace, because a ledger showing a purchase with no counterpart asserts
  they still hold a number that is gone. Assigning also starts a billing cycle,
  so a typo'd `workspaceId` bills an uninvolved customer next month.
- `DID_RELEASE` and `DID_RELEASE_NONPAYMENT` are zero-amount markers. Separate
  types rather than a zero `ADJUSTMENT` because "they gave it back" and "we
  took it away" are different facts, and they carry `workspaceId` so a
  workspace's history survives the DID leaving it.

**The renewal sweep** (`src/services/didRenewal.ts`) runs hourly, started from
`src/worker.ts` and **never** from `createApp()` — a test that builds the app
must not start a timer that bills people, and `test/renewal-sweep-startup.ts`
asserts it. It claims each DID by compare-and-set on `nextRenewalAt`, so it is
idempotent and safe on N processes. The next date advances from the **due date,
not from now**: a sweep down for three months charges one month per pass, in
order, rather than forgiving the gap or emptying an account in one go. The pass
is bounded, re-entrant-guarded, and logs what it did.

**A declined charge does not take the number away.** It rolls back with nothing
debited, marks the DID `PAST_DUE` and leaves it with the workspace — still
theirs, still ringing. `nextRenewalAt` is unmoved, so every later pass retries
the same month, and a successful charge clears the mark. Only when
`DID_GRACE_DAYS`, measured from the **first** decline (`pastDueSince`), runs out
is the number released as `RELEASED_NONPAYMENT`. Releasing on the first miss
meant a customer one internal credit short at the instant the sweep ran lost a
published business number with no way to get it back. `DID_MAX_RELEASES_PER_SWEEP`
stops a pass that has started doing this wholesale — the realistic cause is a
pricing mistake that made everybody insolvent at once.

**A released DID is immediately rentable again.** The available pool is every
DID with `workspaceId IS NULL`; `RELEASED_NONPAYMENT` differs from
`UNASSIGNED` only in carrying the reason it became free, and renting either
clears the marker. A `PAST_DUE` number is **not** in the pool — it still
belongs to the workspace.

| Route | Role | Notes |
|-------|:----:|-------|
| `GET /api/workspaces/:id/phone-numbers` | member | The workspace's own DIDs. |
| `GET /api/workspaces/:id/phone-numbers/available` | member | The unowned pool. Registered before `/:didId`. |
| `POST .../phone-numbers/:didId/rent` | ADMIN | 409 `PHONE_NUMBER_TAKEN`, 402 `INSUFFICIENT_CREDITS`. |
| `POST .../phone-numbers/:didId/release` | ADMIN | No refund. |
| `GET /api/workspaces/:id/billing` | ADMIN | Owner balance, `owner_account_id`, and the 30-day renewal projection. Its `ledger`/`nextCursor` are superseded, kept only until nothing reads them. |
| `GET /api/workspaces/:id/billing/transactions` | ADMIN | The history: `?type=`, `?from=`, `?to=`, `?page=`, `?limit=`. |
| `GET /api/admin/phone-numbers` | staff | `?status=`, `?assigned=`. |
| `POST /api/admin/phone-numbers/sync` | staff | Registered before `/:didId`. |
| `POST /api/admin/phone-numbers/:didId/assign` | staff | `{ workspaceId }` or `{ workspaceId: null }`. No charge. `force: true` required to take a rented number; 409 `PHONE_NUMBER_IN_USE` without it. |
| `PATCH /api/admin/phone-numbers/:didId` | staff | `{ monthlyPriceCredits }` — the **catalog** price; `null` restores the default. Never reaches an existing rental. |

Isolation works as it does for agents: a DID in another workspace is found by
`findFirst({ where: { id, workspaceId } })`, finds nothing, and 404s — a 403
would confirm the id names something real. The available pool is the one
deliberate cross-workspace read and exposes only the number, its price, and
why it is free. The billing ledger filters on `CreditTransaction.workspaceId`,
the snapshot written with the row, not on the DID's current workspace — which
is what keeps a released number's history where it belongs.

### The customer billing surface

`GET /billing` answers the balance card; `GET /billing/transactions` answers
the table. Two routes rather than one because the card is read once per page
load and the table re-reads on every filter click — and because served
together, a ledger failure takes the balance down with it.

**The history is a disjunction, and the second arm is deliberate.** DID rows
filter on `CreditTransaction.workspaceId`, the snapshot written with the row. A
staff grant credits an *Account* and carries no workspace, so that filter alone
shows a customer every charge and never the top-up that paid for them — a
history whose lines cannot add up to the balance above it. The second arm is
`accountId = owner AND type = 'ADJUSTMENT'`: the **owner's** account, not the
caller's, and `ADJUSTMENT` as a whitelist so a future Account-scoped row of
another type does not become customer-visible by default.

The consequence is stated on the page rather than left to be discovered: the
list **does not reconcile to the balance**. It shows one workspace's charges
against an account-wide balance, so an owner with two workspaces sees a balance
moving for reasons this page does not list. Showing every workspace's charges
would leak one customer team's spending to another's admin, which is worse than
an explained gap.

**There is no `balance_after`, and adding one needs a column.** A running
balance can only be reconstructed by summing, and summing describes reality only
over a complete contiguous series — this list is filtered to one workspace and
filtered again by the reader. A figure from a subset would name a balance the
account was never in. `serializeLedgerRow` says so; the honest fix is a
`balanceAfter` written inside the same transaction as the balance change.

**`note` and `reference` are read here and never written here.** The writer will
be the staff grant endpoint, which does not exist in this repo yet — nothing
under `src/` writes either column today. A surface that displays a value does not get to invent
it, so a DID charge shows a null note and the number itself — which says more
than a sentence assembled around it.

**The projection** (`src/services/billingProjection.ts`) sums what this
workspace's DIDs cost over the next `PROJECTION_WINDOW_DAYS` (30) at
`chargePriceOf`, and compares **`accountTotalCredits`** — the same window across
every workspace the owner account owns — to the owner's balance in BigInt. The
comparison is account-wide because the balance is: judging one workspace's
renewals against a balance that funds several would report `covers: true` on
every one of their pages while the account is short enough to lose a number on
all of them. `totalCredits` stays workspace-scoped, because that is the figure
the dashboard's table of rows has to sum to. It lives in
the backend because it is a money claim, because it is the same sum the renewal
sweep performs, and because the alternative is adding credit strings in a
browser. `PAST_DUE` numbers are **included** — a declined charge leaves
`nextRenewalAt` behind, so they are inside every window by date, and they are
the strongest evidence the balance is short. A number with no `nextRenewalAt` is
excluded and reported as `unscheduled_count` rather than folded into the total:
we do not know when it will be billed, and adding an unknown to a sum presents a
guess as arithmetic. The window is emitted in the payload so no consumer assumes
it — and it is a fixed 30 days while renewal dates come from the calendar-aware
`addOneMonth`, so a number rented in a 31-day month falls outside it. Any
surface listing the rows behind the total must filter them to the same horizon,
or its rows will not sum to the total printed beneath them.

Pagination is offset (`src/lib/pagination.ts`), not cursor. A cursor is right
for an append-only feed walked forwards and wrong for a filterable table: it
names a row that may not be in the new result set, so the client resets on every
filter change anyway while still not knowing how many pages there are. Every
offset query must order by a tiebreaker as well as the sort column — rows
written in one transaction share a `createdAt`, and an unstable sort shows one
row on two pages while hiding another. That is a convention the caller has to
keep: `parsePagination` does not take an `orderBy` and cannot enforce it.
`page` is bounded (`MAX_PAGE`) as well as `limit`, because the offset derived
from it has to survive being a JavaScript number and then a 64-bit database
integer.

**Open stitch point:** `PhoneNumber.workspaceId` and all three
`CreditTransaction` foreign keys are `onDelete: Restrict`. There is no
workspace- or account-delete route yet; when one lands it must decide whether
deletion releases rented numbers or refuses, and what becomes of the ledger.
`SetNull` was rejected on the DID because it would leave a row that is
`ASSIGNED` with no workspace — two fields that must agree, silently disagreeing,
on the record that says who is paying. `Cascade` was rejected on the ledger for
the blunter reason that deleting an Account would erase its financial history.

**Also open:** nothing reconciles a DID that vanished upstream, and nothing acts
on `providerStatus` or `providerExpiresAt`. A workspace can rent an already
expired number, and a lapsed one keeps billing. `unseenAssigned` reports the
second; both want a policy.

## Call history

A read-only surface over the calls the platform has already placed: list,
detail, transcript, recording. It **never causes a call** — every upstream
request it makes is a `GET`, and there is no write route on it.

**No mirror table, no schema change.** Calls are read often and briefly and
never edited, so a local copy would buy latency in exchange for staleness and a
backfill nobody asked for. Every request fetches, filters and shapes.

| Route | Role | Notes |
|-------|:----:|-------|
| `GET /api/workspaces/:id/calls` | member | `?page`, `?limit`, `?agentId`, `?campaignId`, `?from`, `?to`, `?status`, `?disposition` |
| `GET /api/workspaces/:id/calls/:callId` | member | metadata, agent, campaign, transcript, variables, extraction, charge, timeline |
| `GET /api/workspaces/:id/calls/:callId/recording` | member | streams the audio; `Range` passed through |

`:callId` is the **upstream** call id — a deliberate departure from the agents
surface, where the local row id is on the wire and the platform's id stays
inside the backend. With no mirror there is no local id to use. It is an opaque
UUID, useless without the partner key, and every handler re-derives visibility
from it rather than trusting the caller got it from us. If a mirror is ever
added, this becomes a local id.

### Who can see a call

Two independent legs, either sufficient (`src/services/callHistory.ts`):

- **Agent.** The call's `agent_id` is an upstream id; local `Agent` rows are
  keyed by `externalId`, so the workspace's agent set is one query.
- **Campaign.** A `client_reference_id` of `ezo:<campaignId>:<campaignContactId>`
  resolves to a local `Campaign`, whose `workspaceId` decides.

A call matching neither is **absent**, not forbidden — a 403 would confirm it
exists. Both sets are resolved into maps once per request, so deciding a row is
a `Map.get` rather than one of 2,000 queries.

**History deliberately ignores `NOT_REMOVED` / `agentIsUsable`.** Those answer
"may this workspace start something with this agent", and a retired agent must
not take new work. This surface asks whether the workspace *placed* a call,
which does not stop being true later. Filtering history through a start gate
would erase a workspace's past the day staff retire an agent.

### The campaign correlation key

A call carries no campaign id anywhere in the platform's call surface. What it
carries is `client_reference_id`, a free-text field the **caller** fills in at
dial time — which is where every integrator namespaces its own ids. This
platform's dialer will stamp `ezo:<campaignId>:<campaignContactId>`;
`src/lib/callCorrelation.ts` reads it back.

That field rather than pre-call variables, which carry the same ids by
convention: variables are returned only on a call's *detail*, while
`client_reference_id` is on the **list** row, and a listing that must fetch a
detail per row to learn whose campaign a call was is not a listing.

The parser is strict both ways. The partner account is shared, so claiming
another integrator's key would attribute their call to one of our campaigns;
and a key with our prefix but the wrong shape is rejected rather than partially
read. **The dialer stamps it**, with a fourth segment naming the attempt —
`ezo:<campaignId>:<campaignContactId>:<attemptId>` — because upstream treats
this field as a per-account idempotency key and a repeated value would replay
the first call instead of retrying. Three-segment keys still parse, so calls
placed before attempts existed keep resolving to their campaign.

### The walk, and why there is no total

The upstream listing accepts `limit`, `offset` and `status` and nothing else
this surface can use — no agent filter, no date filter, no campaign filter. So
scoping is a walk: fetch a page of 100, drop what is not ours, repeat.

- **Bounded** at `MAX_UPSTREAM_PAGES = 20`, i.e. the 2,000 most recent calls.
  When the budget is spent before the page is filled the response says
  `truncated: true` with `scanned`, and the dashboard states what was searched.
  An incomplete list that reads as complete is the one forbidden outcome — the
  reader would conclude the calls do not exist.
- **Paged over the filtered stream**, not upstream offsets: page 3 walks from
  the top and discards the first `2 × limit` matches.
- **`hasMore` by collecting one row past the page**, not by comparing against a
  count.
- **No `total`.** Measuring it means walking a workspace's whole history, and
  upstream's own `total` counts every workspace's calls. A number that is
  wrong is worse than no number.
- Two early exits. A whole batch older than `?from` ends the walk, since the
  listing is newest-first — which is why a date-bounded query is cheap where an
  unbounded one is not. And a workspace with no agents and no campaigns never
  calls upstream at all.
- The listing is **rate limited per workspace** (`src/routes/calls.routes.ts`),
  since one request costs up to twenty upstream reads against a limit every
  workspace shares. Keyed on the workspace, not the caller, or its members
  multiply the budget between them.

`?agentId` and `?campaignId` are local ids resolved through a workspace-scoped
`findFirst` before use. One naming another workspace's resource is a **404**,
not an empty list: an empty list would start returning rows the moment that
resource moved, which makes the filter an existence oracle.

`?status` and `?disposition` are **free text**, matched case-insensitively, and
never delegated upstream. Those values follow whichever carrier placed the call
and the published sets grow without this service deploying; an enum copied from
today's documentation would turn next month's disposition into a 400, and
upstream rejects a status it does not recognise. Note that voicemail is a
*disposition*, never a status.

### What never reaches the browser

The projection in `src/lib/serialize.ts` is an allow-list, not a redaction —
these rows come off an account every workspace shares. Never emitted:

- **`client_reference_id`**, where every integrator writes its own internal ids.
  Echoing it hands one customer a fragment of another's CRM. Read for
  correlation, then dropped.
- **`session_id`, `connection_id`, `agent_id`** — upstream handles. The agent
  arrives resolved to a local `{ id, name }`.
- **`provider`** — the carrier that placed the call. Same rule that keeps
  "Vocobase" out of every customer-facing message string.
- **`credits_used`** — what *this platform* was billed, not what the workspace
  pays. Publishing it publishes the margin.

### Transcripts and recordings

`normalizeTranscript` returns a discriminated union, because the transcript
field is not always a transcript: the documented shape is an array of
`{ role, content, timestamp }`, but a call that never connected sends an
**object** — `{ error, provider, terminal_reason }` — and one still processing
sends `null`. The union stops a renderer presenting carrier diagnostics as
something the customer said. The reason is reduced to a flag, since upstream's
text names the carrier.

The recording is **streamed through this service**, never redirected to. The
presigned URL names the supplier's storage, stays valid for seven days with no
notion of membership — so once forwarded it plays for a week to anyone holding
it, long after they left the workspace — and cannot be revoked. It is minted
fresh per request, because the one on a detail response may already have
expired. `Range` is forwarded and `Accept-Ranges` is advertised even on a
whole-file response, or a player never asks to seek. The body is piped, never
buffered.

`fetchRecording` deliberately does **not** go through the adapter's `request()`
helper, which attaches the partner key to everything it sends: that URL points
at a third-party host, already authorized by its own signature.

**Playback credentials.** An `<audio>` element cannot send an `Authorization`
header, so `GET .../calls/:callId/recording-token` mints a short-lived token
the media element carries as `?token=`. It is signed with
`RECORDING_TOKEN_SECRET`, scoped to one workspace and one call, and expires in
two minutes; `src/lib/recordingToken.ts` holds it. The three alternatives are
each worse — redirecting to the platform's presigned URL hands out a seven-day
unrevocable link that knows nothing about membership, a Clerk session token in
a query string writes the whole account into access logs and browser history,
and downloading the audio as a blob gives up progressive playback and seeking.

The token **authenticates only**. The mint endpoint runs the full visibility
check before signing anything, and the playback route runs it again on every
request — so the token never stands in for authorization, and a call that
leaves the workspace between minting and playing is refused. An unset secret
makes every token invalid rather than opening the door, the same rule the staff
guard holds.

### The timeline, and why it is not from webhooks

The detail carries an `events` timeline as `timeline`, oldest first, plus a
`timelineSource` naming where it came from. **It is not assembled from stored
webhook deliveries**, because there are none to assemble: `WebhookEvent` is a
dedupe ledger — an event key, a name, a received-at — and it carries no call id,
no payload and no status. Nothing per-call can be recovered from it.

The source is `CallAttempt`, which the dialer stamps as a call moves:
`startedAt`, `answeredAt`, `endedAt`, `resolvedAt`, `chargedAt`, rendered as
`dialed / answered / ended / resolved / charged`. `src/lib/callTimeline.ts`
holds it, pure over a narrow input. The `ended` event's detail is
`endReasonLabel(endCallReason) ?? hangupCause` — the reason's WORDS, because
the dashboard's timeline prints `detail` verbatim and a token must never reach
a screen; the raw cause stays for a row settled before the column existed and
for a value this service has no words for yet.

- **A null stamp emits no event.** Dating one to the epoch puts a 1970 row at the
  head of every live call; dating it to `now` invents an event that has not
  happened, and an unanswered call would show as answered the moment somebody
  opened it. `resolvedAt` being null is the only honest way to tell a live dial
  from a settled one and is never filled in.
- **Sorted by instant, not by field order.** A reconciled attempt can be charged
  before its outcome is applied.
- **An attempt exists only for a call the dialer placed for a campaign.** An
  inbound call, a hand-placed one, or one on an agent whose traffic never came
  through the dialer has none, so `timeline` is `[]` and `timelineSource` is
  `none` — which is what lets the dashboard say the timeline was not recorded
  rather than render an empty list that reads as a call which did nothing. Same
  rule as the list's `truncated`: an incomplete answer that reads as a complete
  one is the forbidden outcome.

`billing` rides on the same lookup: `{ creditsCharged, billedSeconds, shortfall }`
from `CallAttempt.costCredits` in **display** units. That is what this workspace
was charged — the opposite of upstream's `credits_used`, which is what the
supplier billed this platform and which this surface still never emits. `billing`
is `null` rather than a zeroed block when there is no attempt: a zero asserts a
charge that came to nothing, where the truth is that the call is not charged to
the workspace at all. `billedSeconds` is null on every attempt settled before
pulse billing existed, and null is not zero and not the duration.

The lookup is scoped `{ upstreamCallId, workspaceId }` though `upstreamCallId` is
already unique — the partner account is shared and this is the one query on the
detail path that reads a local billing figure. It runs only after the visibility
check has granted access, so it can never widen what a caller sees.

### Absence versus outage

`getCall` returns `null` when upstream is certain there is no such call, and
throws `UPSTREAM_ERROR` on everything else. The detail route turns `null`, a
foreign call and a nonsense id into one identical 404, but lets an outage
through as a 502. "Call not found" while the platform is merely unreachable is
a claim about the customer's data we cannot support, and they act on it.

`RECORDING_NOT_AVAILABLE` is likewise distinct from `NOT_FOUND`: the call is
theirs and they may see it, there is simply no audio.

### Limits worth knowing

- **Telephony only.** The platform exposes no session-listing endpoint, and its
  single-session read covers only sessions the partner API itself created. Call
  history is therefore phone-call history; a browser test session does not
  appear in it, by design — see [Browser test sessions](#browser-test-sessions),
  whose charges appear on billing rather than here.
- **No campaign attribution on calls placed before the dialer shipped**,
  since nothing stamped a correlation id then. No heuristic will be invented —
  deriving the link from a campaign's agent would attribute every manual and
  inbound call on that agent to the campaign.
- **No search over transcript text**, which is detail-only upstream.
- **History deeper than the walk's budget is unreachable.** The walk always
  starts at the newest call and is bounded at twenty upstream pages, and there
  is no `?to` early exit, so a query for a window far back spends the whole
  budget on newer rows and returns an empty page marked `truncated` — at every
  page number. The date range narrows what *matches*; it cannot move where the
  walk begins. This binds once the shared partner pool exceeds roughly two
  thousand calls, and lifting it means an upstream listing that filters by date
  or a local mirror, not a bigger budget.
- **A recording token rides in the query string**, because a media element
  cannot send a header. Nothing in this service logs it — there is no request
  logger — but ingress and CDN access logs capture full query strings by
  default. Whoever owns that layer should keep them out of long-retention
  storage; the two-minute expiry is what bounds the damage until they do.
## Browser test sessions

The **Test** button on the agent page: a live WebRTC call to one agent, in the
browser, so an operator can hear what a prompt change did without putting the
agent on a campaign and dialing a real person.

**A test is a call without a carrier, and is billed as one.** The platform
charges the partner account per minute for `POST /sessions/webrtc` exactly as it
charges for a dial, so this is not a free preview and nothing here treats it as
one. Rate resolution, the two roundings, the fail-closed shortfall and the
exactly-once ledger guard are all **reused** from the dialer — `resolveCallRate`
and `chargeFor`, unchanged. Pricing a test by a second route is how the same
minute comes to cost two different amounts.

It is deliberately **not** a call: no `CallAttempt`, no campaign, no contact, no
DID, no correlation key. `TestSession` is its own table, modelled on
`CallAttempt` so a reader who knows one does not have to learn the other.

```
TestSession  id, workspaceId, accountId, agentId, startedByAccountId,
             upstreamSessionId? (unique),
             status (ACTIVE|ENDING|COMPLETED|FAILED|ABANDONED), upstreamStatus?,
             tierId?, tierSlug?, rateCreditsPerMin?, billingIncrementSecs?,
             durationSecs?, billedSecs?, costCredits?, chargedAt?, shortfall,
             startedAt, endedAt?, resolvedAt?
             UNIQUE (workspaceId) WHERE status = 'ACTIVE'   ← hand-written
```

| Route | Role | Notes |
|-------|:----:|-------|
| `POST /api/workspaces/:id/agents/:agentId/test-session` | member | `{ variables? }` → `{ id, room_url, token, max_duration_secs }`, 201 |
| `POST /api/workspaces/:id/test-sessions/:sessionId/end` | member | marks `ENDING`; frees the slot, **never charges**. 204 |

`:sessionId` is the **local** row id, resolved by id *and* workspace, so a
foreign session and a nonexistent one answer the same 404. The platform's
session id never reaches the browser — it is an upstream handle on a shared
partner account, the class of value `serialize.ts` already keeps off the wire.
The room URL and token do, necessarily: they are what the Pipecat client
connects to, both are single-use and scoped to one room, and neither is the
partner key.

### Six gates, in order

| # | Gate | Refusal |
|---|---|---|
| 1 | `requireAuth` → `requireMembership()` | 403 |
| 2 | 6 starts/min per workspace | 429 `RATE_LIMITED` |
| 3 | the agent is in this workspace and `agentIsUsable` | 404, or 409 `AGENT_NOT_USABLE` |
| 4 | `resolveCallRate` resolves | 409 `TEST_SESSION_RATE_UNAVAILABLE` |
| 5 | the balance covers `TEST_SESSION_MAX_SECS` at that rate | 402 `INSUFFICIENT_CREDITS` |
| 6 | one live per workspace; `TEST_SESSION_MAX_CONCURRENT` platform-wide | 409 `TEST_SESSION_IN_PROGRESS` / `TEST_SESSION_UNAVAILABLE` |

**Any member, deliberately**, following the agent surface it hangs off — the
permission matrix already grants members "use agents, campaigns and sessions",
and testing an agent you may edit is not a larger act than editing it. The spend
is bounded by gates 2, 5 and 6 rather than by role, which is the right place to
bound it: an ADMIN looping the button would cost exactly as much.

**Unpriced is not free** (gate 4), the same reason the dialer refuses to launch.
**The balance gate is the whole cap, not one pulse** (gate 5): the browser can
hold the line for the full duration, and refusing at the far end — after the
minutes are spent — is a shortfall rather than a refusal. That makes the
shortfall path unreachable except under concurrent spend; it is still
implemented, because unreachable is not removed.

**Two concurrency caps, and the second is the one that matters** (gate 6). One
live session per workspace is a **partial unique index**, hand-written in the
migration because Prisma cannot express it — the arrangement `Tier.isDefault`
has — so the cap is atomic rather than a check-then-act two clicks slip between.
That alone bounds nothing useful: every test takes a line from the **same
concurrency pool the dialer runs on**, and the platform's default allotment is
five, so enough workspaces testing at once would starve outbound dialing with
nothing on any screen saying why. `TEST_SESSION_MAX_CONCURRENT` (default 2) is
the platform-wide ceiling that stops it, counted in the insert's transaction.

Deliberately **not** folded into `concurrency.ts`: that module counts
`CallAttempt` rows in one raw claim statement on the dispatcher's hot path, and
widening it to a union across two tables to bound a draw already capped at two
is a change to the dialer to solve a problem outside it.

### Three writes, and the one that can orphan

1. **Insert `ACTIVE`**, holding the slot — *before* the platform is called, so a
   burst of clicks costs one upstream request rather than one per click.
2. **`POST /sessions/webrtc`.** A refusal marks the row `FAILED` and frees the
   slot; one outage must not lock a workspace out until the reaper comes round.
3. **Stamp `upstreamSessionId`.** Retried once, then 502
   `TEST_SESSION_STARTED_UNTRACKED` — the shape `AGENT_CREATED_UNASSIGNED` has.
   A session we cannot name is one we can never settle.

### Settling one

The pair the dialer has, for the reason it has it: a webhook is a delivery, not
a guarantee.

- **The webhook.** A browser session's `session.completed` carries **no `call`
  object** — there was no carrier — which is exactly the branch
  `handleSessionCompleted` used to return early on. It now looks the session up
  by `upstreamSessionId` there. The attempt path is untouched and is still tried
  first, so a telephony call is never mistaken for a test. A session matching
  nothing keeps the endpoint's oldest rule: log the id, persist nothing, 200.
- **The reaper.** `closeStaleTestSessions()` runs in the existing
  `campaign-cleanup` worker beside `closeStaleAttempts`. `ENDING` past 60s and
  `ACTIVE` past `TEST_SESSION_TIMEOUT_MINS` get `GET /sessions/{id}`; a terminal
  status settles and charges, a 404 becomes `ABANDONED` at zero with `chargedAt`
  stamped, and a session still reported live is left for the next tick. **It
  never guesses a duration** — only the platform knows when the audio stopped.

The two paths carry **different event keys** on purpose, so the `WebhookEvent`
marker cannot be what stops the second one. What makes this exactly-once is the
`chargedAt IS NULL` guard inside the settlement's own `where`.

`settleTestSession` is `applyTerminalOutcome` with every campaign concern
removed — and takes **no campaign row lock**, because there is no campaign, so
the lock-ordering hazard that transaction documents cannot arise here. Do not
add one to match.

### Environment

```
TEST_SESSION_MAX_SECS         # optional, default 300, floor 30
TEST_SESSION_MAX_CONCURRENT   # optional, default 2, floor 1 (0 is not an off switch)
TEST_SESSION_TIMEOUT_MINS     # optional, default 15
```

`max_duration_secs` is returned in the start response rather than published as a
public build-time value, so the browser's cap and this service's gate cannot
drift. The platform's session endpoint accepts **no duration parameter**, so
that number and the reaper are the whole of the cap.

### Deliberately not here

- **A test-session history surface.** The rows are the billing record and the
  charges appear on billing; a second listing of five-minute sessions is not
  something anyone has asked to read.
- **Transcript, extraction and recording.** All three are on the calls surface.
  `GET /sessions/{id}` returns them and the reaper reads it, but nothing is
  stored and nothing is served.
- **Counting test sessions in the dialer's concurrency budget.** Argued above.

## Analytics

Aggregates over **two local tables**, and the split between them is the whole
design.

| Source | Holds | Written by | Freshness |
|---|---|---|---|
| `CallAttempt` | every **campaign** call | the dialer, at dial time + webhook | real time |
| `CallRecord` | everything **else** on the shared account | the analytics ingest | the sync interval |

`CallAttempt` already carries a disposition, a duration and a price, so
analytics does not mirror campaign calls — it reads them. What had no local row
anywhere is the rest of the partner account: inbound calls, calls placed by
hand, calls on an agent no workspace holds. `CallRecord` is that, and only that.

**The workspace overview reads both.** Reading only the attempts would make it
silently campaign-only; reading only the records would report almost nothing on
a platform whose traffic is campaigns. The payload names the two halves in
`sources`, because they have different freshness and the reader cannot otherwise
tell a five-minute-old total from a live one. **A campaign report reads only
`CallAttempt`.**

**Why a fact table at all**, given the calls surface exists: that surface walks
the platform's listing per request, bounded at twenty upstream pages so one
request cannot read an account's whole history — which makes every total
computed over it a total over a truncated set. A list that is short is visibly
short; a number that is short is simply wrong.

`CallAttempt` carries `@@index([workspaceId, startedAt])` for this surface, and
it is not optional: every analytics query filters that table by workspace and
date, Postgres does not index a foreign key column on its own, and the export
pages under a bare `workspaceId` predicate — so without it the walk is quadratic
in the workspace's history.

```
CallRecord       id, upstreamCallId (unique), workspaceId?, agentId?,
                 direction?, status?, disposition?, phone?, startedAt?,
                 durationSecs?, creditsCharged?, ingestedAt, updatedAt
                 @@index([workspaceId, startedAt]) @@index([workspaceId, disposition])
                 @@index([startedAt])
AnalyticsCursor  id ("singleton"), lastStartedAt?, lastCallId?, coverageFrom?,
                 lastRunAt?, lastRunCount, lastRunTruncated
```

There is deliberately **no `campaignId` on `CallRecord`** — it would be null on
every row, and an index on it an index on nothing.

**No foreign keys on `workspaceId` / `agentId`, and the absence is the
deliberate part.** A fact is an observation about something that already
happened and must outlive what it observed. The same reasoning `WebhookEvent`
carries.

### Ingest

`src/services/analyticsIngest.ts`, the only thing on this surface that talks
upstream. The pool is **partner-wide**: it walks once for the whole platform and
stamps each row with the workspace it resolves to, so a mistake here does not
lose data — it puts one customer's traffic on another customer's chart, as a
number, which is the form a reader is least likely to question.

- **The walk** pages from offset 0 and stops when the page came back short, the
  budget is spent, or the page's oldest row has descended past `lastStartedAt`
  minus the overlap window.
- **The high-water mark moves over every row the pass *scanned*, not over the
  rows it stored**, and the two are barely related here: campaign calls are the
  traffic and every one of them is skipped. Advancing it from what was stored
  meant a pass reading two thousand campaign calls advanced it by nothing — so
  the next pass re-read the same two thousand, forever, spending the whole page
  budget against a shared rate limit to ingest nothing, and reporting
  `lastRunTruncated` permanently. Worse, the walk always restarts at offset 0:
  an inbound call that sank below the budget depth between two passes was then
  never read by any pass. `coverageFrom` is still computed from stored rows —
  it answers how far back the *table* reaches, which is a question about rows,
  while the mark answers how far the *walk* has looked.
- **A row dated in the future cannot move the mark.** It only ever moves
  forward, so one bad carrier clock would park it a year out and silently
  degrade every later pass to reading page one and exiting.
- **The overlap window is not paranoia.** Upstream offsets are computed against
  a list that grows while it is walked, so a call placed mid-pass shifts every
  row down one and a page boundary read after the shift skips the row that
  crossed it. Re-reading `ANALYTICS_SYNC_OVERLAP_MINS` costs one page; the
  unique key makes it free of consequence.
- **The newest-first exit is guarded, not assumed** — the call surface's rule.
  The ordering is documented behaviour, not a promise, and the cost of being
  wrong is silent: page one would fall below the mark, the walk would stop on
  it, and every call after the first pass would be missed with nothing to say
  so. Descent is observed across rows in hand before the exit is taken, and
  abandoned for good the moment a pair ascends.
- **The first pass is a bounded seed, not a backfill.** With no cursor it walks
  up to its page budget and records `coverageFrom` and `lastRunTruncated`. A
  worker that quietly read an account's entire past against a shared rate limit
  is a cost nobody asked for. What the table covers is recorded and stated,
  never implied.
- **Passes are re-entrant guarded**; two concurrent walks double the upstream
  cost to produce identical rows.
- **An upstream failure propagates.** Swallowing it would let the cursor advance
  past calls the pass never read.

### What ingest stores, and what it refuses to

Two legs, resolved from maps built once per page.

- **The campaign leg decides whether to store the row at all**, not which
  workspace it belongs to. It parses `client_reference_id` with main's strict
  `src/lib/callCorrelation.ts` — the first two segments are all this needs, so
  the dialer's fourth is simply ignored — then resolves the key's *contact* id
  and requires it to name a contact **actually on the campaign the key claims**.
  A match means the dialer already wrote a `CallAttempt`, and the row is
  **skipped**.
- That two-factor check is what makes the leg safe on a shared account: the
  field is free text and a campaign id is an ordinary identifier every member
  can read, so a single-factor leg would let anyone able to place a call on the
  partner account drop it into somebody else's history. It matters in both
  directions here — a forged key must not cause a call to be *dropped* any more
  than it should cause one to be misattributed, so a key that fails the check
  falls through to the agent leg like any other row.
- **The agent leg** matches `agent_id` against `Agent.externalId`; an agent with
  `workspaceId = null` maps nothing. `agentIsUsable`/`NOT_REMOVED` are
  deliberately not applied: they answer "may this workspace start something with
  this agent", and this asks whether it *placed* the call, which does not stop
  being true when staff retire the agent.

**An unmappable call is quarantined, never guessed.** `workspaceId IS NULL` is a
real and expected state — a call another integrator placed on the shared
account, or one on an agent nobody holds. It is counted by nobody and invisible
to every route. No heuristic will be invented: the agent's *current* workspace,
a phone match, the nearest campaign are each a way to put one customer's calls
on another's page.

**Attribution is written once and repaired in one direction only.**

| Stored | Resolved now | Written |
|---|---|---|
| `NULL` | a workspace | **yes** — a quarantined row is repaired |
| `NULL` | `NULL` | no change |
| workspace A | workspace A | no change |
| workspace A | workspace B | **no** — kept as A |

The first line makes quarantine safe rather than lossy. The last is the one that
matters: staff reassignment is an `UPDATE` no constraint can see, so without it
the day an agent moves from A to B is the day a late re-ingest slides A's old
calls onto B's charts. The *descriptive* columns are different and refresh every
pass — a call first seen while ringing has to become a completed call with a
duration.

**Started from `worker.ts` only, never from `createApp()`** — the renewal
sweep's and dialer's rule, for this worker's own reason: a test that builds the
app must not start a timer that reads the partner account.
`test/analytics-sync-startup.test.ts` asserts it. `ANALYTICS_SYNC_ENABLED` gates
the timer, is **off by default including in tests**, and is read through the
same strict `flag()` the dialer switch uses. The manual refresh is deliberately
not gated on it — an operator pressing it has asked for a pass.

### Classifying an outcome

`src/lib/callOutcome.ts`, and nowhere else — three surfaces read this rule and
three copies of it eventually say three different things, which here is two
charts on one screen disagreeing about the same calls.

```
answered   completed · transferred · user_hangup_no_speech   (status: completed, in_progress)
voicemail  voicemail
no_answer  no_answer
busy       busy
failed     failed · blocked · canceled
abandoned  the dialer's reaper closed the attempt without learning the outcome
other      everything else
```

Read from `disposition`, falling back to `status`, case-insensitively. The
disposition wins where both exist: a voicemail's *status* is `completed`, so
reading the status first would report every voicemail as a human answering.

**`classifyAttempt` is the three-field variant** for `CallAttempt`, which
carries the carrier's `disposition` and `upstreamStatus` beside our own enum
`status`. **`ABANDONED` outranks both carrier fields** — it is our reaper's
verdict, written over whatever the carrier last said, which is typically a stale
`ringing`. The schema is emphatic that "we never found out" and "the callee did
not answer" are different facts and a report conflating them misstates the
campaign's results; that is why `abandoned` is its own bucket rather than
`failed`, and why it is not `other` either — `other` means a value this service
does not recognise, and this one is recognised precisely.

**`other` is a real bucket and is always reported.** The published sets grow
without this service deploying; folding an unknown value into `failed` would
report a carrier's new outcome as a failure, and dropping it would shrink the
denominator of every rate. It also appears verbatim in the `dispositions`
breakdown, which is a `groupBy` on the raw column and hides nothing.

**Connected** is `answered + voicemail`. **Answer rate** is `connected / calls`,
and both halves ride in the payload. `totals.unresolved` counts `abandoned +
other` beside it, because those sit in the rate's denominator: a page printing
"42% answered" over a set that is a third unreadable is overstating how much it
knows, and only that number lets the reader see it.

### Credits

Calling **is** metered — the dialer prices each attempt against the tier it was
launched under and writes a `CALL_USAGE` ledger row when the completion webhook
lands. Every payload carries `metered: true`.

**Every credits figure is summed from the LEDGER, never from
`CallAttempt.costCredits`.** That column also records what was *owed* on a
shortfall — a call that completed against a balance too small to cover it, where
nothing was debited and the campaign was paused — so adding those in would show
a workspace spending credits it still has. `/campaigns/:id/stats` takes the same
rule, and `CALL_USAGE_SHORTFALL` is excluded by type.

The sum is scoped **through `callAttempt`**, not through the ledger row's own
`workspaceId` and `createdAt`. A charge lands minutes after its call, so
filtering on the ledger's own timestamp would drop the last day's calls out of
the money column while leaving them in the call count beside it.

A range with no charges reports `null`, not `0` — a zero under a credits heading
reads as "these calls were free".

`CallRecord.creditsCharged` stays null on every row: metering charges a campaign
attempt, and nothing in that table is one. It is emphatically not upstream's
`credits_used`, which is what this platform was billed by its supplier — the
calls surface refuses to emit that because publishing it publishes the margin.

### Routes

| Route | Role | Notes |
|-------|:----:|-------|
| `GET /api/workspaces/:id/analytics/overview` | member | `?from=`, `?to=`; totals, `sources`, daily series, outcome breakdown, per-campaign rollup, coverage |
| `GET /api/workspaces/:id/campaigns/:cid/analytics` | member | funnel, `lifetime`, `attemptOutcomes`, `dialLadder`, outcomes, daily series |
| `GET /api/workspaces/:id/analytics/export` | member | streamed CSV of both sources; `?campaignId=` narrows it |
| `POST /api/workspaces/:id/analytics/refresh` | **ADMIN** | runs an ingest pass; rate limited per workspace |

The three reads are open to any member, following the calls surface: nothing in
an aggregate over a workspace's own calls is sensitive to a MEMBER that an ADMIN
should see instead, and a MEMBER operating campaigns is exactly the person who
needs to know whether they are connecting. **The refresh is ADMIN** because it
is not a read — it spends the partner account's ingest budget on behalf of the
whole platform, from one workspace's page.

- **The range is resolved, echoed and never assumed.** Absent bounds default to
  the last 30 days and the resolved pair comes back in the payload. Parsing
  follows `src/lib/analyticsQuery.ts`, whose rules are `callQuery`'s — a bare
  `YYYY-MM-DD` is a UTC day, a timestamp needs an explicit zone, `from > to` is
  a 400. Separate file, because one parser describing two contracts eventually
  hands each the other's defaults. **A span wider than `MAX_RANGE_DAYS` (366) is
  a 400**, checked on the resolved pair so naming one end and letting the other
  default cannot walk past it: the series is dense, so the response grows with
  the span asked for rather than with the data behind it, and a four-digit year
  in `from` is ~3M day objects on a route open to any member.
- **Daily buckets are UTC days**, emitted as `bucket`/`timezone` rather than
  implied, and the series is a `$queryRaw` **union** of both tables since Prisma
  has neither `date_trunc` nor a union. `date_trunc` takes the **bare column**,
  with no `AT TIME ZONE`: `startedAt` is a naive timestamp already holding UTC,
  and `"startedAt" AT TIME ZONE 'UTC'` reads like it forces the intended zone
  while doing the opposite — it yields a `timestamptz`, whose truncation follows
  the *session's* `TimeZone`, which nothing sets and Prisma does not pin. A row
  whose key shifted before the range's first day was dropped from the series
  entirely, so the chart and the tile above it disagreed. `attempt_status` is null on the
  `CallRecord` half, which is how the classifier knows which rule to apply.
- **The series is dense.** A day with no calls is a zero emitted from the range
  rather than from the rows — a sparse series drawn as a line silently connects
  across the gap and renders a quiet week as a decline.
- **A rate with no denominator is `null`, never `0`.**
- **A campaign in another workspace is a 404** with the same body a nonsense id
  gets. The aggregate then filters on `workspaceId` **as well as** `campaignId`:
  redundant with the ownership check by design, so a later refactor of that
  lookup cannot silently widen the query.
- **The per-campaign rollup is derived from the attempts outward**, not from the
  campaigns table — which would list every draft as a row of zeros.
- **Coverage is reported.** `coverage.from` is how far back `CallRecord` goes
  and `coverage.truncated` says whether the last pass finished. `null` means no
  pass has ever run — a third state, which must not read as "complete".
- **`firstCallAt` is the workspace's own earliest call, over all time**, and it
  is what tells the two empty states apart. `coverage` cannot: it is
  platform-wide, so it says the same thing on every workspace's page, and it
  describes only the non-campaign half while the totals span both. "You have
  never placed a call" is a claim about the reader's business; "nothing happened
  in these thirty days" is a claim about the window they chose.
- **Every stage of the campaign funnel is a lifetime figure**, marked
  `scope: 'campaign_to_date'` on the wire. `contacts`, `attempted` and
  `completed` are counted off `CampaignContact`, which records only a contact's
  current state and has no notion of a range, so `connected` is counted over the
  campaign too. Range-scoping one stage of a funnel and not the others made a
  campaign that finished in June, opened in August, read "attempted 950,
  connected 0, completed 900" — three true numbers arranged into a false
  sentence. The range-scoped reading is `totals`, beside it in the same payload.
- **Every stage counts CONTACTS, and `connected` had to be rewritten to make
  that true.** It counted attempt rows, which made it a different measurement
  sharing an axis with three that count contacts — and one unbounded above,
  because a lead on a retry ladder connects more than once. The September
  Touchbase report printed **"Connected calls 3026, 202% of contacts"** with its
  bar pinned full beneath two stages reading 1500, and a reader subtracting one
  stage from the next got nonsense. It is now the same count `lifetime.reached`
  publishes, from the same `reachedContactsFilter` — **published twice rather
  than measured twice**, so the campaign list's ring, the Overview strip and
  this row cannot come to disagree about what "connected" means. The calls
  reading still exists and still belongs: it is `totals.connected`, where it is
  a share of calls and is labelled as one.
- **`attemptOutcomes` replaces the retry distribution.** One row per dial
  ordinal — `{ attemptNo, connected, notConnected }`, ascending, ordinals
  nothing rang at absent rather than zero-filled. The distribution it replaces
  grouped `CampaignContact.attempts` and said how far up the ladder each contact
  had climbed, which is not the question a ladder raises: an operator reading
  "558 contacts on their first retry" could not tell whether that retry had been
  worth placing. It is unique by construction —
  `unique(campaignContactId, attemptNo)` means a contact contributes at most one
  dial to each ordinal — so a rate over the row's own total is a real rate, the
  property `funnel.connected` had to be rewritten to get. An attempt carrying a
  `launchError` is in **neither** count: no telephone rang, so it is not
  somebody who failed to pick up. `connected` here is `reachedAttemptSql`, not
  the `tally` classifier — that one answers "how did this CALL land" and counts
  a voicemail as connected, which is right for a chart of calls and wrong for a
  question about whether a person was on the line.
- **`dialLadder` is that ladder with what each ordinal still owes.**
  `{ attemptNo, connected, notConnected, due }`, one row per dial ordinal.
  **The ordinal is a `ROW_NUMBER` over the dials that RANG**, not
  `CallAttempt.attemptNo`: the stored ordinal counts claims, and a claim the
  platform refused leaves a row behind with no telephone call in it, so
  renumbering keeps rung 1 the first dial that happened and keeps `due`
  (placed + 1) naming the same rung the placed counts do. It answers the one
  thing `attemptOutcomes` cannot — **a rung that has not finished says so**:
  `due` counts contacts still `PENDING`, one rung past however many dials they
  already have, so a contact nobody has rung is owed rung 1. A settled contact
  is owed nothing however its arm reads, and a dial in flight is placed rather
  than due, since its attempt row already exists. It deliberately does **not**
  consult `CallAttempt.kind`: an earlier cut split these rows by lane
  (`first | retry | follow_up | callback`) and, on the campaigns with the most
  follow-ups, filed them as retries — `kind` is nullable on everything dialled
  before it existed. An operator counts dials, not arms: attempt 4 is the
  fourth time that telephone rang, whatever chose to ring it. It ships
  **beside** `attemptOutcomes`, not instead of it: the dashboard deploys ahead
  of this service.
- **`attempted` is `lastAttemptAt IS NOT NULL`, and deliberately not the dial
  counters.** It is the one stage whose evidence is not the contact's current
  state, because no counter records it: **none of `attempts`, `callbackCount`
  or `followUpCount` moves on a contact that answers its first dial and
  settles** — `attempts` is retries consumed and only the retry re-arm
  increments it. Counted off them, a plain campaign where most people picked up
  reported them as never dialled and shipped `completed` **above** `attempted`,
  the same false sentence one stage further on. `lastAttemptAt` is stamped by
  the claim in the same `UPDATE` as `status = 'QUEUED'`, in every lane, and
  never cleared — so it is present on every contact a later stage can describe,
  which is what makes `contacts >= attempted >= completed` hold by construction.
  It over-counts a claim whose placement job never ran, which is the safe
  direction. **Counting `CallAttempt` rows instead is the wrong evidence, not
  the expensive one** — the exact alternative is one
  `COUNT(DISTINCT "campaignContactId")`, a single cheap statement.
  `lastAttemptAt` is written in the same `UPDATE` that flips the contact to
  `QUEUED`, while the `CallAttempt` row is inserted later by the placement
  worker — the window `releaseStaleClaims` exists to clean up — so read off
  attempt rows this stage would report a campaign's in-flight batch as
  untouched. A funnel stage should err wide.
  **`HAS_BEEN_DIALED_SQL` is this same column**, so the campaign list's
  `outcomes` bar, `/stats`' `waiting` split and the bucket panel all answer this
  question the way this stage does.
- **`lifetime` is the same rule, for the strip above the funnel.** `reached`,
  `goalCompleted`, `talkSecs` and `reachedTalkSecs`, all campaign-to-date and
  none of them touched by the picker, for the funnel's own reason: three of the
  four are per-contact and `CampaignContact` holds only a contact's current
  state, so a range-bounded talk-time sum over a lifetime contact count divides
  two different spans. Three rules hold this block together and each exists
  because breaking it produced a wrong number on the page:
  - **`reached` counts ATTEMPTS, never `CampaignContact.disposition`.**
    `reachedContactsFilter` (`campaignOutcomes.ts`) matches a contact with **at
    least one** attempt whose own disposition is in `REACHED_DISPOSITIONS`, and
    both readouts of the sentence — this one and `/stats`' `reached` — come from
    that single filter.

    It was counted off the join row's `disposition` under a `SETTLED_STATUSES`
    gate, and both halves were wrong in the same direction. That column is the
    LAST dial's outcome, rewritten by every resolution, so a lead that had a
    real conversation and was later followed up into a voicemail stopped
    counting; the gate then dropped every contact the goal follow-up had
    re-armed to PENDING, which on a running campaign is most of the ones it has
    spoken to. On a live touchbase campaign the pair reported **158** where 500
    contacts had taken 1,276 calls, and the figure FELL as the campaign kept
    working — the property that makes it unusable rather than merely low.

    **It is therefore expected to exceed the reached tier of the outcome bar,
    and that is not a disagreement to fix.** The bar partitions the roster by
    where each contact stands *now*; this counts what has happened to them at
    any point. Two questions, two answers, both published, each captioned. The
    old rule — "the gate is what makes the two agree" — is retired; what
    replaces it is that **neither may be derived from the other**.

    `EXCLUDED` contacts are counted, deliberately: removing somebody does not
    un-say what was said to them, and every denominator this figure is drawn
    over (the funnel's `contacts`, `/stats`' `total`) counts `CampaignContact`
    rows with no status gate of its own. It is `Campaign.totalContacts` that a
    removal decrements, and nothing divides by that.
  - **`goalCompleted` is `null` on a campaign with no goal, never `0`** — the
    extraction was never asked for a verdict, which is a different fact from it
    having judged nobody complete. It carries **no** status gate, so it stays
    equal to the figure `/stats` puts on the goal tile.

    It is now **a subset of `reached`** in every case the platform can produce,
    which is what lets the completion rate divide by it: the verdict comes from
    a post-call extraction, so a contact carrying one has a conversation
    somewhere in its history, and `reached` counts that history. While `reached`
    read the last dial it was NOT a subset — a met goal settled on a voicemail
    sat outside it — and the rate had to divide by the roster, which reported a
    campaign that had spoken to two thirds of its list as having completed a
    quarter. The subset is a property of how the verdict is produced and not a
    constraint this schema carries, so the dashboard still clamps.
  - **`reachedTalkSecs` exists so an average has one population.**
    `talkSecs` is every recorded second on the campaign, answering machines
    included. `talkSecs / reached` rendered five real conversations among
    ninety-five voicemails as ten minutes "per contact"; the narrowed sum is the
    numerator that matches the denominator. Narrowed to the reached **attempts**
    and not to every attempt of a reached contact: the voicemails left for a
    lead before they finally picked up are not time spent talking to them, and
    rolling them in puts the average back above the length of any conversation
    that happened.

### The export

Streamed, `text/csv; charset=utf-8`, with a UTF-8 BOM. `Cache-Control: private,
no-store` — one customer's call log leaving through a URL a shared cache cannot
scope. The filename carries the workspace **slug**, not its name: a name may
hold a quote, a comma or a newline, and this value goes into a header some
clients write to disk.

**Both sources, merged newest-first.** Each is walked by its own keyset and a
two-way merge takes the newer head, so the file is in one chronological order
rather than one source after the other, at one row per source of memory. A
`source` column says which row came from where, because the two carry genuinely
different fields. `?campaignId=` **drops** the `CallRecord` source rather than
filtering it — no row there is a campaign call.

`cost_credits` and `charged` are two columns because a call can complete against
a balance too small to cover it: the cost is real, the charge never happened,
and one column would have to pick which to tell.

**The range is parsed before the first byte.** Once the header row is out the
status line has gone with it and there is no way left to report a failure. A
failure mid-stream destroys the connection rather than ending it — ending
normally hands the reader a truncated export that opens perfectly well.

**Paged by hand-written keysets on `(startedAt, id)`, folded into the same
`where` as the scope.** Never Prisma's `cursor`: it resolves through an
unfiltered subquery, so an id the caller cannot see still steers the query — an
existence-and-position oracle across the tenant boundary — and its unconditional
`skip: 1` then drops a row the caller never saw. The tiebreaker on `id` is not
optional: rows written in one pass share a `startedAt` to the millisecond, and
an unstable sort repeats one row and omits another.

**No row cap** — which is only honest because backpressure is honoured.
`res.write`'s return value is read and the walk waits for the response to drain
before reading another page; the drain is raced against `close` and the walk
checks whether the response is gone between pages, so a reader who shuts the tab
ends the walk rather than leaving it suspended. A cap would mean either a
truncated file that reads as complete — the one outcome forbidden on every
listing in this service — or a truncation marker that becomes a data row in
somebody's spreadsheet.

**Every cell is neutralised against formula injection**, and this is not
theoretical: `phone` is E.164, so *every* number begins with `+`. A leading `=`,
`+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe and quoted.
Quoting alone does not help — a spreadsheet strips the quotes and evaluates what
is inside.

### Deliberately not here

- **Real-time non-campaign facts.** Campaign calls are live; everything else
  arrives on the sync interval, and the payload's `sources` says so. Folding the
  webhook receiver into the ingest would close that gap for inbound calls too.
- **Extraction analytics.** Extraction lives on a call's detail, so counting it
  means an N+1 against the shared rate limit.
- **Per-agent rollups.** The columns and indexes support them; no surface asks
  for one, and an endpoint with no reader is an endpoint nobody maintains.
- **A workspace-configurable bucket timezone.** See the daily-bucket note.

### Environment

```
ANALYTICS_SYNC_ENABLED            # optional, default false — exactly "true"/"false"
ANALYTICS_SYNC_INTERVAL_MS        # optional, default 300000, floor 60000
ANALYTICS_SYNC_MAX_PAGES          # optional, default 20, floor 1 — 100 calls per page
ANALYTICS_SYNC_OVERLAP_MINS       # optional, default 10, floor 0
ANALYTICS_REFRESH_RATE_LIMIT_MAX  # optional, default 4 per minute per workspace
```

## What a finished call leaves behind

The platform tells us a good deal about a call that has ended, and this service
used to keep almost none of it. `session.completed` carries the conversation,
the variables the dial went out with, whether audio exists and the carrier's
own billed duration; the outcome path read `disposition`, `answered_by`,
`hangup_cause`, the durations and the extraction, and dropped the rest on the
floor. Everything dropped was then fetched live, per view, from
`GET /calls/:id` — or, in one case, guessed at.

`CallAttempt` now carries them:

| Column | What it is | Was |
|---|---|---|
| `extraction` | the agent's keys and the model's answers | already stored |
| `hangupSource` | WHO ended the call, beside the cause that says how | dropped; live-read on call detail only |
| `endCallReason` | the platform's one-vocabulary ending, superseding both of the above (since 2026-09-15) | new |
| `transcript` | the conversation, bounded | dropped |
| `variables` | what this dial was actually told | computed at dial time, then forgotten |
| `recordingAvailable` | whether the platform holds audio | **guessed** from the duration on the journey |
| `billDurationSeconds` | the carrier's own billed seconds | dropped |

**Deliberately still not stored.** `credits_used` — what the supplier billed
*this platform* — for the reason the calls surface refuses to emit it:
publishing it publishes the margin. And the recording **URL**, as opposed to
the flag: a presigned link expires in seven days, so a stored one is dead
almost immediately, and it is a bearer credential for a customer's call audio
that outlives any membership check. The bytes are served through this service
against a freshly minted URL.

### Bounding, and the field that is not what it is called

`src/lib/sessionCapture.ts` is `extractionCapture`'s sibling and makes the same
argument: this is free text a third party produces, stored verbatim it puts the
size of this database in their hands, and it is bounded on the way **in**
because the reason to bound it at all is that it is stored. Turns, characters
per turn, and a total budget — the per-turn cap alone bounds a row at turns ×
chars, which is megabytes. A conversation cut short gains a visible `system`
turn saying so, in the transcript rather than in a flag beside it: every reader
of this value is rendering a conversation and none of them would think to check
a flag.

**The transcript field is not always a transcript.** The documented shape is an
array of turns, but a call that never connected arrives as an OBJECT —
`{ error, provider, terminal_reason }` — and one still being processed arrives
as null. `normalizeTranscript` exists to stop a renderer presenting the second
as speech, and the same hazard applies a layer earlier: a carrier diagnostic
written into a column named `transcript` is internals filed as something the
customer said, and every later reader inherits it. So only an array is stored.

**NULL and `[]` are different facts and both are real.** Null is no
conversation recorded; `[]` is a call that connected and on which nobody spoke.

### Both paths write it, and that is the invariant

The webhook reads these off the delivery's envelope; the reaper's reconcile
reads them off `GET /calls/:id`, which returns
`session: { transcript, recording_url, variables, extraction, … }`. Both hand
the raw values to `applyTerminalOutcome`, which bounds them — neither caller
bounds its own, exactly as neither bounds its own extraction, because a caller
that did would be a second place deciding what a stored conversation may be.

`undefined` means **this delivery said nothing about the field** and is spread
out of the update rather than written, so a pacing event carrying no session
cannot blank a conversation the completion already stored.

### Recovering the history

Three backfill scripts over two walks, and the difference between the walks
is which endpoint holds the answer.

| | `backfill:hangup-source`, `backfill:end-call-reason` | `backfill:session` |
|---|---|---|
| Reads | the **listing** | the **detail** |
| Cost | 1 request per 100 calls | **1 request per call** |
| Scope | platform-wide walk | **one campaign, refused without one** |

The listing carries `hangup_cause`, `hangup_source`, dispositions, durations
and timestamps — and **no transcript, no recording and no variables**. That one
fact is the whole difference in shape: the second walk is an operator script
scoped to a campaign, bounded, and modelled on the re-extraction tool, which
already fetches one session per contact at concurrency 4 and is proven at
Touchbase scale.

**`recordingAvailable` is the "already looked" marker**, not `transcript`. A
call that never connected legitimately stores a null conversation, so keyed on
the transcript every silent dial would be re-fetched on every run for ever —
which on a campaign that is mostly no-answers is nearly the whole walk. The
boolean is written on every successful recovery whatever the conversation
turned out to be. That is what makes a re-run cost nothing for rows a previous
run finished, which for a walk this expensive is the property that matters.

**A call the platform no longer has is counted, not fatal.** `gone` is the
figure to read on an old campaign: it is how much of the history upstream no
longer holds, and no later run will recover it. Stopping on the first one would
mean a single pruned call blocks every later one.

### What reads them

- The **leads export** prefers a dial's stored `variables` over reconstructing
  them from the campaign's current `variableMap`. The reconstruction is right
  only while that map has not been edited since the calls were placed; the
  stored values are what the agent was actually told. It falls back to the
  reconstruction for attempts settled before the column existed — a blank
  column would claim the dial carried nothing, which is a stronger and worse
  claim.
- The **journey's `hasRecording`** reads `recordingAvailable` where there is
  one and keeps its duration heuristic only where there is not. That predicate
  used to guess while its own comment pointed at the call detail as
  authoritative; this is that answer, stored.

## The campaign exports

Two CSVs per campaign, at **byte-identical header parity** with the export this
product replaces, so either is a drop-in for anything already reading those
files.

| Route | Role | Grain |
|-------|:----:|-------|
| `GET .../campaigns/:cid/export/leads` | member | one row per `CampaignContact` |
| `GET .../campaigns/:cid/export/calls` | member | one row per `CallAttempt` |
| `GET .../campaigns/:cid/export/custom` | member | one row per `CallAttempt`; `?fields=` picks column groups, `?from=`/`?to=` bound `startedAt` |

The third file has no parity contract and exists to carry what the other two
cannot: `?fields=` is a comma list of `attempts`, `credits`, `variables`,
`extractions`, `transcript`, `recording`, `session`, laid out in that fixed
order after seven identity columns, the last of which is `Direction`.
**Inbound calls ride the same file**: `CampaignInboundCall` is walked by its
own keyset and merged with the dials by time, filling what an inbound row
records and leaving the rest blank — a campaign that only received calls used
to export a header and nothing else. Since 2026-09-17 an inbound row also
holds `transcript` and `recordingAvailable`, written by the completion webhook
under the same `processingHappened` rule the dial path uses and recovered for
older rows by `npm run backfill:session -- --campaign <id> --inbound`; the
recording cell links the call page by `upstreamPhoneCallId`, the id that page
resolves. An unknown or empty list is a 400
**before the header row**. The extraction group is per dial — it publishes what each
call wrote, voicemails included, which is the opposite of the leads sheet's
rule and is said beside the checkbox. The recording column is a link to the
dashboard's call page, never the audio URL, which is a two-minute token.
`src/services/campaignCustomExport.ts`.

Two files because they answer two questions. The **leads** sheet is the
worklist an operator sorts and filters — where each person stands, what the
conversation extracted, and the variables the dial went out with. The **call
detail** is the dial log, and is what reconciles against the carrier
call-for-call. Member reads, following the analytics export: nothing in a
workspace's own call history is sensitive to a MEMBER that an ADMIN should see
instead.

Both resolve the campaign through `campaignInWorkspace()` first, so a foreign
id, an unmapped one and nonsense 404 alike; both stream, honour backpressure,
race drain against close, and **destroy the connection on a mid-stream
failure** — once the header row is out the status line has gone with it, and
ending normally hands the reader a truncated file that opens perfectly well.
The filename is built from a REDUCED campaign name: the name is the customer's
own text and may hold a comma, a quote or a newline, the same reason the
analytics export uses a workspace slug.

### Which extraction speaks for a lead

**The lead-bucket rule, reused rather than restated.** Not the last dial's
extraction: the latest attempt that carried one **and** reached a person —
`campaignBuckets.ts`'s two-part predicate. Both halves were production bugs. A
later dial that extracted nothing must not erase what an earlier one learned;
and a voicemail's extraction is not an answer, because the post-call model
fills in every key it is given whether or not anybody spoke (27 contacts of 843
on the two September campaigns, PR #48). **An export deriving this differently
would contradict the bucket chip the dashboard shows for the same lead**, which
is the whole reason it is one rule.

### Which columns exist

- **`Lead Metric <key>` + `<key> Reason`, and `Lead Entity <key>`.** Nothing
  here records that distinction and nothing upstream reports it, so it is
  derived: **a key with a sibling `<key>_reason` is a metric; a key without one
  is an entity.** That reproduces the reference file's split exactly — all ten
  of its metrics carry a reason, none of its five entities does — and it is the
  convention the call-note contract is already written in.
- Keys come from the **data** (`DISTINCT jsonb_object_keys`, riding
  `call_attempts_campaign_extraction_idx`), never from `Agent.rawConfig`, which
  this service documents as a display cache and not a source of truth: a stale
  snapshot produces a header that does not describe the file beneath it.
- **Reserved keys are dropped**, reusing `RESERVED_EXTRACTION_KEYS` rather than
  listing the names again. Each already reaches the row as a first-class column,
  and emitting it again puts two versions of one fact side by side, one of them
  phrased for a language model.
- **The variable columns are the AGENT VARIABLE names.** `variableMap` is
  `{ csvColumn: agentVariable }`, so the header is its **values**, and values
  resolve through the precedence `mappedVariables` uses in the dialer — contact
  columns winning over a metadata key of the same name. Getting this backwards
  labels every column with the customer's spreadsheet heading instead.
- **The tool columns are on the call detail and on that sheet only.** Putting
  them on the leads sheet too makes that file three columns wider than the one
  it replaces, which is the same break as omitting one. `test/fixtures/convin-export-headers.json`
  pins both headers and is what caught it.

### end_call_reason

`CallAttempt.endCallReason` is the platform's **one-vocabulary answer to how a
call ended**, the same on every carrier, live on the platform since
**2026-09-15**. It **deprecates `hangup_cause` and `hangup_source`**: both are
still sent this release and removed the next, so their columns and every
reader of them stay — as the fallback for rows settled before 2026-09-15, and
for nothing else. Free text, never an enum: the platform says the set may grow,
and an unlisted value must not fail an ingest. Every consumer normalises it
(upper-cased, trimmed, blank = null) through `src/lib/endCallReason.ts`.

The value arrives on three surfaces and does not mean the same thing on each:

| Surface | Where | What it is |
|---|---|---|
| `session.completed` | `data.call.end_call_reason` (envelope read second) | **authoritative** — the bot's own view of the ending; an answered call with no bot report is `UNKNOWN` |
| `call.status.updated` | `data.end_call_reason` | `null` while live; on the terminal event a **carrier snapshot** — an answered call reads `COMPLETED` here and its real ending (`CUSTOMER_HUNG_UP`, say) on the completion |
| `GET /calls`, `GET /calls/{id}` | `data.end_call_reason` | authoritative, **derived on read** — so every historical call has one and the backfill below can fill it |

The vocabulary splits in two. Unanswered calls resolve from the **carrier**:
`BUSY`, `NO_ANSWER`, `REJECTED`, `BLOCKED`, `INVALID_NUMBER`, `NETWORK_ERROR`,
`CANCELED`, `NOT_CONNECTED`. Answered calls resolve from the platform's **bot**:
`COMPLETED`, `CUSTOMER_HUNG_UP`, `TRANSFERRED`, `VOICEMAIL`, `SCREENER`,
`UNKNOWN`. `SYSTEM_ERROR` comes from either half — a server restart, the wallet
dry, the bot process torn down, a connected call that failed with no bot
report. **`COMPLETED` means the bot ended the call** (its pipeline finished),
NOT that the call succeeded; a bot that hung up mid-refusal reports it just the
same. It is the attribution `hangup_source` gave on ~24% of voicelink calls,
now on every answered one.

**The read rule for "nobody heard".** A platform fault (`SYSTEM_ERROR`, or an
`error_code`) hands the contact back only when the call was neither answered
nor heard: `answered_by: human` OR an `answeredAt` stamp (the IN_PROGRESS
status event's, or the completion's / detail's `answered_at`, persisted onto
the row when the row lacks it) makes it the conversation it was. The stamp is
read because on voicelink the platform writes `answered_by: human` only when
the bot's session-queue worker completes normally — the very teardown that
produces `SYSTEM_ERROR` leaves it null on a call a person had answered, and
reading the detector alone redialled that person at no ladder cost, under no
cap, every cooldown. `classifyOutcome`, `platformFaultOnRow` and both
never-placed spellings apply the same three-column test.

**The write rule.** Three writers, and none writes null over a value. The
terminal status event writes its snapshot onto an open attempt only
(`updateMany` on the non-terminal statuses); `session.completed` writes
unconditionally, so the bot's view **overwrites** the carrier snapshot; the
reaper's reconcile reads it off the detail and, like the webhooks, spreads the
key out of the update when the payload does not carry it, so a detail that
predates the field cannot blank what a webhook stored. A whitespace-only reason
is normalised to null *before* that guard.

**The dashboard prints words, never the token.** `endReasonLabel` in
`src/lib/endCallReason.ts` is the only label map; it travels as `endReason`
beside `endCallReason` on call detail and as `end_reason` beside
`end_call_reason` on the attempt row (next to `hangup_cause`), and is null for
a value this service has no words for yet, which hides the row.

### The disconnect columns, and the one that is empty

`Call Disconnected By` and `Disconnect Reason Key` are derived from
`CallAttempt.endCallReason` **first**, `CallAttempt.hangupSource` second, and
the disposition last. The source is a **new column**, because the platform carries
`hangup_source` on its deliveries and this service dropped it at the rewrite
(the old backend kept it; here it survived only as a live read on call detail,
which stores nothing). It is written by the completion webhook, by a terminal
`call.status.updated`, and by the reaper's reconcile, and free text like every
column beside it.

The mapping is measured, not invented: cross-tabulating the reference file's
5,328 rows leaves the two columns a pure function of each other with exactly
four combinations. It is an **allow-list** — an unrecognised source is reported
as unattributed rather than folded into whichever entry looks closest.

**With no source, the system is credited only where nobody was ever on the
line** — the call rang out or the line was busy. The reference file attributes
an unsourced row exactly two ways, `no_answer` to the system and `failed` to
nobody, and contains no unsourced *completed* call at all; reading "somebody
answered and we were not told who hung up" as "the system hung up" extrapolates
past that. A conversation ends because one of the two parties ended it, and
which one is precisely what is no longer reported.

**`hangup_source` is live on voicelink since 2026-09-07, and backfilled to
2026-08-12.** The platform documents it in `partner-hangup-source.md`: derived
for voicelink from per-leg signalling, ~82% coverage of answered calls, and
`null` for the ambiguous remainder. Calls before 2026-08-12 are permanently
null — the signalling is no longer retained.

**Its vocabulary is the platform's and NOT what SIP suggests**, which is the
part worth reading twice:

| value | means |
|---|---|
| `caller` | **the person on the other end hung up** |
| `system` | **the agent ended the call** |
| `callee` | the dialled leg released it — the person, on carriers that split the legs |
| `carrier` | the network tore it down |
| `api` | a programmatic hangup |
| `error` / `unknown` | treat as unattributed, same as null |

Read as an outbound originator, `caller` looks like our own bot and `system`
like neither party. Both are wrong, and voicelink emits only those two — 49%
and 51% of sourced calls — so being wrong about them is being wrong about every
connected call in the export. `disconnectColumns` takes the mapping from that
document and treats anything unlisted as unattributed, which is what the
document itself asks for.

**Since 2026-09-15 the source is the fallback, not the input.** The bot
witnessed which side ended the call; per-leg signalling inferred it after the
fact. So `disconnectColumns` reads `end_call_reason` first, onto the SAME four
combinations (`END_REASONS` in `src/lib/campaignExportColumns.ts`):

| `end_call_reason` | Disconnect Reason Key | Call Disconnected By |
|---|---|---|
| `CUSTOMER_HUNG_UP` | `user` | Customer |
| `COMPLETED`, `TRANSFERRED` | `voicebot_hangup` | AI Assistant |
| `BUSY`, `NO_ANSWER` | `` | System |
| everything else (`VOICEMAIL`, `SCREENER`, the failure values, `UNKNOWN`, anything newer) | falls through to the source, then the disposition rule below |

A reason that says nothing about **who hung up** leaves the question to the
evidence that does, exactly as no reason at all does. Three cases the platform
actually produces made this the rule: it derives the reason from the Q.850
cause but the disposition WITHOUT it, so `INVALID_NUMBER` arrives beside
`no_answer`, which the reference file files under `System` (stopping at the
reason exported the same carrier outcome as System before 2026-09-15 and blank
after); the listing derives `UNKNOWN` for every connected call whose session
predates the platform's stored bot report (2026-09-14), which would otherwise
blank the ~5,500 rows the hangup-source backfill attributed; and a voicemail
is never attributed, the rule the disposition path already holds.

**`null` is never a category.** The platform is explicit that it means "not
reported", never "nobody hung up", and that a nobody-hung-up bucket in a report
is a reporting bug. Unanswered calls are always null; use the disposition.

**`Telephony Disposition` ships empty and that is deliberate.** In the same
file the one `user` key splits across two of its values, so the column is a
function of the hangup CAUSE as well as the source, and no production
distribution has been measured against it. A guess in a column an operator
reconciles against the carrier is worse than a blank.

### Backfilling the source

`npm run backfill:hangup-source` fills the column for dials that settled before
it existed — which is every dial on the campaigns anybody wants to export
today. It reads the **listing**, not one call at a time: that payload carries
`hangup_source`, so the walk costs one request per hundred calls rather than
one per call.

It **fills absences only**, through the null guard in a conditional
`updateMany`'s `where`. The webhook writes the same column at settle time and
is the fresher source, so overwriting would churn every row on each pass and
could put a stale listing value over a live one — and the guard is what makes
the script safe to re-run and safe to interrupt. An upstream failure
propagates; a truncated walk says so.

`npm run backfill:end-call-reason` is the **same walk** for `endCallReason`,
with one filter of its own: the walk never writes `SYSTEM_ERROR` or `UNKNOWN`
(`normaliseListedEndCallReason`). `SYSTEM_ERROR` decides a budget, and a
historical settle already spent or spared the retry under the rule of its day
— writing it now would re-arm contacts past their cap through every
never-placed reader and print "not counted" on dials that were. `UNKNOWN` is
what the platform derives for every connected call before it stored the bot's
report, and says nothing the row does not. Both stay null, which every reader
falls through from; the webhooks and the reaper still write them live.
The listing walk is generalised as `backfillFromListing(col, options)` in
`src/services/hangupSourceBackfill.ts` — one `(listing keys → column,
normaliser)` pair per script, with `backfillHangupSource` now a wrapper over it
and `src/services/endCallReasonBackfill.ts` the other pair. Same guarantees:
fills nulls only, normalises before the write (so a listing-filled row reads
like a webhook-filled one and a blank is no reason), `--dry-run` counts and
touches nothing, `--production` is required to reach prod, `--start-offset`
resumes a truncated walk. Because the platform derives `end_call_reason` **on
read**, every historical call the listing still returns is fillable — unlike
`hangup_source`, which is permanently null before 2026-08-12.

### Deliberately not here

- **Transcripts.** Neither file has a transcript column, so nothing is stored
  and nothing is backfilled. The `session.completed` payload carries one and
  this service still discards it; storing them is a separate decision with a
  storage cost, not a prerequisite for these files.
- **Tool executions.** No such field exists in this service or the one before
  it, and the platform's own tool logs sit behind an admin route on a different
  backend. Blank in every row of the reference file too.
- **`Visitor ID`.** No such concept here. Present and empty, never invented.

## Voice tiers and per-minute rates

The platform sells its voices in **tiers** — named quality bands with a
per-minute rate. YE resells them at prices YE sets, and the tier an account
holds also decides **which voices its agents may use**.

**Minutes are now billed, in increments.** The dialer calls
`resolveTierPricing` through `src/lib/dialerPricing.ts`, which chooses *which*
tier applies and never restates the precedence chain. `/billing/plan` reports
`metered: true` and the increment each tier is billed in — see [Billing
increments](#billing-increments).

```
Tier         id, slug (unique), name, status (ACTIVE | REMOVED),
             defaultPriceCreditsPerMin BigInt?, billingIncrementSecs Int?,
             isDefault, lastSyncedAt
AccountTier  id, accountId, tierId, priceCreditsPerMin BigInt?,
             billingIncrementSecs Int?, createdAt
             unique(accountId, tierId)
```

**Sync owns catalogue facts; staff own pricing and assignment** — the same
invariant the agent and DID mirrors hold. Upstream sends exactly two facts per
tier, a slug and a label, and neither a price nor a status: what a tier costs
an YE customer is YE's to decide, and so is retiring one. So the upsert in
`src/services/tierSync.ts` writes `name`, `status` and `lastSyncedAt` and
nothing else. A refresh that reset `defaultPriceCreditsPerMin` or `isDefault`
would re-rate every account holding that tier, silently, from a button whose
label says "Sync".

A tier the platform stops listing is marked `REMOVED`, **never deleted** — its
price, every account's override, and the referent of any later ledger row all
hang off the row. It keeps its assignments; what it loses is the ability to be
assigned to anybody new, and its voices stop being offered. A tier that
reappears is restored to `ACTIVE` with the price it had.

**An empty listing marks nothing removed** and reports `truncated: true`. The
catalogue has two or three rows, so there is no coverage ratio to lean on the
way the agent sync does — the only signal is whether anything was read at all.
An outage believed would retire every tier and empty the voice picker across
the product.

### Exactly one default tier, enforced by the database

`Tier.isDefault` marks the tier an account with **no assignment at all** is
treated as holding. "Exactly one" is a **partial unique index** written by hand
in the migration, because Prisma's schema language cannot express the
predicate:

```sql
CREATE UNIQUE INDEX "Tier_isDefault_key" ON "Tier" ("isDefault") WHERE "isDefault";
```

Postgres leaves every `false` row outside the index, so any number of tiers may
be non-default and at most one may be default. Moving the default is one
transaction — clear, then set — and two concurrent moves cannot both land.

**Zero defaults is a legal state**, and the one a fresh install is in. It fails
closed: an account with no assignment then holds no tier and is offered no
tiered voice. The alternative — treating "the first tier" as the default when
none is marked — prices somebody's calls off an arbitrary row.

### Resolution, in one place

`src/lib/tierPricing.ts` and nowhere else. Three copies of a precedence rule
eventually say three different things, and here the disagreement is a customer
charged a rate they never agreed to.

```
resolveTierPricing(accountId, tierId) → { rateCreditsPerMin, incrementSecs }

  rate       → AccountTier.priceCreditsPerMin      (this account's own price)
             → Tier.defaultPriceCreditsPerMin      (the list price)
             → throw TierRateUnavailableError

  increment  → AccountTier.billingIncrementSecs    (this account's own pulse)
             → Tier.billingIncrementSecs           (the tier's default)
             → 1                                   (per second)
```

**One query, one walk, both values.** A call priced at the account's rate and
the tier's increment is priced on a plan the customer never agreed to, so the
two are never resolved separately. `resolveCallRate` in `dialerPricing.ts`
chooses *which* tier and passes the pair straight through.

**The two ends differ because the two absences differ.** Refusing an
unresolvable **rate** is a real outcome, not a defensive branch: a freshly
synced tier is unpriced, and unpriced is not free. It throws rather than
returning null, because a nullable bigint is the kind of value that gets
`?? 0n`'d in a hurry. An unresolvable **increment** does not exist — the chain
bottoms out at one second, which is not a guess but the arithmetic this service
billed with before increments existed.

`??` rather than `||` at every link, so a deliberate `0n` is not stepped over
onto the list price — zero is a price somebody set — and a deliberate `1`, an
account put back on per-second billing while its tier pulses, is not read as an
absence. Neither line may become `|| 1`.

`tiersForAccount` answers entitlement: the account's **ACTIVE** assignments, or
the default tier when it has **no assignments at all**. Having a retired
assignment is still having an assignment, so an account whose only tier was
retired gets nothing rather than falling through to the default — falling
through would grant a plan nobody sold them. `assignedTiers` is the display
counterpart: everything held, retired tiers included, default never
substituted.

Rates are display-credit decimal strings on the wire and BigInt in the
database, through `src/lib/credits.ts`. A per-minute rate is the value most
likely to be a small fraction, which is exactly why it never becomes a float.

### Entitlement reaches the product

`GET /api/workspaces/:id/voices` filters the catalogue against the **workspace
owner's** tiers — not the caller's. Credits belong to the Account and so does
the plan; an ADMIN who is not the owner would otherwise be offered voices out
of their own tiers. The balance card and the rent dialog resolve the owner for
the same reason.

- **A voice with no readable `tier` is offered to everybody.** It sits outside
  the tier system, and hiding it would take voices away from a product that has
  been offering them.
- **A tier slug the local mirror does not know is not entitlement.** The
  comparison is against the account's assigned slugs, which come from the
  mirror, so an unsynced band is withheld.
- **One upstream call, filtered here.** `?tier=` exists upstream and the
  adapter accepts it, but using it would mean one request per held tier against
  a partner rate limit every workspace shares, to assemble a list one
  unfiltered request already contains. The parameter stays as the seam for the
  day a catalogue is too large to filter in this process.

Each row carries `tier` and `tier_name`. A slug the mirror lacks emits
`tier_name: null` rather than the raw slug — `va-1-pro` is an internal key, and
printing it as a product name is how internal vocabulary escapes onto a
customer's screen.

### Routes

| Route | Role | Notes |
|-------|:----:|-------|
| `POST /api/admin/tiers/sync` | staff | Registered before `/tiers/:tierId`. |
| `GET /api/admin/tiers` | staff | Catalogue with list price, `is_default`, `account_count`. |
| `PATCH /api/admin/tiers/default` | staff | `{ tierId }`. Registered before `/tiers/:tierId`. |
| `PATCH /api/admin/tiers/:tierId` | staff | `{ defaultPriceCreditsPerMin?, billingIncrementSecs? }`; an omitted key leaves that column alone, `{}` is a 400. |
| `GET /api/admin/accounts/:id/tiers` | staff | Assignments with both prices and the resolved rate, plus `default_tier`. |
| `PUT /api/admin/accounts/:id/tiers` | staff | `{ tiers: [{ tierId, priceCreditsPerMin?, billingIncrementSecs? }] }` — full replace. |
| `GET /api/workspaces/:id/billing/plan` | ADMIN | The owner's tiers and the rate each resolves to. |

**The staff price edit reaches existing accounts**, unlike the DID catalog
price, which never touches a live rental. The difference is that a rental
captured a price agreed at a moment in time, while a tier rate is a standing
rate on a running service. An account that must not move is given its own
`priceCreditsPerMin`.

**An unpriced or retired tier cannot become the default** (409
`TIER_NOT_PRICEABLE`). The default prices everybody who was never priced
explicitly; leaving it unpriced makes the fallback unreachable for exactly the
population it exists for. A deliberate `0` passes.

**`PUT` is a full replace, and validates everything before writing anything.** A
body naming one good tier and one unknown one leaves the account exactly as it
was — a half-applied plan is a plan nobody chose. A duplicate `tierId` is a 400
rather than last-one-wins, because the two rows carry different prices. A
retired tier is 409 `TIER_NOT_ASSIGNABLE`. `tiers: []` clears every assignment
and is legal; an **omitted** `tiers` is a 400, so a malformed body cannot
silently unprice an account. Rows are upserted rather than deleted and
recreated, so a resubmitted assignment keeps its `createdAt` — when an account
was put on a tier is a fact, and saving a form without changing that row must
not rewrite it.

**The customer surface says nothing a customer should not learn.**
`/billing/plan` emits a slug, a name, a status and one rate. No field
distinguishes a per-account price from the list price — it is simply their
rate, and a "custom" badge invites the question of what everybody else pays.
Nothing marks a tier as the platform default either. An unpriceable tier emits
`null`, never `"0"`. `metered` is now **true**: minutes are billed, and the
qualifier that used to say otherwise would be a false statement about a
customer's own bill. `billing_increment_secs` rides beside each rate and is
**never null** — a rate per minute without one does not describe the bill, and
per-second billing is the increment of one rather than the absence of one, so
the dashboard has one sentence to write rather than a sentence and a gap. It
carries no mark saying whether the increment came from an override, the same
rule the rate holds.

## Outbound dialing

The module that makes a `RUNNING` campaign actually dial. It is the **first
component here that spends real money and rings real phones**, and the first
that writes to the voice platform's telephony surface at all — everything else
in this service is a read, or a write against agents and their pooled
resources. That is why the safety model comes before the architecture.

### Four independent controls

Each is sufficient on its own to stop every call. They are not layers around
one decision; they are four different questions with four different owners.

| Control | Owner | Default |
|---|---|---|
| `DIALER_ENABLED` | the operator | **false** |
| `DIALER_TEST_ALLOWLIST` | the operator | empty (= no restriction) |
| `Campaign.concurrencyLimit` | the customer | 2 |
| `Account.concurrencyLimit` | YE staff | `DIALER_DEFAULT_ACCOUNT_CONCURRENCY` (2) |

**`DIALER_ENABLED=false` makes the module inert.** No sweep is started,
`start`/`resume` answer **409 `DIALER_DISABLED`**, and the webhook receiver
still verifies but correlates nothing. The refusal at `start` is deliberate:
letting a campaign go RUNNING while nothing dials would make the campaigns page
assert something false about the customer's own data.

**The allowlist is how a first live test is bounded.** A contact whose
canonical number is not on it is skipped, counted and logged — never claimed,
and never marked `EXCLUDED`, because that is a customer's irreversible edit to
their own list and a test switch must not leave permanent marks. Entries are
canonicalized **at boot**: an entry that failed to parse at match time would
equal no contact's number, which looks exactly like the allowlist working right
up to the moment somebody trusts it.

**No test places a call.** Every test mocks `src/adapter/vocobase.js`, and
`test/renewal-sweep-startup.test.ts` asserts that `createApp()` starts no timer
and that `app.ts` reaches neither sweep. `test/setup.ts` sets `DIALER_ENABLED`
to `true` so the suite exercises the real paths against a mocked client; that
line is safe only because of the mocking rule, and is the one line that would
turn a test run into a phone bill if the rule ever lapsed.

### The upstream contract

Three new calls, two of them writes:

```
POST /calls/start            place a call         (write)
POST /voicelink/call-ready   make a DID callable  (write, idempotent)
GET  /calls/concurrency      the account-wide pool
GET  /calls/{id}             reconcile a stale attempt (existing `getCall`)
```

**`unwrap` no longer collapses 403 and 429.** The dialer is the first caller
that must act differently on each: a **429** is the shared partner account at
its call ceiling — very often another integrator's traffic — and a **403** is
YE short with its supplier. Both are transient and account-wide; an outage is
neither. Collapsed into one 502, the sweep could not tell "slow down" from
"we are out of credit" from "the platform is down", and all three took the same
branch. Neither message repeats upstream's wording or says why: a customer is
entitled to learn about neither cause, the same rule that keeps `credits_used`
and the carrier's name off the calls surface.

**Pre-call variables come from one of two projections, and the campaign
decides which.** A campaign carrying a `variableMap` is projected through the
map alone — `{ csvColumn: agentVariable }` resolved against `Contact.metadata`,
with a mapped column the contact has no value for sending an **empty string**
rather than being omitted: the operator mapped it, so the prompt names it, and a
variable the prompt names but the payload omits is an upstream error. A campaign
with `variableMap = null` keeps the legacy projection, where the agent's own
declared `variables` are an allow-list over the contact's metadata and `name`,
and a missing value is omitted. The map **replaces** the declared list rather
than joining it: the two answer different questions, and running both would put
one column on the wire twice, once under the name the operator renamed away
from. A map that is set but empty sends no variables — an operator who cleared
every row asked for none. `Contact.name` never participates in the mapped path;
the importer stores every mapped column in metadata precisely so the resolution
has one place to look.

`client_reference_id` is **absent from the documented request body** of
`/calls/start`, though the webhooks pages describe it and the platform
implements it. So nothing depends on it: correlation keys on the `call_id` and
`session_id` recorded from the 201, with the reference id only as a fallback,
and the idempotent-replay property is a bonus rather than a guarantee.

### `CallAttempt`

```
CallAttempt  id, campaignId?, campaignContactId?, workspaceId, accountId,
             attemptNo, fromNumber?, upstreamCallId?, upstreamSessionId?,
             status (QUEUED|RINGING|IN_PROGRESS|COMPLETED|FAILED|ABANDONED),
             disposition?, upstreamStatus?, answeredBy?, hangupCause?,
             hangupSource?, endCallReason?,
             startedAt, answeredAt?, endedAt?, resolvedAt?, durationSecs?,
             billedSecs?, tierId?, tierSlug?, rateCreditsPerMin?,
             billingIncrementSecs?, costCredits?,
             chargedAt?, shortfall, launchError?, extraction Json?,
             errorCode?, errorMessage?
             unique(campaignContactId, attemptNo)
WebhookEvent id, eventKey (unique), event, receivedAt
```

One row per dial, not per contact: a campaign's history is what was actually
tried rather than the last thing that happened. The row is written **pre-dial**,
inside the claim transaction, so `unique(campaignContactId, attemptNo)` is the
mutual-exclusion token — two dispatchers computing the same `MAX + 1` cannot
both place a call, because one of them fails the insert.

**Both campaign pointers are nullable, `ON DELETE SET NULL`.** An attempt row is
also the billing record, so deleting a campaign must not erase the phone bill; a
call still connected when its campaign goes finishes normally, and the late
webhook resolves against the attempt row by the platform's own ids.

`extraction` is what the call's post-call extraction returned — the agent's own
keys and the answers a model wrote for them — bounded on the way in by
`src/lib/extractionCapture.ts` (≤50 keys, ≤2048 serialized chars per value,
visibly truncated rather than dropped). The keys are the customer's and the
values are free text, so unbounded the size of a row here would be upstream's to
decide; a read-time bound would still have stored the blob. **`NULL` and `{}`
are different facts:** null is an extraction that never ran, `{}` is one that
ran and matched none of its keys. Written by whichever path closes the attempt —
both hand the raw envelope to `applyTerminalOutcome` and neither bounds its own,
so a reconciliation cannot leave a different row behind than the webhook it
stands in for. Read by [lead buckets](#lead-buckets) and nothing else.

`errorCode` / `errorMessage` are the platform's own verdict when **it** ended
the attempt rather than the carrier — `error_code` off either webhook, verbatim,
never an enum. Non-null means the number was never tested: the contact went
back on the queue at no cost to its ladder, and `dialBudget` does not count
the row as a dial (it carries a call id, so the three-column never-placed rule
cannot see it; the code is the fourth column). Kept so the journey and the
attempts feed can say why a dial produced nothing.

**Never placed also means `endCallReason = 'SYSTEM_ERROR'` with no human
heard and no `answeredAt`** (since 2026-09-15), in BOTH spellings of the predicate —
`neverPlacedSql` and `NEVER_PLACED` in `src/lib/dialBudget.ts` — because the
settle hands the contact back on that reason exactly as on a code, and a budget
that counted the row would hand a contact back and then refuse its next claim
forever. The three-valued-logic trap: all five callers apply the predicate
under `NOT`, the column is null on every ordinary dial, and a bare
`"endCallReason" = 'SYSTEM_ERROR'` on NULL is NULL, still NULL under `NOT`, and
excluded from a count — so the bare form dropped every ordinary silence from
the budget. Both spellings therefore guard the nullable equality (`COALESCE`
in SQL, `{ not: null }` beside the equality in Prisma, which generates the bare
`=` with no guard of its own), and `test/dial-budget-equivalence.test.ts`
proves the two agree on every row shape. Re-capture the generated SQL whenever
either spelling changes.

`resolvedAt` is when the outcome was applied on our side. Null while in flight —
the only honest way to tell a live dial from a settled one — and the gap from it
to the next attempt's `startedAt` is the cooldown that was actually served.
`fromNumber` is the DID this dial went out on, snapshotted because the rotation
may have changed since.

**`accountId`, `rateCreditsPerMin` and `billingIncrementSecs` are snapshots**,
and that is the point.
The renewal sweep charges `rentedPriceCredits` and never the catalog price,
because reading a live value at charge time re-bills everybody whenever staff
edit one. The same hazard applies here — a call launched under one tier rate
must be charged at that rate even if staff re-price or retire the tier while
the phone is ringing — and billing the owner *at dial time* means an ownership
change mid-call cannot redirect the charge to somebody who never placed it.

`disposition` and `upstreamStatus` are **verbatim free text**. Provider-
controlled and growing; the calls surface already refuses to enum them.

`QUEUED | RINGING | IN_PROGRESS` is the non-terminal set, chosen to match the
platform's own `statuses_counted` on `GET /calls/concurrency`. Two systems
counting "in flight" differently is how a local cap and a remote cap come to
disagree about the same call.

**The correlation key gained a fourth segment.** `client_reference_id` is a
per-account idempotency key upstream, so `ezo:<campaignId>:<contactId>` would
make every retry replay the first attempt's call — three attempts, one ring,
nothing in any log saying so. The dialer stamps
`ezo:<campaignId>:<contactId>:<attemptId>`; `parseCorrelationId` accepts three
or four segments, so calls placed before attempts existed still resolve.

**`WebhookEvent` has no retention policy**, exactly as `Notification` has none.
Both grow without bound; the `receivedAt` index is there for whoever writes one.

### Concurrency is a third resold resource

YE buys a pool of simultaneous calls and sells slices of it — structurally
what this repo already does with DIDs and tiers, so it follows the tier shape.
`src/lib/concurrency.ts` owns the rule and nothing else may restate it:

```
resolveAccountConcurrency(account)
  → Account.concurrencyLimit                (what staff sold this account)
  → DIALER_DEFAULT_ACCOUNT_CONCURRENCY      (the platform default)
```

**`??`, never `||`.** Zero is a limit somebody set — *this account may not
dial* — and absence is not a limit at all. `||` is falsy on `0` and would step
over a deliberate stop onto the default, silently returning an account to
service after staff had halted it. `tierPricing.ts` documents the identical
trap for a `0n` price; it is worse here because a wrong price is discovered on
an invoice and this one is discovered by a phone ringing. Null never means
unlimited.

Four caps, narrowest wins:

```
slots = min(campaign.concurrencyLimit − campaignInFlight,
            accountLimit              − accountInFlight,
            platformRemaining,
            DIALER_MAX_CALLS_PER_SWEEP)
```

That total is then **split between the lanes** by `computeLaneBudgets` when the
campaign reserves slots for retries — see [Lanes](#lanes). The reservation is a
partition of this number, never an addition to it.

**In-flight is counted, never stored.** A column decremented on completion
eventually misses one — a crash between webhook and update, a retried delivery,
a reaped attempt — and a campaign whose counter is one too high is pinned below
its cap permanently with nothing to show for it: it simply stops dialing and
looks idle, with no repair path short of somebody recomputing by hand. A
`COUNT(*)` over `@@index([campaignId, status])` reads a handful of rows and
cannot drift.

**Overallocation is permitted and displayed, never refused.** Allotting 150
lines out of a pool of 100 is legitimate — not every account dials at once —
and refusing would make a staff write depend on a live upstream read. The
console states the overcommit, the way the billing projection states a
shortfall rather than blocking a rental. A pool that cannot be read is reported
as `null`, never `0`, which would read as "the platform has no capacity". **The
customer never sees the pool**: publishing YE's supply publishes YE's margin.

### The sweep

`src/services/dialer.ts`, modelled on `didRenewal.ts`: started from `worker.ts`
and **never** from `createApp()`, re-entrancy guarded, `unref`'d, bounded, and
logging its result rather than discarding it.

One pass: read the shared pool once; walk RUNNING campaigns **least recently
dialed first** (without an ordering, one busy campaign holds every line its
account was allotted and a campaign started an hour later never dials); for
each, re-resolve the agent and DID, evaluate the window, check the balance,
compute slots, claim and launch; then reap stale attempts and complete
campaigns that have nothing left.

**A failed pool read launches nothing.** A skipped pass self-heals in a minute
and costs nobody anything; guessing at a shared account's headroom does not.
`remaining: null` means uncapped and must stay null — a `?? 0` would stop an
unlimited platform placing a single call, which looks exactly like a dialer
that is switched off.

Every question `start` asked is asked again on every pass, because staff
unassign an agent and release a DID through UPDATEs no foreign key can see.

**What pauses a campaign, and what does not:**

| Situation | Result | Scope |
|---|---|---|
| agent unassigned or retired | PAUSED | `ALL_MEMBERS` |
| DID released or missing | PAUSED | `ALL_MEMBERS` |
| dialing window **incomplete** | PAUSED | `ALL_MEMBERS` |
| balance below the float | **CREDIT_EXHAUSTED** | `ADMINS_ONLY` |
| calling unpriced for the account | PAUSED | `ADMINS_ONLY` |
| dialing window **closed** | skipped, still RUNNING | — |
| **403 on a dial** — the platform refused the account | PAUSED, **pass halts** | `ADMINS_ONLY` |
| **402 on a dial** — the supplier's own wallet is empty, returned by `/calls/start` before any call exists | PAUSED, **pass halts** | `ADMINS_ONLY` |
| **404 on a dial** — the agent is gone upstream | PAUSED, this campaign only | `ALL_MEMBERS` |
| **the platform's own carrier account is dry** — `TELEPHONY_CREDIT_EXHAUSTED`, **or a supplier 402 in `error_message`** | PAUSED, this campaign, on the first sight | `ADMINS_ONLY` |
| pool unreadable / 429 | pass halts, nothing paused | — |

The `ADMINS_ONLY` rows are the ones whose *reason* is billing or access, and
credits and the plan are ADMIN-only everywhere else in this service. The
balance row lands in its own status rather than PAUSED, because the operator
did not stop this campaign — the balance did, and `resume` has to know to
re-run the estimate before letting it dial again.

**The supplier's wallet arrives at LAUNCH, not at settle — and that is the door
that was open.** In production the 402 is returned by `/calls/start` itself:
VoiceLink refuses `add_lead`, the platform passes that back, and the dial never
gets a call id and never reaches the settle path at all. The adapter collapsed
it into the generic `UPSTREAM_ERROR`, `rollbackLaunch` read that as transient,
and each contact was handed back with one cooldown — correctly, as far as the
ladder goes: **no retry was spent and no lead was lost** — while both campaigns
stayed RUNNING and re-claimed the same contacts every cooldown, 3,803 refusals
over thirty hours with nothing on any screen saying why. The adapter now
surfaces a 402 as `UPSTREAM_PAYMENT_REQUIRED`, and the launch path pauses and
halts on it through the same writer and notifier the settle path uses, so the
campaign page says one sentence whichever door the fact came through.

**The settle path recognises it from the MESSAGE as well as the code**, for the
day it does arrive on a finished call. On 2026-09-07 the
provider refused every dial with
`VoiceLink add_lead error (402): {"message":"Insufficient wallet balance…"}`
and the platform surfaced that as `error_message` with **`error_code: null`** —
2,593 attempts across 1,407 contacts, not one carrying a code. Keyed on the code
alone, none of it read as a platform fault: each refusal settled as an ordinary
`failed`, spent a retry for a number that was never dialled, and both campaigns
went on dialing into a dead wallet for a day and a half.

`exhaustsPlatformCredit` therefore takes the message too, matched **narrowly** —
the provider's `402` or its wording, both of which mean "no money" and neither
of which a carrier failure produces. A match pauses a customer's campaign, so a
`401` from the same endpoint deliberately does not fire. Free text is a poor
contract and this is not the preferred fix: the right one is upstream sending
the code, which `docs/2026-09-08-vocobase-hangup-source-voicelink.md` asks for,
and the code branch stays first so this becomes dead weight the day it lands.

**The platform-credit row is PAUSED, deliberately not `CREDIT_EXHAUSTED`.**
That status means the YE customer's own balance stopped the campaign: its
page tells them to top up and `resume` re-runs the balance estimate. Neither is
true here — a different party is out of credit and the customer can do nothing
but wait for YE — so overloading the status would send them to the billing
page to fix somebody else's account. What tells the two apart is the
notification type, `campaign.paused_platform_credit_exhausted`, which follows
`campaign.paused_upstream_refusal` (the launch-time pause for the same supplier
saying no). No threshold and no auto-resume: the condition is account-wide and
never clears on its own. The contact whose call reported it goes back whole —
see the `error_code` rule under [Resolving a contact](#resolving-a-contact).

**The two dial-time refusals pause as well as halt**, which is a change: a 403
used to halt the pass and leave every campaign RUNNING, so a minute later the
sweep re-hit the identical wall with nobody told, forever. A rate limit still
pauses nothing — that one really is somebody else's traffic and clears itself.
The 403 halts the pass *and* pauses the campaign that met it; the 404 pauses
that campaign alone and lets the rest of the platform keep dialing, because a
missing agent is one workspace's misconfiguration rather than an account-wide
wall.

### A campaign that placed nothing says why

None of the rows above covers the commonest silence: a campaign that is
perfectly configured, is not paused, and simply has no slots. `totalSlots`
comes out at zero, the pass returns, and until `reportBlocked`
(`src/services/dialer.ts`) existed it said nothing — so **a campaign waiting on
one stuck attempt and a campaign nobody had started produced identical logs**,
namely none. The only symptom either produced was an operator saying a running
campaign looked idle, with no line anywhere to confirm or deny it.

`bindingCap` (`src/lib/blockedReason.ts`) names which cap is holding it. Pure
arithmetic with no database and no clock, for the reason `laneBudgets.ts`
gives: a line that names the wrong cap is worse than no line, because it sends
somebody to raise a limit that was never the one holding the campaign.

**Three caps, not the four `sweepCampaign` weighs.** The per-sweep budget can
never be the answer — the pass loop breaks on `budget <= 0` before a campaign is
swept, so any campaign reaching this branch was swept with budget left, and a
positive budget cannot be what drove `totalSlots` to zero.

**The outermost cap that is exhausted, not the smallest.** Negative remaining is
a supported state — `laneBudgets.ts` calls lowering `concurrencyLimit` below the
live count "a legitimate operator action", and staff may do the same to an
allotment — so a numeric minimum would name whichever cap was *most* negative,
hiding an account-wide fact behind one campaign's over-subscription. Resolution
is outward (pool → account → campaign), the order in which relief actually
unblocks anything. When nothing is exhausted it returns `null` and the pass says
nothing, rather than naming a cap that is holding nothing.

**The question is never "which cap", it is "is anything turning over".** A
campaign pinned at a cap with calls completing and being replaced is working
exactly as configured; one pinned at the same cap with its oldest call
unresolved for forty minutes is wedged. So the wedged-age gate applies to the
campaign arm **and** the account arm:

| Binding cap | Reported |
|---|---|
| the shared platform pool | on sight, **once per pass** |
| the account's allotment | once per account per pass, once its own oldest live attempt has been unresolved for **half** `DIALER_ATTEMPT_TIMEOUT_MINS` |
| the campaign's own ceiling | once its oldest live attempt passes the same threshold |
| an allotment of **zero** | on sight — staff stopped the account, so there is no call to be old |

Gating only the campaign arm was wrong, and the shipped defaults are why:
`Campaign.concurrencyLimit` defaults to 2 and
`DIALER_DEFAULT_ACCOUNT_CONCURRENCY` to 2, so an ordinary busy campaign sits at
**both** caps at once and the ungated account arm spoke for it every minute
forever — the exact noise the campaign gate exists to prevent. The campaign
ceiling may also be raised to 10 while the account default stays 2, which makes
the account the binding cap in the *ordinary* case rather than the exceptional
one. The gate has to be on the symptom, not on which number is smaller.

The shared pool is the one cap reported on sight, because its occupants are
other integrators' calls whose age this service cannot see. It is deduplicated
per pass: the blocked branch runs once per campaign, so one full pool would
otherwise speak once for every RUNNING campaign, up to `CAMPAIGN_BATCH` lines a
minute for a single condition.

Half the reaper's timeout, so the warning lands before `closeStaleAttempts`
gives up on the same attempt and the log names the row while it is still the
live explanation. (At the floor of `DIALER_ATTEMPT_TIMEOUT_MINS=1` the two
coincide at a minute and the reaper wins — a degenerate setting nobody runs.)
Derived rather than configured, so shortening the reaper's patience shortens
this too — **no new environment variable**.

**The age is a predicate, not a post-filter.** `(campaignId, startedAt)` cannot
satisfy the status test, so `ORDER BY startedAt LIMIT 1` over it walks a
campaign's whole attempt history — oldest first, every row terminal — before
reaching the in-flight rows, which are always the newest. The threshold sits in
the `where` and the read goes through `(campaignId, status)` / `(accountId,
status)`, which bound the match set by the concurrency cap. The healthy case,
which is almost every case, is an empty index probe rather than a row fetch.

Two silences are kept. A campaign that **completed** on the very pass that found
it full is a completion, not a campaign held by a cap. And a ceiling held
entirely by claims whose placement jobs have not run yet is a queue draining,
bounded by the claim lease, which `releaseStaleClaims` already reports when it
does not.

**One silence is still open, deliberately.** This covers only `totalSlots <= 0`.
A campaign with slots available but nothing *claimable* — every contact cooling
down, or filtered out by `DIALER_TEST_ALLOWLIST` — returns zero from
`claimLanes` and still logs nothing, which is the same operator-facing symptom.
Closing that means reporting on an empty claim, which is a different question
from reporting on an exhausted cap.

### The dialing window

The campaigns slice validated `fromTime`, `toTime` and `timezone` in isolation
and deliberately asserted no cross-field rule, saying the dispatcher would
decide what a window *means*. `src/lib/dialingWindow.ts` is that decision, and
it returns **three** states because there are three situations:

- **Neither end set** → dials at any hour. A timezone alone restricts nothing.
- **Both ends and a zone** → evaluated in that zone via `Intl` (no new
  dependency). Start inclusive, end exclusive. `from > to` **wraps midnight**,
  or an evening window is the empty set and a campaign configured for one never
  dials while looking perfectly configured.
- **Days restricted** → the day is the campaign-local calendar day of *this
  instant*, which is the only rule that stays simple across a window wrapping
  midnight: a 22:00–02:00 window with Monday allowed dials Monday evening, and
  its small hours only if Tuesday is allowed too.
- **Partial** — one end without the other, hours with no zone, **days with no
  zone**, a day list that restricts to no readable day (`[7]`), **a start time
  equal to its end time** (start is inclusive and end exclusive, so that window
  is the empty set and the campaign would quietly call nobody), an unknown
  zone, a malformed time → **incomplete**, and the campaign is paused.

`evaluateWindow` and `rollIntoDialWindow` share one `nextOpening` walk rather
than each growing its own. They have always had to agree about what the next
opening is, and with days that is a bounded day walk instead of a
today/tomorrow ternary — two copies would eventually book a promise for a
Saturday the dispatcher then refuses to dial, leaving `callbackAt` asserting a
promise that was not kept. `nextOpening` takes the **window and the instant**,
not a start time: a walk told only `fromTime` cannot know the window wraps, and
that is exactly the walk that used to overshoot — 22:00–02:00 on weekdays,
asked on a Sunday afternoon, answered "Monday 22:00" when the campaign starts
dialing again at Monday 00:00. Each allowed day now offers **every** moment the
window can begin on it (midnight as well as `fromTime`, for a wrapping window),
and each candidate is checked against `isOpenAt` — the one predicate the gate
itself uses — before it is returned. One rule, asked twice, so "open" and "when
does it open" cannot drift apart. It returns **`null`** when no candidate
passes that check rather than a best guess: an unverified opening is an instant
the dispatcher then refuses to dial at and a promise the callback engine never
keeps, both silently. The gate turns `null` into `incomplete`; the roll leaves
the promise where it was.

**The hour a spring-forward skips** is why the check is not a formality.
`instantOf` resolves a wall-clock time by guess-and-correct, and a reading
inside the gap — there is no 02:00 in New York on the morning the clocks go
forward — makes that oscillate: one pass lands after the gap, the next steps
back an hour and lands *before* it. The second is the dangerous direction, and
a correction is now refused when it would move back across an instant that
already read at or after what was asked for. Without it, a window opening at
02:00 resolved to 01:00, read as closed, and the campaign skipped the entire
day — once a year, in every zone that changes its clocks. `DialingWindow.dialDays` is **required**, not
optional: absent would read as "no restriction", which fails OPEN where every
other absence in that module fails closed, so a Prisma `select` that forgets
the column is a compile error rather than a gate that silently stops gating.

The third fails closed on purpose. An operator who set `fromTime` and nothing
else was expressing a restriction; reading it as "any hour" is how a campaign
rings somebody at 3am, and reading it as "never" is indistinguishable from a
campaign that has finished.

### Claiming, in one statement

`src/services/dialerClaim.ts`. The rows are selected, locked and flipped
`PENDING → QUEUED` by a **single** `UPDATE … FROM (CTE)`, so no window exists
between reading a contact and claiming it. Split into a read and a write, two
dispatchers — or two overlapping passes of one — see the same PENDING row and
both dial it, and the person on the other end takes two calls from the same
campaign within a second of each other.

`FOR UPDATE OF cc SKIP LOCKED` is the other half: a row another transaction
already holds is passed over rather than waited for, so a second dispatcher
fills its batch from further down the queue. The `LIMIT` is what keeps those row
locks short-lived. None of this is expressible through the query builder —
neither `SKIP LOCKED`, nor select-and-update as one statement, nor an
`ORDER BY` over a boolean expression, which is what the lane priorities are —
so it is raw SQL, deliberately.

Eligibility, every pass:

```sql
cc.status = 'PENDING'
AND (cc."nextEligibleAt" IS NULL OR cc."nextEligibleAt" <= $now)
AND (cc.attempts <= $retryCount OR <armed for callback>)
```

`nextEligibleAt` is a **stored** column rather than `lastAttemptAt + cooldown`
computed at query time, because a promised callback is a specific instant that
no formula over the campaign's settings can reproduce — and because the
invariant needs a column to compare against.

`$retryCount` is **re-read every pass**. Lowering it mid-campaign has to stop a
retry that is already waiting, or the setting is a control that lies. The
callback exemption beside it is not an optimisation: a callback spends no retry,
so without it a lowered budget would silently cancel a call somebody was told to
expect. And only *due* callbacks are claimable — the armed predicate identifies
the state, `nextEligibleAt <= now` gates the time, and a callback booked for
tomorrow is never pulled forward.

The upstream POST is deliberately **outside** the claim transaction: a network
call inside one holds a pooled connection for the length of an upstream timeout.

### Lanes

Per RUNNING campaign per pass, after the gates:

1. **Callbacks first**, ordered `callbackAt ASC`, out of the *same* budget as
   everything else rather than an extra allowance, and ahead of every
   reservation. A callback is the only entry in this queue carrying a time a
   human being was told; everything else is a list position nobody chose. The
   claim is bounded by the campaign's share — `splitPool` in
   `src/lib/laneBudgets.ts` holds `retrySharePercent` of the pass for retries,
   computed over in-flight plus pool so the ratio holds across passes rather
   than rounding away on a small one — and at the default of 0 that bound is
   the whole pass.
2. With `retryConcurrency > 0`: the reservation, shared by **resume** and
   **retry** and divided by the same share (`drainSplit`: the urgent lanes at
   their floor, retries at theirs plus whatever the urgent lanes left, then the
   urgent lanes again for what retries left); the **fresh** lane up to
   `freshBudget`; a **borrow** of whatever is left, under the same split; and
   the remainder back to the fresh list. Every floor is a floor and never a
   cap — whichever side runs dry, the other takes its slots in the same pass.
3. With no reservation: the urgent lanes (`urgent`: callback ahead of resume)
   at their share, then one shared `routine` pass (`FRESH`, `RETRY`,
   `FOLLOW_UP`) settled by age, then the urgent lanes again for what routine
   left. `any` — every arm at once — is claimed by nothing in the dispatcher
   any more; the suite still uses it to reach the predicates that belong to no
   lane.

In-flight is counted **per lane off `CallAttempt.kind`**
(`campaignLaneInFlight`, one `groupBy`), stamped at claim time from the arm
that chose the row. It used to be read off the contact's lifetime counters,
which on a campaign whose fresh list was exhausted made every live call a
"retry", drove the reservation to zero on every pass, and left
`retryConcurrency` a setting that did nothing.

`computeLaneBudgets` (`src/lib/laneBudgets.ts`) is pure and subtracts each
side's in-flight count, so the reservation holds across passes; neither budget
can go negative, and lowering the limit below the live count yields 0 rather
than a hang-up.

Ordering is `callbackAt ASC` in the callback lane, `nextEligibleAt ASC` in the
resume lane, and in the retry lane fewest dials first — `attempts +
followUpCount + callbackCount ASC`, then a goal follow-up ahead of a plain retry,
then `createdAt ASC` — so the same few contacts at the head of an import cannot
take every retry slot pass after pass while the tail sits at one dial. The
routine lane (`retryConcurrency = 0`) still orders follow-up-first then age and
deliberately does not get the dial count yet. Every lane ends in `id ASC` —
`createdAt` defaults to the transaction timestamp, so a bulk import stamps one
identical value across every row and an `ORDER BY createdAt` over an imported
list is a single tie group. The order is written twice, once in
the CTE and once on the way out, because `UPDATE … RETURNING` has no defined row
order and the launcher pairs the *i*-th claimed contact with the *i*-th number
in the rotation.

That pairing is the rotation: `UPDATE "Campaign" SET "rrCursor" = "rrCursor" +
$count … RETURNING "rrCursor"` once per claimed batch, and contact *i* dials
from `numbers[(base + i) % numbers.length]`, stamped onto the attempt's
`fromNumber`. Only the cursor's modulo matters, so it is never reset.

### The five ways a launch fails

| Upstream result | Contact | Attempt | Campaign | Pass |
|---|---|---|---|---|
| 400 — this number will never work | `FAILED`, retry **kept** | `FAILED` + `launchError` | — | continues |
| 502 / timeout — transient | `PENDING`, **given back** | `FAILED` + `launchError` | — | continues |
| 429 `LIMIT_REACHED` | `PENDING`, given back | `FAILED` | — | **halts** |
| 403 — the account was refused | `PENDING`, given back | `FAILED` | **PAUSED** + notify | **halts**, loud |
| 404 — the agent is gone upstream | `PENDING`, given back | `FAILED` | **PAUSED** + notify | continues |
| `UPSTREAM_WRITE_UNCONFIRMED` | stays `QUEUED` | stays `QUEUED` | — | continues |

Leaving an unconfirmed write in flight is what stops a double-dial: the response
was lost, the call may be ringing, and only the platform knows.

**400 is the only per-contact refusal left.** A 404 used to sit beside it, and
mid-campaign a 404 is almost never the number — that was canonicalized here,
and the campaign's ids were re-resolved on this very pass. It is the *agent*,
which staff can unassign upstream through an UPDATE no foreign key can see. So
filing it against the contact settled one row per pass and burned the whole
list, one person per minute, while the campaign looked healthy. Both dial-time
refusals now give the contact back through the same three-branch give-back
below, pause the campaign with a conditional `updateMany` on RUNNING — so two
racing runners produce one pause and one notification — and stop this
campaign's launches for the pass. The reaper
settles it.

**A give-back never increments `attempts`** — that counts retries consumed, and
a call that never left consumed nothing — and it has three branches, because the
invariant has to survive a backoff:

1. **An armed promise the backoff would overrun** (`armKind = CALLBACK` and
   `callbackAt <= backoffAt`) — both columns move to the backoff, together.
2. **An armed promise still ahead of it** — neither column moves. Pushing
   `nextEligibleAt` alone would break the pair and silently downgrade a promise
   to a plain retry.
3. **Everything else** — `nextEligibleAt` alone. Stamping `callbackAt` as well
   would manufacture a promise nobody made, and a `RESUME` row is in this
   branch: a transient launch failure may move when it is due, never why.

None of the three touches `armKind`. A give-back is a dial that did not leave,
so what the row is waiting for has not changed.

### Campaign start now reaches the platform

`start` and `resume` share one flag rather than two lists, so the two
transitions into RUNNING cannot drift apart in what they check.

| Gate | Failure |
|---|---|
| `DIALER_ENABLED` | 409 `DIALER_DISABLED` |
| a usable caller DID | 409 `CAMPAIGN_PHONE_NUMBER_REQUIRED` |
| a complete-or-absent window | 409 `CAMPAIGN_WINDOW_INCOMPLETE` |
| a resolvable per-minute rate | 409 `CAMPAIGN_RATE_UNAVAILABLE` |
| balance ≥ the float | 402 `INSUFFICIENT_CREDITS` |
| the DID is call-ready | 409 `CAMPAIGN_DID_NOT_CALL_READY` |

**A caller DID is now required** — the decision the campaigns slice explicitly
deferred here. `from_number` must name a number active on the connection, so a
campaign without one would dial from whatever the connection defaults to: some
other customer's published business number.

**Every local gate runs before the single upstream call**, so a start that is
going to be refused never writes to a partner account every customer shares. A
test asserts that per gate rather than trusting it.

The upstream call is `POST /voicelink/call-ready { did_number, connection_id? }`
— idempotent, and the documented safe path because it preserves existing
inbound routing where the raw routing update replaces the record.

Still done at **start**, and now also at **import**: `syncPurchasedDids`
provisions each row it creates (see [VoiceLink connections](#voicelink-connections)).
The two are not redundant — start is the gate that must hold whatever else
happened, and import is what stops a number reaching the caller-id picker
before it can dial. It does reverse the older reading that "a number nobody
dials from should not have routing built for it": the cost of routing built
early is an unused bot on the partner account, and the cost of routing built
late was a campaign refused with an error about VoiceLink rather than about the
number. `VOICELINK_AUTO_CALL_READY=false` restores the older behaviour.

Still **not** at rent time: renting is a billing event and creates nothing
upstream.

`NO_VOCOBASE_AGENT` is **not blocking**: it governs inbound routing, and
refusing on it would make every campaign unstartable for a reason that does not
apply to outbound. An **unrecognised** readiness state is logged rather than
refused — that vocabulary is the platform's and it grows. Readiness codes are
mapped to our own sentences, because the platform's `action_items` name the
supplier.

**Known gap:** `call-ready` maps an unmapped DID to a client only when handed
an explicit `client_id`, which this backend does not model. A DID that has
never been client-mapped therefore cannot be made callable from this product,
and start refuses it by name. Adding a staff-settable client id would let this
service perform a mapping write on a shared partner account off a typed value,
and mapping is the one step in that workflow that is not idempotent in a
recoverable direction. It stays an operator prerequisite.

### Outcomes

`POST /webhooks/vocobase`, mounted **outside `/api`** and **before**
`express.json()`, carrying its own `express.raw`. A signature covers the exact
bytes received, and a parsed-and-restringified body is a different string — key
order, whitespace and number formatting all move.

HMAC-SHA256 over `` `${timestamp}.${rawBody}` ``, compared timing-safely, with
a 300-second skew window. **The length check before `timingSafeEqual` is not an
optimisation**: that function throws on unequal buffers rather than returning
false, so without it a forged signature of the wrong length is a 500 — and by
the platform's retry policy, five of them. **An unset secret rejects
everything**, the rule `RECORDING_TOKEN_SECRET` and `ADMIN_STAFF_TOKEN` hold.

Two events, two jobs:

- **`call.status.updated`** with a terminal status closes the attempt and frees
  the line, charging nothing. The platform says plainly not to wait for
  `session.completed` to release a dialer slot, and a slot held through
  transcription is one the customer paid for and cannot use.
- **`session.completed`** is the sole charging event. It fires for every
  outcome including calls that were never answered, which arrive with
  `duration_seconds: 0`.

**The contact is resolved by whichever event first carries a classification** —
not merely whichever arrives first. The pacing event fires at the status
transition, and for a *completed* call the platform computes `disposition` and
`answered_by` with post-call processing, after it has gone out: a bare
completed status is "not classified yet", not "a conversation happened", and
resolving from it would settle every voicemail as a success with the ladder
never arming. So an unclassified completion closes the attempt with
**`resolvedAt` left null** — the mark that the resolution still belongs to the
completion event, or to the reaper when that never comes. A terminal status
other than `completed` classifies by itself and resolves immediately, and so
does a non-null `error_code` whatever the status: the platform decided.
`carriesClassification` treats a `SYSTEM_ERROR` `end_call_reason` the same way
— it is the field that actually arrives for "the platform decided" — while any
OTHER reason on the status event is the carrier's snapshot, not a
classification: `COMPLETED` there is an answered call the completion has yet
to describe.

`chargedAt` is what separates the two jobs: only the charging path sets it, and
`applyTerminalOutcome` treats a set value as already settled. Both outcome
transactions take the **campaign row `FOR UPDATE` first**, before touching the
attempt row — the delete route holds the campaign lock while its `SET NULL`
actions update every attempt row of the campaign, and taking the pair in the
opposite order here was a deadlock with the webhook's charge on the killed
side. The `resolvedAt` pin is then re-read *inside* the transaction, behind
that lock: the pre-transaction copy is stale by however long the transaction
waited on the row, which is exactly the window the pin exists to close.

**Exactly-once is a constraint, not a code path.** The `WebhookEvent` marker is
written inside the same transaction as the charge, so a duplicate violates its
unique index and the whole transaction rolls back. Writing it first loses the
charge if the process dies between; writing it afterwards double-charges on the
retry the platform will certainly send. The ledger row also carries
`reference = attempt.id`, so the existing `@@unique([accountId, reference])`
refuses a second charge even if that transaction were bypassed.

**The handler is synchronous, against the platform's own advice.** For most
integrations answering first is right; here the effect is a credit charge, and
a background job that dies takes it with it while a non-2xx brings a delivery
the platform retries four more times over eight hours.

**The endpoint is account-wide on a shared partner account**, so it receives
every other integrator's completions — transcripts included. An event that
correlates to no attempt of ours is answered **200** with its id logged and
nothing else persisted or logged; a test asserts that a stranger's transcript
and their contact's number never reach a log line. Per-agent scoping would
narrow this, but each agent-scoped endpoint carries its own secret, so it means
N encrypted secrets and a registration lifecycle tied to agents that move
between workspaces. The endpoint declares
`events: ["session.completed","call.status.updated"]` upstream, registered and
rotated through [the staff webhook-config surface](#the-webhook-endpoint-this-backend-receives-on).

### Resolving a contact

`src/services/dialerOutcome.ts` owns the whole decision, and both callers — the
webhook and the reaper — re-derive none of it. A call that cost 2.12 credits
when we heard about it promptly cannot cost something else because our endpoint
was down.

Classification reads three independent fields, because the platform reports the
same fact through whichever of them the carrier populated:

| Class | Reads |
|---|---|
| **retryable** — nobody was spoken to | status `no_answer` \| `busy`; disposition `voicemail` \| `user_hangup_no_speech`; answered_by `machine` \| `not_answered`; or any internal `failureReason` |
| **permanent** — never dial again | disposition `blocked`; or a retryable silence whose Q.850 `hangup_cause` names the **number** (1, 3, 22, 28); or, since 2026-09-15, a retryable silence whose `end_call_reason` is `INVALID_NUMBER` or `BLOCKED` — same `retryable` gate, the cause's successor |
| **platform fault** — hand back, spend nothing | a non-null `error_code` or `end_call_reason = SYSTEM_ERROR`, on a call neither answered (`answeredAt`) nor heard (`answered_by: human`) — same handling, same give-back |
| **success** | anything else with no failure reason → `COMPLETED` |

**`error_code` outranks the cause.** The platform's contract is that the two
are exclusive: `hangup_cause` set and `error_code` null means the carrier
decided and the disposition is trusted; `error_code` set and `hangup_cause`
null means the **platform** decided — `PENDING_TIMEOUT` (reaped pre-connect),
`DIAL_TRANSPORT_FAILURE` (never reached the carrier), `ADMIN_DISMISSED` (an
operator closed a stuck session), `TELEPHONY_CREDIT_EXHAUSTED` (their carrier
account is dry) — and the number was never tested. Such an outcome is never
permanent whatever the disposition or cause says, and `resolveContact` hands
the contact back through the same three-branch `giveBackWithBackoff`
(`src/lib/giveBack.ts`) that `rollbackLaunch` uses: `attempts` untouched,
`armKind` untouched, the armed-callback pair moved together or not at all,
`nextEligibleAt` at the campaign's cooldown. An **unrecognised** code is a
platform fault too, never permanent: every code on the list is "not the
number", and a new one is far likelier to be another of those. The Q.850 rule
stays as the fallback beneath it — it is the only protection until the
platform's fields are actually deployed, and it is still right for a genuine
carrier verdict.

**On 2026-09-15 that contract had never fired.** Read from the platform's
`origin/main`: `error_code` is emitted on messaging events only — never on
`session.completed`, `call.status.updated` or `GET /calls` — so on that
evidence none of the four codes above has ever arrived here, and
[`SYSTEM_ERROR`](#end_call_reason) is the fault signal that does. The code
path stays, because the contract may still land and it is harmless when it
does not. The `SYSTEM_ERROR` reading is gated the same way: "nobody heard" is
the detector's verdict `answered_by: human` OR the carrier's `answeredAt`
stamp, never the disposition — a `completed` label with neither is still
handed back (a redial is cheap, a burned lead is not), and a `SYSTEM_ERROR`
on a call that was answered is the conversation it was, whatever the detector
says (see the read rule under [`end_call_reason`](#end_call_reason)). Two
things `SYSTEM_ERROR` cannot do: tell the wallet-dry
case from a restart — `exhaustsPlatformCredit` stays on the `error_message`
regex, and only that pauses a campaign — and retire a number.

**A human on the line beats a never-connected label.** `answered_by: human`
is the platform's answer-detection verdict that a person was reached, which is
evidence of a *connection* rather than a label for the *ending*. A `no_answer`,
`busy` or `failed` label beside it reads as a conversation, and so does an
`error_code` beside it (an operator dismissing a session that hung after the
person had spoken is not a number that was never tested). The platform has said
Q.850 cause 16 — normal clearing, how a real conversation usually ends — will
map to `no_answer`; if that mapping is not gated on connection state, thousands
of answered calls a week arrive as silences, and this is what keeps them off
the ladder. `user_hangup_no_speech` is deliberately outside the rule: it is a
pick-up in which nobody spoke, and it says so itself — and so are `voicemail`
(the detector disagreeing with itself; the disposition is the later verdict)
and `blocked` (a verdict on the number). The override is the **same set
everywhere it is read**: `settledDisposition` writes `completed` onto the
contact at resolve time, so the outcome bar and the contact badge say what the
settle decided; `classifyAttempt` and `REACHED_ATTEMPT` apply it to the
attempt row on read, so the reached count, the analytics buckets and the lead
buckets agree with it. A platform fault records **no goal-record entry** —
the number was never dialled, and an entry would move the last-call line onto
a call nobody had. The reaper's reconcile still cannot see an `error_code`
(`GET /calls/:id` does not carry it, 2026-09-07), but since 2026-09-15 the
detail DOES carry `end_call_reason`, so a `SYSTEM_ERROR` reconciled off it is
handed back the way the webhook path hands it back; what a reconcile still
leaves off the row is the code itself; the sentence is unaffected, because
`attemptReason` reads the reason too.

`permanent` overrides `retryable` at the point of use rather than being folded
into it: they are separate facts, and a `blocked` number that also reports
`answered_by: machine` is both "nobody was spoken to" and "do not call this
again".

The retry branch needs `retryable ∧ ¬permanent ∧ attempts + 1 <= retryCount`,
with the campaign row **re-read live inside the caller's transaction**. That is
the second of the two budget checks — the claim carries the first — and both are
needed: the claim's stops a retry already waiting, this one stops a retry from
ever being armed.

**Delay indexing.** Element *i* of `retryDelaysMinutes` is the wait before retry
*i+1*, so the index is the count of retries **already consumed** — which is
exactly what `attempts` holds *before* this write increments it:
`retryDelaysMinutes[contact.attempts] ?? cooldownMinutes`. A ladder shorter than
the budget is normal.

The re-arm writes `PENDING`, `attempts + 1`, `nextEligibleAt`, the normalised
`disposition`/`answeredBy` and `lastSessionId` — and leaves **`callbackAt`
untouched**, standing as history. Moving it here would either honour a promise
at the cooldown or manufacture one nobody made.

Both writes are guarded on the contact still being claimed **and** on this dial
still being its latest (`no attempt numbered above mine`, which the unique on
`attemptNo` makes exact). A guard miss returns `race_lost` and **no counter
moves**: a campaign whose `failedCount` was incremented by a resolution that
moved nothing reports more settled contacts than it has.

`disposition` and `answeredBy` are stored twice on purpose — verbatim on the
attempt, which is the record of what the platform said about the *call*, and
normalised lowercase on the contact, which is what our own decisions and the
stats page read. The copy is a copy rather than a join because the re-arm that
puts a contact back on the queue frees the attempt it came from.

### The callback engine

A promised callback is the only entry in a campaign's queue carrying a time a
human agreed to, which is why the dispatcher's callback lane runs first and why
this module is careful in ways the rest of the queue is not.

**Where the instant comes from.** The `session.completed` webhook carries the
session's extraction values, and YE owns an extraction key named
**`callback_requested_at`** (type `datetime`). The platform reserves
`callback_at` for itself, rejects a partner definition of it, and injects its
own only on calls its own campaign product originates — which ours are not,
since YE dials plain V2 calls. So we define our own and read the reserved name
as a **fallback only**. Both names are refused to customers by
`src/lib/extractionConfig.ts`, and the refusal says which party reserved which,
because a customer should learn whether the name is the platform's or ours.

When a campaign with `callbackEnabled` starts or resumes,
`src/services/campaignExtraction.ts` idempotently ensures the agent carries the
key: the set `Campaign callbacks` is found by name before it is created (the
sets pool is partner-wide, so there is no id of ours to store), the attach is
idempotent upstream, and `extraction_enabled` is written only when it is off.
The name carries no supplier — an operator reads it in the agent's own
extraction editor — and the branded name it replaces, `EZO campaign callbacks`,
is listed as superseded so the old set is detached once the new one is on. The
same holds for `Campaign call note`, formerly `EZO campaign call note`. There is
no rename endpoint upstream, so a rename is always a new set plus a detach, and
a superseded name is only ever ADDED to those lists: dropping one strands its
set on every agent that carries it.
**Every failure is caught, logged and notified, never raised** — a campaign that
cannot book callbacks is a campaign that still dials, and refusing to start it
over this would be the worse outcome.

**Parsing** (`src/lib/callbackTime.ts`), with a named reason for every refusal —
`absent | not_a_string | unparseable | too_soon | too_far_ahead`:

- Explicit-offset strings parse directly. The offset regex requires a `T` before
  it, or a bare date's day digits read as an offset.
- Naive datetimes are interpreted in the **campaign's timezone** — we have no
  per-agent timezone, and the window's zone is both the best proxy for the
  conversation's clock and the roll target.
- **Date-only strings are rejected.** A bare date means "some day, no time
  agreed", and "some day" must never place a call. There is deliberately no noon
  default.
- `<= now + 60s` is `too_soon`: extraction runs seconds after hang-up, and a
  lead must not be redialled mid-goodbye. `> now + 90 days` is `too_far_ahead`,
  because models fabricate years.

**Rolling** into the campaign's own window: before it opens → the same local day
at open; after it closes → the next local day at open; inside → untouched. It
**only ever moves forward**, the arithmetic is done on the local date with the
offset computed at the *target* instant so DST is right, and a roll that fails
returns the instant unrolled — the claim gate still refuses it, so the worst
case is a callback that waits rather than one that rings at 3 AM.

**Booking** (`scheduleCampaignCallback`) runs after the terminal outcome has
been applied, in its own try/catch — a callback failure must never take a charge
or a 200 with it — and in one transaction that locks the campaign row first:

| Outcome | When |
|---|---|
| `CAMPAIGN_CANCELLED` | `stoppedAt IS NOT NULL` or status STOPPED |
| `NOT_RESOLVED` | the contact is not COMPLETED/FAILED, or the guarded write lost its race |
| `LIMIT_REACHED` | `callbackCount >= 3` — a chain of "call me back tomorrow" has no natural end, and each link is a real call somebody is billed for |
| `SUPERSEDED` | an attempt numbered above the one this promise came from exists — the outcome path deliberately lets a late delivery through to the *charge* while refusing its queue move, and a booking is a queue move: without this, a delayed completion for a dial the reaper abandoned and the dispatcher re-dialled would re-arm a promise from a superseded call and re-open a finished campaign |
| `SCHEDULED` | the re-arm landed |

Both callers hand the booking the `attemptNo` of the dial the extraction came
from; `'applied'` from the outcome path is not proof the dial is current, since
it also covers the normal case where the pacing event resolved the contact
first and the completion still has to book.

The re-arm writes the one instant to **both** columns — that pair is the
invariant — increments `callbackCount`, keeps `lastSessionId`, and leaves
`attempts` alone. Then it gives the terminal counter back (the contact is no
longer settled) and re-opens a COMPLETED campaign to **RUNNING**, because a
scheduled callback *is* pending work and there is nobody to press Resume at 3pm
tomorrow. That is deliberately asymmetric with a top-up, which re-opens to
PAUSED: the person adding contacts is present, and the person owed this call is
not.

Every outcome, booked or refused, is one log line carrying the contact, the
reason, the truncated raw value and both instants when the roll moved one.
`absent` is silent — the overwhelming majority of calls promise nothing, and a
line for each of them is a log nobody can read.

### Charging

```
billedSecs = ceil(durationSecs / billingIncrementSecs) × billingIncrementSecs
cost       = rateCreditsPerMin × billedSecs / 60      (BigInt, truncated)
```

- The rate **and the increment** are the attempt's **snapshots**, resolved
  together at dial time.
- Billed on **`duration_seconds`**, never the carrier's
  `bill_duration_seconds`. Call details carries both; the completion webhook
  carries only the former, and billing on a field only one path carries would
  make the same call cost a different amount depending on how we heard of it.
- **Two roundings, in opposite directions, both deliberate.** The duration is
  rounded **up** to the next whole increment — that is the pulse doing its job
  — and the credits are then **truncated**, losing at most 0.0001 display
  credits, always in the customer's favour. `ceil` of an exact multiple is that
  multiple, so a call that ends on the tick does not roll into a pulse it never
  entered. Rounding half-up on the second step would be defensible too; leaving
  either rule unstated would not.
- **A zero-duration call writes no ledger row.** `ceil(0 / n) × n` is 0 at
  every increment, so this is arithmetic rather than a special case.
  `chargedAt` is still set so it cannot be charged later. The DID release
  markers are zero-amount rows because they carry a fact nothing else records;
  a zero-credit call carries nothing the attempt does not already say.
- **An attempt with no increment snapshot bills per second.** That is the
  honest reading of a row created before the column existed, which was billed
  that way; those rows are in flight for minutes, not days, and erring the
  other way would charge a customer a pulse they were never on.

**Insufficient balance fails closed.** Nothing is debited; a zero-amount
`CALL_USAGE_SHORTFALL` row records what was owed, `CallAttempt.shortfall` is
set, the campaign auto-PAUSEs, and an `ADMINS_ONLY` notification links
`/settings/billing`. A partial charge would break both the never-negative rule
and the every-movement-pairs-with-a-row rule to save a fraction of a credit.

`src/services/didRental.ts` is **no longer** the only module that moves
credits; `src/services/dialerOutcome.ts` is the second and
`src/services/testSessionOutcome.ts` is the third.

### Billing increments

A call's duration is rounded **up** to the account's `billingIncrementSecs`
before it is priced, so a 47-second call on a 60-second increment bills a full
minute. **One increment, not two** — no first-pulse / subsequent-pulse split
and no minimum-duration column that is really a first pulse in disguise: two
numbers would need a third to say how they compose, and the composition is the
part customers dispute.

**Per-second billing is the increment of one**, not an absence of one. There is
no "off", which is what keeps a single formula on the charge path instead of a
formula and a branch that must agree with it. Both columns arrive null and
resolve to 1, so a platform that sets no increment bills exactly as it did
before this existed.

**Every charge stores both figures.** `CallAttempt.durationSecs` is what the
call ran to and `billedSecs` is what it was charged for, with the
`billingIncrementSecs` that produced them beside both. A row carrying only the
billed figure cannot answer "why is this a minute when the call was
forty-seven seconds", which is the first question a pulse generates. Two
invariants hold on every row: `billedSecs >= durationSecs`, and `billedSecs`
is a whole number of increments.

**`billedSecs = null` is history, not zero.** Every charge settled before this
existed carries null, and no reader may render it as `0` or as "the same as the
duration" — the second is a guess that happens to be right for those rows and
teaches a reader to trust it when it is not. Every surface says the figure was
not recorded.

**`CreditTransaction` gains no column.** Every `CALL_USAGE` and
`CALL_USAGE_SHORTFALL` row already carries `callAttemptId`, `onDelete:
Restrict`, so a charge can never lose its referent — the three facts are one
include away. `LEDGER_CALL` in `serialize.ts` is that include, one constant
rather than four copies of a `select`: a route that forgot a column would emit
`billed_secs: null` on a charge that has one, which is indistinguishable from a
charge written before increments existed. Copying the figures onto the ledger
row would make a second account of one call with no constraint keeping the two
equal, and an append-only ledger exists to be audited.

**Bounds are 1–600 seconds, rejected and never clamped.** The rule lives in
`parseBillingIncrement` in `tierPricing.ts`, beside the precedence chain, and
both write paths call it rather than restating it. Behind them is a `CHECK`
constraint on each table — Prisma cannot express it, so it is hand-written in
the migration, the same arrangement the partial unique index on `isDefault`
has. Clamping 3600 to 600 would charge a customer at an increment nobody chose
and leave nothing on any screen saying so. `CallAttempt.billingIncrementSecs`
deliberately has **no** constraint: it is a snapshot of a value already checked,
and a settled charge must never become un-writable because staff later narrowed
the range.

### The reaper

A webhook is a delivery, not a guarantee: the platform retries four times over
eight hours and then stops. Without a reaper such an attempt sits non-terminal
forever, holding a line against a cap that never frees, and the campaign
quietly stops dialing and looks idle.

It does not guess. It asks `GET /calls/{id}`, which the docs name as the
missed-webhook recovery path, and closes a terminal call exactly as the webhook
would — a missed delivery must not change what a call cost. Only a call the
platform has never heard of, or one still live long past any plausible call,
becomes **`ABANDONED`** — its own status rather than `FAILED`, because "we
never found out" and "the callee did not answer" are different facts, and
filing the first as the second puts people on a customer's did-not-answer
report who may well have picked up.

**Stale has two shapes.** A live attempt past the timeout is the first. The
second is a terminal attempt with `resolvedAt` and `chargedAt` both null: an
unclassified pacing event closed it to free the line and deferred the queue
move to a completion that never came. The reconcile resolves and charges those
from the call detail exactly as it does the first kind; when the platform
cannot answer for one either, the resolution is invented the same way an
abandoned call's is — a retryable silence — with the status left as the
carrier reported it and `resolvedAt` stamped so the sweep does not return to
it. A charged attempt is never selected: the charging path stamps both, so
charged *is* settled.

### The read surface

Three routes, and between them they answer every question a dashboard asks about
a campaign that is not moving. All are member-read, all resolve the campaign
through `campaignInWorkspace()` first, and none of them calls upstream.

**`GET .../contacts?queue=`** — `callback` (a promise still ahead),
`callback_overdue` (a promise already due), `resume` (a conversation that
dropped mid-call, waiting out `IMMEDIATE_CALLBACK_MINUTES`), `follow_up` (a
conversation waiting on its second half) or `retry` (a number that did not pick
up). Any other value is a 400 naming the five. The filter is **ANDed** with
`?status=` rather than merged: a queue already implies PENDING, so an explicit
status must be able to narrow further rather than have one of the two silently
win. Ordering is the clock the queue is about — `nextEligibleAt` on retries,
follow-ups and resumes, `callbackAt` on the two callback queues, `createdAt,
id` otherwise.

**The five partition the PENDING rows by `armKind`, and that is load-bearing.**
A tab is an answer rather than an overlap only if every waiting contact is in
exactly one of them, and the counters could never manage it: the goal re-arm
moves `followUpCount` and touches neither `attempts` nor `callbackAt`, so a
followed-up contact whose first dial connected carried `attempts = 0` and
matched *no queue at all* — invisible on the tab whose job is saying what each
waiting contact is waiting for, in what is the ordinary case for a goal
campaign — while one that had also spent a retry was filed under "cooling
down", a different and wrong answer to the same question. Each row now carries
one arm and lands under one tab. `FRESH` is the single arm with no tab: a
contact waiting for nothing more specific than its turn is not waiting for
anything this page has a name for.
Predicates live in `src/lib/campaignQueue.ts`, which is the one place the
`armKind` reads are expressed in Prisma.

Paging is `?limit` (≤100, default 50) and `?offset`, **not a cursor**. Prisma
applies `cursor` after the `where`, so a cursor row that fails the filter still
positions the page — a way to learn that a row id exists in somebody else's
campaign — and the queue sorts are not on the id a cursor would key on anyway.

**`GET .../contacts/:ccid/journey`** — one contact's whole history:
`attempt` events, the `cooldown` between consecutive dials (measured
`resolvedAt → next.startedAt`, one decimal, gaps that run backwards dropped as
clock skew) and a `callback_due` for a live promise only. `inFlight` is the
only way a live dial appears. Two honesty rules do the real work here:

- **`scheduledMinutes` goes null once `callbackCount > 0`.** A callback takes
  the next `attemptNo` while consuming no retry, so the attempt ordinal and the
  retry index have diverged and nothing on the row records which was which.
  Printing a schedule would attribute another attempt's wait to this gap, so the
  measured gap is left to stand alone.
- **`attemptsRecorded` is not `attempts.length > 0`.** Zero rows means both
  "queued, never dialled" — the common case on any running campaign — and
  "dialled, and the rows are gone". `false` claims only the second, and only
  when contact-level state that survives a re-arm proves past dials.

`hasRecording` reports that a recording is worth asking for: an upstream call id
**and** some reason to think the call carried audio. The id alone is not enough
— a launch the platform refused, a blocked number and a carrier failure all
record an id and zero seconds, so reading it as enough put a Play link on dials
that failed at 0:00, and clicking one could only 404. A **null** duration is not
that zero: every terminal settle writes a number (`webhookOutcome.ts` and the
reaper's reconcile both coerce an unreported duration with `?? 0`), so a null is
the reaper's `ABANDONED` — `resolvedAt` stamped, the outcome never learned — and
the platform kept that call. It is offered when the attempt was closed out and
withheld while it has not been, since there is no recording of a call still
ringing. Zero therefore also means "not reported" and this cannot tell which; it
reads zero as no audio, because withholding a Play button is recoverable by
opening the attempt and a Play button that only 404s is not. It mints nothing: the recording route is rate-limited and
token-gated, and one URL per attempt on a page load would turn a cheap read into
an upstream fan-out. A 404 from that route still means "unavailable", not an
error.

**`GET .../stats`** — the status counts and the `dialer` block the campaigns tab
already read, keeping their exact shape, plus the nine dispositions zero-filled
from the contacts' normalised last outcome, a `settledUnknown` for the values
that postdate this deployment, `callbacksPending` (PENDING with `callbackAt`
still ahead — future commitments, not the dispatch backlog, and a **subset** of
`waiting.betweenCalls` rather than a sibling of it), a `waiting` split of the
PENDING count into `neverCalled` and `betweenCalls` — on `lastAttemptAt`
(`HAS_BEEN_DIALED_SQL`), so `neverCalled` means "no dial was ever attempted"
and a contact the dialer claimed and handed back is `betweenCalls`, which is
what the funnel and the bucket panel already say about it — so a page need not
report work in hand as work nobody has started, `avgDuration` over the attempts of
contacts that COMPLETED, `totalAttempts`, `reached`, and `totalCredits` **from the ledger**. Never from
`CallAttempt.costCredits`, which also records what was owed on a shortfall and
never taken: summing it would show a workspace spending credits it still has. It
also carries `leadBuckets` — see [Lead buckets](#lead-buckets).

`reached` is the leads the campaign has had a conversation with, from
`reachedContactsFilter` — contacts with at least one attempt whose disposition
is in `REACHED_DISPOSITIONS`. It rides here rather than being summed by the
dashboard out of the `dispositions` groups beside it, because those two are
**different questions and are expected to disagree**: the groups key on each
contact's last dial, so the reached tier falls when a follow-up lands in
voicemail, while this cannot fall. It is the same count as `lifetime.reached` on
the analytics report, from the same filter, so the Overview strip and the
Analytics tab cannot drift apart on one sentence.

`totalAttempts` is attempt ROWS over the campaign's life, never a sum of
`CampaignContact.attempts`: that column counts retries CONSUMED — the first dial
does not increment it and neither does a callback — so summing it undercounts
every contact by at least one. It is a lifetime figure, unaffected by any of the
splits above, and the strip that draws it labels it as dials placed rather than
as contacts dialled, since a contact called five times is five here and one in
the tile beside it. It is **optional on the dashboard's type** for the same
reason `waiting` is: this service deploys behind Vercel, and an absent count has
to read as unmeasured rather than as a campaign that has placed no calls.

The status counts, the `waiting` split **and `callbacksPending`** come from
**one raw `GROUP BY`**, not three statements. Separate statements take separate
connections and separate READ COMMITTED snapshots, and the payload would then
ship a split that can overflow the number it splits — `byStatus.PENDING` from
one instant beside a `waiting` pair from another, three keys apart in one object
— and a `callbacksPending` larger than the `betweenCalls` it is documented as a
**subset** of. Not an exotic race: the goal follow-up re-arm moves contacts
`CALLING → PENDING` continuously, and so does a callback booking, which is
steady state on exactly the campaign type the split exists to describe. One
statement makes the partition and the subset exact by construction rather than
floored or merely hoped for, at one round trip and one snapshot instead of
three. **Not one index scan instead of three.** `CampaignContact` has four
indexes on this campaign — `[campaignId, status]`,
`[campaignId, status, nextEligibleAt]`, `[campaignId, callbackAt]` and
`campaign_contacts_arm_lane_idx` on `[campaignId, status, armKind]`, which does
cover the callback filter's arm — but `lastAttemptAt` is in none of them, so
the statement reads the heap whatever plan it takes. A relation the payload
asserts as a property has to be read from one snapshot, and that is the whole
of the argument.

#### Deploying `waiting`: no order is required, in either direction

The dashboard deploys on Vercel and this service on Render, and the dashboard
routinely ships first — which for [agent variables](#deploying-a-change-to-who-declares)
made the order load-bearing. **This seam is safe both ways, and that is worth
writing down before somebody assumes otherwise and invents a constraint.**

`waiting` is the **only field this wave adds** to `/stats`. `callbacksPending`,
the dispositions, `goal` and `leadBuckets` all predate it; what changed about
them is which snapshot they are read from, which is invisible on the wire.

| State | Behaviour |
|---|---|
| new dashboard, old backend | `waiting` is absent, which is why it is **optional** on the dashboard's type — only this one field is mid-rollout. The panel falls back to a single honest "Waiting to be called" row rather than inventing a split out of a figure it does not have |
| new backend, old dashboard | the field is ignored. Nothing else on the payload moved |

The same holds for the figures whose *predicate* changed rather than their
shape — the funnel's `attempted`, the bucket panel's `unreached`, and the
campaign list's **`outcomes.inFlight` / `outcomes.undialed`**, which now split
on `lastAttemptAt` like the other two. Every one keeps its name, type and
position; an old dashboard renders the corrected number without knowing it was
corrected.

`outcomes` is the one worth spelling out, because a give-back sweep now moves
contacts across a boundary the bar draws: rows the dialer claimed and handed
back leave `undialed` for `inFlight`, and a campaign can lose most of its "Not
dialed yet" segment to "In flight" without a single contact moving. Checked
against the dashboard: `undialed` and `inFlight` are read in exactly one place,
`outcomeSegments()` in `components/campaigns/outcome-bar.tsx`, and only ever
become a labelled bar segment with a count — **nothing reads `undialed` as
remaining queue depth**. The two figures that *are* a remainder,
`projectFinish`'s ETA (`lib/campaigns/pace.ts`) and the list's "N left"
(`outcome-cell.tsx`), both compute `total - settled` from the dispositions and
`settledUnknown`, and this change moves nothing in or out of `settled`. So the
projection does not move, and the bar relabels.

So: merge and deploy these two in whichever order suits, and do not add a
sequencing note to the PR. The one thing that must ship together is the pair of
docstrings asserting `unreached` is the complement of `attempted` — this repo's
and the dashboard's `lib/types.ts` — because they are a claim about the
predicate, not about the wire.

`GET /campaigns` carries a per-campaign `outcomes` for the list, assembled in
**one** grouped query for the whole page rather than one stats call per row.
Its four numbers — dispositions, `inFlight`, `undialed`, `settledUnknown` —
**partition `totalContacts`**, which is what makes them one bar. Three things
keep that true. It is **one statement**, grouped over `(campaignId, status,
disposition)` and still batched across the page: as three statements in a
`Promise.all` it was three READ COMMITTED snapshots, and a partition read across
snapshots is not one — the goal re-arm moving a contact `CALLING → PENDING`
between two of them had it counted twice, live in one and PENDING-with-work in
the next, with the `Math.max` floor swallowing the subtraction that would have
taken it back out, so the bar came out longer than the campaign it drew. The
pending-with-work filter is **`lastAttemptAt IS NOT NULL`**
(`HAS_BEEN_DIALED_SQL`), the claim's own stamp and the same column the funnel's
`attempted` and the bucket panel's `unreached` read. Deliberately not the dial
counters, which this used to ask: none of them moves on four give-back paths
that hand a claimed contact back to PENDING — a failed attempt insert and
`rollbackLaunch` (`dialer.ts`), `releaseStaleClaims` (`dialerReaper.ts`),
`giveBack` (`dialerPlacement.ts`) — so after a rate-limited sweep the bar drew
work already in hand as work nobody had started, while the funnel beside it
counted the same contacts as attempted. `settledUnknown` exists because those
rows matched no bucket before and the bar silently came up short.
`Campaign.completedCount` deliberately cannot feed it — that counts contacts
that *settled*, so a voicemail lands in it, and drawing that as "reached a
person" would score a campaign that spoke to nobody as the healthiest row on the
page.

#### `outcomes.connect`: the same roster, partitioned by conversation

The four numbers above answer **where each contact stands now**, which is what
makes them a progress bar and what makes them the wrong answer to the question
the list is actually scanned for. A lead that had a real conversation on Tuesday
and was re-armed for a Thursday follow-up is `inFlight` — correctly — and its
conversation appeared nowhere on the row. Beside a Leads column counting every
contact an extraction had graded, that printed **"450 reached a person" next to
chips summing to 1114** on one line of the September Touchbase campaigns, with
nothing on the page saying which to believe.

`connect` is a **second** partition of the same `totalContacts`, in the same
statement and therefore the same snapshot:

| Field | Means |
|---|---|
| `connected` | at least one attempt matching `reachedAttemptSql` |
| `notConnected` | rung at least once — an attempt carrying no `launchError` — and never reached |
| `notDialed` | no dial has ever gone out |

Three rules, each of which is a wrong number if it is dropped:

- **Evidenced by the attempts, never by `CampaignContact.disposition`.** That
  column is the last dial's outcome and every resolution rewrites it, so it
  loses a conversation to a later voicemail and gains one from a re-arm that
  copied it forward. It is `reachedAttemptSql` — the shared predicate, not the
  two literals — so a cause-16 conversation arriving as `no_answer` beside
  `answered_by: human` is a conversation here, on the strip, in the analytics
  report and in the lead buckets, or in none of them.
- **`notDialed` is deliberately not `undialed`.** That one is scoped to PENDING,
  so a contact the dispatcher has claimed but not yet dialled lands in
  `inFlight`; and it splits on `lastAttemptAt`, which a claim stamps whether or
  not the call was ever placed, so a launch the platform refused reads as a dial
  nobody answered. This splits on an attempt row carrying no `launchError`,
  which is the only evidence a telephone actually rang.
- **Three buckets and not two.** `notConnected` has to mean *we rang and nobody
  picked up*. Folding a contact nobody has dialled into it would report a
  campaign on its first morning as one a thousand people had refused.

It rides on the **same statement** as the four above, through a `LEFT JOIN` onto
one grouped pass over the campaign's attempts (`bool_or` per contact, not an
`EXISTS` per contact row — a workspace list draws every campaign it has). One
snapshot, for the reason that statement is one statement at all: a partition
read across two READ COMMITTED snapshots is not a partition.

`call_attempts_campaign_reached_idx` is the index it rides, partial on the two
conversation dispositions and so declared in raw SQL rather than in the schema —
the same arrangement `call_attempts_campaign_extraction_idx` has, for the same
reason: Prisma cannot express the predicate, so declaring it in the schema would
drop the predicate and index the whole table.

**The dashboard draws `connect` as a ring and states the progress figures in
words beside it.** The bar is kept only as the deploy-skew fallback — an older
backend sends no `connect`, and the cell falls back to the older,
honestly-captioned reading rather than inventing the split out of the
dispositions it does have.

### Lead buckets

Which extracted answer sorts a campaign's leads (`Campaign.leadBucketKey`, one
of its agent's extraction key names) and which of that key's values count as won
(`Campaign.wonBuckets`, free text). Both are editable in **every** status — see
[Editing a campaign](#editing-a-campaign).

**Computed at read time, never stamped.** `src/lib/campaignBuckets.ts` runs one
statement for a whole page: `DISTINCT ON (campaignContactId)` for each contact's
latest attempt that carried `extraction` at all, `extraction ->> key` for its
answer, a `LOWER()` grouping, and window aggregates for the totals. Read time is
the whole feature — an operator does not know which answer matters until they
have a few hundred of them, so the key is chosen *after* the calls, and a bucket
stamped at resolution would only ever describe calls placed after the choice.

Four rules the tests pin:

- **The latest extracting call wins.** A lead who was cold in March and hot in
  August is hot; the campaign kept calling because the earlier answer was not
  final. A later dial that extracted *nothing* erases nothing — an absent
  extraction is no answer, not a new one.
- **An extraction that ran without answering the key leaves the contact
  unbucketed**, rather than falling back to an older call. The campaign asked
  again and got no answer, and reporting the older one would contradict the most
  recent conversation. Blank and whitespace-only answers are the same absence.
- **`Hot` and `hot` are one bucket, and so are `NOT INTERESTED` and
  `not_interested`.** The fold is `foldBucketName` — case, plus underscores,
  hyphens and runs of whitespace collapsed to a single space — applied in SQL by
  the grouping, in TypeScript by the won matching, and a third time in the
  dashboard's `lib/campaigns/lead-buckets.ts`, which decides which chip reads as
  won. Nothing pins a free-text key's answers, so the buckets are whatever a
  language model wrote, and over a few thousand calls it writes one answer more
  than one way: `LOWER()` alone left the September Touchbase rows carrying
  `NOT INTERESTED 64` and `not_interested 26` as two chips, which is not merely
  untidy — it halves the bucket an operator sorts on, and a `wonBuckets` list
  naming one spelling scored only the share that came back in it. Deliberately
  nothing beyond joining: no stemming and no synonyms, because a rule that
  merged two answers a model meant differently would be worse than the split,
  with nothing on the page showing it had happened. The **GROUP BY restates the
  expression** rather than naming the select alias, which SQL will not allow —
  the two drifting apart leaves the chips split while the won total below is
  summed over the folded key. The name shown is the spelling most of those calls
  used, ties broken on `COLLATE "C"` so the answer does not depend on the
  cluster's locale.
- **The cap is on the list and never on the totals.** `MAX_REPORTED_BUCKETS`
  (40, the ceiling the agent editor puts on a key's pinned answers) bounds the
  chips; `bucketed` and `won` are window aggregates over every bucket, because a
  `won` count that summed only the forty shown would be wrong rather than short.
  `truncated` says which happened.

The block rides on `/stats`, on the campaign detail and once per row on the
list, and is **present and empty** on a campaign that does not bucket — a
dashboard cannot tell an omitted field from a campaign whose leads nobody
sorted. A page where no campaign buckets costs no query at all.

The reading index is `call_attempts_campaign_extraction_idx`, partial on
`extraction IS NOT NULL` and so declared in raw SQL rather than in the schema —
the same reason `campaign_contacts_callback_claim_idx` is.

### Routes

| Route | Role | Notes |
|-------|:----:|-------|
| `POST /webhooks/vocobase` | signature | Outside `/api`; raw body; 200s an unknown call |
| `GET .../campaigns` | member | per-campaign `outcomes` and `leadBuckets`, one grouped query plus one bucket statement per page |
| `GET .../campaigns/:cid/contacts` | member | `?queue=callback\|callback_overdue\|resume\|retry\|follow_up`, `?status=`, `?limit=`, `?offset=` |
| `GET .../campaigns/:cid/contacts/:ccid/journey` | member | attempts, cooldowns, callbacks; mints no recording URLs |
| `GET .../campaigns/:cid/stats` | member | counts, dispositions, ledger credits, plus a live `dialer` block |
| `GET .../campaigns/:cid/attempts` | member | paginated; allow-listed projection |
| `GET .../campaigns/:cid/inbound-calls` | member | the calls an inbound-facing campaign received, newest first; `?page`, `?limit`; empty on OUTBOUND |
| `GET .../campaigns/:cid/inbound-activity` | member | when those calls arrived, as a UTC quarter-hour grid; `?days` (1-90, def 14); zeroes on OUTBOUND |
| `GET /api/admin/concurrency` | staff | the pool, allotments, overcommit |
| `PATCH /api/admin/accounts/:id/concurrency` | staff | `{ concurrencyLimit }`; `null` restores the default |

### Background workers

Every piece of background work in this service is a **BullMQ job on a Redis
queue**. There are no `setInterval` timers left: the dial sweep, the schedule
scan, the DID renewal and the analytics ingest are all repeatable jobs, and the
work a tick or a webhook used to do inline is a job of its own.

The reason is one property timers could not have. A second replica of a timer
does not share the work, it repeats it — two dial sweeps a minute against one
partner rate limit. A repeatable job is keyed in Redis, so registering the same
schedule from ten instances produces one schedule, and everything downstream of
it is claimed with `FOR UPDATE SKIP LOCKED` in Postgres. **A second instance is
now a capacity decision rather than a correctness problem.**

**Postgres remains the single enforcement point.** Every cap this platform
honours — `concurrencyLimit`, the account allotment, the retry-lane reservation,
the per-pass blast radius — is enforced by the claim and by the dial-attempt
row's uniqueness. None of it is enforced by "there is only one timer", which is
what made this refactor safe to do at all. BullMQ replaced the `setInterval`. It
does not replace, wrap or advise the claim.

#### The queues

| Queue | Trigger | Concurrency | Attempts | Backoff |
|---|---|---|---|---|
| `campaign-dispatch` | repeatable, `DIALER_SWEEP_MS` (default 60s, floor 1s) | 1 | 1 | — |
| `call-placement` | one job per claimed contact | 1 | 3 | exponential, 2s |
| `campaign-cleanup` | repeatable, `CAMPAIGN_CLEANUP_MS` (default 5m) | 1 | 3 | exponential, 10s |
| `webhook-processing` | one job per verified webhook | 1 | 5 | exponential, 2s |
| `maintenance` | up to 5 repeatables at their own intervals | 3 | 3 | exponential, 30s |

`GET /api/admin/queues` returns each queue's waiting / active / completed /
failed / delayed / paused counts, behind the admin token.

**"Up to 5" is a ceiling, not a count.** Three maintenance repeatables always
register — `did-renewal`, `agent-sync` and `wallet-topup-poll`, none of which
places a call or spends a credit. The other two are switched:
`schedule-scan` rides the dialer flag, and `analytics-sync` has
`ANALYTICS_SYNC_ENABLED` of its own. Both are *removed* when their switch is
off rather than merely skipped, so a scheduler left over from a deploy that
had the switch on cannot keep firing.

**`campaign-dispatch`** runs `runDialerSweep()` unchanged — the same function
the conformance harness drives directly. The tick claims contacts, resolves each
one's turn of the number rotation, posts one `call-placement` job per claim, and
returns. It does not wait for the dials. Its budget and the shared pool's
headroom are therefore spent on **claims** rather than launches: claimed is an
upper bound on launched, so a pass can under-fill and cannot over-fill.

**`call-placement`** carries ids, not state — campaign, contact, from-number,
attempt ordinal, batch, and the tick's clock — and its first act is to re-check
that the contact is still `QUEUED` for that campaign. A placement job is not a
request to call somebody; it is the continuation of a decision Postgres already
made, and where Postgres has unmade it the job exits without dialing and without
taking the contact back.

Its **three attempts are safe for exactly one reason**: the attempt ordinal is
fixed by the tick, so a retry re-finds the attempt row its first run wrote,
reuses that row's id, and therefore dials under the same
`client_reference_id` — which the platform treats as a per-account idempotency
key and answers with the existing call rather than dialing again. **If that
reference ever stopped being stamped, this policy has to go back to one attempt
the same day.** A job that exhausts its attempts hands its contact back through
the existing give-back, timestamps untouched.

Concurrency **1**, and it is load-bearing: a campaign's list is dialed in the
order it was uploaded and the i-th claim of a batch takes the i-th step of the
rotation, and a worker pool scrambles the order the requests leave in. It also
means every job that follows an account-wide refusal reads that batch's halt
marker — a short-lived Redis key one job writes and the rest of its batch read —
before it dials, which is the `break` the sequential loop used to have. The
marker is advisory: nothing rests on it, and a job that misses it meets the same
triage and gives its contact back whole.

**`campaign-cleanup`** calls `closeStaleAttempts` **and** `releaseStaleClaims`,
both of which **also still run inside every dispatch tick**. This queue does
not take them over; it adds a second caller on a five-minute cadence, for the
failure that is new to running two instances — one is SIGKILLed holding claimed
contacts and open attempts, and its ticks stop with it. The two sweeps cover
the two things it leaves behind: open **attempt rows**, reconciled against the
platform's own record, and **claims with no attempt row yet** — a contact
flipped `PENDING → QUEUED` whose placement job died with the instance. The
claim stamps `CampaignContact.claimedAt`; a `QUEUED` row whose lease
(5 minutes, sized over the placement retries plus the stalled-job window) has
expired with no attempt **started since the claim** goes back to `PENDING`,
armed callbacks untouched. Without that, the contact was unreachable — the
attempt sweep reconciles rows that exist, `claimContacts` selects only
`PENDING` — and its campaign could never complete. Calling a compare-and-set
sweep twice is free by construction.

**`webhook-processing`**: the handler verifies the signature, enqueues the
verified event and answers 200; the worker does `applyTerminalOutcome` and the
callback booking. There is **no table of received events** — the job payload is
the record, and what makes a retried or redelivered outcome exactly-once is the
`WebhookEvent` unique `eventKey` written inside the same transaction as the
charge. A delivery lost to a Redis flush is reconciled by the reaper against the
platform's own record, which is the recovery path that already existed. Every
timestamp the work writes comes from the delivery's instant, carried in the
payload: a call's `endedAt` is a fact about the call, not about when the queue
got round to it.

**`maintenance`** carries the schedule scan, the DID renewal and the analytics
ingest at their existing intervals and behind their existing switches.
Concurrency 3 — one lane each — because they run on independent schedules today
and a slow renewal must not delay a scan that is meant to happen every thirty
seconds. Each keeps its own in-process re-entrancy guard: a repeatable's next
job is produced when the previous is picked up, not when it finishes.

`syncAllAgents`, `syncPurchasedDids` and `syncVoiceTiers` are **not** here. They
are admin-triggered on demand and have never been periodic; scheduling them
would be new behaviour, not a migration.

#### Startup, and the kill switch

`startWorkers()` / `stopWorkers()` in **`src/lib/queue/bootstrap.ts`** are the
one composition. `src/worker.ts` is an entry point over it and nothing else —
**it serves no HTTP**, builds no app and opens no port, asserted by reading the
file. `server.ts` reaches the same function behind `WORKERS_ENABLED`, by dynamic
import. Two lists of workers is how one of them silently loses a member.

So a **worker-only deployment is a configuration change**: run `start:worker`,
and set `WORKERS_ENABLED=false` on the API service. The API can then be
restarted without interrupting a sweep, and a crash in one is not a crash in the
other. It buys no extra upstream capacity — the call-start window, the
concurrency pool and the supplier balance belong to the one partner account, and
instances share that ceiling rather than each receiving one.

`WORKERS_ENABLED` is **three-state**, and not a safety control:

- **Under vitest, never.** `process.env.VITEST` is a hard force-false no
  environment variable can override. A unit suite that spun up a dispatch worker
  would place real calls against whatever Redis it found, and the failure would
  look like a flaky test rather than like a phone bill.
- **Under `NODE_ENV=test` without vitest, off unless asked.** That is the battle
  harness, which needs `NODE_ENV=test` for header auth *and* real workers, and
  says so with an explicit `WORKERS_ENABLED=true`.
- **Otherwise the flag, defaulting on.** Off by default would silently stop the
  renewal sweep on every existing deployment — money that quietly stops being
  collected.

It decides *which process* asks. `DIALER_ENABLED`, the allowlist and the two
concurrency caps still decide whether a call is placed.

**Shutdown closes workers, then queues, then the Redis connection**, on SIGTERM
and SIGINT — workers first so an in-flight job finishes or returns to its queue
rather than being cut off mid-dial. An `unhandledRejection` is logged loudly and
does **not** exit: a rejection escaping a job must not take down an HTTP server
serving other customers, and the queue's own retry policy is the mechanism meant
to handle it. `uncaughtException` still exits.

**Redis is load-bearing from this wave on.** A deployment that cannot reach it
does no background work at all — no dialing, no renewals, no schedule scans —
and its webhook handler **rejects every delivery with a 503** rather than
accepting it: the enqueue is bounded (`ENQUEUE_TIMEOUT_MS`) and the producer
connection sets `enableOfflineQueue: false`, so an outage answers the sender
fast and lands on the platform's own retry ladder instead of holding a socket
per delivery. That is the deliberate trade for being able to run more than one
instance.

The scanner is behind the dialer's switch **not because it dials** — it does not
— but because everything it starts does. With the dialer off, no dispatch or
schedule-scan repeatable is registered at all: `startCampaign` refuses every
scheduled start with `DIALER_DISABLED`, and the scanner would faithfully record
that as a permanent refusal, clearing the schedule of every campaign somebody
set for tonight. A deployment that cannot dial leaves those schedules standing.

It runs **the same `startCampaign()` the route runs**, so a campaign started at
3am by a schedule is refused for the same reasons one started by hand at 3pm
would be. A refusal writes the reason into `scheduleError`, clears
`scheduledStartAt` and is **never retried** — guarded on DRAFT, so a manual start
that won the race is not clobbered. A thrown, transient error leaves the
schedule standing for the next tick.

### Still open

- **Nothing detects a call the platform placed under our reference id that we
  have no attempt row for.** The reaper resolves our own stale attempts only.
- **A campaign's cap is read, then claimed against, and the two are not one
  statement.** `campaignInFlight` counts attempt rows, and a claim has no
  attempt row until its placement job runs. Three windows follow from that,
  and two are closed: within one pass the tick carries its claims forward per
  account (`accountClaimed`), and **across passes** the budgets count the
  earlier-tick backlog — `campaignPendingPlacement` / `accountPendingPlacement`
  read `QUEUED` contacts whose `claimedAt` predates this tick with no attempt
  started since, so a placement backlog that outlives the tick period (the
  cross-tick form was new to the queue; the sequential loop closed it by end
  of pass) no longer lets the next tick re-spend the same headroom. What
  remains open is two passes **genuinely overlapping** on one campaign — one
  outliving its own period — where each could still claim up to its limit:
  `SKIP LOCKED` stops them taking the *same* contact; nothing stops them
  jointly exceeding the ceiling. The dispatch repeatable produces one tick per
  period for the whole fleet, delivered to exactly one worker, which is what
  keeps that overlap rare.
- **Round-robin between campaigns, not reserved floors.** A campaign gets a fair
  rotation of its account's lines, not a guaranteed share. `retryConcurrency`
  reserves slots *within* one campaign, between its lanes; nothing reserves
  across campaigns.
- **The shared partner account is the real ceiling** — one pool of concurrent
  calls, one rate limit, one supplier balance across every YE customer and
  every other integrator. This module paces against it and reports it; it
  cannot enlarge it.
- **A transferred call is billed for the bot leg only**, which is what the
  platform bills YE for.

## The call-note contract

`CALL_NOTE_KEYS` in `src/lib/extractionConfig.ts` names the seven keys a
campaign's agent answers at the end of every call — **every campaign's agent**,
since follow-ups became always-on on 2026-09-06:
`call_outcome_vocobaseplatform`, `call_outcome_reason_vocobaseplatform`,
`immediate_callback_needed_vocobaseplatform`,
`immediate_callback_needed_reason_vocobaseplatform`,
`callback_requested_time_vocobaseplatform`,
`next_call_instructions_vocobaseplatform` and
`call_end_timestamp_vocobaseplatform` — descriptions in
`src/services/campaignExtraction.ts` (`CALL_NOTE_DESCRIPTIONS`), verbatim from
the specification.

### The reserved `ezo_` variable prefix

Beside the one goal variable above, **every outbound campaign dial carries
four reserved variables** — `ezo_campaign_id`, `ezo_campaign_name`,
`ezo_contact_id`, `ezo_attempt_no` (`src/lib/contextVariables.ts`). They exist
for the platform's lifecycle hooks: a hook template renders against the call's
scope, and that scope has no idea a campaign exists, so a post-call action
appending the extraction to a sheet could not say which campaign the row came
from. They ride in `Session.variables`, the one channel the template scope
reads, spread AFTER the contact projection so a CSV column cannot win the
collision.

**Inbound calls carry none of them.** Nothing dialled an inbound call, so
there is no campaign context to state; rendering them empty would put a blank
campaign name in somebody's sheet, which reads as a bug in the campaign rather
than as an inbound call. An inbound agent gets its context from a pre-call
lookup on `caller_phone` instead.

**The PREFIX is reserved, not just the four names.** Both surfaces a variable
name can be introduced from refuse `^ezo_`: the agent's declared list
(`VARIABLES` in `src/lib/agentPayload.ts`) and a campaign's CSV column map
(`validateVariableMap` in `src/lib/campaignConfig.ts`), with one shared
sentence so they cannot drift. Reserving the prefix rather than the names is
what stops a `variableMap` written before the fifth name existed from
shadowing it on the deploy that adds it. `scripts/conformance` (scenario 14)
and `scripts/battle-test.ts` assert both halves against real dials — that all
four arrive, and that no OTHER `ezo_`-prefixed key does.

**`CallNote.callbackType` (`requested` / `immediate` / `flexible` / `null`) is
DERIVED, not extracted directly.** There is no `callback_type` key any more:
`readCallNote` in `src/lib/goalRecord.ts` computes it from
`immediate_callback_needed` and `callback_requested_time` — a real, parseable
requested time derives `requested`; failing that, `immediate_callback_needed =
"yes"` derives `immediate`; otherwise `flexible`; and `stop`, `completed` or an
unreadable outcome always derive `null` (no outcome is no note, the same
reading a silence gets). **Precedence when the two answers disagree:** a real
requested time beats `immediate_callback_needed = "yes"`, because the time
key's own description tells the model to leave it blank when immediate is
"yes" — a real time arriving anyway means the model disobeyed that
instruction, and the explicit promise wins. The derivation has no clock, so
"parseable" is not "bookable": a time already past (the echoed call-end stamp
is the usual one) still derives `requested`. The two places that pick a lane
— `resolveOutcome` in `src/services/dialerOutcome.ts` and `planRearm` in
`src/lib/reextraction/plan.ts` — therefore key the RESUME lane on
`immediateCallbackNeeded` whenever the time will not book, so a dropped call
with a stale time beside `yes` still resumes in three minutes rather than
waiting the cooldown ladder. `CallbackType` is kept as a type
and on every wire that already carried it (`attemptLog`, the journey API, the
dashboard's `JourneyGoal` type) so nothing downstream had to change shape for
this to ship.

The old single-key decision, `callback_type_vocobaseplatform`, is retired: it
stays in `RETIRED_CALL_NOTE_KEYS` (append-only) so an agent that ran a note
campaign under an earlier release keeps its grandfathered key and a partner
cannot claim the name. Nothing attaches it, but `readCallNote` still READS it
(`LEGACY_CALLBACK_TYPE_KEY`) off a note that carries no
`immediate_callback_needed` key at all — a call in flight across the deploy,
a reaper reconciliation hours late, and every stored H/G extraction the
re-extract report renders as its "old" verdict column. Such a note is judged
by the contract it was written under (the type is the gate, a time beside a
non-`requested` type is ignored); the moment I's key is present, even
unreadably, I's derivation applies and the legacy key is ignored.

## Re-extracting a campaign under a revised call-note contract

When the call-note contract's **descriptions** change — the wording that tells
the model what `call_outcome` or the callback questions mean — every verdict
already stored for a campaign was judged against the old wording, and its queue
is armed from those verdicts. `scripts/reextract/run.ts` re-judges each
contact's latest reached conversation under the current contract — from the
transcript in the platform's admin session dump — and re-arms the contact from
the new note. An operator tool for a **paused** campaign, never a background
job.

```bash
export DATABASE_URL='postgresql://…'                   # the database this run rewrites
export VOCOBASE_API_URL='https://api.vocobase.com'     # optional; this is the default
export VOCOBASE_ADMIN_DEBUG_TOKEN='…'                  # reads the session dumps
export SIM_BASE_URL='…' SIM_API_KEY='…' SIM_MODEL='…'  # the endpoint that judges

npm run reextract -- --campaign <campaignId>                  # dry run
npm run reextract -- --campaign-name "September Touchbase A"  # the same, by exact name
npm run reextract -- --campaign <campaignId> --apply          # writes
npm run reextract -- --campaign <campaignId> --apply --yes    # unattended
npm run reextract -- --campaign <campaignId> --apply --max-reopened-stops 40
```

Those are checked before anything loads, but a **full backend `.env` is needed
too**: the tool imports the campaign service, which pulls in `src/lib/env.ts` and
everything it requires. Run it from the repo root. `--campaign-name` refuses
unless exactly one campaign carries the name, printing the candidate ids.

**Dry run first, always.** Without `--apply` every conversation is fetched,
judged and reported and nothing is written. `--apply` without `--yes` asks once,
naming the campaign, **before batch 1 is judged** — the one mistake no batch
table can catch is a valid campaign that is not the one you meant. Batches are 20
(`--batch`), 4 model calls in flight (`--concurrency`), and the run pauses after
each batch for a `y` — anything else stops it with the report intact. `--yes`
runs unattended. A batch is applied only once all of it has been judged, and if
more than half of a batch of four or more fails, the whole batch is left
unapplied and the run stops. (Under four there is no majority worth reading, so
`--batch 1` is not stopped by one bad dump.) `--max-reopened-stops <n>` stops
before applying a batch that would take the run past n reopened stops; the
batches before it stand.

**The report file grows as the run does.** Each batch is appended to
`scripts/reextract/runs/<campaignId>-<runId>.md` as it lands, header first, and
the finished report overwrites the file at the end — so a run that is killed
still leaves the record of which contacts were re-armed and which do-not-call
rows were deleted (each reopened-stop line prints the row's reason before it
went).

The report goes to stdout and to `scripts/reextract/runs/<campaignId>-<runId>.md`
(gitignored — it names contacts):

| Section | What it means |
|---|---|
| Conversations | one row per contact — old → new verdict, old status, the plan applied, and the reason for any skip |
| Totals | counts per `old→new` transition, plus skips and not-selected contacts under their own reasons, never as a transition |
| Reopened stops | old `stop` verdicts the new note withdrew, split into **Dialable again** and **Reopened but still listed** |

That split is the section to read. A reopened contact is only back if nothing
still lists its number **and** it is inside the campaign's retry and dial
budgets: the run deletes the do-not-call row **its own** old `stop` wrote
(matched on `sourceCampaignContactId`) and no other, so a row from an opt-out
upload or from another contact on the same number survives and the dispatcher's
next do-not-call sweep excludes the contact again. Clear those by hand before
unpausing.

**Budgets are asked before a contact is armed**, exactly as `claimContacts` asks
them: `followUpCount < maxGoalFollowUps` (a `CALLBACK` is exempt — a promise
spends no budget) and no *placed* attempt at or past the dial ceiling,
`retryCount + maxGoalFollowUps + 1` (every campaign, no exemption). It is the
FOLLOW-UP budget and not the retry one because `selectConversations` skips a
contact nobody reached, so every re-arm here belongs to somebody who ANSWERED —
whose retries were forfeited by that answer and whom the claim exempts from the
retry clause. The **daily cap is deliberately not a refusal**: a contact at it
has run out of nothing and the claim dials it after the next local midnight. A
note that wants another call for a contact past either budget is
reported as `over_budget:follow_up_budget` / `over_budget:dial_budget` and
**nothing is written** — arming it would swap a settled row for a PENDING one the claim
never takes, which nothing else would ever settle and which would stop
`completeIfDone` finishing the campaign. Those rows are never listed as dialable.

**What `--apply` writes**, in one transaction per contact: the attempt's
`extraction` column (whole-column replace, plus `_reextractedBy` /
`_reextractedAt` markers, which `readCallNote` ignores); the contact's status,
`armKind`, `nextEligibleAt`/`callbackAt`, and `followUpCount` reset to 0; the
campaign's `completedCount`/`failedCount`/`skippedCount` where the old and new
statuses own different counters; and a goal-record attempt entry, so the next
dial's memory reads the new note.

**What it refuses.** A campaign that is `RUNNING`, `SCHEDULED` or `DRAFT` — at
selection, and again under the campaign lock before *every* write, so unpausing
mid-run stops the rest of it instead of racing the dispatcher. And a campaign
timezone `Intl` cannot resolve. A campaign with no timezone anchors every
relative time in every transcript to **Asia/Kolkata**; the report says so.

A reply naming no `call_outcome` is `no_verdict`: **nothing at all is written**
for it, not even the extraction — the write is a whole-column replace, and an
outcome-less reply would blank the five other values the attempt has held since
the call. One that names an outcome and fewer than four of the six keys is
refused as `partial_reply`, for the same reason. **Resumable**: conversations an
earlier run stamped are skipped, so a stopped run resumes on the same command;
`--force` re-judges them.

**Two things end a run rather than a row.** A 401/403 from the session dump is
`dump_unauthorized` — a fact about the token, identical for every session, so it
stops on the first one whatever the batch size rather than reporting a thousand
conversations that "could not be judged". And a second run of the same campaign
is refused with `run_in_progress`: the run holds a Postgres advisory lock on the
campaign for its whole life, which guards two operators in two processes (two
runs sharing one Prisma pool may share a connection, where the lock is
re-entrant — the CLI is one run per process).

A re-judged call does **not** move `lastCallNote` when a voicemail followed the
conversation it re-judged: `recordAttempt` moves that for the latest attempt by
ordinal only, and the dashboard's "last call" is still the last call. The memory
the next dial reads does move.

**`EXCLUDED` contacts are manual work the run will not do.** They are reported as
`not_selected:excluded`, and two writers put them there: an operator's remove,
and the dispatcher's `excludeDoNotCallContacts` sweep, which settles every
PENDING contact whose phone is on the campaign's do-not-call list — so one wrong
old `stop` can have excluded a *second* contact sharing that number. `EXCLUDED`
is the one status `totalContacts` was decremented for, so putting one back is a
deliberate two-part edit — set the contact `PENDING` **and** increment
`totalContacts` — and only once no do-not-call row still covers the number.

It never touches the platform's own extraction configuration or its stored
session extraction, and it never dials: the campaign stays paused until an
operator unpauses it.

## Notifications

A notification is a **fact that already happened** inside a workspace, recorded
after the fact. It is never a step in the action that produced it.

```
Notification      id, workspaceId, scope (ALL_MEMBERS | ADMINS_ONLY), type,
                  title, body, href?, createdAt
                  @@index([workspaceId, scope, createdAt])
NotificationRead  id, notificationId, accountId, readAt
                  @@unique([notificationId, accountId])
```

**One row per notification, not one per recipient.** Who may see a row is a
function of *current* membership, evaluated at read time, so somebody joining,
leaving or changing role never has to rewrite history. Read state is per
person and lives in the join table: the row's existence *is* the read, so a
new member needs no backfill.

`type` is an open-ended `String` on purpose — new event types land with the
module that emits them, and an enum would make each one a migration in lockstep
with code on another branch. Nothing branches on the value. `title` and `body`
are resolved at emit time, not rendered at read time, because a campaign
renamed afterwards must not retroactively rewrite the sentence about it. `href`
is an in-app path fed to the router, never an absolute URL — `notify()`
enforces that and drops anything else, rather than leaving it as an invariant
three documents assert and no code checks.

**Scope is an access rule, not a display hint.** `ADMINS_ONLY` rows are absent
from a `MEMBER`'s list, uncounted in their badge, and unmarkable by id. One
helper, `visibleScopes(role)` in `notifications.routes.ts`, feeds the `where`
clause of every query; there is no second copy and nothing is filtered after
the fact. The owner needs no special case — the owner holds an `ADMIN` member
row.

| Route | Role | Notes |
|-------|:----:|-------|
| `GET /api/workspaces/:id/notifications` | member | cursor paginated, newest first, each row carrying this caller's `read`/`readAt` |
| `GET .../notifications/unread-count` | member | `{ count }`; no joins, no rows — this is what the bell polls |
| `POST .../notifications/read` | member | `{ ids }`, idempotent, returns `{ marked }` |
| `POST .../notifications/read-all` | member | idempotent, returns `{ marked }` |

`read` **filters** the ids to what the caller can see rather than validating
them one by one. A 404 on an invisible id would confirm that the id names
something real here, which is what scoping withholds. Idempotency is
`createMany({ skipDuplicates: true })` against the unique index, so two
concurrent clicks cannot race; `marked` is what the database actually inserted.

**Never paginate a scoped table with Prisma's `cursor`.** Prisma resolves it
with an unfiltered subquery (`SELECT "createdAt" FROM … WHERE id = $1`, no
workspace, no scope), so a cursor naming a row the caller cannot see still
steers the query — an existence-and-position oracle across the tenant boundary
— and the unconditional `skip: 1` then drops a row the caller never saw. The
list endpoint resolves the cursor through the same `where` as the page, 400s
when it names nothing visible, and keysets by hand on `(createdAt, id)`.
`campaigns.routes.ts` still has the raw-`cursor` form for campaign contacts;
scope is not a security boundary there, but it has the same oracle.

`read-all` is one `INSERT … SELECT … ON CONFLICT DO NOTHING` so no id is
materialised in Node. **Its cost is still linear in the caller's unread count,
and there is no retention policy on `Notification`** — bounding that needs a
retention window or a read watermark, and neither has been decided. The same
applies to `unread-count`, which every open tab polls once a minute.

Nothing rate-limits these routes; `createRateLimiter` is mounted on
`/api/admin` only, as it is for every other customer route. `unread-count` is
the first endpoint here *designed* for unattended polling, so it is the first
place that gap actually costs something.

### Emitting

`notify(workspaceId, scope, type, title, body, href?)` in `src/lib/notify.ts`.
Fire-and-forget: call sites write `void notify(...)`. The returned promise
**always resolves** — every failure is caught, logged and dropped — because a
notification must never fail the action that triggered it. Call it only on a
success path, after the write, never inside a `try` that still returns 2xx.
`flushNotifications()` is a test-only seam that awaits in-flight writes.

Wired today:

| Event | Scope | Type |
|---|:--:|---|
| Invite accepted / declined | `ADMINS_ONLY` | `invite.accepted`, `invite.declined` |
| Member role changed | `ADMINS_ONLY` | `member.role_changed` |
| Member removed / left | `ADMINS_ONLY` | `member.removed`, `member.left` |
| Campaign started / paused / resumed / stopped | `ALL_MEMBERS` | `campaign.started`, … |
| Campaign paused by the dialer | per the pauses table | `campaign.paused_*`, including `campaign.paused_platform_credit_exhausted` |

Membership changes are `ADMINS_ONLY` because the roster is management data;
campaign lifecycle is `ALL_MEMBERS` because a `MEMBER` uses campaigns and "why
is this not dialling" is their question too. Removal and leaving share a
handler but not a sentence — `isSelf` tells them apart.

**Known consequence:** a member joining an old workspace sees the whole
`ALL_MEMBERS` history as unread. That falls out of one-row-per-notification.
Clamping the feed to `WorkspaceMember.createdAt` is a one-line `where`
addition when somebody decides whether a new admin wants the backlog.

Adding an event elsewhere is one `notify()` line at a site that already knows
it succeeded — no schema change, no enum, no registry.

## Route conventions

- JSON envelope: `{ success: true, data }` / `{ success: false, error: { code, message } }`.
- Routes live in `src/routes/*.routes.ts`, registered in `src/app.ts`.
- Workspace routes are prefixed `/api/workspaces/:workspaceId/...` (membership middleware runs there).
- Vocobase V2 partner API is called server-side only (`src/adapter/vocobase.ts`); the partner key never leaves the backend. Most upstream failures surface as `UPSTREAM_ERROR` (502) with a generic message — the upstream's own wording is logged, not returned, since it can quote credentials.
- **One exception, bounded on purpose.** An upstream **400** surfaces as `VALIDATION_ERROR` carrying the upstream message, because "prompt must be 120000 characters or fewer" is the only thing that tells a customer what to fix, and reconstructing it here would mean duplicating every upstream limit and then drifting from it. It passes through the *same* `redact()` that protects the logs — one control, one code path, so the two cannot diverge — then `scrubIdentifiers`, because that redaction protects our credential and not another workspace's entity ids, and is capped in length. A **404** passes through as a 404: a resource already gone is not an outage, and reporting it as one stopped callers clearing the row that pointed at it. A **409** becomes `NAME_TAKEN` — the name is unavailable, and nothing about what holds it. Every other status keeps the generic message, except a write whose response never arrived, which is `UPSTREAM_WRITE_UNCONFIRMED` so a create is not retried into a duplicate.
- **Naming, two registers.** Code, comments, env vars, schema and these docs say **Vocobase** — it is the supplier and there is no reason to be coy internally. Message strings that reach a customer's screen say **"the voice platform"** instead: which supplier is under the product is not theirs to learn from an error. Keep the split; do not tidy one side into the other.
- Upstream fields are read through `src/lib/upstream.ts`, which accepts both snake_case and camelCase spellings and yields `null` rather than throwing. The V2 API mixes both: agent fields are snake_case, the `tools` rows are camelCase.

### Agent routes

Fully manageable by **any member** (see the permission note above). Every write
is the same five steps, in this order:

```
requireAuth → requireMembership() → agentInWorkspace() → proxy upstream → refresh the mirror
```

The mirror refresh is part of the write, not a follow-up: an update that
returned before refreshing would leave the caller re-reading the configuration
it had just changed.

| Route | Notes |
|-------|-------|
| `GET /api/workspaces/:id/agents` | cached mirror |
| `POST /api/workspaces/:id/agents` | create upstream, then assign + mirror. **`enable_recording` defaults to `true`** — applied on the route so the dashboard, the V2 partner API and a script all get it, where a default on a form would cover one caller of three. An explicit `false` is honoured; it is a default, not an override |
| `GET /api/workspaces/:id/agents/:agentId` | cached mirror + config snapshot |
| `PATCH /api/workspaces/:id/agents/:agentId` | partial update, then refresh |
| `DELETE /api/workspaces/:id/agents/:agentId` | **unassign**, not delete |
| `PATCH .../agents/:agentId/inbound` | turns the inbound face on or off. Enabling deep-copies the base configuration upstream and is idempotent; disabling is the platform's two-step, which answers `CONFIRM_REQUIRED` with a `details` payload naming the numbers it unlinks and the campaigns it pauses. **Moves `inboundEnabled` and NOT `direction`**, and is now the ONLY route that can disable a face — the direction route never does |
| `PATCH .../agents/:agentId/direction` | `UNI \| BI`, plus `confirm` and an optional `keep: 'outbound' \| 'inbound'` on the way back to `UNI` — see **An agent's direction** below |
| `GET /api/workspaces/:id/voices` | live catalogue, for the voice picker |
| `POST /api/workspaces/:id/agents/sync` | refresh this workspace's rows |
| `GET .../agents/:agentId/tools` | live; **bound rows always shown** (redacted + `owned:false` when the connection is unmapped), candidates ∩ mapped connections **or no connection at all**. **Upstream order, preserved** — one filter, one mapping lookup, no bound/candidate grouping, so flipping a switch never moves a row under an index-keyed list. A row with no connection id — a built-in — is `owned:true` and stays listed once disabled |
| `GET .../agents/:agentId/available-connections` | live, ∩ mapped connections |
| `GET .../agents/:agentId/lifecycle-hooks[?side=inbound]` | live. **Two shapes, decided by ownership.** A row whose source this workspace owns (`hookOwnership`) comes back in full — `tool_slug`, `tool_fn`, `function_id`, `input`, `skip_unless`, `owned:true` — because that template is what the editor loads. A row staff bound to a pool connection keeps the old summary and `owned:false`: the input template (spreadsheet ids, match columns, headers) and the platform's internal function id stay behind. `owned` rides on BOTH shapes rather than being inferred from a missing `input`: an empty template and somebody else's hook are different facts, and a dashboard that cannot tell them apart draws an editable blank over another workspace's spreadsheet. `supplies` is pre-call only and de-duplicated; `declares_fields` (boolean) says whether the hook ENUMERATES what it returns — true for a sheet `lookup_row` whose input maps columns, false for a CRM or store lookup handing back an opaque object under `expose_as`. That is what decides how a name *missing* from `supplies` reads: a typo that renders empty, or nothing at all. It reports the existence of the column list, never its headers, and describes the configuration rather than the stage, so it stays true on a post-call hook whose `supplies` is empty. Upstream is the odd one out: plural `/agents/…` path, bare `{ hooks }` body (`bareBody` in the adapter is a **predicate over the parsed body**, not a key name: `key in body` is true for a key carrying `null`, so `{ hooks: null, success: false }` used to take the bypass and reach the route as an empty list) |
| `POST .../agents/:agentId/lifecycle-hooks[?side=inbound]` | create; body §4.1 of the design. A tool source BINDS the tool first when it is not bound (`connection_id` required and checked), because the platform 422s `TOOL_NOT_CONNECTED` and the caller would be told their *input* was wrong. An already-bound-and-owned tool ignores `connection_id`; one bound elsewhere is 404. A function source must pass `resourceInWorkspace('FUNCTION')`. The platform's 422 `VALIDATION_FAILED` passes through **verbatim**, its `issues` carried in `details` — they name form fields (`input.columns[2].header`) and rewriting them loses the only thing that says which input to fix |
| `PATCH .../agents/:agentId/lifecycle-hooks/:hookId[?side=inbound]` | `{ name?, input?, expose_as?, required?, timeout_ms?, enabled?, skip_unless? }`. `stage` and `source` are NOT patchable and `.strict()` 400s them: the input template's shape is the source's, so a moved hook is a row whose configuration means nothing. `skip_unless` is checked against the STORED stage |
| `DELETE .../agents/:agentId/lifecycle-hooks/:hookId[?side=inbound]` | |
| `POST .../agents/:agentId/lifecycle-hooks/reorder[?side=inbound]` | `{ stage, ids }`, and stricter than a proxy because upstream REPLACES the stage's whole sequence: an id the caller may not touch is 404, and a list that is merely SHORT is 400 — the hooks it leaves out would be deleted. The 400 does not quietly complete the list: a mismatch means the editor's view is stale |
| `POST .../agents/:agentId/lifecycle-hooks/:hookId/preview[?side=inbound]` | `{ variables? }` → `{ input, skipped, skipped_on }`: the template rendered, and whether the hook's `skip_unless` guard would have skipped it — `skipped_on` is the ONE path the platform stopped at, not a list. Upstream answers `renderedInput` (bare on the base, `data`-wrapped on the face); `input` is read as a fallback. Writes nothing, so it never mirrors |
| `GET .../agents/:agentId/tools/google_sheets/sheet-columns` | `?spreadsheet_id=&sheet_name=`. A read gated like a write — it spends the agent's Google token on an id the caller chose — so it needs an owned `google_sheets` binding, not merely membership. Answers `{ columns, sheet_name, tabs, truncated }` — `tabs` is the workbook's tab list (the platform's key; there is no `sheets`), `sheet_name` the tab actually read. `NOT_CONNECTED` → 409 `INTEGRATION_NOT_CONNECTED`, `SHEET_NOT_CONFIGURED` → 422, `TAB_NOT_FOUND` → 404 with `details.tabs` (the tabs that DO exist): they name different things to do, and collapsed to `UPSTREAM_ERROR` all point at nothing |
| `GET .../agents/:agentId/action-runs[?side=inbound]` | `?from&to&cursor`, default the last 24h, page of 50. `side=inbound` reads the face's runs under the hook routes' side rule (404 `INBOUND_NOT_ENABLED` without a face) and is forwarded with the BASE `externalId` as `agentId` — the platform keys inbound rows on the parent; a release that does not know the parameter ignores it and answers the base's rows. A projection of the platform's `/integration-logs`; nothing is stored here. The response names the `window` it read, because a PRUNED window and a quiet one are otherwise the same empty list |
| `GET .../calls/:callId/actions` | the runs keyed to this call's upstream session. `:callId` is the local attempt id **or** the platform's call id — a call that was never placed has no upstream id, and that is the case this route exists to answer with `{ runs: [], reason: 'not_placed' }`. Unfiltered it would return every other call's runs on the same agent. Window: the attempt's clock, −5 min (a pre-call hook runs before the answer) and +60 min (the post-call queue runs after the hangup) |
| `PUT .../agents/:agentId/tools/:slug` | `{ enabled, connection_id? }`. A named connection must be mapped here; enabling without naming one is refused (upstream would pick from the partner account). **A row already bound to a connection this workspace does not own is refused whatever the body says** — including a bare `{ enabled: false }`, which neither of the other two checks looks at. 404, like every other unowned-resource refusal. Read-only rendering in the dashboard is where that rule is *shown*, not where it is enforced |
| `GET .../agents/:agentId/documents` | live, merged with sync status |
| `POST .../agents/:agentId/documents:upload` | multipart, ≤25MB |
| `POST .../agents/:agentId/documents:text` / `:link` | one upstream call each |
| `DELETE .../agents/:agentId/documents/:documentId` | unlink then delete, mapped only |
| `GET /api/workspaces/:id/documents` | the workspace's own library, attached or not |
| `DELETE /api/workspaces/:id/documents/:documentId` | delete one it owns, whatever it is attached to |
| `GET .../agents/:agentId/dictionaries` | live |
| `PUT .../agents/:agentId/dictionaries` | set-replace; each id owned **or** already attached |
| `GET/POST .../dictionaries`, `PATCH/DELETE .../dictionaries/:id` | library |
| `GET .../agents/:agentId/functions` | live |
| `POST/PATCH/DELETE .../agents/:agentId/functions/:fid` | attach/toggle/detach |
| `GET/POST .../functions`, `PATCH/DELETE .../functions/:id` | library |

#### An agent's direction

`Agent.direction` is **YE's own column, not a mirror** — the platform has no
equivalent (its `agentType` is a two-value label that controls nothing), so
**sync never writes it**. `inboundEnabled` beside it is the platform's fact
about whether a face exists. The two legitimately disagree: staff can disable
a face upstream, and `PATCH .../inbound` moves one and not the other.

**It has two values, and the reason is that the third was never a product
question.** `OUTBOUND` and `INBOUND` were one fact wearing two names — an
agent with one persona — differing only in whether a face existed upstream,
which is the platform's plumbing. Asking a reader to decide it produced a mode
whose agents silently could not answer a call until somebody found the
dropdown.

| Mode | Label | Face | Editors | A save writes |
|---|---|---|---|---|
| `UNI` | Uni-directional | lazily, once something routes inbound | one | the base config, **and** the face once one exists |
| `BI` | Bi-directional | on, from the moment the mode is chosen | two | each independently |

**A `UNI` agent's face is created by the backend, the first time something
routes inbound to it** — today exactly one place, an inbound-facing campaign
starting (`ensureInboundFace`, called from `runInboundStart`). It is not free:
the platform deep-copies the knowledge base on enable, which is why "a face
for every agent" is the wrong default and why an agent never used inbound
never pays for one. From that moment every save of the one editor writes both
sides.

**The start waits for the face's knowledge base before binding a number.**
Not for the enable: the platform flips `inbound.enabled` inside the enable's
own transaction and queues the copied documents afterwards, so that read is
true at once and a poll on it never waits. `ensureInboundFace` polls the face's
document sync status (`GET /agent/:id/inbound/documents/sync-status`, via the
parent id) every 500 ms until `pending + syncing` is zero, for at most 15 s of
wall time, each read raced against what is left. No documents is ready on the
first read; `failed > 0` once settled is its own 422 (re-upload them); still
pending at 15 s, or a read that fails or hangs, is the "try again in a minute"
422. Nothing is claimed on any refusal.

**A revived face is overwritten, because the enable is not always a copy.**
Re-enabling a face that already exists revives it unchanged, config and hooks
included — and while a `UNI` agent's face was off nothing kept it level, since
the save mirror and the `BI → UNI` overwrite both skip an agent with no live
face. So for a `UNI` agent the start writes the base's config and then its
actions (`overwriteFaceWithBase`, `src/lib/faceMirror.ts`) before the poll, and
refuses with nothing claimed if either write fails. A `BI` agent's revived face
is its own persona and is left as it was.

Two refusals went with it, and both were the same mistake in two places: a
start used to answer `AGENT_INBOUND_NOT_ENABLED` and tell the operator to turn
Inbound on, and `validateCampaignType` used to refuse the *configuration* with
422 `CAMPAIGN_AGENT_INBOUND_NOT_ENABLED` at save time. The second could not
survive the first — a face built at START time cannot be reached through a
gate that refuses the campaign that would trigger it. `AGENT_INBOUND_NOT_ENABLED`
keeps its name, changes its meaning to *the face could not be created*, and
answers **422**; `CAMPAIGN_AGENT_INBOUND_NOT_ENABLED` is retired and nothing
throws it.

**The §11 extraction mirror is conditional on the mode.** `UNI` widens it to
the whole body; `BI` switches it off entirely, extraction included, because
that is the mode — mirroring there would overwrite the inbound extraction
somebody had just entered. **This re-opens §11's drift in `BI`,
deliberately**: the two sides can extract different keys and a campaign's goal
can then stop matching on the inbound calls it exists to count. The dashboard
makes it visible rather than silent, naming the keys the two sides disagree
on. If a goal ever stops counting inbound calls, look here first.

##### The two moves

| From → To | Upstream | Confirmed |
|---|---|---|
| `UNI` → `BI` | with no live face, enable one and write the base's config and actions over it — a revived face comes back unchanged, so the enable alone is not a copy; otherwise nothing, they already match and simply stop being kept so | no |
| `BI` → `UNI` | `keep: 'outbound'` (the default): write the base config over the face, then replace its actions with the base's, if one exists. `keep: 'inbound'`: first make the base the face (actions, then config), then the same overwrite | **yes** |

**Config and actions are two platform resources.** `PUT .../inbound/config` is
scalar config and leaves the face's hooks alone, so both moves also replace the
face's hook list with the base's (`PUT /agents/:id/inbound/lifecycle-hooks`,
idempotent and all-or-nothing), in order, carrying `enabled` and `skipUnless`
per row. The config write is fatal to the move; the actions copy is best
effort, and a failure answers 200 with `inboundActionsSynced: false` and
`inboundActionsError`. An unread base is never turned into an empty
replace-all.

**`BI → UNI` chooses which persona survives, with `keep`.** Omitted or
`'outbound'` is the move above, unchanged. `'inbound'` makes the BASE equal to
the face first, and then runs that same overwrite, which now copies the
inbound persona back over itself — both sides end as the face. In order,
stopping at the first failure with the direction unchanged:

1. Read the face (`getAgent(id, { includeInbound: true })`, unwrapped by
   `faceConfig`) and its hooks (`getInboundLifecycleHooks`). A `BI` agent with
   no live face, a read that fails or carries no prompt, or a hook read with no
   list is 422 `KEEP_INBOUND_UNREADABLE`; a blank prompt is 422
   `KEEP_INBOUND_EMPTY`. The base config body is built from the face now, and
   a face field the write schema refuses (it would stay at the base's value
   and then be copied over the face, erasing it) is 422
   `KEEP_INBOUND_FIELDS_REFUSED` with `details.fields`. Nothing is written.
   Then BOTH sides are snapshotted: the base is overwritten next, the face
   right after from the base.
2. Replace the base's hooks with the face's (`replaceAgentLifecycleHooks`,
   `PUT /agents/:id/lifecycle-hooks { hooks }`, mapped by `hookRowToFaceCopy`,
   in order, carrying `enabled` and `skipUnless`). First on purpose: it is the
   newer platform route, so a missing route (the catch-all 404, answered 501
   `KEEP_INBOUND_UNAVAILABLE`) or a bare 422 `VALIDATION_FAILED` (passed
   through with `issues`) happens while nothing has changed.
3. Write the face's config onto the base (`writableConfigFrom`: writable
   fields only, never `agent_name`/`project_id`, `variables` unioned like the
   outbound PATCH), then `refreshAgent`. A failure here puts the base's own
   actions back (from the confirmed read) and answers 502
   `KEEP_INBOUND_FAILED`, nothing changed. Only if that rollback fails too is
   it 502 `KEEP_INBOUND_PARTIAL`, whose message points at restoring the
   OUTBOUND snapshot just taken.

**`keep: 'inbound'` depends on the voice platform's base replace-all route**
(`PUT /api/v2/agents/:agentId/lifecycle-hooks`). Until Vocobase deploys it,
every such move answers 501 and changes nothing. `keep` on any other move is
400 `VALIDATION_ERROR`; every `BI → UNI` response carries `kept`.

**No `BI → UNI` overwrite is silent, and none is unrecoverable.** Both rules
come from the 2026-09-21 Dhandha incident, where a switch wrote a stub base over
a very different inbound persona: prompt, greeting, transfer and six extraction
keys gone, 194 calls without extraction.

- `GET .../direction/preview?to=UNI` compares both sides live (config through
  the editable keys, normalised; hooks by stage, source and settings) and
  answers, per choice, the fields and actions it would replace plus a
  `fingerprint` over both full sides and the choice.
- When the sides differ, the move needs `keep` (no default) AND that choice's
  `fingerprint`, recomputed server-side right before writing: missing is 409
  `OVERWRITE_CONFIRM_REQUIRED`, changed since the preview is 409
  `DIRECTION_PREVIEW_STALE`, both carrying the fresh preview as `details`.
  Identical sides skip both.
- Every overwrite — both `keep`s, the `UNI → BI` revive, the inbound start's
  revive — first saves the side it replaces to `AgentPersonaSnapshot`
  (`src/lib/personaSnapshot.ts`, newest 20 per agent and side; a side
  identical to its newest snapshot is not saved again, so retries cannot push
  real history out). A save that
  fails refuses the overwrite: 502 `SNAPSHOT_FAILED` on a move, the start's 422
  on a start. Do not add an overwrite path that skips it.
- `GET .../persona-snapshots` lists them; `POST
  .../persona-snapshots/:snapshotId/restore` writes one back after snapshotting
  the current side (reason `RESTORE`) — a save that never prunes the snapshot
  being restored, and that also saves the face when an OUTBOUND restore will
  mirror onto it. An inbound snapshot restores only onto a `BI` agent: 409
  `RESTORE_NEEDS_BI`. An OUTBOUND restore writes the actions FIRST (501
  `RESTORE_UNAVAILABLE` / 502 `RESTORE_FAILED`, nothing written) and the
  config second (502 `RESTORE_PARTIAL`). Every restore answers `notRestored`,
  the labels of saved fields the write schema refused.
- `timezone` is not compared or restored: it is displayed but is not a
  writable agent field.

**Nothing here ever turns a face off**, which is what collapses six moves into
two. Numbers stay linked, inbound campaigns keep running, and turning an agent
bi-directional and back loses nothing but the inbound edits it warns about —
so the platform's `CONFIRM_REQUIRED` two-step, which guards a *disable*, is
unreachable from this route and its passthrough branch is gone. `PATCH
.../inbound` is now the only route that can disable one.

The `confirm` this route takes is therefore **YE's own**, guarding the
overwrite. It answers 409 `CONFIRM_REQUIRED` with `details: { overwrites:
'inbound' }`, before any upstream act, so a refusal leaves the platform as it
was. It is **not gated on a face existing**: a `BI` agent whose face staff
turned off upstream is still asked, because otherwise the dialog appears or
not according to a platform fact the operator did not change and cannot see.
Asking when nothing would be lost costs a click; not asking when something
would be costs somebody's inbound persona.

**The column moves only after the upstream acts succeed** — a mode saying `BI` over a face that was never enabled offers an
editor for a configuration that does not exist. One rule worth knowing:

- **The overwrite reads the PLATFORM, not `rawConfig`** — a display cache
  would restore an older prompt over a newer one. It sends `null` for a key
  the base does not carry wherever the payload takes one (derived from the
  schema, not listed), and parses field by field, dropping a value this
  service will not accept rather than the whole move.

The column write is conditional on the mode the request decided from, and
answers 409 `DIRECTION_CHANGED` when two moves race.

`scripts/report-agent-direction.ts` is the post-deploy check: per workspace,
`UNI` without a face / `UNI` with one / `BI`, plus a `BI`-without-a-face count
that should be zero and means a face was disabled upstream when it is not.

The update payload is exactly the field list the platform accepts
(`src/lib/agentPayload.ts`) — nothing invented, and `language`, `status` and
`document_count` are stripped rather than forwarded, since the platform does
not accept them.

`WRITABLE_AGENT_FIELDS` there and `VISIBLE_CONFIG_KEYS` in `serialize.ts` must
agree, and a test holds them against each other by serializing a row rather
than by comparing two lists. A field that can be written and not read renders
blank in a form and overwrites the real value on the next save.

**Two structured fields, and they are rebuilt rather than copied.** Everything
else on the visible list is a scalar, where allowing the key and allowing the
value are the same act. These two are JSON whose shape the platform owns:

| Field | Rules | Where |
|---|---|---|
| `transfer_destinations` | ≤ 20 `{ key, label, number, llmDescription }`; `key` is `^[a-z][a-z0-9_]*$` and unique; `llmDescription` required; `number` is E.164 or a `{{template}}` | `src/lib/transferDestinations.ts` |
| `extraction_config` | `{ prompt, keys[], includeToolLogs?, inlineEnabled }`; ≤ 50 keys; pinned `values` deduped case-insensitively | `src/lib/extractionConfig.ts` |

`null` and `[]` are **different values** on the catalogue: `null` clears it,
`[]` says it was configured and emptied. Consumers branch on `length > 0`.

`extraction_config` is accepted on **update only** — the platform's create
route reads `extraction_enabled` and nothing else about extraction, so a create
carrying a config would report success and store nothing. This is why
`updateAgentSchema` is a factory: it takes the extraction key names the row
already stores, so a **reserved** name is refused when being added and accepted
when the agent already carries it. Without that, re-saving such an agent fails
and locks its owner out of editing anything else on it.

Two names are reserved, by two different parties, and the refusal says which:

| Name | Reserved by | Why |
|---|---|---|
| `callback_at` | the voice platform | it defines and injects this one itself, and rejects a partner definition of it |
| `callback_requested_at` | campaign callbacks | ours. A customer redefining it would silently replace its type and description, and the campaign would go on booking callbacks off whatever a differently-worded prompt returned |

It is also why `PATCH` resolves the agent **before** parsing the body,
which additionally means a malformed body aimed at an invisible agent answers
404 rather than 400.

Every number that will be dialed — `transfer_number` and each destination's —
goes through `canonicalizeE164`, so one number typed two ways is one number.

The knowledge-base tuning fields (`kb_threshold`, `kb_include_summaries`,
`kb_result_format`) were **removed** from both lists. Not moved. Stored values
upstream are untouched and simply stop being editable here.

**`DELETE` on an agent unassigns.** The mapping is cleared, the agent returns
to the unassigned pool, the upstream agent survives. It is refused with 409
`AGENT_IN_USE` while a campaign *in that workspace* names the agent — counted
rather than left to a foreign key, both because `Campaign.agentId` carries no
constraint yet and because the message names the campaigns, which a constraint
violation cannot. The count and the unassign run in one transaction — apart,
they are a check-then-act a concurrent campaign edit slips between. For the
same reason (no foreign key, so nothing else checks it) `PATCH /campaigns/:id`
verifies a supplied `agentId` names an agent **in that workspace**, answering
the same plain 404 an unknown id gets; without it an admin who learned another
workspace's agent id could run calls on their agent. The staff hard delete
clears `Campaign.agentId` in the same transaction as the row, so nothing is
left pointing at an agent that no longer exists. Real deletion is staff-only:
`DELETE /api/admin/agents/:agentId` with `{ confirm: "<externalId>" }` in the
body — the agent's own upstream id, because a boolean is something a misrouted
script sends by accident.

**Creating can orphan.** If the local assignment fails after upstream returned
201, the agent exists in the shared namespace belonging to nobody. The write is
one statement and is retried once; a second failure answers 502
`AGENT_CREATED_UNASSIGNED`, whose message says the agent was created but could
not be attached and to contact support rather than retry. No compensating
upstream delete is attempted — a failed rollback of a failed create is worse
than one orphan, which the staff pool listing is built to show.

**Uploads.** `requireMembership` and the write limiter run *before*
`upload.single`, so a stranger's body is never buffered into this process's
heap; the cap is 25MB, deliberately below the platform's 50, because the file
is held whole in memory on its way to the presigned URL. `fields`, `parts` and
`fieldSize` are bounded too — capping only `fileSize` left a request carrying
no file at all unbounded. The MIME check is a convenience, not a control:
`file.mimetype` is whatever the client put on the part. What bounds the risk is
the size cap, the fact the bytes are streamed to a presigned URL and never
executed or stored here, and upstream's own check at confirm.

**A removal that only half succeeds says so.** Deleting a knowledge source
unlinks, then deletes; if the delete fails the mapping is kept and the response
reports `deleted: false` with the reason, rather than `{ removed: true }`. The
document is still reachable, because `GET /:workspaceId/documents` lists what
the workspace *owns* rather than what is attached — which is also the recovery
path for a create whose link failed.

Adding a file is four upstream calls (presign → PUT → confirm → link); pasted
text and web links produce a ready document in one. Every source created here
is mapped to the workspace **before** it is linked: mapped-but-unlinked is
recoverable, linked-but-unmapped is a source nobody can prove they own and so
nobody can ever remove.

Removing one unlinks **and deletes** it. A source is created by, and linked to,
exactly one agent — there is no attach-an-existing-document flow — so unlinking
is the end of its life, and leaving it behind would grow the partner account
without bound with rows no workspace can see, reclaim or delete. If the delete
fails the mapping is kept and the response says `deleted: false` with the
reason: the unlink is what was asked for, but reporting a whole success would
tell the reader their file was gone when it is not. It stays reachable through
the workspace's document library, which is keyed on the mapping rather than on
what is attached. **If an attach-existing flow is ever added, this must become
conditional on the document having no other link.**

A workspace sync fetches each of its own agents directly rather than paging
the pool: the route is open to any member, and a listing walk would let one
workspace's refresh cost grow with the whole platform and spend a rate limit
shared by everyone. The global staff sync pages the listing, which returns
complete agent objects — one request per hundred agents.

`:agentId` is the **local row id**; the Vocobase agent id stays inside the
backend. Every handler resolves the agent by id *and* workspace in one query,
so ownership is a precondition of finding anything. An agent in another
workspace, an unassigned agent, and a nonexistent id all return **404** — a
403 would confirm the id names something real. `/agents/sync` is registered
before `/agents/:agentId`, or Express matches `sync` as an id.

Staff routes (`X-Admin-Token`, see below):

| Route | Description |
|-------|-------------|
| `POST /api/admin/agents/sync` | sync the global pool |
| `GET /api/admin/agents?assigned=true\|false` | pool listing with each agent's workspace |
| `POST /api/admin/agents/:id/assignment` | `{ workspaceId }` or `{ workspaceId: null }` |
| `DELETE /api/admin/agents/:agentId` | hard delete, `{ confirm: "<externalId>" }` |
| `GET /api/admin/resources?kind=&cursor=` | pooled-resource mappings, 100/page (`meta.next_cursor`) |
| `POST /api/admin/resources/:kind/:externalId/assignment` | `{ workspaceId }` or `null` |

Unassigning requires an explicit `null`; an omitted field is a 400, so a
malformed request cannot silently un-share an agent.

## Credits & billing

Credits are tracked per **Account** as BigInt with a 10000× internal multiplier (1 display credit = 10,000 internal) for 0.01 precision. `src/lib/credits.ts` is the only place that multiplier appears: `toInternalCredits` parses a non-negative decimal string, `parseSignedCredits` a non-zero signed one (staff corrections only), `toDisplayCredits` formats. Credit values cross the wire as **decimal strings** — BigInt is not JSON serializable and a float loses the hundredths on the one kind of value where that is a billing dispute.

```
CreditTransaction  id, accountId, workspaceId?, phoneNumberId?,
                   amount BigInt (signed), type, reference?, note?, createdAt
```

- Every balance change happens in a single `prisma.$transaction` pairing the update with a ledger row. There is no path that writes one without the other.
- **A balance is moved by a conditional atomic update, never by reading it and writing back a number computed in Node.** `{ credits: { increment: delta } }` with the sufficiency test in the `where` clause. Read-modify-write loses under concurrency in both directions — two grants overwrite each other and a credit vanishes; two deductions each find the balance sufficient and the account overdraws — and no amount of checking before the write can fix it, because the value checked is stale by the time it is used. `Account.credits` also carries a `CHECK (credits >= 0)` as the floor under that.
- The ledger is **append-only**: no update or delete route exists, and `onDelete: Restrict` on the account relation means deleting an Account cannot silently erase its financial history.
- `note` is required by the staff adjustment *route*, not by the column — a correction nobody can account for later is what the ledger exists to prevent, while a machine-written charge has its type to explain it.
- `reference` is **unique per account where present**. It is what makes a resubmitted form a duplicate (**409 `DUPLICATE_REFERENCE`**, nothing written) rather than a second correction. NULLs are distinct in Postgres, so machine-written rows are unconstrained and two adjustments with no reference never collide.
- A deduction larger than the balance is a **422 `INSUFFICIENT_CREDITS`**; the balance is never driven negative.
- `CreditTransactionType` declares the machine-written kinds (`DID_*`, `CALL_USAGE`, `CALL_USAGE_SHORTFALL`, `TEST_SESSION_USAGE`, `TEST_SESSION_SHORTFALL`) alongside `ADJUSTMENT`; the credit-adjustment route writes only the latter.
- **Three types are staff-written but are not `ADJUSTMENT`.** `ONBOARDING_TOPUP` is an opening balance and `ACCOUNT_TRANSFER_OUT`/`ACCOUNT_TRANSFER_IN` are one balance moving between accounts — see [Onboarding a customer, and transferring an account](#onboarding-a-customer-and-transferring-an-account). A correction and a movement are different facts, and only one of them answers where a customer's credits went.
- **A browser test gets its own two types rather than reusing `CALL_USAGE`.** That type's contract is that it carries a `callAttemptId`, and `LEDGER_CALL` in `serialize.ts` is the include that reads it — a usage row with a null attempt would render on the billing surface as a charge for a call that does not exist. `TEST_SESSION_USAGE` carries `testSessionId` and sets `reference = testSessionId`, so the same per-account unique index makes a second charge unreachable. See [Browser test sessions](#browser-test-sessions).
- `CALL_USAGE` rows set `reference = callAttemptId`, so the per-account unique index makes a second charge for one call unreachable at the database. `CALL_USAGE_SHORTFALL` is a zero-amount marker recording credits **owed and not taken**.

### The supplier wallet

Everything above is YE's own ledger: what YE's customers hold. The
supplier wallet is what YE holds with the voice platform, and it is one
balance behind every customer. `src/services/platformWallet.ts` reads it and
mints Razorpay payment links against it through the platform's
`/billing/topup/*` endpoints; `src/routes/admin/wallet.routes.ts` serves that
to the staff console's Platform wallet page.

- **A link credits YE's wallet, only.** It is never a way to bill a customer.
  Nothing under `/api/workspaces` reaches any of this.
- **There is no callback.** A paid link becomes `CREDITED` because something
  re-read it: the console's own 30-second poll while the page is open, and
  the `wallet-topup-poll` maintenance job every `WALLET_TOPUP_POLL_MS`
  (default 2 minutes). `PlatformTopup` mirrors each link so a reload or a
  second operator does not lose the URL; the platform stays the source of
  truth for status.
- **Six statuses, three of them terminal.** A link is `CREATED`, then
  `ATTEMPTED` once a payment is tried, and ends `CREDITED`, `EXPIRED` or
  `MISMATCH` — those three are terminal and stop the polling.
  **`FAILED` is not terminal**: a declined card can be retried on the same
  link, so a `FAILED` row keeps being polled and can still reach `CREDITED`.
  `MISMATCH` means the amount paid is not the amount the link was minted for,
  and needs the platform's support rather than a retry. Only `CREDITED` means
  money moved.
- **Expiry is on our clock, but only after one confirming read.** The platform
  flips `EXPIRED` on an hourly sweep, so a link can read `CREATED` for an hour
  after it died — `refreshTopup` therefore settles a row past its own
  `expiresAt` on this pass rather than waiting. It asks first, because
  `EXPIRED` is terminal and never revisited: a payment made in the last poll
  interval, written off blind, is a link the operator is told to mint and pay
  again. `CREDITED` and `MISMATCH` survive the expiry; anything else past it
  becomes `EXPIRED`, including when the platform cannot be reached at all.
- **At most 5 links open.** The sixth is a `409 OPEN_ORDER_LIMIT`, passed
  through by name — the one upstream 409 that is not `NAME_TAKEN` — so the
  console shows the open links instead of an error.
- **`WALLET_LOW_BALANCE_INR`** (default 25000) is the balance under which
  `GET /api/admin/wallet` says `low: true`, and the console shows "critically
  low" on every page. Every campaign halts on `CREDIT_EXHAUSTED` at zero.
- A balance the platform reports as anything but a finite number is a 502,
  never `₹0`: empty and unreadable must not look alike.

### Staff routes

All under `/api/admin/*`. `src/routes/admin/index.ts` composes the staff surface into one router, applies `requireStaffToken` to it, and `app.ts` mounts that behind the rate limiter — so adding a staff endpoint is adding a line there, and it is guarded and capped by construction rather than by remembering. Each sub-router keeps its own guard as well, so none can be mounted elsewhere and arrive open; the guard remembers its answer for the life of the request, so the repeat is free.

The limiter carries **two budgets per address per window**, because the traffic has two shapes. `ADMIN_AUTH_FAILURE_MAX` (default 10) counts only requests that end in 401 and is the anti-guessing cap. `ADMIN_RATE_LIMIT_MAX` (default 600) counts everything, and is loose because the staff console renders on its own server — every operator's page loads arrive from one address and share one key, so a budget sized for guessing alone was a budget the console spent on itself. It stays finite so guessing right is not unlimited reach.

| Route | Description |
|-------|-------------|
| `GET /api/admin/overview` | platform counts: accounts, workspaces, agents (assigned/pool), campaigns by status, credits outstanding |
| `GET /api/admin/accounts` | paginated; `?search=` matches a fragment of email or name, case-insensitively |
| `GET /api/admin/accounts/:id` | owned workspaces, memberships, balance, 20 most recent ledger rows |
| `POST /api/admin/accounts/:id/credits` | `{ amount, note, reference? }` — signed adjustment, transactional |
| `GET /api/admin/workspaces` | paginated; owner email and member/agent/campaign counts |
| `GET /api/admin/workspaces/:id` | members with roles, assigned agents, campaigns (name + status) |
| `GET /api/admin/credit-transactions` | global ledger; `?accountId=`, `?type=` |
| `POST /api/admin/customers/onboard` | `{ email, workspaceName, agentIds[], phoneNumberIds[], credits, tierId? }` — the whole onboarding, one transaction |
| `GET /api/admin/account-transfers/preview` | `?sourceAccountId=&destinationAccountId=` — what a transfer would move |
| `POST /api/admin/account-transfers` | `{ sourceAccountId, destinationAccountId }` — performs it |
| `GET /api/admin/webhook-config` | the endpoint this backend receives outcomes on; secret always masked |
| `PUT /api/admin/webhook-config` | `{ url, events? }` — registers it (201, secret **once**) or moves it (200, no secret) |
| `POST /api/admin/webhook-config/rotate` | issues a new signing secret and shows it **once** |
| `GET /api/admin/wallet` | supplier balance in ₹, the low threshold, and `low` |
| `GET /api/admin/wallet/topup-config` | presets, min, max, GST rate, from the platform |
| `POST /api/admin/wallet/topup-quote` | `{ amount_rupees }` → `{ base, gst, total }` |
| `POST /api/admin/wallet/topups` | mints a payment link; `201` with the row; `409 OPEN_ORDER_LIMIT` when five are open |
| `GET /api/admin/wallet/topups` | 20 most recent links, open ones refreshed |
| `GET /api/admin/wallet/topups/:id` | one link by `payment_order_id`, refreshed; what the console polls |

### Onboarding a customer, and transferring an account

Two staff writes that reach across the whole tenancy graph. Both exist because
assembled by hand out of the endpoints beside them each is six writes with no
transaction around them, and every half-finished state is **silent** — a
workspace whose owner has no `WorkspaceMember` row cannot be opened by its
owner, and nothing on any screen says so.

**Onboard** (`src/services/onboarding.ts`) strips the agents, resolves the
Account, then does the rest in one transaction: workspace, the owner's ADMIN
membership, agents, DIDs, the opening balance with its ledger row, and the tier.

- **The agents are stripped FIRST.** A pool agent is not a clean agent: the
  customer-side removal route nulls `workspaceId` without stripping, so an
  agent in the pool routinely still carries the previous tenant's dictionaries,
  function URLs and documents. `detachForeignResources(agent, null)` runs on
  each one before anything else — before the transaction, because it is a
  round of platform HTTP calls, and before Clerk, because the strip is
  idempotent on a pool agent and a Clerk user is not. Fail-closed: a strip that
  cannot be completed is a 502 `HANDOVER_INCOMPLETE` with nothing written and
  no Clerk user made. An agent somebody holds is refused at this step rather
  than stripped, so their resources are not detached from an agent still
  answering their calls; the read is not the claim — that is still the
  conditional `updateMany` below.
- **Clerk runs OUTSIDE the transaction.** `Account.clerkUserId` is unique and
  not nullable, so an Account cannot exist before a Clerk user does — and every
  other path here provisions one from a request the person made themselves, off
  their own JWT, which is exactly what staff onboarding does not have.
  `src/lib/clerkUsers.ts` is the whole of that seam and nothing else in this
  service creates a Clerk user. Run inside `$transaction` it would hold
  `Account` row locks for the length of a third-party HTTP request, and every
  concurrent call charge against that account would queue behind it. The
  consequence of doing it first is a Clerk user with no workspace when the
  transaction then fails; the next attempt with the same address adopts it,
  which is why the lookup comes before the create. The same goes for the
  `Account` row: `resolveAccount` creates it outside the transaction too, so a
  failed onboarding leaves an Account with no workspace, no balance and no
  ledger row behind. That is not a leak to clean up — the retry finds it by
  email (case-insensitively) or by Clerk id and adopts it, and `created: false`
  in the response says so.
- **Agents and DIDs are claimed by conditional `updateMany` with a count
  assertion**, never by a read followed by a write — the discipline
  `accounts.routes.ts` sets out for balances, and it applies to any contended
  row. The DID guard is `workspaceId: null`, which is the pool: `UNASSIGNED`
  and `RELEASED_NONPAYMENT` are in it, `ASSIGNED` and `PAST_DUE` are not.
- **A DID assigned here is not charged**, exactly as staff assignment has never
  charged — but it writes the same field set `assignPhoneNumber` writes,
  `rentedPriceCredits` and `nextRenewalAt` included. Without those the customer
  holds a number the renewal sweep never charges for and never renews.
- **The slug is chosen through the transaction's own client.** `uniqueSlug`
  takes an optional client for this: read through the global one it runs on a
  different connection and a different snapshot, so a workspace the same
  transaction just created is invisible and two onboardings of one name both
  pick the same slug — a `P2002` dressed up as a 500 rather than a sentence.
- A duplicate id in `agentIds` is a **400**, not a silent dedupe: deduped it is
  indistinguishable from naming an agent somebody else holds, and the operator
  would see a count that does not match the list they submitted.

**Transfer** (`src/services/accountTransfer.ts`) moves everything one account
owns to another. `Workspace.ownerAccountId` is the hinge — campaigns, contacts,
agents, DIDs and call attempts come along because they hang off the workspace
and were never attached to the account — so only four things are written:
ownership, membership, the balance, and the tier entitlements.

- **`describeTransfer` serves the preview AND the commit**, the commit calling
  it inside its own transaction. Two code paths would let the confirm step
  promise something the write does not do, and on an operation with no undo the
  confirm step is the only protection there is.
- **The balance moves by compare-and-set on the value the plan reports.**
  `describeTransfer` returns the raw `balanceInternal` beside the display
  string and the commit CASes on that — not on a second read, which under
  READ COMMITTED can return a different number from the one the response then
  reports. A `count` of 0 means it moved in between — a call settled, a top-up
  landed — and that is a 409 `CONCURRENT_MODIFICATION`, not a transfer of a
  number nobody read. A zero balance writes no ledger rows. `balanceInternal`
  is a `bigint` and never serialized: the route picks its fields, and
  `JSON.stringify` would throw on it rather than leak it.
- **Ownership moves by a guarded `updateMany` with a count assertion.** The
  guard is `ownerAccountId: source`; the assertion is that it held for every
  workspace the plan listed. Two staff submitting the same transfer both read
  a plan naming every workspace, and without the assertion the second write
  matched nothing, seated its destination as ADMIN on workspaces the first
  destination now owned, and answered 200 with a plan describing a transfer
  that did not happen. A short count is the same 409 `CONCURRENT_MODIFICATION`
  as a moved balance.
- **Membership upserts**, because the destination may already be a `MEMBER` of
  a workspace it is about to own; `create` would fail the composite unique.
  Every other member keeps their seat and their role.
- **Three things deliberately do not move**, and each is stated in the console
  rather than left to be discovered. The **ledger**: it is append-only and
  `onDelete: Restrict` on the account for exactly this reason, and the two
  transfer rows naming the other party are what connect a history now split
  across two accounts. **`Account.concurrencyLimit`**: it is YE's commercial
  arrangement with an account, not a property of the workspaces, so a busy book
  of business landing on an account allotted three lines is a working customer
  about to stop working. And **an `AccountTier` row for a tier the destination
  already holds**: overwriting would replace a rate the destination agreed to
  with one somebody else agreed to, and deleting would destroy an entitlement
  nobody asked to lose — so it stays on the source and the preview names it.
  Stays **live**: the source keeps a working `AccountTier` entitlement for that
  tier after the transfer, not a tombstone, and a source that later owns a
  workspace again is priced by it.
- The source account survives with no workspaces and no balance. That is the
  intended end state: they still exist in Clerk and can still sign in.

`ONBOARDING_TOPUP`, `ACCOUNT_TRANSFER_OUT` and `ACCOUNT_TRANSFER_IN` are why
these are not `ADJUSTMENT`. It is the same argument `CALL_USAGE_SHORTFALL`
makes against being a zero-amount `CALL_USAGE`: "staff corrected this balance"
and "this balance moved to another account" are different facts, and a billing
page that cannot filter one from the other cannot answer where a customer's
credits went.

### The webhook endpoint this backend receives on

Registering it used to be a hand-run partner API call and a secret pasted out
of a terminal — fine exactly once, and terrible the day it has to be rotated in
a hurry. `src/routes/admin/webhookConfig.routes.ts` is that workflow, staff-only
for the reason the DID inventory is: there is one partner account behind every
YE customer, so this configures the platform rather than a workspace, and a
customer who could point it at a URL of their own would receive every other
customer's call outcomes.

The endpoint is found by the label **`ezo-backend`**, a constant rather than a
setting — there is no id of ours to store, the same problem the extraction-set
ensure has, so the name we gave it is the handle. Every other row on the account
belongs to another integrator and is never returned or logged; their URLs are
addresses on their own networks.

It subscribes to `session.completed` and `call.status.updated` **explicitly**.
An empty allowlist upstream means *every* event including ones added later,
which on a shared account would quietly enrol this endpoint in the next event
type somebody ships. Event names are otherwise not enumerated here: the
catalogue is the platform's and grows, so upstream validates them and its 400
passes through with its own wording. The URL is checked locally only for
absolute-and-`https:` — permanent properties, worth one saved request against a
shared rate limit — while the SSRF and DNS rules stay upstream's, because a copy
of a rule that grows eventually refuses a URL the platform would have taken.

**The secret is returned in full exactly once**, on create and on rotation, and
is unreadable afterwards by any route. So it is passed from the adapter into one
response body and nowhere else: never logged, never notified, never stored, and
tests assert each of those rather than trusting the absence. Reads mask it with
a placeholder of **our own** rather than echoing upstream's, because a mask this
service prints cannot stop being a mask when upstream changes its mind. The
response says what to do with the value while it is still on screen — there is
no second chance to read it, so a response that merely hands it over loses it.
`redact()` gained a `whsec_` net for the day an upstream error message quotes
one back at us: same argument as the partner key, worse consequence, since a
webhook secret forges completions and charges.

**Rotation is zero-drop only because verification accepts two secrets.**
Deliveries the platform enqueued before a rotation keep signing with the value
they snapshotted, so `verifyWebhook` accepts `VOCOBASE_WEBHOOK_SECRET` and, when
set, `VOCOBASE_WEBHOOK_SECRET_PREVIOUS` — current first, so the steady state is
one HMAC. `_PREVIOUS` never stands alone: the unset-secret guard runs first and
unchanged, so a half-finished rotation is a closed door rather than a quietly
open one. The runbook is in `.env.example` and in [Environment](#environment).

Listings are offset-paginated through `src/lib/pagination.ts`: `?page=` (1-based, capped at 1,000,000) and `?limit=` (default 25, capped at 100), answered as `{ items, page, limit, total }`. A bad `page`/`limit` is a 400 rather than a fallback — a listing that quietly shows page 1's rows under page 4's heading is worse than one that refuses. "Bad" includes numbers too large to be numbers: past `Number.MAX_SAFE_INTEGER` a page silently renames itself, and past that a derived offset reaches Prisma as a float and comes back a 500. A page past the end is an empty `items`, not a 404: that is a stale link, not a mistake.

Every listing orders on **a timestamp and then the id**. `createdAt` is a `TIMESTAMP(3)`, so rows written in one pass share a millisecond; ordered on that column alone the tie breaks arbitrarily per query, and offset paging over an arbitrary order shows a row on two pages or on none.

Counts come from `_count`/`groupBy`, never from `.length` on a loaded relation, so a page costs what a page costs. Detail views cap their relations at 100 rows for the same reason and report the true `_count` beside them, so a capped list is legible as one.

The staff serializers in `src/lib/serialize.ts` (`serializeAccountForStaff` and friends) are deliberately wider than the customer ones — they carry the Clerk user id and the upstream agent id, which are exactly what staff need to match a row here against a row elsewhere. That width is why they sit behind their own guard; **no workspace route may reuse them**.

## Environment

Secrets live in `.env` (gitignored — never commit). Required:

```
DATABASE_URL        # local dev Postgres
TEST_DATABASE_URL   # local test Postgres; the suite refuses to run without it
TEST_REDIS_URL      # local test Redis DATABASE INDEX; the suite refuses without it
REDIS_URL           # the queues. Load-bearing: no Redis, no background work.
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
PORT                # default 3001
CORS_ORIGIN         # dashboard origin. Read TWICE: the CORS allow-list, and the
                    # origin the Google connect flow redirects a browser back to
                    # (`env.dashboardUrl`). There is deliberately no DASHBOARD_URL.
                    # A comma-separated list allows several dashboards; the FIRST
                    # is where browsers are sent (connect return, CSV links).
PUBLIC_API_URL      # this service's own public origin; the other half of that
                    # redirect. Required whenever VOCOBASE_API_KEY is set.
VOCOBASE_API_KEY    # V2 partner key — server-side only, never sent to a client
VOCOBASE_API_URL    # default https://api.vocobase.com/api/v2
VOCOBASE_VOICELINK_CONNECTION_ID   # required once the partner holds >1 connection
VOICELINK_AUTO_CALL_READY          # optional, default TRUE — provision a DID as it is imported
AGENT_SYNC_INTERVAL_MS             # optional, default 900000, floor 60000 — agent mirror refresh
WALLET_LOW_BALANCE_INR             # optional, default 25000 — supplier balance under which the console says "critically low"
WALLET_TOPUP_POLL_MS               # optional, default 120000, floor 30000 — how often open payment links are re-read
ADMIN_STAFF_TOKEN   # ye-voice-admin → /api/admin/* auth (until staff auth is built)
ADMIN_RATE_LIMIT_MAX       # optional, default 600 (all staff requests, per address per window)
ADMIN_AUTH_FAILURE_MAX     # optional, default 10  (rejected tokens, per address per window)
ADMIN_RATE_LIMIT_WINDOW_MS # optional, default 60000
DID_DEFAULT_MONTHLY_PRICE_CREDITS  # optional, default "500" (DISPLAY credits)
DID_RENEWAL_SWEEP_MS               # optional, default 3600000, floor 60000
DID_GRACE_DAYS                     # optional, default 7
DID_MAX_RELEASES_PER_SWEEP         # optional, default 25

# Outbound dialing. Every one of these is a control, not a tuning knob.
DIALER_ENABLED                     # default FALSE. The master switch.
DIALER_TEST_ALLOWLIST              # E.164 list; empty = no restriction
DIALER_SWEEP_MS                    # optional, default 60000, floor 60000
DIALER_MAX_CALLS_PER_SWEEP         # optional, default 25
DIALER_DEFAULT_ACCOUNT_CONCURRENCY # optional, default 2 (0 = fail closed)
DIALER_MIN_BALANCE_CREDITS         # optional, default "1" (DISPLAY credits)
DIALER_ATTEMPT_TIMEOUT_MINS        # optional, default 60
SCHEDULE_SCAN_MS                   # optional, default 30000, floor 30000
CAMPAIGN_CLEANUP_MS                # optional, default 300000, floor 10000
VOCOBASE_WEBHOOK_SECRET            # per-endpoint; unset rejects every delivery
VOCOBASE_WEBHOOK_SECRET_PREVIOUS   # optional; the secret being rotated OUT
WORKERS_ENABLED                    # optional, default TRUE. Queue workers in this process.

# Logging. All optional — unset means structured JSON on stdout and no shipping.
LOG_LEVEL                          # optional; info in prod, debug otherwise, silent in test
AXIOM_DATASET                      # optional; both this and the token, or nothing ships
AXIOM_TOKEN                        # optional; a missing token warns, never crashes
AXIOM_EDGE                         # optional region ingest edge, e.g. eu-central-1.aws.edge.axiom.co
```

All are in `.env.example` with the reasoning.

`DIALER_ENABLED` accepts only `true` or `false`, spelled exactly. A permissive
parser is the wrong shape for the switch deciding whether this deployment can
ring a stranger's phone: read loosely, `yes` is either false — a switch that is
off while the operator believes it is on — or true, which is worse.

`DIALER_TEST_ALLOWLIST` is canonicalized at boot through the same phone parser
the CSV upload uses. An entry that failed to parse at match time would equal no
contact's number, which looks exactly like the allowlist working.

`VOCOBASE_WEBHOOK_SECRET` follows `RECORDING_TOKEN_SECRET`: empty fails closed
and the service still starts; short is refused, because it fails open while
looking fine. `DID_DEFAULT_MONTHLY_PRICE_CREDITS`
is the **catalog** default: changing it prices future rentals and cannot
re-bill an existing one.

**Rotating the webhook secret, in order.** Upstream shows a secret once, and
deliveries it has already enqueued keep signing with the value they snapshotted
— so a rotation done as a straight swap drops every delivery in flight, on the
endpoint that closes call attempts and charges credits.

1. `POST /api/admin/webhook-config/rotate`. The new secret is in that response
   and in no other, ever.
2. Move the **current** value of `VOCOBASE_WEBHOOK_SECRET` into
   `VOCOBASE_WEBHOOK_SECRET_PREVIOUS`.
3. Put the new value into `VOCOBASE_WEBHOOK_SECRET`.
4. Restart. Both are accepted now, so nothing in flight is dropped.
5. Once nothing signed with the old value can still arrive — the platform
   retries over roughly eight hours — clear `_PREVIOUS` and restart again.

`_PREVIOUS` has the same floor and the same helper as the main secret, and never
stands alone: with `VOCOBASE_WEBHOOK_SECRET` unset, verification refuses
everything whatever `_PREVIOUS` holds.

`DID_DEFAULT_MONTHLY_PRICE_CREDITS` is validated at boot through the same
parser that reads a price off the wire. A typo is a wrong charge on every
unpriced number, and startup is the moment to find that out — not the first
customer's invoice.

**`REDIS_URL` is required, not optional.** It was declared and unused before the
queues; from this wave on every piece of background work is scheduled over it
and the webhook handler cannot accept a delivery without it. It is parsed
through `requiredUrl()`, so a **missing** value and a malformed one are both
startup failures rather than a connection that retries forever behind a
healthy-looking HTTP port — the old `url()` fallback would have booted an
unconfigured deployment green, pointed at a localhost Redis that does not
exist.

**`TEST_REDIS_URL` must be a database index of its own.** Queues are keyed by
name and not by database, so a suite pointed at the development Redis would
share `campaign-dispatch` with a running dev server — and a test that enqueued a
placement job would be handing a real dial to whatever worker was listening.
Workers never start under vitest regardless; both locks are worth having,
because the first stops the suite consuming and this stops it publishing.

The local convention, and what each index is for:

| Redis DB | Used by |
|---|---|
| 9 | `REDIS_URL` — local dev server |
| 10 | `TEST_REDIS_URL` — the vitest suite |
| 11, 12 | the battle test (pinned in `scripts/battle-lib.ts`) |
| 13 | the conformance suite (pinned in `scripts/conformance/boot.ts`) |

`CAMPAIGN_CLEANUP_MS` bounds how long a killed instance's claimed contacts sit
before another instance frees them. The dial tick already calls the reaper on
its own cadence; this is the second caller, and it exists for the one case the
first cannot cover — the process that was going to run it is gone.

`PROD_DATABASE_URL` and `PROD_REDIS_URL` are recorded but **not active**.
Never point local dev or the test suite at them. `test/setup.ts` refuses to
run against a hosted host, and both the conformance and battle harnesses pin
their own local database and Redis index and hard-abort on anything else.

## Logging

`src/lib/logger.ts` is imported first in `app.ts`, before any module that logs.
Importing it overrides `console.log/info/warn/error/debug` to route through
Pino, so every existing `console.*` call in the codebase is already structured —
there is no separate logging API to adopt and no call site needs rewriting. A
`[component]` prefix in the message becomes a `component` field, an `Error`
argument becomes `err` with its stack, and a plain object argument is merged
into the line's context.

Output is pretty-printed in development and JSON on stdout in production.
When `AXIOM_TOKEN` and `AXIOM_DATASET` are **both** set, production adds an
Axiom transport alongside stdout — never instead of it, so container logs are
never empty because a token expired. Half-configured or unconfigured is a
one-line warning at boot and nothing more: logging configuration must not be
able to stop the API from starting. Give each environment its own dataset.

`httpLogger` mounts ahead of every router, so a request rejected by CORS, by
the webhook signature check or by the body parser is still one logged line. It
takes `x-request-id` from the caller when it is well-formed and mints a UUID
otherwise, and echoes it back on the response — a caller-supplied id outside
`[A-Za-z0-9._~-]{1,128}` is replaced rather than sanitised, because it is going
back out in a header. `accountId` and `workspaceId` are read off the request
when the auth middlewares have resolved them; `customProps` runs at
response-finish, so neither middleware knows the logger exists. `/health` is
not logged.

### Redaction

Non-negotiable, and in two layers because one cannot cover this product.

**By key name** — a normalised key set (`recording_url`, `recordingUrl` and
`Recording-URL` are one key) covering telephony identity, transcripts,
extraction, pre-call variables, recording URLs, request credentials and
person-shaped fields, plus substring rules for anything named `*token*`,
`*secret*`, `*signature*`, `*apikey*`, `*password*` or `*credential*`. `name`
is deliberately excluded: a campaign, an agent and a workspace all have one and
none of them is a person. pino's own `redact.paths` runs as a second line of
defence, including `err.request` — an error carrying the outbound body it
failed on sits two levels deep, where no single-level wildcard reaches it.

**By content** — `maskPhones` scans every string for phone-shaped runs and
keeps only the last four digits. This layer exists because the first one
structurally cannot see inside a sentence: ``console.warn(`Could not mirror DID
${did}`)`` is one string with no field in it, and a number in a query parameter
reaches the request log through `req.url`. Both are covered; the request
serializer masks the url.

Numbers are never content-masked — a duration, a count and a credit amount are
indistinguishable from a phone number by value — so numeric PII is caught by
its key name instead. The bare-digit rule is deliberately blunt at the edges: a
13-digit epoch-millisecond value logged bare would also be masked. Times in
this codebase are logged as ISO strings, and over-masking a timestamp costs a
debugging convenience while under-masking costs a person's privacy.

Only plain objects and arrays are walked. A request, an error, a `Buffer` or a
Prisma instance passes through to pino's serializers — rebuilding `req`'s
circular graph on every request is how a logger becomes a memory problem.

**Writing a new log call**: put anything sensitive in a *field*, never in the
message. The logger can only redact what it can see a name for. `campaignCallback`
logs `{ extractionValue }` rather than interpolating the value for exactly this
reason.

The console override is **not** installed under test, and the level defaults to
`silent` there: vitest reports through the console, and the suite asserts on
console output in places.

## Google integrations

Connecting a workspace's Google Sheets, Calendar or Gmail account, through the
platform's hosted OAuth. `src/routes/integrations.routes.ts`, design §2–§3 of
`docs/plans/2026-09-21-agent-actions-google-design.md`.

**The platform's OAuth connections are partner-wide** — one account, every
workspace's tokens in one pool — which is why `WorkspaceResource(kind=CONNECTION)`
exists and why, until now, connections were staff-assigned. What makes them
self-service is a **partner customer per workspace**:
`Workspace.partnerCustomerId`, created on first use by
`src/lib/partnerCustomer.ts` with `external_id = workspace.id`. A connection
minted through that customer is upstream-owned by *this* workspace, so
`GET /customers/:id/connections` becomes an authoritative answer to "is this
theirs" rather than a list to be intersected. `resourceInWorkspace` stays the
gate every bind and hook passes through; only who fills it has changed.

| Route | Role | Notes |
|-------|:----:|-------|
| `GET /api/workspaces/:id/integrations` | member | the three connectors and this workspace's connections; **reconciles** as it reads |
| `POST .../integrations/:slug/connect` | **ADMIN** | mints the hosted-OAuth URL → `{ url, expires_at }` |
| `GET /integrations/google/return/:nonce` | **public** | the return leg; the nonce is the authentication. Always a 302 |
| `DELETE .../integrations/connections/:id` | **ADMIN** | revokes upstream, then unmaps. 204 |

**Connecting and disconnecting are ADMIN**, deliberately against the agent
surface's member rule: it is the act that authorises call content to leave for
a mailbox or a spreadsheet of somebody's choosing. Configuring an action that
*uses* a connection stays a member act — it can only reach one an admin already
approved.

**The three slugs are an allow-list** (`GOOGLE_SLUGS`: `google_sheets`,
`google_calendar`, `gmail`), in this surface's own order. The catalogue is
partner-wide and grows, and a connector appearing on this page because somebody
enabled it upstream for another integration is a feature nobody designed.

**The nonce is the whole of the return leg's authentication.** That request
arrives from the platform's consent screen as a browser with no session this
service can read and no header it can set — so `src/lib/oauthNonce.ts` mints 32
random bytes, stores `{ workspaceId, slug, accountId }` behind it in Redis for
forty minutes (`NONCE_TTL_SECONDS`, 2400), and reads it back with a single
`GETDEL`. The connect link is minted with `expires_in_seconds` =
`CONNECT_LINK_TTL_SECONDS` = the nonce's life minus the 600 s the platform
keeps its OAuth state after the click, so every redirect the platform can
still send lands while the nonce is live. Single use is what
stops a link out of a browser history being replayed into a second claim.

It waits for the shared queue connection to be `ready` before issuing a
command. That connection sets `enableOfflineQueue: false`, which is right for
the dispatcher and wrong here: ioredis also rejects a command issued in the
milliseconds before the socket comes up, and the caller who opens that window
is the first request after a deploy.

**The return leg never trusts the id it is handed.** `connection_id` arrives on
a query string from an unauthenticated redirect, so it is checked against
`listCustomerConnections` for *this* workspace's customer before anything is
written; an id that is not in that list is refused as `not_ours` and nothing is
recorded. An unreadable upstream is `failed`, not `connected` — an outage
cannot support either claim — and an id already mapped to a **different**
workspace is `not_ours` rather than success, because reporting "Connected" for
a connection every later bind will 404 on is the worse of the two lies.

`error` is five values and no more — `expired | denied | not_ours |
unavailable | failed` — so the dashboard has a sentence for each;
`unavailable` is `tool_not_available` or `customer_archived`, dead ends a retry
cannot fix; the platform's own vocabulary is
wider and grows, so it is mapped in through an allow-list. Only a genuine
refusal (`oauth_denied`, the only code the platform sends for one) reads as `denied`: reporting a fault as
one tells an admin they cancelled something they did not.

**The listing reconciles.** A return leg can be lost — a browser closed on the
consent redirect — leaving a connection that exists upstream with no mapping
here: invisible to every bind that would use it while the customer is billed
for the token. The listing claims it, which is not a guess: the platform has
already said whose customer holds it. A row some other workspace holds is
skipped rather than moved or listed.

**A read mints nothing.** Without a partner customer there is nothing to ask
upstream about, and an admin opening the page has not asked for a customer —
otherwise every workspace that ever looked would have one.

**Disconnect revokes before it unmaps**, the order the dictionary delete
argues for: the reverse leaves a live connection no workspace can see and
nobody can revoke. A connection staff mapped under the older flow has no
customer behind it and is refused (404) rather than unmapped — unmapping alone
would tell an admin their Google access was withdrawn while the token went on
working.

### The ops prerequisite

`PUBLIC_API_URL`'s host must be on the partner user's `allowedRedirectHosts`
upstream before any of this works in an environment. There is no partner-key
API that can set it, deliberately — it is the control that stops a partner
redirecting somebody's OAuth result to an address of their choosing.

Without it the connect-link call answers **400 `INVALID_REDIRECT_URI`** (not
`REDIRECT_HOST_NOT_ALLOWED`, which the design guessed at — the platform's
actual code is in `connectLink.service.ts`), and this service reports **503
`INTEGRATIONS_NOT_CONFIGURED`** so the dashboard can say the integration is not
set up rather than blaming a reader who supplied nothing. The five connect-link
failures are the only place upstream's own code passes through the adapter
(`CONNECT_LINK_CODES`), and `integrations.routes.ts` catches every one of them:
none reaches a customer wearing the platform's vocabulary. Runbook in
`docs/deploy.md`.

## VoiceLink connections

The partner account may hold more than one active VoiceLink connection. When it
does, **upstream refuses to guess between them** and every VoiceLink-scoped
request must name one — `/calls/start` answers `CONNECTION_AMBIGUOUS` without
it, and `/voicelink/call-ready` refuses in the same terms. On a
single-connection account the field is optional and upstream resolves it alone.

`VOCOBASE_VOICELINK_CONNECTION_ID` is that pin. It is appended by the adapter,
never by a caller — the connection is a property of the deployment, not of the
call — and omitted entirely when unset, so a single-connection deployment sends
exactly what it always sent. Three requests carry it:

| Request | Where |
|---|---|
| `GET /voicelink/dids/purchased` | query string |
| `POST /voicelink/call-ready` | body |
| `POST /calls/start` | body |

It went in on the DID listing first and the other two were missed, which is the
part worth remembering: the *inventory* kept working while every *dial* was
refused, so the symptom pointed at campaigns rather than at configuration.

`connection_id` is not `client_id`. The pin selects between the partner's own
connections and comes from this deployment's environment. A client id would map
a DID to a tenant, is not idempotent in a recoverable direction, and is never
sent from here — which is why an unmapped DID comes back `ready: false` instead
of being mapped.

### Provisioning an imported DID

A DID can only dial once it is mapped to a client, that client has an active
WebSocket bot pointing at the platform, and outbound routing points at that bot.
`POST /voicelink/call-ready` does all of it, and `syncPurchasedDids` calls it
for **every row a pass imports**, so a number entering the inventory and a
number being able to dial are one event rather than two.

Only on import. Re-running it across the whole inventory every hour would turn
a mirror refresh into a stream of writes against a live telephony account for
numbers that were already ready. Provisioning runs after the walk rather than
inline, so one slow call cannot stall the rows behind it, and sequentially
rather than concurrently, because a burst of bot-and-routing writes against a
shared account is how a first sync of a large inventory becomes somebody else's
incident.

The result reports three outcomes, because they need different responses:

| Field | Meaning |
|---|---|
| `provisioned` | upstream reports the number ready to dial |
| `provisionUnready` | upstream accepted and reports it **not** ready — an unmapped DID, say, which needs a person |
| `provisionFailed` | the call errored |

A failure never costs the mirror: the row is already written and stays written.
`VOICELINK_AUTO_CALL_READY=false` turns the whole thing off and restores the
read-only sweep.

## Agent variables

`Agent.variables` is the list of pre-call variables an agent declares. It is
**the platform's field, and the platform does not derive it from the prompt** —
a `{{placeholder}}` naming something undeclared is not an error at call time,
the value simply renders as an empty string. `Hi {{name}}!` becomes `Hi !`, on
every call, with no validation error and no log line.

**Declaration is the dashboard's job, not this service's.** `variables` reaches
the platform exactly as a caller sent it, or not at all: the agent create and
update paths derive nothing from the prompt, and a prompt-only `PATCH` carries
no `variables` at all.

This backend once scanned `prompt` and `intro_message` for `{{name}}` and merged
what it found into the declaration. It cannot do that correctly, because it
declares **every** flat placeholder it sees and never reads the agent's pre-call
lifecycle hooks. A name a hook already supplies — a sheet lookup's mapped
column, a lookup's `expose_as` — must **not** be declared as a per-call
variable: declaring it converts a visible "this renders empty" warning into a
confident claim that a value is coming, which nothing then fills. The dashboard
reads `GET .../agents/:agentId/lifecycle-hooks`, whose `supplies` and
`declares_fields` are exactly the two facts that tell a hook-supplied name from
a genuine typo, so it is the only layer that can decide. The backend cannot, so
it does not guess.

**But `variables` is a PUT, so a supplied list is treated as what to ADD.**
`updateAgent` replaces the array wholesale, and every caller builds its list
from a copy of the agent that is already old — the dashboard's is the mirror
below, refreshed on a fifteen-minute timer and then held for as long as the page
stays open. Sent verbatim it deletes every name added on the platform since that
copy was taken, and the `refreshAgent` on the next line mirrors the truncation,
so nothing ever looks wrong while `{{order_id}}` renders empty on every call.

So `unionWithUpstreamVariables` re-reads the platform's own list for that write
and unions the caller's onto it. This is **not** the derivation that was removed:
nothing reads the prompt and nothing is guessed at — every name in the result was
either sent by the caller or already on the agent. What it refuses to do is let a
caller drop a name by not knowing it existed. Three deliberate limits:

| Situation | What happens |
|---|---|
| the body carries no `variables` | untouched, and **no extra GET** — the prompt-only PATCH, which is the common edit, still makes one upstream call |
| an explicit `null` | honoured. That is the documented way to empty the list, and unioning onto a clear would make it impossible to perform |
| the upstream read fails | the caller's list is sent as given, and the risk is logged. An empty union is the same data loss by another route |

The 100-cap is the platform's and is not enforced here: the union can exceed it
only if the agent was already at it, in which case the write was going to be
refused whatever this returned. Truncating would pick which of somebody's
variables to delete.

**Removing a variable is therefore an explicit act** — send the full list you
want, or `null` to clear. Omitting a name no longer removes it. There is no UI
for per-name removal today, and the alternative was silent deletion.

Which leaves the mirror as the other half, and it is now the more important one:
the dashboard's variable picker reads the declared names out of it. Note the
consequence beyond the prompt: `declaredVariables` in `dialer.ts` uses
`Agent.variables` as the **allow-list** for what an unmapped campaign's dial
carries, so a name nobody declared is not merely an empty placeholder — it is a
value the dial never sends at all.

### Deploying a change to who declares

This half of the feature lives in the dashboard, which deploys on Vercel while
this service deploys on Render — and the dashboard routinely ships **first**. The
order matters and is not the one the merge order implies:

| State | Behaviour |
|---|---|
| new dashboard, old backend | **lossy.** Both layers declare, and the old backend's merge takes the caller's list as its base — discarding the upstream re-read it just paid for, so a platform-added name is deleted |
| new backend, old dashboard | degraded, not lossy. Nothing declares; placeholders render empty until the dashboard lands, and nothing is deleted |

So: **merge and deploy this service first, confirm it live, and only then merge
the dashboard.** Merging first is not the same instruction as deploying first —
Vercel builds on merge.

**On a timer** — the `agent-sync` maintenance job refreshes the mirror every
`AGENT_SYNC_INTERVAL_MS` (default 15 minutes). `refreshAgent` covers an edit
made through this backend and `syncWorkspaceAgents` covers a workspace whose
list somebody opens; neither covers an agent edited on the platform directly,
which is the ordinary way a prompt gains a variable. Without the sweep the local
copy can disagree with the platform indefinitely — and the CSV column mapper
offers variables out of that copy, so a stale mirror shows an empty picker for
an agent that genuinely declares names, and the column cannot be mapped.

It is the one maintenance sweep with **no switch**, deliberately: it places no
call and spends no credit, and there is no configuration in which a stale mirror
is the right answer.

**It also retires, which a refresh does not.** `syncAllAgents` ends by marking
every agent the listing did not mention `status = "removed"`, which
`agentIsUsable` treats as unusable — and before this sweep that only ran when
staff pressed a button, with somebody watching. It now runs unattended ninety-six
times a day. The empty-listing guard and the coverage floor bound it, but leave a
band where a complete-but-short listing retires the remainder, so a pass removing
more than a handful logs at **error** level rather than in the same shape as a
routine pass.

## Working style

Small meaningful commits as you go — one migration, one route group, one service per commit. Build feature-by-feature in coherent slices (schema → service → routes), always scoped to the workspace model.

Tests are written before the code they cover and run against `TEST_DATABASE_URL` only. The Vocobase client is always mocked with `vi.mock` — **no test may make a real network call**, so the suite is deterministic, runs offline, and cannot touch the live partner account.

That rule is load-bearing in a way it was not before the dialer. `test/setup.ts` sets `DIALER_ENABLED=true` so the suite exercises the real dialing paths; the adapter mock is the only thing between that line and a test run placing calls on a live account. A test that reaches the network is not a flaky test, it is a phone bill.
