# Campaign parity — backend implementation plan

> **For Claude:** execute task-by-task with the design doc (`2026-08-28-campaign-parity-design.md`) open. TDD: every task starts with a failing test. One commit per task (or per coherent step inside a task), imperative mood. Run the full suite (`npm test`) and `npm run build` at every checkpoint. The suite occasionally flakes on cross-file bleed — re-run a failing file in isolation (`npx vitest run test/<file>`) before treating a failure as real.

**Goal:** implement Phase 1 of the campaign-parity design.

**Architecture:** extend the existing sweep dispatcher, webhook pipeline and campaign routes in place. New pure modules for lane budgets, callback parsing/rolling, retry policy validation. One schema migration wave up front, then features in dependency order.

**Conventions:** all work workspace-scoped; 404 for cross-workspace; no Prisma `cursor` pagination; adapter always mocked in tests; migrations follow the `NOT VALID` + separate `VALIDATE` style with `SET lock_timeout = '3s'` where they add FKs to hot tables.

---

## Checkpoint A — schema and validators

### Task 1: migration wave

**Files:** `prisma/schema.prisma`, new migration(s), `test/migration-parity.test.ts` (data-shape assertions via a seeded row).

- Campaign: add `description`, `retryConcurrency`, `retryDelaysMinutes Int[] @default([])`, `callbackEnabled Boolean @default(true)`, `variableMap Json?`, `stoppedAt`, `scheduledStartAt`, `scheduleError`, `rrCursor Int @default(0)`, `totalContacts`/`completedCount`/`failedCount`/`skippedCount Int @default(0)`, `startedAt`/`pausedAt`/`completedAt DateTime?`; rename `concurrency`→`concurrencyLimit`, `maxAttempts`→`retryCount` (data: `LEAST(GREATEST(max_attempts-1,0),20)`), `retryDelayMins`→`cooldownMinutes` (data: clamp 0→1). Add `CREDIT_EXHAUSTED` to `CampaignStatus`, `SKIPPED` to `CampaignContactStatus`. Index `[status, scheduledStartAt]`.
- CampaignContact: add `nextEligibleAt`, `callbackAt`, `callbackCount Int @default(0)`, `lastSessionId`, `disposition`, `answeredBy`; data: `attempts = GREATEST(attempts-1,0)`; backfill `nextEligibleAt` for retry-waiting rows (`FAILED` with attempts ≤ retryCount → status `PENDING`, `nextEligibleAt = lastAttemptAt + cooldownMinutes`); indexes `[campaignId, status, nextEligibleAt]`, `[campaignId, callbackAt]`, partial callback-claim index (raw SQL).
- CampaignPhoneNumber: new model + backfill one row at position 0 per campaign with `phoneNumberId`.
- Contact: `email String?`, `tags String[] @default([])`.
- CallAttempt: `@@unique([campaignContactId, attemptNo])`, `fromNumber`, `resolvedAt`; make `campaignId`/`campaignContactId` nullable `onDelete: SetNull` (NOT VALID + VALIDATE pattern). Backfill `resolvedAt = endedAt` for terminal rows, and campaign counters (`totalContacts` etc.) from live data.
- Rename note: use `ALTER TABLE … RENAME COLUMN` in hand-edited migration SQL (Prisma will otherwise drop/create). Verify with a before/after seeded test.

