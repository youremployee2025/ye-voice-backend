# Queue workers — task plan

Design: [`2026-08-31-queue-workers-design.md`](2026-08-31-queue-workers-design.md)

Baseline captured before any change: the conformance suite on this branch's
base, 13 scenarios / 43 rows / 0 failed runs. That report is the "before" half
of the diff every phase below is measured against.

One timer, one commit. A timer's `setInterval` is deleted only in the commit
that proves its queue replacement green.

## Phase 0 — foundation

- [x] `feat: add a Redis connection and the queue registry` — `bullmq` +
      `ioredis`; `src/lib/queue/connection.ts` (shared queue connection, worker
      connection factory, `maxRetriesPerRequest: null`); `src/lib/queue/types.ts`
      (queue names, job payload types).
- [x] `feat: define the five queues and their retry policies` — one module per
      queue, `defaultJobOptions` per the topology table. No workers yet.
- [x] `test: repeatable registration is idempotent across instances` — register
      the same repeatable key twice, assert one schedule. Fails until Phase 1.
- [x] `feat: bootstrap workers behind WORKERS_ENABLED, forced off under vitest`
      — `src/lib/queue/bootstrap.ts` with `startWorkers()` / `stopWorkers()`;
      the `VITEST` hard gate; `NODE_ENV=test` defaults off, overridable.
- [x] `feat: log unhandled rejections without exiting, and shut down in order`
      — workers, then queues, then Redis, on SIGTERM and SIGINT.
- [x] `feat: report queue counts on the admin surface` —
      `GET /api/admin/queues` behind the admin token.

## Phase 1 — campaign-dispatch

- [x] `feat: run the dial sweep from a repeatable dispatch job` — worker
      concurrency 1, processor is `runDialerSweep()` unchanged, interval
      `env.dialerSweepMs`.
- [x] `feat: floor the dial sweep interval at a second rather than a minute` —
      default unchanged at 60 000.
- [x] **Gate:** conformance green, verdicts identical to baseline.
- [x] `refactor: retire the dial sweep timer` — delete `startDialerSweep`.

## Phase 2 — call-placement

The riskiest phase. The tick stops dialing inline and starts posting jobs —
**post and move on**, never post-and-wait.

