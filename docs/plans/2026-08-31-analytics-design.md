# Analytics & Reports — Design

> **Addendum, 2026-08-27 (rebase).** This document was written against
> `feat/campaign-dispatcher`. A different dialer — `feat/outbound-dialer` —
> landed on `main` instead, bringing a `CallAttempt` table and live per-minute
> billing, and this slice was reworked onto it. Three decisions below are
> **superseded**; the rest stands.
>
> | Below | Now |
> |---|---|
> | "No local mirror exists, so analytics needs one" | `CallAttempt` is one, for campaign calls. `CallRecord` covers only what it does not: inbound, hand-placed, and calls on an unassigned agent. |
> | "Calling is not metered; `creditsCharged` is null and `metered: false`" | Minutes are billed. `metered: true`, and every figure is summed from the **ledger** (`CALL_USAGE`), never from `CallAttempt.costCredits`, which also records what was owed on a shortfall. |
> | Retry keys are `…:a<N>` | main's fourth segment is the attempt id. Only the first two segments matter here, so the parser is used unchanged. |
>
> `CLAUDE.md` § Analytics is the current description. Kept as written because
> the reasoning behind the parts that survived — the bounded walk, the
> two-factor campaign check, the attribution rules, the quarantine, the export's
> keyset and formula guarding — is unchanged and is recorded here first.

Date: 2026-08-31. Scope: the analytics slice in `ye-voice-backend` — a local fact table over the calls the platform has placed, an incremental ingest that fills it, and three aggregate read routes over it.

This module **never causes a call**, and never calls the voice platform from a request handler. Ingest is the only thing here that talks upstream, and it runs on its own schedule.

## The shape of the problem

Call history (`src/services/callHistory.ts`) answers "show me this workspace's calls" by walking the platform's listing on every request, filtering rows in memory, and paging over the filtered stream. That works for a page of twenty-five rows and cannot be made to work for an aggregate.

Three reasons, and each on its own is fatal:

**An aggregate has no page to stop at.** "How many calls did this workspace place last month, and what did they average" is a question about every row, not the first twenty-five that match. The walk is bounded at twenty upstream pages precisely so one request cannot read an account's whole history — so every aggregate computed that way is computed over a truncated set and is simply wrong. A chart that is wrong is worse than no chart, because a number carries an authority a list of rows does not.

**The upstream listing filters by almost nothing.** `limit`, `offset`, and a `status` this platform deliberately never delegates. There is no date filter, so a query for last month starts at the newest call and pages down through everything newer — and the deeper history is unreachable at any page number.

**The rate limit is shared.** Every workspace on this platform draws on one partner account's budget. A dashboard that renders four charts is four listing walks, each up to twenty upstream reads, per page load, per reader.

So analytics needs a local copy. That is the decision this slice makes, and it is the decision call history explicitly deferred: *"If a mirror is ever added, this becomes a local id."*

## Decisions

- **A fact table, not a mirror.** `CallRecord` holds the dozen scalar columns an aggregate reads and nothing else. No transcript, no recording, no variables, no extraction, no raw payload. Those are read-often-briefly, are large, and are already served live by call history. A row here is a *fact about a call*, and the call itself stays upstream.
- **Ingest is global; every read is workspace-scoped.** The upstream pool is partner-wide. Ingest walks it once for the whole platform and stamps each row with the workspace it resolves to. Every route then filters on that column and nothing else.
- **An unmappable call is quarantined, never guessed.** `workspaceId IS NULL` is a real and expected state: calls placed before the dispatcher existed, calls another integrator placed on the shared account, calls on an agent no workspace holds. A NULL row is counted by nobody and is invisible to every route. Attributing it by heuristic — the agent's *current* workspace, a phone-number match, the nearest campaign — would put one customer's traffic on another customer's chart, which is the one failure this surface must not have.
- **Attribution is written once and repaired in one direction only.** A row that already names a workspace keeps it forever. A row that names none may later acquire one. See § Re-attribution.
- **Aggregates are SQL.** `groupBy` where Prisma can express it, `$queryRaw` with bound parameters where it cannot (daily buckets need `date_trunc`). Nothing loads a workspace's calls into Node to count them.
- **No Prisma `cursor`, anywhere.** Prisma resolves `cursor` with an unfiltered subquery, so an id the caller cannot see still steers the query — an existence-and-position oracle across the tenant boundary — and the unconditional `skip: 1` then drops a row the caller never saw. The CSV export keysets by hand on `(startedAt, id)` inside the same `where` as the page. This is a standing rule in this service, not a preference.
- **Calling is not metered, and the surface says so.** See § Credits.

