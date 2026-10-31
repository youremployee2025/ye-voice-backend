# Campaign Engine Conformance Report — 2026-08-31

The scenario suite specified in
[`docs/plans/2026-08-31-campaign-conformance-design.md`](plans/2026-08-31-campaign-conformance-design.md)
was built and run against the dial engine on `main`. This report is the
verdict table it produced, with run statistics and the honest list of what
the suite does not cover. Re-run with:

```bash
npm run conformance                      # every scenario, default repetitions
npm run conformance -- --scenario billing --runs 1
npm run conformance -- --seed 4242       # alternate seed base
```

Requirements: the local sim Postgres (`localhost:5436`, database
`ye_voice_conformance`, migrations deployed), the sibling `vocobase-mock`
checkout with dependencies installed, and free ports 3941/4021. The suite
hard-aborts on any other database, any non-loopback upstream, and any busy
port; it never touches a remote system or real telephony.

Row G6 (a completed call whose `session.completed` lands after its classified
`call.status.updated`) needs `vocobase-mock` at commit `d46c5a8` or later —
"Emit call.status.updated before session.completed for completed calls" — which
is the first version of the mock that emits the two events as separate steps
with the classification on the status event. An older mock passes the row
vacuously, because it never produces the ordering the row exists to catch.

## Headline

**No DIVERGES-BUG was found.** All 43 graded matrix rows hold: 32 MATCHES and
11 DIVERGES-DELIBERATE, every deliberate divergence behaving exactly as its
design rationale says. No scenario area is NOT-YET-BUILT — the engine
implements every behavior area in the matrix.

## Run statistics

| Invocation | Scenarios | Runs | Failures |
|---|---|---|---|
| Full suite, seed base 1000 | 13 | 53 | 0 |
| Full suite, seed base 4242 | 13 | 53 | 0 |
| Earlier full invocations during hardening (12 scenarios) | 12 | 150 | 0 |

Concurrency-sensitive scenarios repeat 10× per invocation (`exactly-once`,
`transient-faults`); everything else 3×. One full invocation places ~400
scripted calls and completes in under 15 seconds of wall time — the virtual
clock pays for 30-minute cooldowns and 60-minute reaper timeouts with clock
steps, not waiting.

## Scenarios

| Scenario | Matrix rows | Repetitions | What it proves |
|---|---|---|---|
| basic-drain | D1 D2 L6 | 3 | FIFO claim order, one dial per contact, counters, auto-complete |
| concurrency | D6 D7 D8 D9 | 3 | campaign + account ceilings never pierced; claimed work occupies a line; no starvation between two campaigns of one account |
| lane-budgets | D3 D4 | 3 | retry-lane reservation splits a full sweep one-and-one; the idle reserved slot is lent to fresh work |
| retry-matrix | R1 R2 R3 R4 | 3 | the full outcome classification table; budget enforced at claim and resolution; ladder timing from the engine's own timestamps |
| retry-budget-lowering | R5 CB2 | 3 | lowering `retryCount` sweeps over-budget waiters SKIPPED; armed callbacks are exempt and their promises are still kept |
| callbacks | CB1–CB6 | 3 | the armed equality, oldest-promise-first, the 3-callback cap, window rolling at booking, YE's extraction key + fallback, date-only and too-soon refusals |
| dial-window | W1 W2 | 3 | a closed per-campaign window claims nothing and touches nothing; claiming resumes at opening; half-configured windows fail closed |
| lifecycle | L1–L5 L7 L8 CB4 D10 | 3 | pause/resume/stop/complete guards, stop's permanent marker blocking top-up and callback booking, top-up dedupe + reopen-to-PAUSED, credit-exhaustion auto-pause and funded resume |
| exactly-once | X1 X2 | 10 | four dispatch passes racing one queue place one call per contact; replayed idempotency keys never redial; retries carry fresh keys |
| transient-faults | X3 X4 X5 | 10 | give-backs consume nothing; 429 halts the pass, 403 pauses the campaign, 400 settles only its contact; an unconfirmed write is never double-dialed |
| stuck-cleanup | S1–S4 | 3 | lost-webhook calls reconcile to the same outcome and charge; unconfirmed launches abandon onto the retry budget; a late webhook after a reconcile changes nothing |
| billing | B1–B4 | 3 | charge only at terminal outcome, on the dial-time snapshot; increment round-up and truncating division; zero-duration calls free; duplicate completions charge nothing; shortfalls fail closed |
| rotation | N1 N2 | 3 | cursor rotation in attachment order with per-attempt from-number snapshots; deactivated numbers drop out; all-unusable holds without pausing and recovers alone |

## Verdicts

Every row's full statement of expected behavior is in the design doc; this
table is the outcome. D5 (sweep cadence and the per-sweep call budget) is
graded by configuration inspection, not by scenario — the suite drives sweeps
itself, so cadence is not observable from inside it.

