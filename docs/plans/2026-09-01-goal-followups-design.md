# Goal-driven follow-ups — design

A campaign can define a **goal**: a set of required extraction keys to collect
from each contact. A connected conversation that achieves only part of the goal
no longer settles the contact — a follow-up call is scheduled, and every later
call carries the context of the previous attempts (what is already collected,
what is missing, what happened last time). A campaign with no goal keys behaves
exactly as today; the feature must be behaviorally invisible when off.

Base: `main` @ 40e2dd2 (queue-workers merged via PR #20 — queue-based webhook
processing, conformance suite, battle harness). Dashboard base: `main`.

## Decisions already made (do not relitigate)

- Goal definition is per campaign; `goalKeys` editable only in DRAFT, the three
  policy knobs also editable while PAUSED / CREDIT_EXHAUSTED.
- `maxTotalDials` is a hard cap across ALL attempt kinds — fresh + retries +
  callbacks + follow-ups. Default 6, range 1..15, reject-don't-clamp.
- `maxGoalFollowUps` default 2, range 0..5. `followUpDelayHours` default 24,
  range 1..168.
- Partial + budget exhausted settles `COMPLETED` with `goalAchieved=false` —
  never FAILED; they did talk to us.
- Opt-out is a workspace-wide **do-not-call list keyed by phone** (survives
  contact deletion/re-import), written when any call extracts `do_not_call`
  truthy, checked at claim time. Always on; not a knob.
- The optional narrative summary is **platform extraction**, not a separate
  LLM call: a managed `call_summary` extraction key attached to the agent the
  way `callback_requested_at` is, behind `GOAL_SUMMARY_LLM=off|on` (default
  off). Cached on the context record; never computed at dial time.
- Lead buckets stay exactly as they are (latest extracting call); they do not
  read the merged record.

## Schema

**`Campaign`** gains:

```prisma
goalKeys           String[] @default([])  // empty = feature off
maxTotalDials      Int      @default(6)
maxGoalFollowUps   Int      @default(2)
followUpDelayHours Int      @default(24)
```

