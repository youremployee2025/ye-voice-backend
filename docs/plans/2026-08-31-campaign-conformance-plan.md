# Campaign Engine Conformance Suite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A runnable, deterministic scenario suite (`npm run conformance`) that
drives the real dial engine against the local upstream mock, produces an
ordered trace per scenario, and grades every row of
`2026-08-31-campaign-conformance-design.md` as MATCHES / DIVERGES-DELIBERATE /
DIVERGES-BUG, with a committed report.

**Architecture:** The backend runs **in-process** (the express app listens on a
loopback port for webhooks; no worker timers start), and the suite drives sweeps
directly via `runDialerSweep({ now })` with a virtual clock — the only way to
express 30-minute cooldowns and 60-minute reaper timeouts without touching the
engine. The upstream mock (`../vocobase-mock`, its own repo) is spawned as a
child process in a new **manual-clock, scripted** mode: the driver POSTs
`/_sim/advance` with the virtual now and the mock fires every due lifecycle
transition and delivers every webhook synchronously before responding, giving
deterministic ordering. Scenarios are declarative data: campaign config +
contacts + per-attempt scripted outcomes/durations/faults + a clock program;
the runner assembles a TRACE (ordered dials with attempt numbers and
from-numbers, contact/campaign state transitions, counter deltas, ledger
writes) from the mock's dial log plus DB snapshots between steps.

**Tech Stack:** tsx scripts (no vitest — scenarios repeat 3–10× and want a
custom report), Prisma against the dedicated local sim DB
(`localhost:5436/ye_voice_conformance`), the existing battle-driver patterns
(preflight DB guards, process-group spawn/kill for the mock, polling, report
writer) carried forward.

**Safety rails (from the battle driver, kept):** hard abort unless the DB URL
is localhost:5436 and the database name is `ye_voice_conformance`; hard abort
on any URL containing `neon.tech`; the mock refuses non-loopback webhook
targets; no real telephony anywhere.

---

### Task 1: Mock — scripted outcomes & manual clock (repo `../vocobase-mock`)

- `SIM_MANUAL_CLOCK=1`: lifecycle transitions are queued on a virtual
  timeline instead of `setTimeout`; `POST /_sim/advance {nowMs}` fires all due
  transitions in timestamp order and awaits webhook delivery (no retries/chaos
  in this mode) before responding with what fired.
- `POST /_sim/script`: rules keyed by `to_number` + occurrence index (nth
  accepted call to that number): terminal `status`, `disposition`,
  `answered_by`, `duration_seconds`, per-stage delays, optional
  `extraction` values for `session.completed`, and optional pre-accept fault
  (`http_502` / `drop` / `timeout`) consumed before a call is created.
  Unscripted calls keep the seeded-RNG behavior.
- New endpoints the current engine requires: `GET /api/v2/calls/:id`
  (reaper reconcile; includes session extraction) and
  `POST /api/v2/voicelink/call-ready` (campaign start gate; scriptable
  refusal). Record `from_number` in the dial log.
- Commit per endpoint/mode in vocobase-mock.

### Task 2: Harness core (`scripts/conformance/` in this repo)

- `lib.ts`: preflight guards, env bootstrap (set `process.env` before any
  `src/` import: DB URL, `VOCOBASE_API_URL` → mock, webhook secret ≥32 chars,
  `DIALER_ENABLED=true`, `NODE_ENV=test`), in-process app boot on an ephemeral
  port, mock spawn/kill (process group), truncate + seed (account, workspace,
  agent, tier, numbers) via Prisma.
- `clock.ts`: virtual clock; `tick()` = `runDialerSweep({ now })` → mock
  `/_sim/advance(now)` → repeat until quiescent within the step.
- `scenario.ts`: declarative `Scenario` type + runner (setup → clock program →
  trace assembly → assertions → verdict per matrix row).
- `trace.ts`: trace assembly from mock dial log + DB deltas (CampaignContact,
  Campaign counters, CallAttempt, CreditTransaction) with virtual timestamps.
- `report.ts`: per-run and aggregate report writer (verdict table, run stats).
- `package.json`: `"conformance": "tsx scripts/conformance/run.ts"` (+
  `--scenario`, `--runs`, `--seed`).
- Smoke scenario: 2 contacts, both answer → engine dials via mock, webhooks
  land, contacts COMPLETE, campaign auto-completes. Commit.

### Task 3: Scenarios (one commit each; matrix IDs in parentheses)

1. `basic-drain` (D1, D2, L6): N answer-all contacts; assert dial order,
   counters, terminal statuses, auto-complete.
2. `concurrency` (D7–D9): campaign limit + two campaigns of one account
   sharing the pool; peak in-flight assertions from the trace.
3. `retry-matrix` (R1–R4): one contact per outcome class; assert
   retry-vs-permanent, ladder timing, budget enforcement at both ends.
4. `retry-budget-lowering` (R5): lower retryCount mid-flight; assert sweep +
   claim refusal, armed callback exempt.
5. `callbacks` (CB1–CB6): scripted extraction books promises; assert
   arming invariant, oldest-promise-first priority, budget exemption, max 3,
   window rolling, campaign re-open.
6. `dial-window` (W1, W2): closed window → nothing claimed, timestamps
   untouched; opens → claims resume; overnight wrap.
7. `lifecycle` (L1–L8): pause mid-tick, stop with in-flight calls, complete
   relabel, top-up dedupe/reopen, credit exhaustion + resume re-check.
8. `exactly-once` (X1, X2): two concurrent sweeps racing the same contacts →
   one call each; idempotent replay probe. Run 10×.
9. `transient-faults` (X3–X5): scripted 502/timeout/429/403/400 launches;
   assert give-back semantics, no attempt consumed, halt/pause behavior. 10×.
10. `stuck-cleanup` (S1–S4): freeze webhooks for chosen calls, advance past
    the timeout; assert reconcile-and-charge, ABANDONED retry path, no
    double charge.
11. `billing` (B1–B4): scripted durations vs increment; assert charge math,
    once-per-attempt, shortfall fail-closed.
12. `rotation` (N1, N2): multi-number campaign; assert modulo assignment from
    the trace's from-numbers, deactivation drop-out, hold-when-none.

### Task 4: Full runs + report

- Default runs: 3× per scenario, 10× for `exactly-once` and
  `transient-faults`, distinct seeds.
- `docs/2026-08-31-campaign-conformance-report.md`: scenario × verdict table,
  every DIVERGES-* with repro/rationale, run stats. Commit.

### Task 5: Docs

- README/CLAUDE.md note for `npm run conformance` + the sim DB it requires.