## The fact table

```prisma
model CallRecord {
  id              String    @id @default(cuid())
  upstreamCallId  String    @unique
  workspaceId     String?
  campaignId      String?
  agentId         String?
  direction       String?
  status          String?
  disposition     String?
  phone           String?
  startedAt       DateTime?
  durationSecs    Int?
  creditsCharged  BigInt?
  ingestedAt      DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([workspaceId, startedAt])
  @@index([campaignId, startedAt])
  @@index([workspaceId, disposition])
  @@index([startedAt])
}
```

`upstreamCallId @unique` is the idempotency key and the whole of the re-run story: ingesting the same upstream page twice writes the same rows twice and produces one row each time. It is the platform's own call id — the same opaque identifier call history already puts on the wire, so a CSV row and a call-detail URL name the same call.

**Every descriptive column is nullable** because every one of them is absent on some real upstream row. `status` and `disposition` are free text for the reason call history already documents: they follow whichever carrier placed the call and the published sets grow without this service deploying. A column typed as an enum turns next month's carrier disposition into a failed ingest.

`phone` is the **counterparty** — `to_number` on an outbound call, `from_number` on an inbound one. Storing both would duplicate what the DID inventory already knows and would put this platform's own numbers in a customer-facing export.

The three composite indexes are the three access patterns and nothing speculative: the overview (`workspaceId` + range), the campaign report (`campaignId` + range), the outcome breakdown (`workspaceId` + `disposition`). `startedAt` alone serves the ingest's own high-water queries.

**Foreign keys.** `workspaceId`, `campaignId` and `agentId` are plain columns with indexes, **not** relations. A fact row is an observation about something that already happened and must outlive the thing it observed: a campaign is deletable (`DRAFT`/`STOPPED`/`COMPLETED`), and a `Restrict` would make the fact table quietly veto a delete the campaigns surface offers, while a `Cascade` would erase the record of calls that were really placed. Both are worse than a column that may name a row that is gone. This mirrors the reasoning already applied to `CallWebhookEvent.callId`.

### The cursor

```prisma
model AnalyticsCursor {
  id             String    @id @default("singleton")
  lastStartedAt  DateTime?
  lastCallId     String?
  coverageFrom   DateTime?
  lastRunAt      DateTime?
  lastRunCount   Int       @default(0)
  lastRunTruncated Boolean @default(false)
  updatedAt      DateTime  @updatedAt
}
```

One row, keyed on a constant. A table rather than a column on something else because there is nothing else this belongs to — it is the state of a platform-wide worker, not a fact about any workspace.

`lastStartedAt` is the **high-water mark**: the newest `started_at` ingest has seen. `coverageFrom` is the **low-water mark**: the oldest. The second exists so the dashboard can state what the numbers cover. A chart drawn over a fact table seeded three days ago must not be read as a claim about a workspace's whole history, and the only way to stop that is to say where the data begins.

## Ingest

`src/services/analyticsIngest.ts`. One exported entry point, `runAnalyticsSync()`, driven by an interval from `server.ts` and by a manual refresh route.

### The walk

The listing is newest-first, pages of 100, `limit`/`offset` only. So:

1. Read the cursor.
2. Walk pages from offset 0.
3. Map and upsert every row on the page.
4. Stop when **any** of: the page came back short (the end of history — set `backfillComplete`), the page budget is spent, or every row on the page started at or before `lastStartedAt` minus the overlap window.
5. Advance `lastStartedAt` to the newest `started_at` ingested, lower `coverageFrom` to the oldest, and record what the pass did.

**The overlap window is not paranoia.** Offsets are computed against a list that grows while it is being walked: a call placed mid-pass shifts every row down one, and a page boundary read after the shift skips the row that crossed it. Re-reading `ANALYTICS_SYNC_OVERLAP_MINS` (default 10) of already-ingested calls on each pass costs one page and closes it, and the unique key makes the re-read free of consequence.

