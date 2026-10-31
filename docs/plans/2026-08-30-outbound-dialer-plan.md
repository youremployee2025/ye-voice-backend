# Outbound Calling Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a RUNNING campaign dial its contacts through the voice platform, record every attempt, close it from webhooks, and charge the workspace owner for the minutes — behind four independent safety controls, as described in `2026-08-30-outbound-dialer-design.md`.

**Architecture:** One additive migration adds `CallAttempt`, `WebhookEvent`, `Campaign.concurrency`, `Account.concurrencyLimit`, `Agent.voiceTierSlug`, `CreditTransaction.callAttemptId` and two `CreditTransactionType` values. `src/services/dialer.ts` is an interval sweep modelled on `src/services/didRenewal.ts`, started from `server.ts` and never from `createApp()`. `src/lib/concurrency.ts` owns allotment resolution. `src/lib/dialingWindow.ts` owns window evaluation. `src/routes/webhooks.routes.ts` receives outcomes on a raw body, mounted outside `/api`. `src/lib/webhookSignature.ts` verifies them. The adapter gains three upstream calls and two status passthroughs. The dashboard's Stats tab becomes live; the admin console gains `/concurrency`.

**Tech Stack:** Express 4, TypeScript, Prisma 6, Zod 4, Vitest + Supertest (backend). Next.js 15 App Router, React 19, Tailwind 4, Vitest + Testing Library (dashboard, admin).

**Worktrees:** `.worktrees/outbound-dialer/{ye-voice-backend,ye-voice-dashboard,ye-voice-admin}`, all on `feat/outbound-dialer`.

**Ports:** backend **:3023**, dashboard **:3024**, admin **:3025**. Backend `.env` points at `ye_voice_dialer` (dev) and `ye_voice_test_dialer` (test); dashboard and admin `.env.local` point at `:3023`.

---

## Rules that apply to every task

1. **No test places a call.** Every test mocks `src/adapter/vocobase.ts` with `vi.mock`. The suite must pass with the real adapter module unloaded. This is not a convention — it is the reason the suite may be run at all.
2. **`DIALER_ENABLED` defaults to false.** The sweep is not started, `start`/`resume` refuse, and the module is inert. `test/setup.ts` sets it to `'true'` so the rest of the suite exercises the real paths against a mocked adapter; `test/dialer-disabled.test.ts` overrides it to `'false'` before importing the app, the way `admin-rate-limit.test.ts` overrides its cap.
3. **Money moves only under a conditional write** paired with a ledger row in one `$transaction`. Never read-then-write. `src/lib/credits.ts` is the only place the multiplier appears.
4. **Unknown is not zero.** An unresolvable rate refuses the launch. An unset concurrency allotment falls back to the env default via `??`, never `||`.
5. **In-flight is counted, never stored.**
6. **Dispositions and upstream statuses are free text.** Never an enum, never validated against a list.
7. **Customer-facing strings say "the voice platform"**, never Vocobase, VoiceLink, or a carrier name.
8. **The upstream write at campaign start runs last**, after every local gate.
9. Small commits — one migration, one library, one service, one route group, one component group per commit.

**Migration safety:** generated with `--create-only`, applied to this worktree's dev and test databases, **shown to the user and held**. Not applied to production. No existing migration file is edited or reordered.

**Upstream safety:** no test, and no development run, may reach the live account. The only new upstream calls are `POST /calls/start`, `POST /voicelink/call-ready`, `GET /calls/concurrency` and the existing `getCall`. No webhook endpoint is registered against the live account without the user's explicit go-ahead.

---

# Backend

## Task 1: The schema

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260830090000_outbound_dialer/migration.sql`, `test/setup.ts`

**Step 1 — models.** Add `CallAttemptStatus` and `CallAttempt` exactly as the design gives them, with the doc comments explaining why `accountId` and `rateCreditsPerMin` are snapshots and why the non-terminal set matches the platform's `statuses_counted`. Add `WebhookEvent`. Add the five column/enum additions.

Relations: `CallAttempt.campaign → Campaign` (Cascade — an attempt has no meaning without its campaign), `CallAttempt.campaignContact → CampaignContact` (Cascade, same), `CreditTransaction.callAttempt → CallAttempt` (**Restrict**, matching all three existing ledger FKs: an append-only ledger cannot lose the referent of a charge).

**Step 2 — migration.** `npx prisma migrate dev --create-only --name outbound_dialer`. Read the generated SQL and confirm it is purely additive: `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN` with defaults or nullable, `ALTER TYPE ... ADD VALUE`. Any `DROP`, any `ALTER COLUMN ... SET NOT NULL` on an existing table, or any rewrite is a bug in this task.

> `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older Postgres and cannot be used in the same transaction as a statement referencing the new value. Split the enum additions into their own statements ahead of everything else, and verify the migration applies to a fresh database.

