# Queue workers — battle test

The conformance suite is a precise regression gate and is blind to everything
this report is about. It drives ticks by hand on a virtual clock, in one
process, so it cannot see whether the queues keep the platform pool full,
whether two instances double-dial, or what a killed process does to the work it
was holding. The battle test runs the real engine on a real clock, at load,
across real processes, and asks those questions.

Eleven runs, three scenarios, **every run passed**. Generated report:
[`scripts/battle-report.md`](../scripts/battle-report.md); run it with
`npm run battle`.

| Scenario | Runs | Failed | Wall |
|---|---|---|---|
| multi-campaign concurrency | 3 | 0 | 662s |
| two instances, one Redis | 5 | 0 | 1054s |
| queue-failure semantics | 3 | 0 | 462s |

## How the runs are shaped

Real processes, spawned detached and killed by process group. One upstream mock
on a wall clock at `SIM_TIME_SCALE=3`, so an unscripted call lives about nine
seconds — long enough relative to the two-second dispatch tick that utilisation
measures the engine rather than the sweep interval. Contacts are seeded through
Prisma; campaigns are started over HTTP the way the dashboard starts them.

Every run gets its own ports and its own Redis database (11 or 12, reserved and
pinned in `scripts/battle-lib.ts`), and that database is flushed before the run
begins. `spawnBackend` sets `WORKERS_ENABLED=true` — under `NODE_ENV=test` the
workers default **off**, and without it an instance would serve HTTP and dial
nothing — and `DIALER_SWEEP_MS=2000`, which is why the sweep floor was lowered
from a minute to a second.

## 1. Multi-campaign concurrency, and utilisation

Three campaigns over two accounts, with different ceilings: `alpha-wide` (limit
6) and `alpha-lanes` (limit 4, reserving one retry slot) on an account allotted
9 lines, and `beta` (limit 5) on an account allotted 6. 190 contacts, mixed
outcomes from the mock's own weighted draw, against a platform pool of 14. The
engine is sampled twice a second for the whole run.

| Run | Utilisation | Samples | Longest stall | Dials | Peak |
|---|---|---|---|---|---|
| 1 | 88.2% | 429 | 1.5s | 233 | 14 |
| 2 | 88.7% | 422 | 1.0s | 239 | 14 |
| 3 | 88.2% | 382 | 1.5s | 231 | 14 |

**Utilisation is measured against the binding cap**, computed the way the engine
computes it: a campaign cannot exceed its own limit or the work it actually has,
an account cannot exceed its allotment across its campaigns, and nobody exceeds
the shared pool. Measuring against anything looser would fail a dialer for not
dialing contacts that do not exist. The first samples — before the first tick —
are excluded; everything after is graded.

The floor is **75% mean**, and separately **no six consecutive samples below
half the ceiling**, because a mean can hide a stall. Observed: ~88% mean and a
longest stall of one to one and a half seconds, which is less than one sweep
period. The remaining ~12% is the sweep interval itself: a slot freed just after
a tick waits for the next one, and at a two-second tick against nine-second
calls that is about what it costs. **Peak in-flight reached 14 — the whole
platform pool — in all three runs.**

Also asserted at every sample: no campaign over its `concurrencyLimit`, no
account over its allotment, and the mock's own concurrency ledger clean. Every
reference dialed exactly once, one attempt row per (contact, ordinal), and every
contact terminal.

**The reserved retry lane was exercised, not merely configured.** Each run
required at least one instant where `alpha-lanes` had a retry and a fresh call
live at the same time; the campaign is seeded with twenty already-due retries so
that state arises inside a run rather than after a cooldown the run outlives.

## 2. Two instances, one Redis, one Postgres

Two app processes, both running workers, against one Redis and one Postgres.
Two campaigns on two accounts, started through *different* instances so neither
is the only writer. Partway through, one process is **SIGKILLed with no warning
at all**, holding claimed contacts and open attempts. Nothing is restarted: the
survivor finishes the work.

| Run | Schedules | Dials | Peak | Contacts | Held by the killed instance | Final |
|---|---|---|---|---|---|---|
| 1 | 1 + 2 | 165 | 9 | 130 | 8 | 125 completed, 5 failed |
| 2 | 1 + 2 | 163 | 9 | 130 | 9 | 124 completed, 6 failed |
| 3 | 1 + 2 | 158 | 9 | 130 | 8 | 127 completed, 3 failed |
| 4 | 1 + 2 | 166 | 9 | 130 | 8 | 119 completed, 11 failed |
| 5 | 1 + 2 | 156 | 9 | 130 | 9 | 124 completed, 6 failed |

