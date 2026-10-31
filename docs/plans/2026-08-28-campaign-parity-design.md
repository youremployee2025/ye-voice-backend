# Campaign parity — backend design

**Goal:** grow campaigns into a full-featured dialing product — retry ladders, promised callbacks, number rotation, scheduling, lane-reserved concurrency, honest queue/journey/stats reporting — while keeping YE's own dispatcher, correlation and idempotency model over the upstream V2 partner API (Vocobase) intact.

**Status:** design approved for implementation on `feat/campaign-parity`. Companion task list: `2026-08-28-campaign-parity-plan.md`.

---

## 1. Scope and non-goals

In scope (three phases):

1. **Phase 1 (this repo):** campaign config parity (retry policy, concurrency lanes, callbacks, scheduling, number rotation, variable map storage), lifecycle parity (stop/complete/delete/duplicate/schedule/top-up/credit-exhaustion), the callback engine, and the read surface the dashboard needs (queue views, per-contact journey, stats).
2. **Phase 2 (dashboard repo):** the matching UI.
3. **Phase 3 (this repo + dashboard):** `variableMap` wired into the dispatcher, and lead buckets.

Out of scope, deliberately: inbound campaigns, per-outcome retry rules, an extraction-set management UI beyond what campaigns need, and any rewrite of dispatcher behaviour that is already correct (the sweep loop, the four-cap slot arithmetic, the launch rollback triage, the reaper, webhook charging — all stay).

## 2. Ground rules

- **Dialing stays ours.** YE dials through `POST /calls/start` on the V2 API. Campaign identity travels only via the attempt-scoped `client_reference_id` (`ezo:<campaignId>:<campaignContactId>:<attemptId>`) and, later, per-call variables. The four-segment reference id is load-bearing (it is an idempotency key upstream) and must never be reduced.
- **Everything is workspace-scoped.** Every new model carries `workspaceId` or reaches it through its campaign; every query filters by it; cross-workspace access is 404. No Prisma `cursor` pagination anywhere (it bypasses `where`).
- **Upstream constraints:** `/calls/start` is rate-limited per partner; the concurrency budget is partner-wide and read from `GET /calls/concurrency` — per-campaign limits are ceilings inside it, never additions to it. A 429 halts the sweep pass. The missed-webhook fallback remains the reaper (`GET /calls/:id`); a bulk `updated_since` sweep is a follow-up, not part of this wave.
- **Dial window:** YE's per-campaign `fromTime`/`toTime`/`timezone` is a deliberate superset of a fixed window and stays. New campaigns default to **09:00–21:00** in the campaign's timezone.
- **Validation philosophy: reject, don't clamp.** A caller who asked for 50 retries and silently got 20 would be billed for a campaign they did not describe. The two exceptions, kept deliberately: `concurrencyLimit` is clamped to [1,10] (historical behaviour of that field), and **duplicate** re-clamps every copied value so a rogue stored value cannot be frozen onto a clone.

## 3. Schema changes

### 3.1 `Campaign`

| Field | Type / default | Rule |
|---|---|---|
| `description` | `String? @db.Text` | trimmed; empty → null; no length cap |
| `concurrencyLimit` | rename of `concurrency`, `Int @default(2)` | integer required (400), then **clamped** to [1,10] |
| `retryConcurrency` | `Int @default(0)` | integer in [0, final `concurrencyLimit`] — **rejected** out of range; validated against the *merged* final state; lowering `concurrencyLimit` below a stored `retryConcurrency` without also lowering it is rejected with a message naming both |
| `retryCount` | rename of `maxAttempts`, `Int @default(2)` | integer in [0,20], 0 disables retries. **Semantic change:** counts *retries after the first call*, not total dials. Migration: `retry_count = LEAST(GREATEST(max_attempts - 1, 0), 20)` |
| `cooldownMinutes` | rename of `retryDelayMins`, `Int @default(30)` | integer in [1,10080]. Migration clamps stored 0 → 1 |
| `retryDelaysMinutes` | `Int[] @default([])` | array, ≤20 entries, each integer in [0,10080] (0 legal here — "dial again on the next tick"); element *i* = wait before retry *i+1*; missing entries fall back to `cooldownMinutes` |
| `callbackEnabled` | `Boolean @default(true)` | strict boolean (no coercion — `"false"` must not read as on) |
| `variableMap` | `Json?` | flat object; **values** must match `^[a-zA-Z_][a-zA-Z0-9_]*$`, keys are free-form CSV headers; `null` clears (SQL NULL, so `variable_map IS NULL` stays a reliable "no mapping" test) |
| `stoppedAt` | `DateTime?` | written once by stop, never cleared — survives the complete relabel; top-up and callback re-arm key their refusal on it |
| `scheduledStartAt` | `DateTime?` | meaningful only while DRAFT; cleared by start and by cancel-schedule. There is deliberately no SCHEDULED status in use — the schedule lives in this column so a process restart cannot lose it |
| `scheduleError` | `String?` | why the last scheduled start refused; a scheduled start never retries |
| `rrCursor` | `Int @default(0)` | round-robin cursor over attached numbers; only its modulo matters |