**Step 3 — apply** to dev and test (`migrate deploy` / `npm run test:prepare`). **Show the SQL to the user and stop for confirmation before continuing past this task.**

**Step 4 —** add `CallAttempt` and `WebhookEvent` to the `TABLES` reset list in `test/setup.ts`, child-first: `WebhookEvent` anywhere, `CallAttempt` **after** `CreditTransaction` and **before** `CampaignContact`.

**Verify:** `npx prisma generate`, `npx tsc --noEmit`, `npm test` still green.

**Commit:** `feat: record every call attempt a campaign makes`

---

## Task 2: `src/lib/concurrency.ts`

**Test first** (`test/concurrency.test.ts`):
- `resolveAccountConcurrency` returns the account's own limit when set.
- Returns the env default when null.
- **Returns `0` when the account's limit is `0`** — the `??`-not-`||` case. This test is the reason the module exists; write it first and watch it fail against a `||` implementation.
- Negative or non-integer env value is a boot failure (covered in Task 3's env test).

**Implement:** `resolveAccountConcurrency(account: { concurrencyLimit: number | null }): number`, plus `countInFlight` helpers taking a `PrismaClient | TransactionClient`:
- `campaignInFlight(tx, campaignId)` and `accountInFlight(tx, accountId)`, both `count` over `status: { in: NON_TERMINAL_ATTEMPT_STATUSES }`.
- Export `NON_TERMINAL_ATTEMPT_STATUSES` as the single definition.

**Commit:** `feat: resolve how many lines an account may use at once`

---

## Task 3: Environment

**Test first** (extend `test/env.test.ts`): each new variable's parse failure is a boot error naming the variable; `DIALER_TEST_ALLOWLIST` with a malformed number throws; a valid list canonicalizes (`+91 98765 43210` and `+919876543210` collapse to one entry).

**Implement** in `src/lib/env.ts`, following the existing helpers:

```
DIALER_ENABLED                        flag,   default false
DIALER_SWEEP_MS                       count,  default 60_000,  floor 60_000
DIALER_MAX_CALLS_PER_SWEEP            count,  default 25,      min 1
DIALER_DEFAULT_ACCOUNT_CONCURRENCY    count,  default 2
DIALER_MIN_BALANCE_CREDITS            creditAmount, default "1"
DIALER_ATTEMPT_TIMEOUT_MINS           count,  default 60,      min 1
DIALER_TEST_ALLOWLIST                 e164List, default []
VOCOBASE_WEBHOOK_SECRET               secret(32), default ''
```

Two new helpers beside the existing ones:
- `flag(name, fallback)` — accepts only `'true'`/`'false'` (case-insensitive) or empty. Anything else throws. A safety switch that reads `DIALER_ENABLED=yes` as false is a switch that is off when the operator believes it is on; a switch that reads it as true is worse.
- `e164List(name)` — splits on commas, trims, drops empties, runs each through `canonicalizeE164`, throws naming the offending entry. Returns a `ReadonlySet<string>`.

Add all eight to `.env.example` with the reasoning, matching the existing entries' tone.

**Commit:** `feat: configure the dialer's safety controls`

---

## Task 4: `src/lib/dialingWindow.ts`

**Test first** (`test/dialing-window.test.ts`), with an injected `now`:
- Both ends null → open at every hour, whatever the timezone.
- `09:00`–`17:00` in `Asia/Kolkata` → open at 10:00 IST, closed at 08:00 IST, closed at 17:00 IST (end exclusive).
- The same window evaluated for a `now` that is 10:00 IST but 04:30 UTC → open. This is the test that fails if the implementation reads the server's clock.
- `21:00`–`06:00` → open at 23:00 and at 02:00, closed at 12:00. Overnight windows wrap.
- One end set without the other → `{ state: 'incomplete', reason }`.
- Both ends set with no timezone → `{ state: 'incomplete', reason }`.
- An unknown IANA zone → `incomplete`, not a throw.

**Implement:** `evaluateWindow(campaign, now): { state: 'open' } | { state: 'closed', opensAt } | { state: 'incomplete', reason }`.

Use `Intl.DateTimeFormat(undefined, { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now)` — no new dependency. Validate the zone by constructing the formatter inside a `try`.

`opensAt` is for the dashboard's "next dials at" copy; compute it as the next occurrence of `fromTime` in the campaign's zone.

**Commit:** `feat: decide when a campaign's dialing window is open`

---

## Task 5: Adapter

**Test first** (`test/upstream-dialer.test.ts`), stubbing `fetch`:
- `startCall` posts to `/calls/start` and returns the 201 `data`.
- A 429 response throws `ApiError` with status 429 and code `UPSTREAM_RATE_LIMITED`.
- A 403 throws status 403, code `UPSTREAM_FORBIDDEN`.
- Neither message repeats upstream's wording, and neither mentions the supplier.
- A 400 still surfaces as `VALIDATION_ERROR` (unchanged).
- A network failure on `startCall` still yields `UPSTREAM_WRITE_UNCONFIRMED` (unchanged — this is a non-GET).
- `getConcurrency` reads `/calls/concurrency` and passes `limit: null` through as null rather than coercing to 0.

**Implement** in `src/adapter/vocobase.ts`:
- Extend `unwrap` with the two passthroughs. Add them beside the existing 400/404/409 branches with a comment saying why each is distinguishable rather than generic.
- `startCall(body: StartCallBody): Promise<StartCallResponse>`
- `voicelinkCallReady(body: { did_number: string }): Promise<CallReadyResponse>`
- `getConcurrency(): Promise<ConcurrencyResponse>`

Read every response field through `src/lib/upstream.ts`, which tolerates both spellings and yields null rather than throwing.

**Commit:** `feat: place a call, ready a number, and read the shared line pool`

---

## Task 6: Correlation gains an attempt

**Test first** (extend `test/call-correlation.test.ts`):
- A three-segment key still parses, with `attemptId: null`. **This is the regression guard for the shipped calls surface** — write it before touching the module.
- A four-segment key parses all three ids.
- Five segments → null.
- `formatCorrelationId(a, b)` → three segments; `formatCorrelationId(a, b, c)` → four.
- A four-segment key with an empty final segment → null.

**Implement:** widen `parseCorrelationId` to accept 3 or 4 parts and add the optional third argument to `formatCorrelationId`. Update the module's doc comment: the "nothing stamps it yet" paragraph is now false and must say what stamps it and why the fourth segment exists.

**Commit:** `feat: key a correlation id to one attempt, not one contact`

---

## Task 7: Pricing a call

**Test first** (`test/dialer-pricing.test.ts`):
- Agent with a known tier slug → the account's override rate.
- Agent with a slug the mirror does not know → the default tier's rate.
- Agent with a null slug → the default tier's rate.
- No default tier and an unknown slug → `TierRateUnavailableError`.
- A tier priced `0` → `0n`, not the default. (Again the `??` case, one layer up.)

**Implement** `resolveCallRate(accountId, agent)` in `src/lib/dialerPricing.ts`: resolve `Tier` by `agent.voiceTierSlug`, fall back to `findFirst({ isDefault: true, status: 'ACTIVE' })`, then delegate to `resolveTierRate`. **Do not reimplement the precedence chain** — `tierPricing.ts` owns it; this module only chooses which tier to ask about.

Also add `chargeFor(rate, durationSecs): bigint` — `(rate * BigInt(durationSecs)) / 60n`, truncating, with the comment stating the bound on the loss.

**Commit:** `feat: price a minute of calling for one campaign's agent`

---

## Task 8: `agentSync` writes the voice's tier

**Test first** (extend `test/agent-sync.test.ts`): a synced agent whose voice carries `tier: "va-1"` stores `voiceTierSlug: "va-1"`; a voice with no tier stores null; a voice id absent from the catalogue stores null rather than the voice id.

**Implement:** `loadVoiceNames` already builds a map from the catalogue. Widen it to `loadVoiceFacts` returning `{ name, tier }` per voice id, and have `cachedFields` write both. One extra field, no extra request.

**Commit:** `feat: record which tier an agent's voice is sold in`

---

## Task 9: The sweep

The largest task. Write it in four commits, each with its tests first.

### 9a — claiming and eligibility

`test/dialer-claim.test.ts`:
- A `PENDING` contact with no attempts is eligible.
- A `FAILED` contact with `attempts < maxAttempts` and `lastAttemptAt` older than `retryDelayMins` is eligible; one inside the delay is not; one at `maxAttempts` is not.
- `EXCLUDED`, `COMPLETED` and `QUEUED` are never eligible.
- Two concurrent claims of one contact: exactly one succeeds (`updateMany` count 1 and 0).
- A claim increments `attempts` and sets `lastAttemptAt`.

### 9b — the pass, without launching

`test/dialer-sweep.test.ts`, with `runDialerSweep({ now, ... })` injectable like `runRenewalSweep`:
- Disabled → returns an inert result and makes no upstream call at all (assert the adapter mock was never called).
- A campaign whose agent has been unassigned → PAUSED + notification, nothing dialled.
- Same for a released DID.
- A closed window → skipped, **not** paused, and still RUNNING.
- An incomplete window → PAUSED with a notification naming the field.
- Owner balance below the float → PAUSED, `ADMINS_ONLY` notification.
- A failed `getConcurrency` → nothing launched, nothing paused.
- `remaining: null` (unlimited) → the pass proceeds, bounded by the other caps.
- Slots respect the narrowest of the four caps: a table-driven test over `(campaignCap, accountCap, platformRemaining, sweepBudget)`.
- Least-recently-dialled ordering: two campaigns, one with a recent attempt, the other picked first.
- Allowlist: a contact not on it is skipped, stays `PENDING`, is counted, and is **not** marked `EXCLUDED`.

### 9c — launching, and the failure branches

`test/dialer-launch.test.ts`, one case per row of the design's failure table:
- Success → attempt gets `upstreamCallId`/`upstreamSessionId`, contact stays `QUEUED`.
- 400 → contact `FAILED`, attempt kept, `launchError` recorded, pass continues.
- 502 → contact `PENDING`, `attempts` back to its prior value, pass continues.
- 429 → contact `PENDING`, attempts restored, **pass halts** (a second campaign in the same pass is untouched).
- 403 → same rollback, pass halts, and the result flags it distinctly from 429.
- `UPSTREAM_WRITE_UNCONFIRMED` → contact and attempt both stay `QUEUED`.
- The launch body: `client_reference_id` has four segments; `variables` contains only keys the agent declares; `from_number` is the campaign's DID; `provider` is `voicelink`.

### 9d — completion and the reaper

`test/dialer-reaper.test.ts`:
- A campaign with an empty eligible pool and zero in-flight → COMPLETED + notification.
- The same campaign with one in-flight attempt → still RUNNING.
- Two concurrent passes → exactly one completion notification (the conditional `updateMany`).
- A stale attempt whose `getCall` reports a terminal call → closed and charged from that payload.
- A stale attempt `getCall` does not know → `ABANDONED`, contact `FAILED` with retry scheduling, no charge.
- A stale attempt still live upstream past the timeout → `ABANDONED`.

**Implement** `src/services/dialer.ts` with `runDialerSweep(options)` and `startDialerSweep(periodMs)`, mirroring `didRenewal.ts` — re-entrancy guard, `unref`, one pass at boot, a logged result, per-campaign error isolation so one workspace's failure cannot stop the platform.

**Commits:** `feat: claim a campaign's next contact for dialing`, `feat: sweep running campaigns within every line limit`, `feat: place a campaign's calls and record what happened`, `feat: complete finished campaigns and close attempts nobody reported`

---

## Task 10: Wire the sweep into `server.ts`

**Test first** — extend `test/renewal-sweep-startup.test.ts` into `test/sweep-startup.test.ts` (or add a sibling): `createApp()` starts no interval, and `src/app.ts` contains neither `dialer` nor `startDialerSweep`. The renewal assertions stay exactly as they are.

**Implement:** in `server.ts`, `if (env.dialerEnabled) startDialerSweep(env.dialerSweepMs);` with the comment saying why it is here and not in `createApp()`, and a startup log line stating whether the dialer is on, how large the allowlist is, and the per-sweep cap. An operator must be able to read the first ten lines of the log and know whether this process can ring a phone.

**Commit:** `feat: start the dialer sweep only when it is switched on`

---

## Task 11: Campaign start reaches the platform

**Test first** (`test/campaign-start-gates.test.ts` + updates to `test/campaign-lifecycle.test.ts`):
- Disabled → 409 `DIALER_DISABLED`, and **no upstream call is made**.
- No caller DID → 409 `CAMPAIGN_PHONE_NUMBER_REQUIRED`.
- Unresolvable rate → 409 `CAMPAIGN_RATE_UNAVAILABLE`.
- Balance below the float → 402 `INSUFFICIENT_CREDITS`.
- Incomplete window → 409 `CAMPAIGN_WINDOW_INCOMPLETE`.
- `call-ready` returning `NO_CLIENT_MAPPING` → 409 `CAMPAIGN_DID_NOT_CALL_READY`, message names the step, mentions no supplier.
- `call-ready` returning only `NO_VOCOBASE_AGENT` → **starts successfully**.
- Every local gate failure makes **zero** upstream calls — assert the mock's call count is 0 for each.
- `resume` enforces the identical set.
- Existing lifecycle tests updated for the DID requirement.

**Implement:** a `assertCampaignDialable()` helper in `src/lib/campaign.ts` running the local gates, called by the transition handler before the upstream write. Map readiness codes to our own sentences in one table.

**Commit:** `feat: refuse to start a campaign that cannot actually dial`

---

## Task 12: The webhook receiver

### 12a — signature verification

`test/webhook-signature.test.ts`:
- A correctly signed body verifies.
- A body altered by one byte does not.
- A timestamp 301 seconds old does not.
- A signature of the wrong length returns false rather than throwing (the `timingSafeEqual` trap — write this test and watch it crash first).
- An unset secret rejects a validly signed request.
- A missing header rejects.

`src/lib/webhookSignature.ts`, and nothing else may verify a signature.

### 12b — the route

`test/webhooks.test.ts`:
- An unsigned request → 401, and nothing is written.
- A valid `session.completed` for an unknown session → **200**, no row, and the payload's transcript appears in no log.
- A duplicate delivery → 200, and the charge happened exactly once (assert the balance moved once and one ledger row exists).
- A `call.status.updated` with `terminal: true` closes the attempt and frees the slot.
- A non-terminal `call.status.updated` advances the status without closing.
- A malformed body → 400, not a 500.
- The route is registered before `express.json()` and receives a `Buffer`.

**Implement** `src/routes/webhooks.routes.ts`, mounted in `app.ts` before the JSON parser with `express.raw({ type: '*/*', limit: '1mb' })`.

**Commits:** `feat: verify a webhook came from the voice platform`, `feat: receive call outcomes on a signed endpoint`

---

## Task 13: Charging

**Test first** (`test/dialer-charging.test.ts`):
- 127 seconds at 1.0 credits/min → the exact truncated internal amount; assert against a hand-computed BigInt, not against the implementation's own arithmetic.
- Zero duration → no ledger row, `chargedAt` set, balance unmoved.
- The charge uses the attempt's **snapshot** rate even after the tier is re-priced between dial and webhook. This is the test that justifies the column.
- Insufficient balance → zero-amount `CALL_USAGE_SHORTFALL` row, `shortfall: true`, `costCredits` recording the debt, campaign PAUSED, `ADMINS_ONLY` notification, **balance unchanged** and never negative.
- A second `session.completed` for the same attempt cannot double-charge — assert both via the `WebhookEvent` key and, separately, by calling the charge function directly twice to prove the `reference` unique constraint catches it.
- The ledger row carries `callAttemptId` and `reference = attempt.id`.

**Implement** `chargeAttempt(tx, attempt, durationSecs)` in `src/services/dialerBilling.ts`, called inside the webhook's transaction alongside the `WebhookEvent` insert.

**Commit:** `feat: charge a workspace for the minutes its campaign used`

---

## Task 14: Progress and attempts routes

**Test first** (`test/campaign-progress.test.ts`):
- `/stats` gains `dialerEnabled`, `inFlight`, `campaignConcurrency`, `accountInFlight`, `accountConcurrency`, `window`, `spendCredits` — and keeps `total`/`byStatus` **exactly** as they are (a regression guard for the shipped Stats tab).
- `spendCredits` sums the ledger through the attempt relation, as a decimal string.
- `.../attempts` is offset-paginated, ordered by `startedAt DESC, id DESC` (the tiebreaker rule), member-readable, workspace-scoped.
- An attempt id from another workspace 404s.
- The payload never carries `upstreamCallId`, `upstreamSessionId`, or the correlation id — the calls surface's allow-list rule applies here too.

**Implement:** extend the `/stats` handler; add `GET /:workspaceId/campaigns/:campaignId/attempts`.

**Commit:** `feat: report what a running campaign is actually doing`

---

## Task 15: Staff concurrency routes

**Test first** (`test/admin-concurrency.test.ts`):
- `GET /api/admin/concurrency` returns the live pool, the total allotted, and per-account allotments.
- An upstream failure reading the pool returns the allotments with the pool marked unavailable — **not** a 502. The console must still be able to allot when the platform is unreachable.
- `PATCH /api/admin/accounts/:id/concurrency` sets, and `null` restores the default.
- A negative value → 400. A non-integer → 400.
- Allotting beyond the pool **succeeds** and the response reports the overcommit.
- Unauthenticated → 401, and the route is behind the staff limiter.

**Implement** `src/routes/admin/concurrency.routes.ts`, composed into `src/routes/admin/index.ts`.

**Commit:** `feat: allot the platform's call capacity to accounts`

---

## Task 16: Backend docs

Update `CLAUDE.md`: a new **Outbound dialing** section (the safety model, the sweep, the four caps, the failure branches, the webhook receiver, charging), plus edits to **Campaigns** (a caller DID is now required; the dialing window now has a meaning; `start` reaches upstream), **Call history** (`client_reference_id` is now stamped, so the campaign leg matches), **Voice tiers** (`metered` is now true — minutes are billed), **Credits & billing** (two new types; `didRental.ts` is no longer the only module that moves credits) and **Environment** (eight new variables).

**Commit:** `docs: record how the dialer works and what it refuses to do`

**Gate:** `npx tsc --noEmit` clean, `npm test` fully green. Per the repo's known flakiness, run the suite **three times** and treat any failure as real until reproduced clean.

---

# Dashboard

## Task 17: Live campaign progress

**Test first** (`components/campaigns/__tests__/`): each honest state from the design's table renders its own sentence; a paused-for-credits campaign renders a link to `/settings/billing`; "lines in use" renders both numbers; a closed window renders the next dial time in the campaign's zone, not the reader's.

**Implement:** rewrite `app/(dash)/campaigns/[id]/stats-tab.tsx` around the new payload. Reuse `components/calls/format.ts` and `StatusPill` for the attempts feed rather than writing a second formatter — a disposition must render identically on both surfaces.

Poll the progress endpoint while the campaign is RUNNING (a fixed interval, cleared on unmount and on workspace switch), and **discard any response whose workspace or campaign is no longer current** — the exact rule the calls slide-over already documents.

**Commits:** `feat: show what a running campaign is doing right now`, `feat: list a campaign's call attempts`

## Task 18: Start-failure copy and dashboard docs

Every new 409/402 from `start` needs a sentence a customer can act on. `CAMPAIGN_DID_NOT_CALL_READY` in particular must say what to ask for without naming a supplier.

Update `CLAUDE.md`'s campaigns section and the pages table.

**Commit:** `feat: say why a campaign will not start`, `docs: record the live campaign surface`

**Gate:** `npx tsc --noEmit`, `npm test`, `npm run build`.

---

# Admin

## Task 19: `/concurrency`

**Test first:** the page renders pool, allotted and headroom; an overcommit renders a warning naming both numbers; an unavailable pool renders as unavailable rather than as zero; an inline edit posts and revalidates.

**Implement** `app/(console)/concurrency/page.tsx` in the shape `/tiers` already uses — server component, `lib/staff.ts`, a server action for the write, inline editing, `RouteNotServedError` handled so a backend without the route says so rather than showing an empty platform.

Add the allotment field to `/accounts/[id]` beside Tiers.

**Commits:** `feat: allot call capacity from the console`, `feat: set an account's line limit on its own page`

## Task 20: Admin docs

Update `CLAUDE.md`: the new page, what an overcommit means, and that the pool is live and may be unavailable. Correct the stale "Local-only repo for now — no GitHub remote yet" line.

**Commit:** `docs: record the concurrency console`

**Gate:** `npx tsc --noEmit`, `npm test`, `npm run build`.

---

# Finishing

1. `git fetch origin && git merge origin/main` in each of the three repos; resolve, re-run every gate.
2. `gh pr create --base main` in each. **Do not merge.**
3. Report to the user: the exact environment variables an operator must set, what the first bounded live test looks like, and what the webhook setup needs from the Vocobase side that could not be configured from here.

**Nothing in this plan registers a webhook or places a call against the live account.** Both require the user's explicit go-ahead, asked for separately.