| Rows | Verdict |
|---|---|
| D1 D2 D3 D4 D7 D8 D9 | MATCHES |
| D5 D6 D10 | DIVERGES-DELIBERATE |
| X1 X2 X5 | MATCHES |
| X3 X4 | DIVERGES-DELIBERATE |
| R1 R2 R3 R4 R5 | MATCHES |
| CB1 CB2 CB3 CB4 CB5 | MATCHES |
| CB6 | DIVERGES-DELIBERATE |
| W1 | DIVERGES-DELIBERATE |
| W2 | MATCHES |
| L1 L2 L3 L4 L5 L6 L7 L8 | MATCHES |
| S1 S3 | DIVERGES-DELIBERATE |
| S2 S4 | MATCHES |
| B1 B3 | MATCHES |
| B2 B4 | DIVERGES-DELIBERATE |
| N1 N2 | MATCHES |

### The deliberate divergences, with their observed behavior

- **D5 — sweep cadence.** 60-second sweeps with a per-pass call budget (25),
  vs the baseline's 3-second dispatch tick. A partner polling its upstream
  paces itself; the budget bounds any one pass's blast radius.
- **D6 — campaign ordering.** Least-recently-dialed-first across campaigns.
  Observed: two campaigns on one shared pool both complete fully, no
  starvation, in every run.
- **D10 — credit pre-check.** A flat configurable floor (1 display credit)
  instead of a modeled 30-second-call estimate. Observed: the sweep parks the
  campaign `CREDIT_EXHAUSTED` the pass after the balance dips below the floor.
- **X3 — transient launch backoff.** One flat campaign cooldown instead of a
  30 s/180 s two-tier requeue; upstream 5xx retried rather than terminal.
  YE's launch failures are partner-API failures, not carrier verdicts, and
  the sweep cadence already floors any retry at a minute. Observed: attempts
  untouched, the failed-launch attempt row closed, redial after exactly one
  cooldown.
- **X4 — launch-failure triage.** Status-specific handling (429 halts the
  pass, 403/404 pause the campaign, 400 alone settles the contact) instead of
  a transient/terminal split. Observed as specified, including the released
  remainder of a halted batch being untouched.
- **CB6 — callback key and parsing.** `callback_requested_at` as YE's own
  extraction key (`callback_at` read as fallback only), date-only promises
  rejected rather than defaulted to noon, naive times read in the campaign's
  timezone.
- **W1 — per-campaign dial window.** `fromTime`/`toTime`/`timezone` per
  campaign, open when unset, fail-closed when half-configured — a superset of
  a fixed 9-to-21 account-timezone window, for clients calling across
  jurisdictions.
- **S1/S3 — stuck handling.** One 60-minute timeout plus reconciliation
  against the platform's call detail, instead of three wall-clock stuck
  classes; unknown outcomes close `ABANDONED` (not `FAILED`) and retry on the
  contact's budget rather than settling terminally. A partner can ask its
  upstream what happened; an engine that owns the call stack cannot.
- **B2/B4 — pricing and shortfall.** Per-tier rate with a configurable
  billing increment, no connection charge, truncating division in the
  customer's favor; an unpayable charge debits nothing (shortfall marked,
  zero-amount ledger row, campaign paused broke) instead of clamping the
  debit to the remaining balance — the ledger never understates a call.

## NOT-YET-BUILT

No scenario area. For completeness, absences outside the matrix's scenario
areas (from the design doc): the reserved-floor-and-burst cross-campaign
allocator, an escalating backoff ladder for repeated launch failures, and a
writer for the `CALLING` contact status.

## What the suite does not cover

Honest limits, so a green table is read for what it is:

- **Virtual/wall clock drift.** The engine stamps wall-clock times on webhook
  resolutions while the suite injects virtual sweep times, so once the clock
  has been advanced past one cooldown, later cooldowns are already elapsed in
  virtual terms. Timing rows are therefore asserted from the engine's own
  timestamp pairs (`nextEligibleAt` − `resolvedAt`), which is exact; only the
  *first* wait in any chain is also observed as elapsed virtual time.
- The armed-callback arms of the give-back write (promise slipped vs held on
  a transient launch failure) are exercised only through the general
  give-back path, not each arm separately; those arms are covered by the
  repo's unit tests.
- Classification arrival order is modeled once: carrier-failure statuses
  classify on the status event, `completed` classifies on the completion
  event. The mock can force other orders (`classify_on_status`) but no
  scenario sweeps all orderings.
- Campaign scheduling (`scheduledStartAt` and the scan loop), the upstream
  rate-limit sliding window, the 200-campaign scan cap and the reaper's
  50-row batch cap, and the 404-agent-upstream pause are not scenario-ized.
- The suite runs one engine process (with in-process concurrent sweeps for
  the races); it does not run two separate backend processes.