**The newest-first exit is guarded, not assumed.** Call history already learned this: the listing's ordering is documented behaviour, not a promise, and the cost of being wrong is silent — the first page would fall below the high-water mark, the walk would stop on it, and every call after the first pass would be missed with nothing to say so. So descent is *observed* across rows in hand before the early exit is taken, and abandoned permanently the moment a pair ascends. A pass that cannot establish the order spends its budget and reports itself truncated.

**The first pass is a bounded seed, not a backfill.** With no cursor, the pass walks up to its page budget and stops, recording `coverageFrom` and `lastRunTruncated`. There is deliberately no resumable descent into the whole partner history: analytics are for what this platform does from here, historical calls carry no campaign correlation at all (nothing stamped one before the dispatcher existed), and a worker that quietly reads an account's entire past against a shared rate limit is a cost nobody asked for. What the fact table covers is recorded and stated; it is never implied.

### Mapping a row to a workspace

Two legs, the same two call history uses, resolved from maps built once per page rather than per row.

**The campaign leg.** `client_reference_id` is parsed by `src/lib/callCorrelation.ts` — the strict parser, unchanged and not re-implemented. A key that parses yields `(campaignId, campaignContactId, attempt)`. The contact id is then resolved against the database and **must name a contact that is actually on the campaign the key claims**:

```
campaignContact.findMany({
  where: { id: { in: contactIds } },
  select: { id: true, campaignId: true, campaign: { select: { workspaceId: true } } },
})
```

and the row counts only when `contact.campaignId === correlation.campaignId`. Both halves, or neither. This is the two-factor check that makes the leg safe on a shared account: `client_reference_id` is free text and a campaign id is an ordinary identifier every member of a workspace can read, so a single-factor leg would let anyone able to place a call on the partner account drop their own call into somebody else's history by writing one guessable string into a field nobody validates. The contact id is the second factor, and it is not derivable from the campaign id.

**The agent leg.** The row's `agent_id` is an upstream id; local `Agent` rows are keyed by `externalId`. An agent with `workspaceId = null` maps nothing — an unassigned agent is in the pool and its calls belong to no workspace.

Deliberately **not** applied: `agentIsUsable` / `NOT_REMOVED`. Those answer "may this workspace start something with this agent", and a retired agent must not take new work. This asks whether the workspace *placed* the call, which does not stop being true when staff retire the agent later.

**When both resolve and disagree, the campaign leg wins.** Call history treats either leg as sufficient and lets a call appear under both, which a visibility check can afford; a fact table has one `workspaceId` column and must choose. It chooses the campaign leg because that leg is two-factor, attempt-scoped, and stamped by the dispatcher at dial time — evidence about the call as it was placed. The agent leg reads a *mutable mapping*: staff reassign agents, so the agent leg answers "whose agent is this now", which is a different question and the wrong one.

`campaignId` is therefore set only when the campaign leg resolved, and `agentId` only when the agent leg did — so which leg attributed a row is readable off the row itself, and no extra column is needed to record it.

### Re-attribution

The upsert refreshes the volatile columns on every pass — a call ingested while ringing is later ingested as completed with a duration. Attribution is different, and asymmetric:

| Stored | Resolved now | Written |
|---|---|---|
| `NULL` | a workspace | **yes** — a quarantined row is repaired |
| `NULL` | `NULL` | no change |
| workspace A | workspace A | no change |
| workspace A | workspace B | **no** — kept as A |

The first row is why quarantine is safe rather than lossy: an agent assigned to a workspace after its calls were ingested brings its history with it on the next pass.

The last row is the important one. Staff reassignment is an `UPDATE` no constraint can see, so without this rule the day an agent moves from A to B is the day a late re-ingest of A's old calls silently moves them onto B's charts. Attribution records who placed a call, which is a fact about the past; it is written once and it does not move.

Implemented as a read of the page's existing rows before the write, not as a database trigger, so the rule is visible in the service that holds it.

### Scheduling

`startAnalyticsSync()` is called from `src/server.ts` and **never** from `createApp()` — the rule the renewal sweep and the dispatcher both hold, and `test/analytics-sync-startup.test.ts` asserts it. A test that builds the app must not start a timer that reads the partner account.

It is additionally gated on `ANALYTICS_SYNC_ENABLED`, default **off**. A worker that spends a shared upstream budget should be switched on deliberately, per deployment.