- [x] `feat: post one placement job per claimed contact` — the tick claims
      (unchanged), resolves each contact's from-number from the rotation
      (unchanged, base advanced once per batch), enqueues jobs carrying ids
      only (campaign, contact, from-number, attempt ordinal, batch id, the
      tick's clock), and decrements the pass budget and pool headroom by the
      **claimed** count.
- [x] `feat: place a claimed call from the queue, replay-safe` — the worker
      re-reads campaign + contact + rate, **re-checks the contact is still
      QUEUED for this campaign** (exits silently otherwise), and calls the
      existing `dialContact`. 3 attempts; the same `client_reference_id` on
      every retry, which is what makes the retries unable to double-dial.
- [x] `feat: release a dial the queue gave up on` — the worker's failed
      handler, final attempt only: release the contact through the existing
      give-back (timestamps preserved, callback pair intact).
- [x] `feat: fail the rest of a batch fast after a halt` — a job whose dial
      returns halt/stopCampaign sets a short-TTL Redis marker keyed by batch;
      later jobs in that batch see it, release their own contact, and never
      dial. Cross-instance by construction.
- [x] `test: a retried placement job cannot dial twice` — same reference, mock
      counts one dial.
- [x] `test: a job that dies after the dial-attempt insert does not redial`.
- [x] `test: a halted batch releases its remainder untouched`.
- [x] `feat: run a placement worker inside the conformance harness` — boot.ts
      starts one against a dedicated Redis DB; `tick()` drains the placement
      queue to quiescence before snapshotting.
- [x] **Gate:** conformance run. Verdicts identical outside the halt-semantics
      rows; any moved row is either re-graded `DIVERGES-DELIBERATE` with a
      written rationale (only if caused by posted-dial semantics — expected:
      scenario 09-transient-faults) or treated as a bug. The final report
      lists every re-grade.

## Phase 3 — campaign-cleanup

- [x] `feat: sweep stuck contacts on a five-minute cleanup job` — repeatable,
      calls `closeStaleAttempts`. The in-tick call **stays**.
- [x] **Gate:** conformance green (the in-tick cadence is unchanged, so the
      stuck-cleanup rows must not move).

## Phase 4 — maintenance

One commit per timer, each with its gate.

- [x] `feat: scan campaign schedules from a repeatable maintenance job`
- [x] `refactor: retire the schedule scan timer`
- [x] `feat: renew DIDs from a repeatable maintenance job`
- [x] `refactor: retire the renewal sweep timer`
- [x] `feat: ingest analytics from a repeatable maintenance job`
- [x] `refactor: retire the analytics sync timer`
- [x] `refactor: reduce worker.ts to an entrypoint over the bootstrap` — the
      last timer gone, the file is one line over `startWorkers()`.

## Phase 5 — webhook-processing

- [x] `feat: process a verified webhook on a queue` — handler verifies,
      enqueues, returns 200; worker does `applyTerminalOutcome` and the
      callback booking, 5 attempts, exponential backoff.
- [x] `test: a webhook job that throws retries with backoff and lands`
- [x] **Gate:** conformance green — the billing and exactly-once rows are the
      ones to watch.

## Phase 6 — battle test

Extend `scripts/battle-lib.ts` and the upstream mock. Never rebuild them.

- [x] `test: parameterise the battle harness by port and Redis database` —
      two instances need two ports and a flushable per-run Redis DB.
- [x] `test: multi-campaign concurrency with a utilisation report` — 3+
      campaigns, 2+ accounts, hundreds of contacts, mixed outcomes; ceilings,
      shared pool, lane reservation, and utilisation % with a failure
      threshold. 3 runs.
- [x] `test: two instances against one Redis and one Postgres` — zero
      double-dials, no double-fired ticks, caps hold, SIGKILL loses nothing.
      5 runs.
- [x] `test: queue failure semantics end to end` — 3 runs.
- [x] `docs: battle report`

## Phase 7 — close out

- [x] `docs: conformance diff, before and after`
- [x] `docs: record the queue topology and the new variables in CLAUDE.md`
- [x] `.env.example`: `CAMPAIGN_CLEANUP_MS`, and `REDIS_URL` promoted from
      declared to required.

## Not in this wave

- Agent / DID / tier sync on a schedule. They are admin-triggered today;
  scheduling them is new behavior, not a migration.
- A worker-only deployment. The bootstrap module makes it a one-line
  entrypoint and a `WORKERS_ENABLED=false` on the API service; actually
  splitting the Render services is a CD change, not a code change.

## What actually happened

Every phase landed and every gate was run. The notes worth keeping:

- **Placement concurrency is 1, not 4.** At 4 the conformance suite moved `D2`
  and `N1` — dial order within a batch — which are nothing to do with the halt
  semantics this wave was allowed to change. Lowering it holds both, and holds
  `X4` as well, so the after table is identical to the baseline in all 45
  verdicts. `webhook-processing` is 1 for the same reason: a single call's
  events are an ordered sequence.
- **No re-grades.** The design predicted the transient-fault rows would move and
  they did — at concurrency 4, before it was lowered. See
  `docs/2026-08-31-queue-workers-conformance-diff.md`.
- **The pass carries per-account claims.** `accountInFlight` counts attempt
  rows, and a posted claim has none until its job runs, so the second campaign
  of an account would re-spend the allotment the first had taken. The tick now
  carries claims forward exactly as it carries the budget and the pool.
- **The conformance harness runs two real workers**, placement and webhooks, on
  a pinned Redis database, and `tick()` drains both. `Driver.deliverPending()`
  exists because "delivered" stopped meaning "applied".
- **The upstream mock had a latent bug** that this harness was the first to hit:
  any `SIM_TIME_SCALE` that does not divide 10 000 evenly produced a fractional
  `AbortSignal.timeout()` delay, which throws, which the emitter's catch read as
  a failed delivery — so the mock delivered nothing at all and reported no
  failures. Fixed in the mock repo.
- **CI had no Redis.** The suite has required it since Phase 0; the workflow
  did not provide it.

## Still not in this wave

- Agent / DID / tier sync on a schedule. Unchanged reasoning: admin-triggered
  today, and scheduling them is new behaviour.
- Splitting the Render services. The code side is done — `worker.ts` is an
  entry point over `startWorkers()` — so it is a `startCommand` and a
  `WORKERS_ENABLED=false`, which is a CD change.
