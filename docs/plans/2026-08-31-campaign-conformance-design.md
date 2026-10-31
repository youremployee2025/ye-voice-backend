# Campaign Engine Conformance — Behavior Matrix

This document is the specification of expected behavior for YE's outbound
campaign engine, stated so that every row is mechanically checkable by the
conformance suite (`npm run conformance`). The baseline for comparison is the
campaign engine of the upstream voice platform YE builds on; where YE's
engine deliberately departs from that baseline, the row says so and cites the
design decision. The suite's verdict vocabulary:

- **MATCHES** — YE's observed trace agrees with the row.
- **DIVERGES-DELIBERATE** — YE departs from the platform baseline by design;
  the row records the rationale. The suite asserts YE's own documented
  behavior, not the baseline's.
- **DIVERGES-BUG** — the trace disagrees with this spec; the report carries a
  minimal repro. Fixes are out of scope for the suite itself.
- **NOT-YET-BUILT** — the feature does not exist in the engine yet.

## Vocabulary mapping

The two engines name their states differently. Rows below use YE's names.

| Concept | YE | Platform baseline |
|---|---|---|
| Contact waiting to be dialed | `PENDING` | `QUEUED` |
| Contact claimed → call finished | `QUEUED` (+ inert `CALLING`) | `IN_PROGRESS` |
| Contact talked to a human | `COMPLETED` | `COMPLETED` |
| Contact terminal without conversation | `FAILED` | `FAILED` |
| Contact swept by stop / budget lowering | `SKIPPED` | `SKIPPED` |
| Campaign stopped by operator | `STOPPED` | `CANCELLED` |
| Campaign out of credits | `CREDIT_EXHAUSTED` | `CREDIT_EXHAUSTED` |
| Per-dial history row | `CallAttempt` | per-attempt dial row |

## D — Dispatch & claim

| ID | Expected behavior | vs baseline |
|---|---|---|
| D1 | One sweep claims eligible contacts with a single `FOR UPDATE OF cc SKIP LOCKED` CTE that flips `PENDING → QUEUED`; a contact is eligible iff `status = PENDING`, `nextEligibleAt IS NULL OR <= now`, and `attempts <= retryCount` unless armed for callback. | MATCHES (same claim shape) |
| D2 | Non-callback lanes claim oldest-first by `createdAt` (id tiebreak). The callback lane orders by `callbackAt ASC` — oldest promise first. | MATCHES |
| D3 | Lane budgets: `totalSlots = max(0, min(accountRemaining, concurrencyLimit − activeAll))`; `reserved = clamp(retryConcurrency, 0..concurrencyLimit)`; `retryBudget = min(totalSlots, max(0, reserved − activeRetry))`; `freshBudget = min(totalSlots, max(0, concurrencyLimit − reserved − activeFresh))`. | MATCHES (identical formulas) |
| D4 | Claim order per campaign per sweep: callbacks first (out of the shared budget, not extra), then — when `retryConcurrency > 0` — retry-reserved, fresh-reserved, and a borrow pass (`any`) for the remainder, skipped only when both reserved lanes were proven dry. With `retryConcurrency = 0`: one FIFO pass across both lanes. | MATCHES |
| D5 | Sweep cadence is 60 s (floored env `DIALER_SWEEP_MS`); each sweep also carries a per-pass blast-radius budget `DIALER_MAX_CALLS_PER_SWEEP` (default 25) across all campaigns. | DIVERGES-DELIBERATE — YE polls its upstream as a partner rather than running a 3 s in-house dispatch loop; the per-sweep cap bounds the blast radius of any one pass. |
| D6 | Campaigns are served least-recently-dialed-first each sweep. | DIVERGES-DELIBERATE — explicit fairness ordering instead of unspecified scan order; the reserved-floor-and-burst allocator remains future work. |
| D7 | Claimed-but-not-yet-dialed work counts against concurrency: the pre-dial `CallAttempt` row (status `QUEUED`) is what in-flight counting reads, so a claimed contact occupies a line from attempt-insert until its terminal status. | MATCHES (baseline counts claimed contacts as reservations) |
| D8 | Account-level pool: in-flight attempts are counted across all the account's campaigns against `Account.concurrencyLimit ?? DIALER_DEFAULT_ACCOUNT_CONCURRENCY` (default 2; `0` is a hard stop). Two campaigns of one account share the pool. | MATCHES in mechanism; default value is YE configuration (baseline default is 1). |
| D9 | Campaign's own `concurrencyLimit` (default 2) caps that campaign's in-flight regardless of pool headroom. | MATCHES |
| D10 | Credit pre-check: a sweep pauses a campaign to `CREDIT_EXHAUSTED` when the owner's balance is below `DIALER_MIN_BALANCE_CREDITS` (default 1 display credit). | DIVERGES-DELIBERATE — flat configurable floor instead of a modeled 30-second-call estimate; YE prices per-tier and keeps the gate independent of tier resolution. |

