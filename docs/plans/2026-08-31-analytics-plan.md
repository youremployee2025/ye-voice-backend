# Analytics & Reports — Implementation Plan (backend)

**Goal:** a local `CallRecord` fact table, an incremental ingest that fills it from the voice platform's call listing, and three workspace-scoped aggregate routes over it. Design: `2026-08-31-analytics-design.md`.

**Architecture:** one additive migration (two models, no changes to existing ones), one ingest service, one outcome classifier, one query-parsing helper, one aggregation service, one route file, one line in `app.ts`, one line in `server.ts`. Nothing existing is edited beyond `env.ts` (additive keys), `errors.ts` (no new codes needed), and those two mount lines.

**Tech stack:** existing — Express, TypeScript, Prisma, Zod, Vitest + Supertest. No new dependencies.

**Test safety (read first):** tests run only against this worktree's own `TEST_DATABASE_URL` (`ye_test_analytics`), under the guard in `test/setup.ts`. **Every test mocks the voice-platform adapter with `vi.mock`** — no test may make a real network call. The partner account is production and ingest's whole job is reading it.

**Branch:** `feat/analytics`, cut from `feat/campaign-dispatcher`. Do not commit to any other branch; do not push.

---

### Task 1: Schema — the fact table and the cursor

**Files:** `prisma/schema.prisma`, new migration.

1. Add `model CallRecord` and `model AnalyticsCursor` exactly as the design specifies. Both are **new models**; no existing model gains a relation field, so the diff is append-only and a rebase over the dispatcher's schema cannot conflict.
2. `upstreamCallId String @unique`. Indexes: `[workspaceId, startedAt]`, `[campaignId, startedAt]`, `[workspaceId, disposition]`, `[startedAt]`.
3. No foreign keys on `workspaceId` / `campaignId` / `agentId` — see the design's § Foreign keys. Document the reason in a schema comment, since the absence is the surprising part.
4. `npx prisma migrate dev --name analytics_call_record`. Apply to the test DB with `npm run test:prepare`.
5. Add both tables to `TABLES` in `test/setup.ts` so `truncateAll` clears them. They are childless — top of the list.
6. Commit: `feat: add CallRecord fact table and analytics cursor`.

### Task 2: Outcome classification

**Files:** `src/lib/callOutcome.ts`, `test/call-outcome.test.ts`.

1. Failing tests first:
   - each documented disposition maps to its bucket, case-insensitively;
   - an absent disposition falls back to `status`;
   - both absent → `other`;
   - an unknown value → `other`, never `failed` and never dropped;
   - `isConnected` is true for `answered` and `voicemail` and false for the rest.
2. Implement `classifyOutcome(disposition, status)`, `isConnected(outcome)`, and the exported `OUTCOMES` order.
3. Commit: `feat: classify call outcomes in one place`.

### Task 3: Analytics query parsing

**Files:** `src/lib/analyticsQuery.ts`, `test/analytics-query.test.ts`.

1. Failing tests: bare `YYYY-MM-DD` is a UTC day (`from` at 00:00:00.000Z, `to` at 23:59:59.999Z); a timestamp without a zone is a 400; `from > to` is a 400; absent bounds default to the last 30 days; a repeated parameter is a 400.
2. Implement, reusing the shape of `src/lib/callQuery.ts` — same rules, same messages, separate file. Not a shared parser: that file's contract carries `page`/`limit`/`truncated`, this one carries a resolved range, and one parser describing two contracts hands each the other's.
3. Return `{ from, to }` as resolved `Date`s, always non-null, so no aggregate has to branch on an open range.
4. Commit: `feat: parse analytics date ranges`.

### Task 4: Environment

**Files:** `src/lib/env.ts`, `.env.example`.

1. Add `analyticsSyncEnabled`, `analyticsSyncIntervalMs` (default 300000, floor 60000), `analyticsSyncMaxPages` (default 20, floor 1), `analyticsSyncOverlapMins` (default 10, floor 0), `analyticsRefreshRateLimitMax` (default 4, floor 1), through the existing `count()` helper so a malformed value fails at boot.
2. `ANALYTICS_SYNC_ENABLED` is a boolean: `'true'` (case-insensitive) enables, anything else does not. Default off, including in tests.
3. Mirror all five into `.env.example` with the reasoning.
4. Test in `test/env.test.ts`? **No** — write `test/analytics-env.test.ts` instead. Editing the existing env test file buys a rebase conflict for nothing.
5. Commit: `feat: add analytics sync configuration`.

### Task 5: Ingest — mapping

**Files:** `src/services/analyticsIngest.ts` (mapping half), `test/analytics-mapping.test.ts`.

1. Failing tests, adapter mocked with `vi.mock`:
   - a call whose `agent_id` matches an agent assigned to workspace A maps to A;
   - a call whose `agent_id` matches an **unassigned** agent maps to `NULL`;
   - a call with a valid correlation key maps to the campaign's workspace and stores `campaignId`;
   - a correlation key naming a real campaign but a contact **not on it** maps to `NULL` — the two-factor check;
   - a correlation key with our prefix and the wrong shape maps to `NULL`;
   - a call matching neither leg maps to `NULL` and is still stored;
   - **campaign leg beats agent leg** when the two name different workspaces.