**Step order:** write the migration-shape test (seed old-shape via raw SQL against a scratch schema is overkill — instead assert post-migration invariants on freshly created rows + a raw-SQL seeded legacy row) → `npx prisma migrate dev` → `npx prisma generate` → fix all compile errors from the renames across `src/` and `test/` (mechanical: `concurrency`→`concurrencyLimit`, `maxAttempts`→`retryCount`, `retryDelayMins`→`cooldownMinutes`) **keeping existing behaviour semantically identical for now** (eligibleWhere: `attempts < maxAttempts` becomes `attempts <= retryCount`; claim's `attemptNo: attempts+1` becomes MAX+1 in Task 6) → full suite green → commit(s): `feat: add campaign parity columns and models`, `refactor: rename campaign retry and concurrency fields`.

### Task 2: retry/concurrency/callback/variableMap validators

**Files:** `src/lib/campaignConfig.ts` (new), `test/campaign-config.test.ts`.

Pure functions with the exact reject/clamp semantics and error strings from design §3/§2: `validateRetryConfig` (retryCount [0,20] reject; cooldownMinutes [1,10080] reject; ladder ≤20, entries [0,10080] reject; no string coercion), `validateConcurrencyUpdate` (integer reject → clamp [1,10]; retryConcurrency [0,mergedLimit] reject; cross-field lowering rejection), `validateCallbackEnabled` (strict boolean), `validateVariableMap` (flat object; values `^[a-zA-Z_][a-zA-Z0-9_]*$`; null = clear). Commit: `feat: add campaign config validators`.

### Task 3: PATCH gains the new fields (DRAFT-scope only for now)

**Files:** `src/routes/campaigns.routes.ts`, `test/campaigns.test.ts` additions.

Wire description/concurrencyLimit/retryConcurrency/retryCount/cooldownMinutes/retryDelaysMinutes/callbackEnabled/variableMap + `phoneNumberIds` (ordered array, ≤20, dedupe reject, each number usable in this workspace; replaces join rows in a transaction; keeps legacy `phoneNumberId` = first). POST create accepts the same. Mid-campaign gates come in Task 12 — for now keep the existing `CONFIG_MUTABLE` behaviour for old fields and allow new fields on the same statuses. Commit: `feat: accept campaign parity config on create and update`.

**Checkpoint A ends:** full suite + build green.

## Checkpoint B — dispatcher lanes and rotation

### Task 4: `computeLaneBudgets`

**Files:** `src/lib/laneBudgets.ts`, `test/lane-budgets.test.ts`. Port exactly (design §5.1) with property tests: reservation holds across passes, never negative, cap by accountRemaining, limit-below-live → 0. Commit.

### Task 5: single-statement claim SQL

**Files:** `src/services/dialerClaim.ts` (new), `test/dialer-claim.query.test.ts` (real Postgres).

`claimContacts(campaignId, limit, lane, retryCount)` with lanes `fresh|retry|callback|any`, the armed-callback predicate, `nextEligibleAt` gate, budget guard with callback exemption, per-lane ordering, `FOR UPDATE SKIP LOCKED`, status flip `PENDING→QUEUED` + `lastAttemptAt` in the same statement, returning claimed ids + contact fields. Tests: lane filters; due vs future callbacks; equality predicate with stale history; concurrent double-claim safety (two parallel transactions); budget exemption for armed callbacks; limit 0 short-circuit. Commit.

### Task 6: dispatcher integration — lanes, rotation, stored eligibility

**Files:** `src/services/dialer.ts`, `src/services/dialerNumbers.ts` (new), `test/dialer-sweep.test.ts`, `test/dialer-launch.test.ts`, `test/dialer-rotation.test.ts`.

- Replace `eligibleWhere` + CAS claim with lane passes over Task 5's claim (callback → reserved retry → fresh → borrow with proven-dry skip; shared pool when `retryConcurrency = 0`), budgets from Task 4 fed by the existing four-cap arithmetic.
- Attempt rows: `attemptNo = MAX(attemptNo)+1` (unique-constraint backed), created pre-dial in a transaction as today; stamp `fromNumber`.
- Rotation: `loadCampaignDialNumbers` (position order, usable only), hold-when-attached-but-none-usable, legacy fallback, `rrCursor` batch advance, per-dial pick.
- `rollbackLaunch` updated: give-back sets status `PENDING` (never touching `attempts` — it no longer counts dials) and preserves the invariant in both directions (three-guarded-updates shape, design §5.2/§10-tests).
- CREDIT_EXHAUSTED: the low-balance gate now writes that status.
- Completion pass: lock campaign `FOR UPDATE`, count PENDING+QUEUED, RUNNING→COMPLETED (+`completedAt`) only under the lock.
Commits per coherent step.

**Checkpoint B ends:** full suite + build green.

## Checkpoint C — resolution and callbacks

### Task 7: resolution rewrite

**Files:** `src/services/dialerOutcome.ts`, `test/dialer-outcome.test.ts`, `test/webhooks.test.ts`.

- Normalised disposition/answeredBy copied to the contact; retry classification (design §4.1); budget at resolution (`attempts + 1 <= retryCount`); delay indexing `retryDelaysMinutes[attempts] ?? cooldownMinutes` (0-based on the pre-increment count = design's 1-based rule); re-arm to `PENDING` with `attempts+1`, `nextEligibleAt`, `lastSessionId`, **callbackAt untouched**; permanent vs terminal-failure branches; counter increments in-transaction; race-lost drops everything. Charging/idempotency (WebhookEvent-in-transaction) unchanged. Set `resolvedAt` on the attempt.
Commit: `feat: port retry ladder and stored eligibility into resolution`.

### Task 8: callback parsing + rolling

**Files:** `src/lib/callbackTime.ts`, `test/callback-time.test.ts`. `parseCallbackAt` (all rejection reasons, offset forms incl. bare `±HH`, naive-in-campaign-tz, date-only rejected, 60s/90d bounds) and `rollIntoDialWindow` against the campaign's own window (forward-only, DST-correct, month/year rollover, open-window no-op, corrupt-zone fallback-to-unrolled). Commit.

### Task 9: booking engine

**Files:** `src/services/campaignCallback.ts`, `test/campaign-callback.test.ts`.

`scheduleCampaignCallback` per design §6.3 (lock order, stoppedAt refusal incl. the stop→complete regression test, status gate, cap 3, the invariant write, attempts untouched, counter give-back, COMPLETED→RUNNING re-open, race → NOT_RESOLVED). Wire into the webhook path after `applyTerminalOutcome` (read `data.extraction.values.callback_requested_at ?? .callback_at`, only for campaign-correlated attempts, own try/catch, single outcome log line). Also handle the reaper path (a reconciled call's extraction is available on `GET /calls/:id` → read it there when present). Commit(s).

### Task 10: extraction-key attachment at start

**Files:** `src/adapter/vocobase.ts` (add extraction-set wrappers: list/create set, attach to agent, read/update agent extraction_enabled), `src/services/campaignExtraction.ts`, `test/campaign-extraction.test.ts` (adapter mocked).

Idempotent `ensureCallbackExtractionKey(agentExternalId)`: find-or-create the `EZO campaign callbacks` set with the `callback_requested_at` datetime key, attach (tolerate already-attached), ensure `extraction_enabled`. Called from start/resume when `callbackEnabled`; failures log + notify, never block. Commit.

**Checkpoint C ends:** full suite + build green.

## Checkpoint D — lifecycle

### Task 11: stop / complete / delete / duplicate

**Files:** `src/routes/campaigns.routes.ts`, `src/lib/campaignLifecycle.ts` (new helpers), tests in `test/campaign-lifecycle.test.ts`.

Stop (sweep + stoppedAt, from DRAFT/SCHEDULED/RUNNING/PAUSED/CREDIT_EXHAUSTED), complete (STOPPED-only relabel, 409 live / 409 race), delete (any status, history survives — assert CallAttempt rows remain with null pointers), duplicate (copy-by-omission, re-validate, re-clamp, `(Copy)` naming, empty contacts, nested create). Commits per action.

### Task 12: mid-campaign edit gates

**Files:** `src/routes/campaigns.routes.ts`, `src/lib/campaignTopup.ts` (`isAdditiveVariableMapUpdate`), `test/campaign-edit-gates.test.ts`.

DRAFT-everything / PAUSED+CREDIT_EXHAUSTED-retry+callback-only (400 naming locked fields) / additive-variableMap single-key path (any non-stopped status) / retryCount-supplied → SKIPPED sweep under the campaign lock with counter increment and armed-callback exemption. Commit.

### Task 13: top-up

**Files:** `src/routes/campaigns.routes.ts`, `src/lib/campaignTopup.ts`, `test/campaign-topup.test.ts`.

JSON endpoint (contactIds | tagFilter | selectAll+search, caps, warnings), core transaction per design §7.4, CSV upload path routed through the same core and its status restriction lifted (any non-stopped status; `totalContacts` maintained). Contact library endpoints gain `email`/`tags` handling in CSV parsing (`tags` split on `[;,|]`). Commit(s).

### Task 14: scheduler

**Files:** `src/services/campaignStart.ts` (extract the start routine from the route), `src/services/scheduleScanner.ts`, `src/server.ts`, `src/lib/env.ts` (`SCHEDULE_SCAN_MS`, default/floor 30000), `test/campaign-schedule.test.ts`.

Schedule/cancel-schedule routes; scanner semantics (DRAFT-guarded refusal write, no-retry on refusal, retry on throw, batch 20, per-campaign try/catch). Commit(s).

**Checkpoint D ends:** full suite + build green.

## Checkpoint E — read surface

### Task 15: queue filters on the contacts list

**Files:** `src/routes/campaigns.routes.ts`, `test/campaign-queues.test.ts`. `?queue=` predicates with null-arms, orderings, AND-composition with `?status=`, 400 on bad values. Include contact identity fields. Commit.

### Task 16: journey endpoint

**Files:** `src/routes/campaigns.routes.ts` or `src/services/campaignJourney.ts`, `test/campaign-journey.test.ts`. Events (attempt/cooldown/callback_due), inFlight, `attemptsRecorded` honesty flag, `scheduledMinutes` nulled once `callbackCount > 0`, 404 shape, 200-attempt cap, `hasRecording` without minting URLs. Commit.

### Task 17: stats + list outcomes

**Files:** `src/routes/campaigns.routes.ts`, `test/campaign-stats.test.ts`. Nine-disposition zero-fill, callbacksPending, avg duration, ledger-sourced credits; list `outcomes` aggregate (three grouped queries, partition property asserted). Commit.

### Task 18: docs + wrap-up

Update `CLAUDE.md` (routes table, schema notes, worker list + scanner), re-run everything, fix flakes, leave the tree clean.

**Checkpoint E ends Phase 1.** Stop for review before Phase 2 (dashboard) begins.

---

## Phase 3 (backend part, after Phase 2)

- **variableMap in the dispatcher:** when `variableMap` is set, per-call variables = `{ mappedVariable: String(metadata[csvColumn] ?? '') }` (missing → empty string), replacing the legacy agent-declared projection for that campaign; legacy projection stays for `variableMap = null`. Tests: mapping, missing values, null passthrough.
- **Lead buckets:** `leadBucketKey String?` + `wonBuckets String[] @default([])` on Campaign (bucket-only edits allowed in every status); computed at read time from stored extraction values (coordinate with the analytics wave's extraction storage — if per-call extraction is not yet persisted YE-side, land a `CallAttempt.extraction Json?` capture from the webhook first). Stats/list gain bucket counts.