## X — Exactly-once dialing

| ID | Expected behavior | vs baseline |
|---|---|---|
| X1 | Two dispatch passes racing over the same contact produce exactly one upstream call. The mutual-exclusion token is the pre-dial attempt row's unique `(campaignContactId, attemptNo)`; the loser's insert fails and its claim is released `QUEUED → PENDING` with no timestamps touched. | MATCHES (baseline pins a unique session link; same guarantee, different token) |
| X2 | The upstream idempotency key (`client_reference_id`) is attempt-scoped: `ezo:<campaignId>:<contactId>:<attemptId>`. A replayed request for the same attempt is answered with the original call (no second dial); a later retry attempt carries a fresh key and does dial. | MATCHES — the 4-segment key exists precisely to conform to the platform's per-account idempotent replay while still allowing retries. |
| X3 | A transient launch failure (upstream 5xx / socket error / rate-limit / concurrency refusal) gives the contact back `QUEUED → PENDING` with `nextEligibleAt = now + cooldownMinutes`, `attempts` untouched — a call that never left consumes nothing. An armed callback keeps its `nextEligibleAt == callbackAt` pair intact (both slipped when the promise is already past, neither when it is still ahead). | DIVERGES-DELIBERATE — baseline requeues on a 30 s / 180 s two-tier backoff; YE gives back one flat campaign cooldown. Rationale: YE's transient failures are partner-API failures (not carrier transport), and the sweep cadence already floors the retry interval at 60 s, so a sub-minute backoff would be indistinguishable; upstream 5xx is retried rather than terminal because it is a platform-API error, not a carrier verdict on the number. |
| X4 | An upstream 400 on launch is per-contact permanent: contact `FAILED`, `failedCount + 1`, attempt closed — the only launch failure that consumes the contact. 429 halts the rest of the pass (no pause); 403 pauses the campaign; 404 (agent gone upstream) pauses the campaign. | DIVERGES-DELIBERATE — richer launch-failure triage than the baseline's transient/terminal split, driven by what each upstream status means for a partner. |
| X5 | An unconfirmed upstream write (connection died mid-POST) leaves the attempt open for the reaper to reconcile — the call may be ringing; nothing is retried immediately and nothing is double-dialed. | MATCHES in guarantee (no double dial) |

## R — Retry semantics

| ID | Expected behavior | vs baseline |
|---|---|---|
| R1 | Retryable outcomes: call status `no_answer` or `busy`; disposition `voicemail` or `user_hangup_no_speech`; answered_by `machine` or `not_answered`. Permanent (never redialed, overrides retryable): disposition `blocked` or `failed`. A terminal outcome that is neither retryable nor permanent resolves the contact `COMPLETED`; everything else terminal resolves `FAILED`. | MATCHES (identical classification table) |
| R2 | `retryCount` counts retries, not dials: a contact is dialed at most `1 + retryCount` times (+ up to 3 callbacks). Enforced at resolution (`attempts + 1 <= retryCount`) AND at claim (`attempts <= retryCount`, armed callbacks exempt). | MATCHES |
| R3 | Retry delay: `retryDelaysMinutes[attempts] ?? cooldownMinutes` — element *i* is the wait before retry *i + 1*, indexed by retries already consumed; a short ladder falls back to the flat cooldown (default 30 min). `nextEligibleAt = resolution now + delay`. | MATCHES |
| R4 | A retry re-arm moves only `nextEligibleAt` (and `attempts`, `status → PENDING`); `callbackAt` is never touched, so the armed-callback equality can never be forged by a retry. No campaign counter moves on a retry. | MATCHES |
| R5 | Lowering `retryCount` mid-campaign sweeps waiting contacts over the new budget `PENDING → SKIPPED` (`skippedCount += swept`); armed callbacks are exempt from the sweep; and the claim re-reads `retryCount` each pass so an already-eligible retry above the new budget is not claimed. | MATCHES |

## CB — Callbacks