Validation joins the dialing policy in `src/lib/campaignConfig.ts`
(reject-don't-clamp: 1..15, 0..5, 1..168). `goalKeys` must be names the
campaign's agent declares in its extraction schema and must not collide with
the reserved keys — same source and check as `leadBucketKey`. Edit gating
extends the existing PATCH change-list: DRAFT edits everything;
PAUSED/CREDIT_EXHAUSTED may change the three policy knobs but never `goalKeys`.

**`CampaignContact`** gains `followUpCount Int @default(0)` (third counter
beside `attempts` and `callbackCount`) and `goalAchieved Boolean?` (null = no
goal, or not yet settled).

**New model `CampaignContactGoal`** — the context record, one row per
campaign-contact (unique FK):

```prisma
model CampaignContactGoal {
  id                String   @id @default(uuid())
  campaignContactId String   @unique
  mergedExtraction  Json     @default("{}")
  attemptLog        Json     @default("[]")
  summaryNote       String?
  updatedAt         DateTime @updatedAt
  campaignContact   CampaignContact @relation(...)
}
```

`attemptLog` entries: `{ attemptNo, kind: fresh|retry|callback|follow_up,
disposition, answeredBy, callbackNote?, durationSecs?, collectedKeys[] }`.
Bounded by `maxTotalDials <= 15`, so a Json log is safe.

Merge rule, and the idempotency story in one sentence: the log is keyed by
`attemptNo` (replaying an attempt replaces its own entry, changing nothing),
and in `mergedExtraction` a later non-empty value wins while an empty value
never erases a collected one.

**New model `DoNotCall`**: `workspaceId`, `phone` (E.164), `reason`,
`sourceCampaignContactId?`, `@@unique([workspaceId, phone])`.

## Resolution decision table (the heart)

In `resolveContact` (`src/services/dialerOutcome.ts`), only the
settle-as-COMPLETED branch changes, and only when `goalKeys` is non-empty —
re-read live inside the transaction, the way `retryCount` already is:

| Situation at a CONNECTED resolution | Outcome |
|---|---|
| `do_not_call` extracted truthy (any call) | settle `COMPLETED`, write DNC row, journey says why |
| all `goalKeys` collected across attempts | `COMPLETED`, `goalAchieved = true` |
| partial ∧ `followUpCount < maxGoalFollowUps` ∧ dials < `maxTotalDials` | re-arm `PENDING`, `nextEligibleAt = now + followUpDelayHours` rolled into the dial window (`rollIntoDialWindow`), `followUpCount + 1`, `callbackAt` untouched |
| partial ∧ budget exhausted | `COMPLETED`, `goalAchieved = false` |

Non-connected outcomes keep today's retry semantics untouched, except the
absolute cap: for goal campaigns the retry re-arm, the callback booking
(`scheduleCampaignCallback`), and the claim CTE (`dialerClaim.ts`) all
additionally refuse past `maxTotalDials`. Dials are counted as
`MAX(attemptNo)`, which `unique(campaignContactId, attemptNo)` makes exact.

Races: the follow-up re-arm is guarded by the same `claimed` predicate as
every resolution write — a lost race drops the write, never double-schedules.
A callback booked during a follow-up conversation rides the existing engine
unchanged and counts against the cap; an explicit `callbackAt` beats the
follow-up delay because the callback lane already claims first (they told us
when to call).

The context-record update runs in the `webhook-processing` worker beside
`applyTerminalOutcome` — exactly-once via the existing `WebhookEvent` key,
plus merge-by-attemptNo idempotency underneath it, so replaying the same
`session.completed` changes nothing either way.

Opt-out at claim time: the claim CTE joins the contact's phone against
`DoNotCall` for the workspace and skips (settles `EXCLUDED` with a journey
note) any contact on the list — current and future campaigns alike.

## Variable contract

`variablesFor` in the dispatcher (`src/services/dialer.ts`), for goal
campaigns only, overlays a reserved block on every dial:

| Variable | Content |
|---|---|
| `previous_attempts` | count of prior dials |
| `last_call_note` | deterministic one-liner: "first call" / "asked to be called back on <date>" / "call dropped after 2 answers" |
| `collected_summary` | "name, city" — keys already collected |
| `missing_fields` | "8 of 10 remaining: <names>" |
| `goal_state` | `not_started` / `partial` / `achieved` |

All are deterministic renders of the context record, read at placement time
(one indexed query per dial). Nothing is ever computed at dial time.

With `GOAL_SUMMARY_LLM=on`, campaign start additionally attaches a managed
`call_summary` extraction key (reserved beside `do_not_call` in
`src/lib/extractionConfig.ts`, attached the way `callback_requested_at` is —
failures logged and notified, never blocking). Its extracted value is cached
on the context record (`summaryNote`) and, when present, replaces the
deterministic `last_call_note` on the *next* dial. Flag default `off`; a
missing or failed summary silently falls back to the deterministic line.

Reserved keys (`do_not_call`, `call_summary`) are rejected as `goalKeys` and
as `leadBucketKey`.

## Dashboard

- **Goal editor** in `settings-tab.tsx` DRAFT form and `campaigns/new`: key
  picker fed from the agent's declared extraction keys (the `leadBucketKey`
  source), the three policy fields with reject-range hints, and a plain-words
  cost sentence in the `retryCostSentence` style ("A contact may be called up
  to N times in total…"). Mid-campaign form exposes only the three knobs.
- **Contacts tab**: goal progress ("4 of 10 collected"), follow-up pips
  visually distinct in `AttemptPips` / `attemptTally`, opt-out badge
  prominent.
- **Journey**: per-attempt context notes; follow-up rows distinct from
  retries and callbacks.
- **Overview**: goal-achieved % tile (achieved / settled with a goal) and a
  collected-fields distribution (one groupBy over context records — cheap).
- Nothing under `components/analytics/` or the analytics routes is touched.

## Guardrails (each one tested)

1. `maxTotalDials` is absolute: nothing — retry, callback, follow-up — dials
   past it.
2. Opt-out is permanent per workspace+phone, checked at claim time, and the
   journey says why.
3. Never two goal-driven conversations inside `followUpDelayHours`; the dial
   window is always respected; an explicit callback time beats the follow-up
   delay.
4. Race-guarded like the existing resolution paths; a lost race drops the
   write, never double-schedules.
5. The pipeline is idempotent: replaying the same `session.completed` changes
   nothing.
6. `goalKeys = []` is behaviorally invisible — zero verdict changes across
   the existing 46 conformance rows.

## Verification

- TDD throughout; unit + integration tests per guardrail.
- Conformance: new goal scenarios in the matrix; the existing rows must show
  **zero verdict changes**.
- Battle driver + vocobase-mock (`/_sim/script` extended to script per-dial
  extraction values): five goal scenarios — 3-attempt convergence to
  achieved, budget exhaustion, mid-journey opt-out, callback↔follow-up
  interleaving, replay idempotency — 3 runs each.
- `docs/goal-campaigns-agent-guide.md`, customer-facing ("the voice
  platform", no internals): the variables the platform supplies, a worked
  prompt block, and the rule that the agent must never re-ask collected
  fields.

## Known limitations

- ~~**Lowering `maxTotalDials` mid-campaign can strand contacts.**~~
  **Retired in review.** Accepting it was wrong: the same predicate stranded
  contacts for reasons no operator chose, because `attemptNo` counts the rows
  `rollbackLaunch` closes for launches that never reached the platform — six
  transient 502s spent a contact's whole dial budget without dialing them
  once. So the cap now counts **placed** attempts only (`lib/dialBudget.ts`),
  and `sweepContactsOverDialBudget` settles a PENDING contact past it —
  in the dispatcher pass, so no upstream weather can leave one unreachable,
  and in the PATCH transaction, the analogue of the `retryCount` sweep four
  lines away.
- **Attempt rows from before the kind stamp under-report.** Rows created
  before `CallAttempt.kind` existed fall back to the ordinal alone — the
  first dial reads as `fresh`, everything after it as `retry` — so callbacks
  among them are under-reported in the journey and the context record's log.
  Already commented at `deriveKind` in `webhookOutcome.ts`; the fallback
  never flips between deliveries, which is the property that matters.
- **A retry OF a follow-up is stamped `follow_up`.** The claim reads only
  `followUpCount`, which cannot distinguish "armed by the goal re-arm" from
  "armed by the retry ladder after a follow-up hit voicemail". Accepted over
  inventing a column recording which re-arm armed the row; the label is
  still derived purely from facts frozen at claim time.
- **A promise can be lost to a crash between the outcome commit and the
  booking.** A webhook job that dies after `applyTerminalOutcome` commits but
  before `bookCallbackFromExtraction` runs sees `duplicate`/`already_closed`
  on redelivery, and the booking is gated on `applied` — so that delivery's
  callback promise is not re-attempted. Pre-existing gate (predates this
  wave); the crash-survival hardening deliberately covered the context
  *record* (which re-records on every attempt-naming result) and not the
  booking. The contact still follows its normal retry/follow-up path.