Passes are **re-entrant guarded**: a second call while one is in flight joins the running promise rather than starting a second walk. Two concurrent walks would double the upstream cost to produce identical rows.

### The manual refresh

`POST /api/workspaces/:workspaceId/analytics/refresh` — **ADMIN**, and rate limited per workspace.

Everything else on this surface is readable by any member, and this is not a read: it spends the partner account's rate limit, on behalf of every workspace, from one workspace's page. ADMIN and a per-workspace cooldown are what stop a reader holding the refresh button from making the platform's ingest budget their own. A refresh while a pass is running returns the running pass's result rather than queuing another.

The response reports what the pass did — rows ingested, whether it truncated, and the coverage window — because a refresh button that says only "done" teaches the reader nothing about why the chart did not change.

## Credits

`CallRecord.creditsCharged` is **what YE charges the workspace**, in internal credit units, and it is `NULL` on every row this slice writes.

That is not an oversight, and the alternative is worse. The platform reports `credits_used` on a call's *session*, which is what **this platform** was billed by its supplier — not what the workspace pays. Call history already refuses to emit it, for the reason that publishing it publishes the margin. Copying it into a column named `creditsCharged` would put that number on a customer's chart under a "Credits" heading, and the fact that it arrives only on the call *detail* (never on a listing row) means an ingest that wanted it would have to fetch one detail per call — an N+1 against the shared rate limit, to obtain a figure it must not show.

Per-minute metering is not wired: `resolveTierRate` exists and the dispatcher does not call it, so no campaign call deducts credits today. The column is the seam for the slice that changes that, and until then the overview emits `metered: false` alongside a null credits total — the same rule `/billing/plan` already holds, and for the same reason: a number under a "Credits" heading with no qualifier reads as a charge already being made, and the reader goes looking for it in a history that will never show it. A zero would be worse than a null, because zero is a measurement.

## Classifying an outcome

`src/lib/callOutcome.ts`, and nowhere else. Three surfaces read it — the overview's answer rate, the campaign report's breakdown, the CSV's outcome column — and three copies of a classification rule eventually say three different things, which here is two charts on one screen disagreeing about the same calls.

```
answered   completed · transferred · user_hangup_no_speech
voicemail  voicemail
no_answer  no_answer
busy       busy
failed     failed · blocked · canceled
other      everything else
```

Read from `disposition`, falling back to `status` when the disposition is absent, matched case-insensitively.

**`other` is a real bucket and is always reported.** The sets above are today's published values and they will grow without this service deploying; a classifier that folded an unknown value into `failed` would report a carrier's new outcome as a failure, and one that dropped it would quietly shrink the denominator of every rate on the page. An unrecognised value lands in `other`, is counted, and appears verbatim in the outcome breakdown — which is a `groupBy` on the raw column and hides nothing.

**Connected** is `answered + voicemail`: the call reached the far end. **Answer rate** is `connected / calls`, and the payload carries both numerator and denominator so the page never has to trust a rate it cannot check. Voicemail is separated in the breakdown, because "a machine picked up" and "a person picked up" are different results even though both connected.

## The read routes

`src/routes/analytics.routes.ts`, mounted with one line in `app.ts`. All three run `requireAuth → requireMembership()`; membership answers a non-member 403 before any of this is reached.

| Route | Role | Answers |
|---|:--:|---|
| `GET /api/workspaces/:id/analytics/overview?from=&to=` | member | totals, daily series, per-campaign rollup |
| `GET /api/workspaces/:id/campaigns/:cid/analytics?from=&to=` | member | funnel, attempt distribution, outcome breakdown, daily series |
| `GET /api/workspaces/:id/analytics/export?from=&to=` | member | CSV of this workspace's `CallRecord`s |
| `POST /api/workspaces/:id/analytics/refresh` | ADMIN | runs an ingest pass |

**The range is resolved, echoed, and never assumed.** Absent `from`/`to` default to the last 30 days, and the resolved bounds come back in the payload. A page that renders "1,204 calls" over a window the reader did not choose and cannot see is a number without a question attached to it. Parsing follows `src/lib/callQuery.ts` exactly — a bare `YYYY-MM-DD` is a UTC day, a timestamp needs an explicit zone, and `from > to` is a 400 rather than an empty result. The dashboard sends instants for both ends, as the calls page already does.