**No double-fired ticks.** Asserted at the mechanism rather than through a
proxy: with both instances up and both having registered the schedules, Redis
holds **exactly one** `campaign-dispatch` scheduler and no duplicate
`maintenance` keys. The logs corroborate it — over a ~210s run at a two-second
tick there are about 105 tick slots, and the two instances between them wrote
73–79 posting ticks, split across both processes (instance A 71–76, instance B
1–3 in its short life). Two independent schedules would have produced about
twice that, with each instance showing a full share of its own.

**Zero double-dials.** No `client_reference_id` was dialed twice at the mock, no
two attempt rows exist for one (contact, ordinal), and no attempt id appears
twice in the dial log — across five runs and ~800 dials.

**The caps hold under combined throughput.** Per-campaign limits (5 and 4),
per-account allotments (8 and 6) and the platform pool (12) were checked at
every sample of every run. Peak in-flight settled at 9, which is the sum of the
two campaign ceilings — the binding constraint here, not the pool.

**A SIGKILL loses no contact.** Each run killed an instance holding 8–9 claimed
contacts. All 130 contacts reach a terminal state in every run, recovered by the
survivor: the contacts sit `QUEUED` until the cleanup sweep gives them back, and
the placement and webhook jobs the dead worker was holding are redelivered by
BullMQ to the one that is still alive.

## 3. Queue-failure semantics

One instance, sixty contacts, SIGKILLed mid-batch with placements in flight and
completions arriving, then restarted on the same port against the same Redis and
Postgres.

| Run | Dials | Unresolved at the kill | Attempts charged | Final |
|---|---|---|---|---|
| 1 | 72 | 6 | 59 | 59 completed, 1 failed |
| 2 | 76 | 6 | 56 | 56 completed, 4 failed |
| 3 | 75 | 6 | 56 | 56 completed, 4 failed |

**A placement job that died after its dial-attempt insert did not redial.** Six
attempts were open at each kill. Afterwards: one attempt row per (contact,
ordinal), one dial per attempt row, and every reference dialed exactly once.
This is the property the whole retry policy rests on — the ordinal is fixed by
the tick, so a redelivered job re-finds the row its first run wrote and dials
under a reference the platform has already answered.

**A webhook job interrupted mid-flight still lands, exactly once.** No attempt
was charged twice — checked against the ledger, grouped by attempt — and no
completed call with a non-zero duration was left uncharged. The killed worker's
in-flight jobs came back to the restarted one and found the outcome's event key
already written where the transaction had committed, and absent where it had
not.

The narrower version of both — a job that *throws* and retries with backoff and
lands, and a job that throws after its transaction committed — is graded
deterministically by `test/webhook-queue.test.ts` and
`test/dialer-placement.test.ts` against a real BullMQ worker. This scenario is
the same properties at load and across a real process death, which is the shape
they actually take.

## What the harness found on the way

**The upstream mock delivered no webhooks at all for most time scales.** Scaled
milliseconds were left fractional, `AbortSignal.timeout()` refuses a fractional
delay with a `RangeError`, and that throw landed inside the emitter's catch —
which treats any failure as a failed delivery. So every attempt failed before
the request was made, the retry chain exhausted itself in milliseconds, and
`webhookFailures` stayed empty because only the manual-clock engine writes to
it. The mock reported a clean run in which calls lived their whole lifecycle and
no outcome ever arrived. Scale 20 divides 10 000 evenly and scale 3 does not,
which is why it survived until a load harness wanted slower calls. Fixed in the
mock; both scaled-time helpers now round to whole milliseconds.

**`npx` is not a stable way to start a child process.** An identical respawn
mid-scenario resolved a copy of `tsx` under `~/.npm/_npx`, which cannot see the
project's `node_modules`, and died on `Cannot find package 'express'`. Both
spawns now name the local binary.

## What this does not cover

- **A halt across campaigns in one pass.** The batch that met the wall stops;
  campaigns claimed later in the same tick have their own batch id and meet the
  refusal themselves. No scenario here forces that shape.
- **More than two instances**, and no instance count above what one laptop can
  run honestly.
- **Chaos delivery.** The mock can duplicate, delay and drop webhooks
  (`SIM_CHAOS=1`); these runs do not turn it on. Exactly-once is graded by the
  event key in the conformance suite and in the unit tests instead.