| ID | Expected behavior | vs baseline |
|---|---|---|
| CB1 | The armed-promise discriminator is the equality `nextEligibleAt == callbackAt` (both non-null), written as one instant only by callback booking. Retry re-arms move `nextEligibleAt` alone, so equality ⇔ live promise. | MATCHES |
| CB2 | Armed callbacks are claimed before any other lane, oldest promise first, and are exempt from the retry budget (`attempts` untouched by booking and by the callback dial). | MATCHES |
| CB3 | At most 3 callbacks per contact (`callbackCount`); booking a 4th is refused (`LIMIT_REACHED`). | MATCHES |
| CB4 | Booking bounds: at least 60 s lead, at most 90 days ahead; refused on a stopped campaign (`stoppedAt` set); contact must be resolved (`COMPLETED`/`FAILED`); a booking for a superseded attempt is refused. Booking hands back the counter resolution just took (`completedCount`/`failedCount` decrement) and re-opens an auto-`COMPLETED` campaign straight to `RUNNING` — a promise has no operator to press Resume. | MATCHES (the superseded-attempt refusal is an YE addition) |
| CB5 | The promised instant is rolled forward-only into the campaign's dial window at booking time; the claim-time window check still applies as a second layer, and only due promises (`nextEligibleAt <= now`) are claimed. | MATCHES (window itself differs — see W1) |
| CB6 | Callback timestamps come from the extraction key `callback_requested_at` (YE's own), with `callback_at` accepted as fallback; naive datetimes are read in the campaign's timezone (default `Asia/Kolkata`); date-only values are rejected outright. | DIVERGES-DELIBERATE — the upstream reserves `callback_at` for its own campaigns, so YE owns a distinct key; date-only promises are rejected instead of defaulting to noon because a fabricated hour is a guess the caller never made. |

## W — Dial window

| ID | Expected behavior | vs baseline |
|---|---|---|
| W1 | The dial window is per-campaign: `fromTime`/`toTime` (`"HH:MM"`, start inclusive, end exclusive, overnight wrap allowed) in the campaign's IANA `timezone`; both ends unset = open. A half-configured window fails closed (campaign refused at start / paused by the sweep). | DIVERGES-DELIBERATE — a per-campaign window is a superset of the baseline's fixed 09:00–21:00 account-timezone window; YE's clients run campaigns across jurisdictions with their own calling-hour rules. |
| W2 | A contact eligible while the window is closed is simply not claimed: no status change, `nextEligibleAt` untouched (moving it would corrupt the callback equality); claiming resumes on the first sweep after the window opens. | MATCHES |

## L — Lifecycle

| ID | Expected behavior | vs baseline |
|---|---|---|
| L1 | Start: `DRAFT`(/`SCHEDULED`) only; requires a usable agent, at least one `PENDING` contact, a usable number, a complete-or-absent window, a resolvable rate, and balance ≥ the credit floor. Sets `RUNNING` + `startedAt`. | MATCHES (gate list is YE's; shape identical) |
| L2 | Pause: `RUNNING → PAUSED` stops new claims mid-tick; in-flight calls finish and resolve normally. | MATCHES |
| L3 | Resume: from `PAUSED` or `CREDIT_EXHAUSTED` only; re-runs the start gates (numbers, window, rate, credits). | MATCHES |
| L4 | Stop: sweeps every `PENDING` contact → `SKIPPED` (`skippedCount += swept`), sets status `STOPPED` and stamps `stoppedAt` (permanent, never cleared) + `completedAt`; `QUEUED` (in-flight) contacts finish and resolve. A contact claimed in the same batch as the stop is swept `SKIPPED` by the per-contact pre-dial re-check. | MATCHES |
| L5 | Complete: `STOPPED → COMPLETED` relabel only; 409 while any contact is in flight; contacts and counters untouched; `stoppedAt` survives, so top-up and callback booking stay refused. | MATCHES |
| L6 | Auto-complete: a sweep that finds a `RUNNING` campaign with zero contacts in `PENDING`/`QUEUED`/`CALLING` completes it (under the campaign row lock) exactly once. | MATCHES |
| L7 | Credit exhaustion: the sweep's balance gate and the charge-time shortfall both flip `RUNNING → CREDIT_EXHAUSTED` (+ `pausedAt`); resume is the only way back and re-checks balance. | MATCHES (two writers is YE's; baseline pauses from its dispatch tick) |
| L8 | Top-up: refuses stopped campaigns (on `stoppedAt`, not status); dedupes against existing membership (`duplicates` reported, never re-inserted); `totalContacts += actually-inserted`; re-opens a `COMPLETED` campaign to `PAUSED` (never `RUNNING` — start and resume are the only doors into RUNNING) only when it inserted something; no credit check. | MATCHES |

## S — Stuck-attempt cleanup

| ID | Expected behavior | vs baseline |
|---|---|---|
| S1 | The reaper runs at the top of every sweep over attempts older than `DIALER_ATTEMPT_TIMEOUT_MINS` (default 60): (a) non-terminal attempts (`QUEUED`/`RINGING`/`IN_PROGRESS`), and (b) terminal-but-unresolved attempts (freed the line but never classified). | DIVERGES-DELIBERATE — the baseline runs three wall-clock classes (10/30/10 min) because it owns the call stack; YE, as a partner, has a better tool: ask the platform. One timeout plus reconciliation replaces the class split. |
| S2 | A stuck attempt with an upstream call id is reconciled via the platform's call-detail read; a terminal answer there is applied exactly as the webhook would have been — same classification, same charge, same callback booking — so retryability is fully preserved. | MATCHES in effect (baseline re-resolves through its standard resolution) |
| S3 | A stuck attempt with no call id, or unknown/still-live upstream past the timeout, closes `ABANDONED` (not `FAILED` — "never found out" ≠ "did not answer") and the contact retries while budget lasts, settling `FAILED` when out. An abandoned call consumes a retry — the call may well have happened. | DIVERGES-DELIBERATE — the baseline fails a never-started contact terminally; YE retries unknown-outcome contacts (consuming budget) rather than burning them on infrastructure noise. |
| S4 | Reconciliation charges land under a distinct event key but the same per-attempt ledger uniqueness, so a late webhook after a reconcile (or vice versa) can never double-charge. | MATCHES (once-per-attempt guarantee) |

## B — Billing per attempt

| ID | Expected behavior | vs baseline |
|---|---|---|
| B1 | A call is charged when its terminal outcome is applied (completion webhook or reaper reconcile), never at dial time. Rate and billing increment are snapshotted on the attempt row at dial time; the charge reads the snapshot. | MATCHES (baseline charges at session completion) |
| B2 | Charge formula: `billedSecs = ceil(durationSecs / incrementSecs) × incrementSecs`; `cost = rateCreditsPerMin × billedSecs / 60` (integer division; sub-unit remainder in the customer's favor). Zero duration costs zero and writes no ledger row. | DIVERGES-DELIBERATE — YE's own pricing: per-tier rate with a configurable billing increment and no connection charge, vs the baseline's pulse + init-charge model. The suite asserts YE's documented rule. |
| B3 | Exactly one ledger write per attempt (`CALL_USAGE`, `reference = attempt id`, unique per account): duplicate webhooks, replayed events, and webhook-vs-reaper races all collapse to one charge via the event-key unique, the `chargedAt: null` close guard, and the ledger unique. | MATCHES |
| B4 | Insufficient balance at charge time is fail-closed: nothing debited, the attempt marked shortfall with the owed amount recorded, a zero-amount `CALL_USAGE_SHORTFALL` ledger row written, and the campaign paused to `CREDIT_EXHAUSTED`. | DIVERGES-DELIBERATE — the baseline clamps the debit to the remaining balance; YE refuses partial debits so the ledger never understates what a call cost. |

## N — Number rotation

| ID | Expected behavior | vs baseline |
|---|---|---|
| N1 | Up to 20 numbers per campaign rotate in attachment order via an atomic cursor advanced once per claim batch; the *i*-th contact of the batch dials from `numbers[(cursorBase + i) % count]`; the attempt row snapshots the from-number actually used. | MATCHES |
| N2 | Deactivated numbers drop out of rotation; a campaign whose attached numbers are all unusable holds (no claims, no pause) rather than falling back to the legacy single number; a campaign with no attachments uses the legacy pointer without advancing the cursor. | MATCHES |

## Explicitly NOT-YET-BUILT

Every scenario area in this matrix is implemented; no area is skipped. Known
absences outside the scenario areas, for completeness:

- A reserved-floor-and-burst cross-campaign allocator (D6's least-recently-dialed
  ordering is the stated placeholder).
- An escalating backoff ladder for repeated launch failures (X3's flat
  cooldown is the whole story).
- A writer for the `CALLING` contact status (counted defensively, never set).