**Daily buckets are UTC days**, stated in the payload as `bucket: 'day'` / `timezone: 'UTC'`. A per-workspace timezone would have to come from somewhere — the campaign's, the reader's browser, a workspace setting that does not exist — and a chart whose buckets depend on who is looking at it cannot be compared with the one beside it.

**The series is dense.** A day inside the range with no calls is emitted as a zero, from the range rather than from the rows. A sparse series drawn as a line silently connects across the gap and reports a week of nothing as a smooth decline.

**A campaign in another workspace is a 404.** `campaignInWorkspace()`-shaped lookup — `findFirst({ where: { id, workspaceId } })` — exactly as every other campaign route does. A foreign id, an unmapped id and pure nonsense answer identically, so the route cannot be used to sort ids into real and unreal. The analytics query then filters on `workspaceId` **as well as** `campaignId`, which is redundant with the ownership check by design: two independent filters, so a future refactor of the lookup cannot silently widen the query.

**The per-campaign rollup on the overview is derived from `CallRecord`**, grouped by `campaignId` within the workspace filter, then joined to campaign names in one query. Not from the campaigns table outward — that would list campaigns with no calls as rows of zeros and would need a second query per row for the counts.

### The export

Streamed, `text/csv; charset=utf-8`, with a UTF-8 BOM so a spreadsheet opens it as UTF-8 rather than guessing.

Rows are walked with an explicit `where` (workspace + range), `orderBy` on `(startedAt, id)`, and a **manual keyset** — `where: { OR: [{ startedAt: { lt: last.startedAt } }, { startedAt: last.startedAt, id: { lt: last.id } }] }` folded into the same clause as the scope. Constant memory, no `cursor`, and the scope filter is never something the anchor can escape. The tiebreaker on `id` is not optional: rows written in one ingest pass share a `startedAt` to the millisecond, and an unstable sort repeats one row and omits another.

**No row cap.** A cap would mean either a truncated file that reads as complete — the one forbidden outcome on every listing in this service — or a truncation marker inside a CSV, where it becomes a data row in somebody's spreadsheet. The query is indexed on the workspace and streams; a large export is slow, not unbounded.

**Every cell is neutralised against formula injection.** A cell whose first character is `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote before quoting. This is not theoretical here: `phone` is E.164 and *every* phone number starts with `+`, so an unguarded export of this table is a spreadsheet full of formulas. Quoting alone does not help — a spreadsheet strips the quotes and evaluates what is inside.

## What is deliberately not here

- **Real-time facts.** Rows arrive on the sync interval, so a call that just ended is not on the chart yet. The webhook receiver already learns of terminal calls the instant they end and is the natural place to write a fact row; folding it in is a small follow-up once both branches are on `main`, and it is deliberately not attempted here — this branch must not touch the webhook pipeline.
- **Extraction analytics.** Extraction values live on a call's detail, not its listing row, so counting them means an N+1 against the shared rate limit. It needs the webhook path above, not a deeper walk.
- **Transcript search.** Detail-only upstream, and not a fact.
- **Per-agent rollups.** The columns and indexes support them; no surface asks for one yet, and an endpoint with no reader is an endpoint nobody maintains.
- **A workspace-configurable timezone.** See § daily buckets.

## Environment

```
ANALYTICS_SYNC_ENABLED       # optional, default false — the interval worker; off in tests
ANALYTICS_SYNC_INTERVAL_MS   # optional, default 300000, floor 60000
ANALYTICS_SYNC_MAX_PAGES     # optional, default 20, floor 1 — 100 calls per page
ANALYTICS_SYNC_OVERLAP_MINS  # optional, default 10, floor 0 — re-read window, see § the walk
ANALYTICS_REFRESH_RATE_LIMIT_MAX  # optional, default 4 per minute per workspace
```

Read through `src/lib/env.ts`, so a malformed value is a startup failure rather than a limiter that silently admits everything.

## Merge order

This branch is cut from `feat/campaign-dispatcher`, not from `main`, because `CallCorrelation`, `CampaignContact.attempts` and the dispatcher's stamping convention are what make the campaign leg resolvable at all. **`feat/campaign-dispatcher` must land on `main` before this branch can.** The footprint is kept additive — new files, one route mount, a small additive block in `env.ts` — so the rebase is cheap.