2. Implement `resolveAttribution(rows)` returning a per-row `{ workspaceId, campaignId, agentId }`, building both maps once per page. Reuse `parseCorrelationId` unchanged — do not re-implement the parser.
3. Commit: `feat: map platform calls to workspaces for analytics`.

### Task 6: Ingest — the walk

**Files:** `src/services/analyticsIngest.ts` (walk half), `test/analytics-ingest.test.ts`.

1. Failing tests:
   - a first pass with no cursor ingests every row of a stubbed listing and sets `lastStartedAt` / `coverageFrom`;
   - **idempotency**: running the same stubbed page twice leaves the same row count and updates rather than duplicates;
   - a second pass stops early once the page falls below the high-water mark, and does not read further pages;
   - the overlap window re-reads rows just under the mark;
   - the page budget bounds the pass and sets `lastRunTruncated`;
   - an ascending listing disables the early exit rather than stopping on page one;
   - a volatile field (status → completed, duration) is refreshed on re-ingest;
   - **attribution is not moved**: a row stored for workspace A, re-ingested while its agent now maps to B, stays A;
   - a row stored with `NULL` is repaired when its agent is later assigned;
   - re-entrancy: two concurrent `runAnalyticsSync()` calls perform one walk.
2. Implement. Per page: read existing rows by `upstreamCallId`, then one `$transaction` of upserts whose `update` branch includes attribution only where the stored `workspaceId` is null.
3. Commit: `feat: incrementally ingest platform calls into the fact table`.

### Task 7: Sync startup guard

**Files:** `src/server.ts` (one line), `test/analytics-sync-startup.test.ts`.

1. Failing test: building the app via `createApp()` starts no analytics timer; `startAnalyticsSync()` is a no-op until called; the source of `src/app.ts` contains no `startAnalyticsSync` reference. Same shape as the existing renewal-sweep guard, in its **own file** — do not edit `test/renewal-sweep-startup.test.ts`.
2. Add `startAnalyticsSync(...)` to `server.ts`, gated on `env.analyticsSyncEnabled`.
3. Commit: `feat: start the analytics sync from the server entry point only`.

### Task 8: Aggregation service

**Files:** `src/services/analytics.ts`, `test/analytics-service.test.ts`.

1. Failing tests: totals over a seeded fact table; the answer-rate numerator and denominator; a dense daily series with zero-filled gaps; the per-campaign rollup excluding campaigns with no calls; range edges (a call at exactly `from`, one at exactly `to`, one a millisecond outside); `NULL`-workspace rows counted by nobody; `metered: false` and a null credits total.
2. Implement `workspaceOverview(workspaceId, range)` and `campaignAnalytics(workspaceId, campaignId, range)`. `groupBy` where it expresses the query; `$queryRaw` with `Prisma.sql` bound parameters for the `date_trunc` daily buckets — **never** string interpolation of a workspace id.
3. Funnel counts come from `CampaignContact` (contacts, attempted = `attempts > 0`, completed = status `COMPLETED`) and connected from `CallRecord`; the attempt distribution is a `groupBy` on `attempts`.
4. Commit: `feat: aggregate call facts into workspace and campaign reports`.

### Task 9: CSV export

**Files:** `src/services/analyticsExport.ts`, `test/analytics-export.test.ts`.

1. Failing tests: header row; one row per fact in range; keyset paging across a page boundary with rows sharing a `startedAt`; a cell containing a comma, a quote and a newline round-trips; **a leading `+` phone number and a leading `=` value are neutralised**; another workspace's rows are absent.
2. Implement `streamWorkspaceCsv(workspaceId, range, write)` — a generator or a write callback, so the route owns the response and the service owns the rows. Keyset on `(startedAt, id)` with the scope folded into the same `where`.
3. Commit: `feat: stream a workspace's call facts as CSV`.

### Task 10: Routes

**Files:** `src/routes/analytics.routes.ts`, one line in `src/app.ts`, `test/analytics-routes.test.ts`, `test/analytics-isolation.test.ts`.

1. Failing tests in `analytics-routes.test.ts`: each route's happy path and payload shape; the resolved range echoed; a bad range 400s; the CSV's content type, BOM and disposition; refresh is ADMIN (a MEMBER gets 403) and rate limited.
2. Failing tests in `analytics-isolation.test.ts` — **the non-negotiable file**:
   - a non-member gets 403 on all four routes;
   - workspace A's overview counts none of B's calls;
   - A reading B's campaign analytics is **404**, identical to a nonexistent id;
   - A's export contains none of B's rows;
   - a quarantined (`NULL`) row appears in no workspace's numbers;
   - a forged `client_reference_id` naming B's campaign with a contact that is not on it lands quarantined, not on B's chart.
3. Implement the routes. Mount with one line in `app.ts`: `app.use('/api/workspaces', analyticsRoutes);`, beside the existing workspace mounts.
4. Commit: `feat: expose workspace and campaign analytics routes`.

### Task 11: Documentation

**Files:** `CLAUDE.md`.

1. Add an `## Analytics` section: the two models, the ingest's two legs and the attribution rules, the classifier, the four routes, the credits position, and the deliberate gaps.
2. Commit: `docs: describe the analytics surface`.

---

## Verification before the branch is called done

- `npm test` green; re-run any failing file in isolation several times before concluding this branch broke it — the suite has known cross-file bleed.
- `npm run build` clean.
- `git log --oneline` reads as a sequence of small imperative steps on `feat/analytics` only.