Kept as-is: `fromTime`/`toTime`/`timezone` (per-campaign window), `defaultCountry`, `agentId`, `phoneNumberId` (becomes the legacy pointer, kept in sync with the first attached number), counters we add below.

New counters (needed by stats and the sweeps): `totalContacts`, `completedCount`, `failedCount`, `skippedCount` (`Int @default(0)`), maintained transactionally with every status change that they describe, plus `startedAt`, `pausedAt`, `completedAt` timestamps.

New index: `@@index([status, scheduledStartAt])` for the schedule scanner.

`CampaignStatus` gains `CREDIT_EXHAUSTED`. `SCHEDULED` remains in the enum (Postgres cannot drop enum members) but nothing writes it any more; `stop`/`start` keep accepting it as a from-state for old rows.

### 3.2 `CampaignPhoneNumber` (new)

```prisma
model CampaignPhoneNumber {
  id            String   @id @default(cuid())
  campaignId    String
  phoneNumberId String
  position      Int
  createdAt     DateTime @default(now())
  campaign      Campaign    @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  phoneNumber   PhoneNumber @relation(fields: [phoneNumberId], references: [id], onDelete: Restrict)
  @@unique([campaignId, phoneNumberId])
  @@unique([campaignId, position])
  @@index([phoneNumberId])
}
```

- ≤ 20 numbers per campaign; the list order at attach time *is* the rotation order.
- The legacy `Campaign.phoneNumberId` keeps pointing at position 0 for old readers, maintained by create/update/duplicate.
- Backfill migration: every campaign with a non-null `phoneNumberId` gets one join row at position 0.

### 3.3 `Contact`

- `email String?`
- `tags String[] @default([])`

CSV import maps recognised headers into these; everything else stays in `metadata`.

### 3.4 `CampaignContact`

| Field | Purpose |
|---|---|
| `nextEligibleAt DateTime?` | earliest claim time, **stored** (today eligibility is computed from `lastAttemptAt + retryDelayMins` at query time; the callback invariant requires a stored column) |
| `callbackAt DateTime?` | the promised callback instant; retained after the callback call completes, as history |
| `callbackCount Int @default(0)` | bounds callback chains (max 3) |
| `lastSessionId String?` | pointer to the most recent completed attempt's session id; not a foreign key |
| `disposition String?` | outcome of the last attempt, normalised (see §7.1), copied — not joined — because a re-arm frees the live attempt pointer |
| `answeredBy String?` | last attempt's answered-by, normalised lowercase |

**`attempts` changes meaning: retries consumed, not dials made.** A callback dial never increments it; the first dial does not either — it is incremented only by the retry re-arm at resolution time. Migration for existing rows: `attempts = GREATEST(attempts - 1, 0)` (correct today because no callbacks exist yet, so dials-made − 1 = retries-consumed for every historical row).

`CampaignContactStatus` gains `SKIPPED` (campaign stopped / retry budget lowered). `EXCLUDED` keeps meaning "an operator removed this contact". `CALLING` stays inert.

Status vocabulary (unchanged names, tightened meanings):

| YE status | Meaning |
|---|---|
| `PENDING` | waiting in the queue (fresh, cooling down, or armed for a callback) |
| `QUEUED` | claimed by the dispatcher; a dial is being placed / in flight |
| `COMPLETED` / `FAILED` | settled |
| `SKIPPED` | swept out (stop, or retry budget lowered) |
| `EXCLUDED` | removed by an operator |

New indexes: `@@index([campaignId, status, nextEligibleAt])`, `@@index([campaignId, callbackAt])`, and a partial index for the callback lane:

```sql
CREATE INDEX "campaign_contacts_callback_claim_idx"
  ON "CampaignContact" ("campaignId", "callbackAt")
  WHERE "status" = 'PENDING' AND "callbackAt" IS NOT NULL;
```

### 3.5 `CallAttempt` (kept; per-attempt history)

`CallAttempt` already is our per-dial attempt table and is created **before** the upstream call, inside the claim transaction — a stronger form of the attempt-row mutual exclusion, which we keep. Changes:

- `attemptNo` becomes `MAX(attemptNo)+1` per contact (it can no longer be derived from `attempts`, which now counts retries; a callback takes the next `attemptNo` while consuming no retry).
- Add `@@unique([campaignContactId, attemptNo])` — the dial mutual-exclusion token.
- Add `fromNumber String?` (the DID actually dialled from, for rotation-aware journeys) and `resolvedAt DateTime?` (when the outcome was applied; the gap to the next attempt's creation is the cooldown actually served).
- **Survive campaign deletion:** `campaignId` and `campaignContactId` become nullable with `onDelete: SetNull` (today they cascade). Call/session records are history; deleting a campaign must not erase the phone bill.

### 3.6 The invariant

> **`nextEligibleAt == callbackAt` (both non-null) is the sole marker of an armed callback.** A retry cooldown moves `nextEligibleAt` alone and leaves `callbackAt` behind as history. Every writer must preserve this in both directions: never move one column of an armed pair alone (that destroys a promise), and never stamp both columns onto a plain retry (that manufactures one).

Read sites: the dispatcher's callback lane and retry-budget exemption, the retry-lowering sweep's exemption, the `?queue=` filters, the journey's `callbackPending`, stats' `callbacksPending`. All must use the same predicate; the retry-queue predicate needs explicit null-arms (`callbackAt IS NULL OR nextEligibleAt IS NULL OR NOT equal`) because SQL `NOT (a = b)` is NULL when either side is NULL.

## 4. Retry engine

### 4.1 Outcome classification

Upstream reports `status`, `disposition`, `answered_by` as lowercase strings on the `session.completed` webhook. Classification:

- **Retryable** ("no real conversation"): status `no_answer` or `busy`; disposition `voicemail` or `user_hangup_no_speech`; answered_by `machine` or `not_answered`.
- **Permanent:** disposition `blocked` or `failed` — never retried, even when answered_by would suggest otherwise.
- **Success:** anything else without a failure reason → `COMPLETED`.
- A resolution carrying an internal `failureReason` (reaper timeout, launch failure) forces the FAILED branch when out of retries, but is retryable like any other when budget remains.

### 4.2 Budget, delays, re-arm

- Retry branch: retryable ∧ not permanent ∧ `attempts + 1 <= campaign.retryCount` (checked at **resolution time**, reading the campaign row live).
- Delay before retry *n* (1-based): `retryDelaysMinutes[n-1] ?? cooldownMinutes`; `nextEligibleAt = now + delay`.
- The re-arm write is guarded on `{ id, status: 'QUEUED', /* current attempt pinned via the attempt row */ }` and sets: `status: 'PENDING'`, `attempts + 1`, `nextEligibleAt`, `lastSessionId`, disposition/answeredBy, **`callbackAt` untouched**. A guard miss drops the write (a lost race must not deflate counters).
- **Claim-time re-check:** the claim SQL carries `AND (attempts <= retryCount OR <armed-callback>)` with `retryCount` re-read every pass — lowering `retryCount` mid-campaign must stop an already-queued retry here, or the setting is a control that lies. The callback exemption is not an optimisation: a callback spends no retries, so without it a retried contact's promised callback would be silently cancelled by a budget it was never spending.

### 4.3 Lowering `retryCount` mid-campaign

Inside the same transaction as the campaign update, with the campaign row locked `FOR UPDATE` first:

```sql
UPDATE "CampaignContact" SET status = 'SKIPPED', "updatedAt" = NOW()
WHERE "campaignId" = $1 AND status = 'PENDING' AND attempts > $2
  AND NOT ("callbackAt" IS NOT NULL AND "nextEligibleAt" = "callbackAt")
```

Run whenever `retryCount` is supplied (not only when lower — a no-op UPDATE is cheaper than reasoning about drift), `skippedCount` incremented in the same transaction, armed callbacks exempt.

## 5. Lane budgets and the claim

### 5.1 `computeLaneBudgets` (pure function, ported exactly)

```ts
const activeAll   = activeFresh + activeRetry;
const totalSlots  = Math.max(0, Math.min(accountRemaining, concurrencyLimit - activeAll));
const reserved    = Math.max(0, Math.min(retryConcurrency, concurrencyLimit));
const retryBudget = Math.min(totalSlots, Math.max(0, reserved - activeRetry));
const freshBudget = Math.min(totalSlots, Math.max(0, concurrencyLimit - reserved - activeFresh));
```

Budgets subtract per-lane in-flight counts so the reservation holds across passes; neither can go negative; lowering the limit below the live count yields 0, never a hang-up. `accountRemaining` is the narrower of the account's own remaining and the upstream pool's remaining (the existing four-cap arithmetic keeps its outer layers).

### 5.2 Lane order and claim mechanics

Per RUNNING campaign per sweep pass, after the existing gates (agent, numbers, window, balance, pool):

1. **Callback lane first, unconditionally**, ordered `callbackAt ASC`, consuming the shared budget (a callback is the only queue entry carrying a time a human was told; everything else is a list position nobody chose).
2. If `retryConcurrency > 0`: **retry lane** (`attempts > 0`, `createdAt ASC`) up to `retryBudget`, then **fresh lane** (`attempts = 0`) up to `freshBudget`, then a **borrow** pass with no lane filter for whatever remains — skipped when both lanes are proven dry (a positive target that underfilled).
3. Else: one shared-pool pass (FIFO).

The claim is **one statement** — select, lock, and flip in the same SQL so no read-then-write window exists and concurrent dispatchers cannot double-claim:

```sql
WITH selected AS (
  SELECT cc.id FROM "CampaignContact" cc
  WHERE cc."campaignId" = $1 AND cc.status = 'PENDING'
    AND (cc."nextEligibleAt" IS NULL OR cc."nextEligibleAt" <= NOW())
    AND (cc.attempts <= $retryCount OR (cc."callbackAt" IS NOT NULL AND cc."nextEligibleAt" = cc."callbackAt"))
    /* lane filter */ /* order */ LIMIT $n
  FOR UPDATE OF cc SKIP LOCKED
)
UPDATE "CampaignContact" SET status = 'QUEUED', "lastAttemptAt" = NOW()
FROM selected WHERE "CampaignContact".id = selected.id
RETURNING "CampaignContact".id
```

Only *due* callbacks are claimable — the armed predicate identifies the state and `nextEligibleAt <= NOW()` gates the time; a callback booked for tomorrow is never pulled forward. The callback lane does not filter by `attempts` (it cuts across both lanes). Ordering: callbacks by `callbackAt ASC` (the one column here that genuinely sorts — bulk-imported rows share a `createdAt`), everything else `createdAt ASC, id ASC`.

After the claim, launches proceed exactly as today: create the `CallAttempt` row (pre-dial, in a transaction), `startCall` outside the transaction with the four-segment reference id, `rollbackLaunch` triage unchanged — except the give-back path must preserve the invariant: an armed callback that is given back keeps `nextEligibleAt == callbackAt` (move both together if backing off past the promise, move neither if the promise is still ahead); a plain retry moves `nextEligibleAt` alone; and a give-back never increments `attempts`.

### 5.3 Number rotation at dispatch

- Load attached numbers ordered by `position`, filtered to usable (`ASSIGNED`/usable status). A deactivated number falls out of the rotation instead of failing every Nth call.
- When join rows exist but none are usable, **hold the campaign this pass** (log; do not fall back to the legacy pointer — it may be the very number just deactivated). When no join rows exist, fall back to the legacy `phoneNumberId`.
- `UPDATE "Campaign" SET "rrCursor" = "rrCursor" + $count WHERE id = $1 RETURNING "rrCursor"` once per claimed batch (only when rotating); the i-th claimed contact dials from `numbers[(base + i) % numbers.length]`; stamp `fromNumber` on the attempt row.

## 6. Callback engine

### 6.1 Where `callback_at` comes from

The upstream `session.completed` webhook carries the session's extraction results at `data.extraction.values` (a flat map) whenever the agent has extraction enabled and keys configured. The upstream platform reserves the key name `callback_at` for itself and **rejects a partner-defined key of that name**, and it only injects its own on calls it originates through its own campaign product — which our calls are not. Therefore:

- YE owns an extraction key named **`callback_requested_at`** (type `datetime`), description: *"The absolute date and time the person asked to be called back, if they asked at all. Null if no callback was requested or no specific time was agreed. Include the UTC offset."*
- When a campaign with `callbackEnabled` starts (or resumes), the backend **idempotently ensures** the agent carries this key: find-or-create an YE-managed extraction set named `EZO campaign callbacks` via `POST /extraction-sets`, attach it via `POST /agent/:id/extraction-sets/:setId` (idempotent upstream: 201 new / 200 already attached), and ensure the agent's `extraction_enabled` is true. Failures here are logged and surfaced but do not block the start — a campaign without the key simply books no callbacks.
- The webhook handler reads `data.extraction.values.callback_requested_at`, falling back to `data.extraction.values.callback_at` if present.
- This engine parses whatever arrives; it never re-runs extraction.

### 6.2 Parsing and validation

`parseCallbackAt(raw, timezone, now)` → ok(`Date`) | rejection reason `absent | not_a_string | unparseable | too_soon | too_far_ahead`:

1. null/undefined → `absent`; non-string → `not_a_string`; trim.
2. Explicit-offset strings (`T…Z` / `±HH:MM` / `±HHMM` / bare `±HH`, normalised to `±HH:00`) parse directly; NaN → `unparseable`. The offset regex must require a `T` before it so a bare date's day digits never read as an offset.
3. Naive datetimes are interpreted in the **campaign's timezone** (wall-clock → UTC arithmetic; never host-local).
4. **Date-only strings are rejected** (`unparseable`): a bare date means "some day, no time agreed" and must never schedule a call. (No noon default.)
5. `at <= now + 60s` → `too_soon` (extraction runs seconds after hang-up; a lead must not be redialled mid-goodbye). `at > now + 90 days` → `too_far_ahead` (models fabricate years).

Then `rollIntoDialWindow(at, campaign window)`: before opening → same local day at open; after close → next local day at open; in-window → untouched. **Only ever moves forward.** Calendar arithmetic on the local date, DST-correct (compute the offset at the *target* instant, not the input's). If rolling fails, return the instant unrolled — the claim gate still refuses it, so the worst case is a callback that waits, never one that rings at 3 AM. Campaign windows with null times mean always-open (roll is a no-op); an incomplete window pauses the campaign at the dispatcher as today.

Every outcome — booked or rejected — is logged in one line with the contact id, the reason, both instants when the roll moved one, and the raw value.

### 6.3 Booking (`scheduleCampaignCallback`)

Runs after the terminal outcome has been applied (webhook or reaper), in its own try/catch (a callback failure must never break charging). One transaction:

1. **Lock the campaign row `FOR UPDATE` first** (same lock order as stop/complete/top-up/the completion pass — without it the dispatcher can complete the campaign underneath the re-arm and strand a queued callback).
2. Refuse when `stoppedAt IS NOT NULL` or status `STOPPED` → `CAMPAIGN_CANCELLED`. Keyed on `stoppedAt`, not status: complete relabels STOPPED → COMPLETED, and a status-only guard would let a lead in a call that outlived the stop re-open a campaign the operator killed.
3. Contact must be `COMPLETED` or `FAILED` (the states resolution just wrote) → else `NOT_RESOLVED`.
4. `callbackCount >= 3` → `LIMIT_REACHED`.
5. The re-arm, guarded on the contact's current status: `status: 'PENDING'`, `nextEligibleAt = callbackAt = <instant>` (the invariant, one instant to both columns), `callbackCount + 1`, `lastSessionId` kept, live session pointer freed, **`attempts` untouched** (a callback never spends retries). Guard miss → `NOT_RESOLVED`, nothing below runs.
6. Give back the terminal counter (`completedCount`/`failedCount` − 1) — the contact is no longer terminal.
7. `COMPLETED → RUNNING` re-open via a status-guarded update (matching zero rows is the normal case). A scheduled callback *is* pending work; there is nobody to press Resume at 3pm tomorrow. (Asymmetric with top-up on purpose — top-up re-opens to PAUSED.)

## 7. Lifecycle

### 7.1 Dispositions

`CallAttempt.disposition` stays verbatim upstream text; a derived, normalised copy lands on the contact (`disposition`, lowercase) and drives stats. The canonical nine: `completed, transferred, voicemail, user_hangup_no_speech, no_answer, busy, canceled, blocked, failed` — stats zero-fill all nine; unknown strings count as settled-unknown, never dropped.

### 7.2 Transitions

| Action | From | Behaviour |
|---|---|---|
| **start** | DRAFT (and legacy SCHEDULED) | all existing gates (agent usable, ≥1 usable number re-validated, window not incomplete, balance ≥ ~30s of calling, contacts > 0) + concurrency overrides validated against merged state; sets `startedAt`, clears `scheduledStartAt`/`scheduleError`; then ensures the callback extraction key (§6.1) when `callbackEnabled` |
| **pause** | RUNNING | `pausedAt` |
| **resume** | PAUSED, CREDIT_EXHAUSTED | re-runs number validation and (from CREDIT_EXHAUSTED only) the balance check; accepts concurrency overrides; the **only** door back to RUNNING besides start/scheduler |
| **stop** | RUNNING, PAUSED, CREDIT_EXHAUSTED, DRAFT, SCHEDULED | one transaction: lock campaign `FOR UPDATE`, sweep `PENDING → SKIPPED` (+`skippedCount`), set `STOPPED`, `stoppedAt = completedAt = now`. In-flight contacts are left alone — live calls finish |
| **complete** | STOPPED only | pure relabel STOPPED → COMPLETED; 400 if already COMPLETED; **409** while any contact is `QUEUED` (calls still connected), with the live count in the message; **409** on a lost status race; `completedAt` untouched (that *is* when it stopped); `stoppedAt` stays set so top-up and callbacks keep refusing |
| **delete** | any status | lock `FOR UPDATE`, delete; assignments cascade; `CallAttempt` history survives with campaign pointers nulled; live calls finish and late webhooks for them resolve against the attempt rows |
| **schedule** | DRAFT | body `{ startAt }`; must parse and be future; writes `scheduledStartAt`, clears `scheduleError`. Deliberately no contact/credit/number checks here — they run when the schedule fires and land in `scheduleError` ("schedule now, upload tonight" must work). `DELETE /schedule` clears both fields, any status |
| **duplicate** | any status | copy **by omission** (fetch the whole row, delete the non-copyable columns: id, workspaceId, name, timestamps, status, counters, cursor, `phoneNumberId`, `stoppedAt`, `scheduledStartAt`, `scheduleError`); re-validate agent + numbers as they are *now*; **re-clamp** every numeric (`concurrencyLimit` [1,10], `retryConcurrency` [0,limit], `retryCount` [0,20], `cooldownMinutes` [1,10080], ladder sliced to 20 entries each clamped [1,10080]); name = requested or `"<name> (Copy)"`/`(Copy 2)`…; numbers cloned with positions in one nested create; **no contacts, no results**; → DRAFT, 201 |

### 7.3 Scheduled-start scanner

A `setInterval` sweep in `server.ts` (per this codebase's worker model — no queue infrastructure), every **30s**, floor 30s, re-entrancy-guarded, `unref()`, never started by `createApp()`:

- `findMany({ where: { status: 'DRAFT', scheduledStartAt: { lte: now } }, take: 20 })`, per-campaign try/catch.
- Runs **the same start routine** as the route (extract `startCampaign()` into a shared service so the two cannot drift), with no overrides.
- Refusal → `updateMany({ where: { id, status: 'DRAFT' } , data: { scheduledStartAt: null, scheduleError: reason } })` — guarded on DRAFT so a manual start that won the race is never clobbered; **no retry**.
- A thrown (transient) error leaves `scheduledStartAt` in place for the next tick.

### 7.4 Top-up (add contacts to an existing campaign)

New JSON endpoint (alongside the CSV upload, which routes through the same core): `POST /:workspaceId/campaigns/:id/contacts` with exactly one of `contactIds` (≤10000), `tagFilter` (contacts with any of the tags), or `selectAll` (+ optional `search`) mirroring the picker's own query so "select all matching" resolves server-side.

Core (`addContactsToCampaign`), one transaction with a 30s timeout:

1. Lock the campaign `FOR UPDATE` **first** (same order as everything else).
2. Refuse when `stoppedAt IS NOT NULL` (400): *"This campaign was stopped, so the rest of its queue was skipped on purpose. Contacts cannot be added to it — create a new campaign for further calls."* Keyed on `stoppedAt` because complete relabels and a status-keyed rule is a two-click bypass of itself.
3. Dedupe against existing `(campaignId, contactId)` rows → reported as `duplicates`, never re-inserted.
4. Insert in 1000-row chunks with `skipDuplicates`; `added` accumulates the returned counts, never the input length.
5. `totalContacts += added`.
6. `COMPLETED` + `added > 0` → re-open to **PAUSED** (never RUNNING — resume is the only path that re-validates), `completedAt` cleared, `reopened: true` in the response.
7. No credit pre-check — a top-up prices nothing; resume and the dispatcher re-check.

RUNNING/PAUSED/CREDIT_EXHAUSTED accept top-ups in place (the dispatcher claims whatever is PENDING each pass); the CSV upload's status restriction is lifted accordingly.

### 7.5 CREDIT_EXHAUSTED

The dispatcher's existing low-balance pause changes target: instead of PAUSED + notification, set `status: 'CREDIT_EXHAUSTED', pausedAt: now` when the owner's balance cannot cover ~30 seconds of calling at the campaign's rate. Resume from CREDIT_EXHAUSTED re-checks the same estimate. Notifications unchanged.

### 7.6 Mid-campaign edits (`PATCH /:id`)

- **DRAFT:** everything.
- **PAUSED / CREDIT_EXHAUSTED:** only `retryCount`, `cooldownMinutes`, `retryDelaysMinutes`, `callbackEnabled`. Anything else in the body → **400 naming the offending fields** (a field that appears to save and does not is the worst outcome). Supplying `retryCount` runs the SKIPPED sweep (§4.3) in the same transaction.
- **variableMap additive-only exception:** a body containing *exactly* `{ variableMap }` is accepted in any non-stopped status when the update is purely additive (every existing key survives with an identical value; `null` is a clear, not an add) — the CSV importer's import→assign→save-mapping flow must survive a re-upload landing on a COMPLETED campaign.
- **RUNNING and terminal:** read-only (the additive variableMap exception aside).
- Existing agent/number locks while RUNNING stay as today.

## 8. Read surface

All under the existing `/:workspaceId/campaigns` router (member-read, ADMIN-write, campaign always resolved through `campaignInWorkspace` → 404).

### 8.1 Contacts list — `GET /:id/contacts`

- `?status=` (validated against the enum, silently ignored otherwise), `?queue=callback|callback_overdue|retry` (400 on other values), limit ≤100 default 50, offset. Queue filters are ANDed with any status filter.
- Predicates: `callback` = PENDING ∧ armed ∧ `callbackAt > now`; `callback_overdue` = PENDING ∧ armed ∧ `callbackAt <= now`; `retry` = PENDING ∧ `attempts > 0` ∧ NOT armed (with the null-arms spelled out).
- Ordering: retry → `nextEligibleAt ASC`; callback queues → `callbackAt ASC`; default → `createdAt ASC, id ASC`.
- Rows include the joined contact (name, phone, email, tags, metadata).

### 8.2 Journey — `GET /:id/contacts/:campaignContactId/journey`

Campaign resolved first (404), then the contact re-asserted against that campaign id (404). Response:

- `campaign`: id, name, retryCount, cooldownMinutes, retryDelaysMinutes.
- `contact`: identity off `Contact`, plus status, disposition, answeredBy, attempts (documented as *retries consumed, not dials made*), nextEligibleAt, callbackAt, callbackCount, `callbackPending` (the armed predicate, timestamps compared by value), creditsUsed, lastSessionId, addedAt.
- `events` (oldest first, capped at 200 attempts):
  - `attempt`: attemptNo, disposition, answeredBy, fromNumber, startedAt, resolvedAt, durationSecs, costCredits, sessionId, `hasRecording` (existence only — no URLs minted here).
  - `cooldown` between consecutive attempts: served minutes (measured `resolvedAt → next.startedAt`, one decimal, negative gaps dropped) and `scheduledMinutes` — **null as soon as `callbackCount > 0`** (a callback takes the next attemptNo without consuming a retry, so the attempt ordinal and the retry index diverge and printing a schedule would attribute the wrong row).
  - `callback_due`: emitted only for a live armed promise.
- `inFlight`: the only way a live dial appears (the current claimed-but-unresolved attempt).
- `attemptsRecorded`: honest-empty flag — `attempts.length > 0 || !hasEverDialed`, where `hasEverDialed` is proven from contact-level fields that survive re-arms. `false` means specifically "dialled, and the rows are gone", never "queued, never dialled".

### 8.3 Stats — `GET /:id/stats`

Extends the existing stats route: status counts (all statuses zero-filled), the **nine-disposition breakdown zero-filled** (from the contacts' normalised last disposition), `callbacksPending` (PENDING with `callbackAt > now`), average duration over COMPLETED contacts, total credits **from the ledger** (`CALL_USAGE` rows for the campaign's attempts — never from `costCredits`, which also records unpaid shortfalls), plus the existing dialer block (in-flight, caps, window).

### 8.4 List outcomes — `GET /`

Adds a per-campaign `outcomes` aggregate for the dashboard list (three grouped queries across the page of campaigns, never per-row stats calls): dispositions grouped, `inFlight`, `undialed`, `settledUnknown` — four numbers that partition `totalContacts`.

## 9. Deliberate divergences from the upstream product's campaign behaviour

Recorded so review can check them consciously:

1. **Per-campaign dial window** (superset of the fixed 9–21 window), kept; new campaigns default to 09:00–21:00 in the campaign's timezone; callbacks roll into the *campaign's* window.
2. **No noon default for date-only callback promises** — date-only strings are rejected as unparseable. A bare date is "some day", and "some day" must never place a call.
3. **Callback extraction key is YE-owned and named `callback_requested_at`** — the upstream reserves `callback_at` for itself and rejects partner definitions of it; our calls are plain V2 calls the upstream never decorates. We read `callback_at` from the extraction values as a fallback only.
4. **Naive callback datetimes parse in the campaign's timezone** (we have no per-agent timezone concept; the campaign's window timezone is both the best available proxy for the conversation's clock and the roll target).
5. **Attempt rows are written pre-dial** (inside the claim transaction) rather than at resolution — a stronger idempotency stance we already had and keep; `resolvedAt` distinguishes in-flight rows.
6. **Status names:** `STOPPED` (≈ cancelled-by-operator) and `PENDING`/`QUEUED`/`EXCLUDED` keep their YE names; `SKIPPED` and `CREDIT_EXHAUSTED` are added. Semantics match §7.2's table.
7. **No 3-second dispatch tick** — the sweep stays on this codebase's interval model (60s floor). Queue-view copy must not promise second-level precision.
8. **Delete keeps attempt history** with nulled campaign pointers (upstream cascades its attempt rows; our attempt rows are also the billing record, so they must survive).
9. **`resume` re-checks the balance from PAUSED too**, not only from CREDIT_EXHAUSTED as §7.2's table says — implemented, deliberately, in Checkpoint D. `resume` reaches exactly the state `start` does, and both run the one `assertCampaignDialable` gate list rather than two; a second list that differed by one check is how the two doors into RUNNING come to accept different campaigns. The cost of the stricter reading is a 402 on a resume that the dispatcher would have paused a minute later anyway, which is the better place to learn it.

## 10. Testing strategy

TDD throughout; every task in the plan starts from a failing test. Suites (all against `TEST_DATABASE_URL`, adapter mocked — a test that reaches the network is a phone bill):

- Pure units: `computeLaneBudgets`, `parseCallbackAt`, `rollIntoDialWindow`, retry classification, delay indexing, validators (reject-vs-clamp pinned exactly), duplicate re-clamp, variableMap additive check.
- Claim SQL: real-Postgres tests for lane filters, the armed-callback predicate (equality, both null-arms), FOR UPDATE SKIP LOCKED double-claim safety, due-vs-future callbacks, the window gate.
- Resolution: retry re-arm preserves `callbackAt`; give-back preserves the invariant in both directions (armed+late moves both, armed+future moves neither, plain retry moves one, stale history never manufactures the pair); race-lost drops writes and counters.
- Callback booking: every rejection reason, the stoppedAt refusal (including the stop→complete→callback regression), the cap, the COMPLETED→RUNNING re-open, counter give-back, campaign lock ordering vs the completion pass.
- Lifecycle: each transition's guards and writes; complete's 409s; delete-survives-history; duplicate empty + re-clamped; scheduler start/refusal/no-retry/transient-retry; top-up dedupe/re-open/stoppedAt; mid-campaign edit gates incl. the additive variableMap.
- Read surface: queue predicates, journey honesty flags, stats zero-fill, ledger-sourced credits.
- Migration: a data test that converts a seeded pre-migration shape (maxAttempts/retryDelayMins/attempts) and asserts the new semantics.
