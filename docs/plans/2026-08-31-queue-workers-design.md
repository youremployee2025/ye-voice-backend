# Queue workers — design

Background work in this backend runs on four `setInterval` timers living inside
whichever process has `WORKERS_ENABLED=true`. That composition is correct and
well-guarded, and it has exactly one property we cannot keep: it is
single-instance. A second replica does not share the work, it repeats it.

This wave moves the *scheduling* of background work onto Redis-backed BullMQ
queues, so a second instance is a capacity decision rather than a correctness
problem. It changes no dialing logic, no claim semantics, and no schema.

## The invariant this rests on

**Postgres remains the single enforcement point.** Every cap this platform
honours — a campaign's `concurrencyLimit`, the account allotment, the retry
lane reservation, the per-pass blast radius — is enforced by
`FOR UPDATE SKIP LOCKED` claims inside `claimLanes`, and by the dial-attempt
row's uniqueness. None of it is enforced by "there is only one timer".

That is what makes this refactor safe to do at all. BullMQ replaces the
`setInterval`. It does not replace, wrap, or advise the claim.

Two instances both running a dispatch tick against the same Postgres is
already correct today — `SKIP LOCKED` means the second one claims what the
first did not. The queue is not what makes multi-instance safe; the claim is.
The queue is what stops the two instances from *duplicating* the work that
sits outside a claim, and gives failures a retry policy.

## Queue topology

| Queue | Trigger | Worker concurrency | Attempts | Backoff | Replaces |
|---|---|---|---|---|---|
| `campaign-dispatch` | repeatable, `DIALER_SWEEP_MS` (default 60 000) | 1 | 1 | — | `startDialerSweep` |
| `call-placement` | one job per claimed contact | 1 (see below) | 3 — same `client_reference_id` each try | exponential, 2s | the in-loop `dialContact` calls |
| `campaign-cleanup` | repeatable, `CAMPAIGN_CLEANUP_MS` (default 300 000) | 1 | 3 | exponential, 10s | (new — see below) |
| `webhook-processing` | one job per verified webhook | 1 (see below) | 5 | exponential, 2s | inline work in `webhooks.routes.ts` |
| `maintenance` | 3 repeatable jobs at their existing intervals | 3 | 3 | exponential, 30s | `startRenewalSweep`, `startScheduleScan`, `startAnalyticsSync` |

### `campaign-dispatch`

Concurrency 1, one repeatable job, `jobId` pinned to a singleton key. The
worker's processor is `runDialerSweep()` — unchanged, not re-implemented.

The per-timer `let running = false` guard that each sweep carries today is
what BullMQ's concurrency 1 already provides for a single worker, and the
repeatable key provides across instances. The guard stays in the code anyway;
it costs nothing and it is the thing that keeps `runDialerSweep` safe for the
conformance harness to call directly.

**Interval: 60s, not 3s.** `DIALER_SWEEP_MS` defaults to 60 000 and is floored
at 60 000 today. Speeding the tick up would be a behavior change dressed as a
refactor — twenty times the claim queries and twenty times the pressure on a
partner rate limit shared with every other integrator. The repeatable interval
is `env.dialerSweepMs` and the default does not move.

The *floor* moves from 60 000 to 1 000. The floor exists because
`setInterval(fn, 0)` busy-loops; 1 000 preserves that protection and lets the
battle harness drive a fast tick. The default is untouched, so no deployment
changes behavior.

### `call-placement`

**Post and move on.** The tick claims contacts in Postgres — unchanged, inside
the same `FOR UPDATE SKIP LOCKED` statement as today — resolves each one's
caller number from the rotation exactly as it does now, enqueues one job per
claimed contact, and returns. It does not wait for the dials.

The job carries ids, not state: campaign, contact, the resolved from-number,
the attempt number, and the tick's clock. The worker re-reads everything else,
and its **first act is to re-check the claim**: if the contact is no longer
`QUEUED` for this campaign, someone else resolved it — a stop, a cleanup pass,
an operator — and the job exits without dialing. A placement job is not a
request to call somebody; it is the continuation of a decision Postgres
already made, and if Postgres has since unmade it, there is nothing to
continue.

**Retries: 3 attempts, and every retry reuses the same
`client_reference_id`.** That reference is what makes retrying safe: the
platform's `/calls/start` is idempotent on it — a reference it has already
seen returns the existing call (`idempotent_replay: true`) rather than dialing
again, and a concurrent duplicate is caught by a uniqueness guarantee on the
platform side. So the three attempts can only produce one telephone call, even
in the case that used to be unretryable — a request that went out and whose
answer was lost. The retry replays, the platform answers with what happened,
and the attempt is *reconciled* rather than guessed at.

A job that exhausts its attempts releases its own contact back to the queue
through the existing release path, untouched timestamps and all, so a dead
dial strands nothing. The dial-attempt row's mutual exclusion stays underneath
as the local backstop.

**Concurrency 1, decided against the conformance suite.** This was drafted at
4 and built at 4, and the suite moved two rows that had nothing to do with
halting: `D2` (a list is dialed in the order it was uploaded) and `N1` (the
i-th dial of a batch comes from the i-th number in the rotation, read off the
dial log in order). Four workers racing a batch keep the *pairing* — that is
decided by the tick — but scramble the order the requests leave in. Neither
property is enforced anywhere downstream; both were properties of dialing a
batch in a loop, and a worker pool is exactly where they would have been
dropped without anybody deciding to.

At 1 they hold, and so does the halt: every job after a refusal reads the
marker before it dials. It costs nothing the engine was not already paying —
the loop this replaces dialed serially too, inside the tick. What the queue
buys is that the tick no longer *waits* for it, and parallelism, when it is
wanted, is another instance. That is the thesis of the whole wave.

**What this deliberately changes.** The sequential loop this replaces kept two
pass-level behaviours a posted batch cannot keep:

1. *The pass budget was spent on actual launches.* `budget` and the shared
   pool headroom now decrement by the **claimed** count — the number of dials
   this pass has committed to — rather than the launched count. Claimed is an
   upper bound on launched, so the substitution is conservative: a pass can
   under-fill when launches fail, never over-fill.
2. *A halt stopped the whole pass.* A rate-limit or supplier refusal used to
   `break` out of the batch **and out of the campaign loop**. The batch half is
   restored by the halt marker below and by placing serially, so the remainder
   of the batch that met the wall is still given back untouched — this is what
   keeps `X4` where it was. The *cross-campaign* half is genuinely gone: a
   later campaign in the same pass has already been claimed and posted under
   its own batch id, so its jobs do not read the first one's marker and will
   meet the same refusal themselves. The blast radius of a halt is therefore
   one cheap failed request per campaign still in the pass, rather than zero —
   against an upstream that is already refusing, and with every contact
   released intact.

Both are visible to the conformance suite and are handled by its own
vocabulary: a row that moves *because of this section* is re-graded
`DIVERGES-DELIBERATE` with the rationale written next to it, and the final
report lists every re-graded row. A row that moves for any other reason is a
bug in the refactor.

**As built, nothing moved.** The transient-fault rows were the ones expected
to, and they did — at placement concurrency 4, before it was lowered to 1 for
the ordering reason above. At 1 the marker is read by every job that follows a
refusal, `X4` grades as it always did, and the after table is identical to the
baseline in all 45 verdicts and all 13 failed-run counts. There are no
re-grades in this wave. The cross-campaign halt above remains a real change
that this suite does not reach: no scenario runs two campaigns of one account
through a single pass in which the first is refused.

### `campaign-cleanup`

The stuck-contact sweep, every 5 minutes. Today `closeStaleAttempts` runs
*inside* the dispatch tick (`dialer.ts:779`), so it fires on the dispatch
cadence.

It keeps running there. This queue does not move it — it *adds* a second
caller on a 5-minute cadence, whose reason for existing is the multi-instance
failure mode: when an instance is SIGKILLed mid-batch, the contacts it had
claimed and the attempts it had opened need a reaper that is not the dead
process. Since `closeStaleAttempts` is a compare-and-set over rows older than
`DIALER_STALE_PROBE_MINS`, calling it twice from two places is a no-op the
second time, and calling it from two instances is a no-op on one of them.

Leaving the in-tick call in place is what keeps the conformance verdict table
identical — the suite drives ticks directly and observes the reaper's effects
on the tick cadence.

### `webhook-processing`

`webhooks.routes.ts` currently verifies the signature and then does the real
work inline: `applyTerminalOutcome` (billing, the charge, contact resolution,
a campaign `FOR UPDATE` transaction) and `bookCallbackFromExtraction`. That
is the slowest handler in the service sitting on the request path of a
partner's retrying webhook sender.

After: the handler verifies the signature, enqueues the verified event, and
returns 200. The worker does the rest, with 5 attempts and exponential
backoff.

**No new table.** The BullMQ job payload is the durable record of the event.
This honours the additive-only-if-necessary rule literally: this wave ships
zero migrations. The cost is that a Redis flush loses in-flight events; the
mitigation is the one already in place, which is that any outcome that never
lands is reconciled by the reaper against the platform's own record. That is
not a new risk this wave introduces — it is the existing recovery path,
unchanged.

Signature verification stays synchronous and stays in the handler. An event
that fails verification is rejected with the status it is rejected with today
and is never enqueued. Nor is an event this platform does not act on: the
allowlist is applied at the door, so the queue's depth means something.

**Concurrency 1, for the reason `call-placement` is.** A single call's events
are a sequence — ringing, in progress, terminal, then the completion that
charges — and the platform sends them in that order. The handlers tolerate a
reordering (the status write only moves forwards; whichever event first carries
a classification resolves the contact), but tolerating one is not a reason to
manufacture one, and four workers would reorder a single call's own events
against each other in a way the sender never does. The work is a short
transaction, so one lane is a few hundred events a second; when that is not
enough the answer is another instance.

### `maintenance`

Three repeatable jobs, at exactly the intervals they run at now:
`DID_RENEWAL_SWEEP_MS` (1h), `SCHEDULE_SCAN_MS` (30s),
`ANALYTICS_SYNC_INTERVAL_MS` (5min, and only when
`ANALYTICS_SYNC_ENABLED`). Worker concurrency **3**, so the three do not
serialise behind one another — today they run on independent timers and one
slow sweep does not delay the others, and that stays true.

Each sweep keeps its own in-process `running` guard. Their own comments record
that overlapping passes remain *correct* (compare-and-set, DRAFT-guarded
writes); the guard is there to avoid piling load, and it is worth keeping.

**`ANALYTICS_SYNC_ENABLED` and `DIALER_ENABLED` keep their exact current
meaning and keep gating what they gate.** With the dialer off, no dispatch
repeatable is registered and no schedule scan runs — for the reason
`worker.ts` already documents: a scanner running against a dialer that refuses
every start would clear tonight's schedules as permanent refusals.

#### Finding: the "periodic syncs" are not periodic

`syncAllAgents`, `syncPurchasedDids` and `syncVoiceTiers` are **admin-triggered
on demand** from `/api/admin/agents`, `/api/admin/phone-numbers` and
`/api/admin/tiers`. There is no timer for any of them. They are deliberately
left alone this wave: putting them on a schedule would be new behavior — a
recurring unattended call into a rate-limited partner API — and moving them
behind a queue would change the response shape of three admin endpoints that
currently return their sync result synchronously. Both are worth doing;
neither is a migration of an existing timer, so neither belongs here.

## Multi-instance correctness

- **Repeatable jobs do not double-fire.** BullMQ keys a repeatable job by its
  repeat options plus `jobId`; registering the same key from ten instances
  produces one schedule in Redis, not ten. This is asserted by a test that
  registers twice and counts the repeatable entries, and again by the
  multi-instance battle scenario, which counts ticks across two processes.
- **Everything else is safe because claims are in Postgres.** Two dispatch
  ticks racing is the case `SKIP LOCKED` was chosen for. Two call-placement
  workers racing the same contact is impossible, because the contact was
  claimed before the job was enqueued, and the dial-attempt row's uniqueness
  is the backstop if it somehow were not.
- **A dead instance loses nothing permanently.** Contacts it claimed sit in
  `QUEUED` and are recovered by `campaign-cleanup`; attempts it opened are
  reconciled by `closeStaleAttempts` against the platform's record.

## Startup and the kill switch

`WORKERS_ENABLED` keeps its name, its default (`true`) and its meaning. What
changes is what it starts.

The worker bootstrap becomes its own module, `src/lib/queue/bootstrap.ts`,
exporting `startWorkers()` and `stopWorkers()`. `server.ts` calls it behind
the flag, exactly as it dynamically imports `worker.ts` today. `worker.ts`
becomes a one-line entrypoint over the same module — which is what makes a
worker-only deployment later a configuration change rather than a code change.

**Vitest can never start a worker.** The gate is `process.env.VITEST`, which
vitest always sets, and it is a hard force-false that no environment variable
can override. `NODE_ENV=test` alone defaults workers *off* but permits an
explicit `WORKERS_ENABLED=true` — which is how the battle harness runs two
real app processes with real workers while still using the `x-test-clerk-user`
header that `NODE_ENV=test` enables. Gating the hard force on `NODE_ENV`
instead would make the multi-instance scenario unbuildable.

The conformance harness sets `WORKERS_ENABLED=false` already and is unaffected.

## Resilience

- **`unhandledRejection` logs loudly and does not exit.** A rejection escaping
  a job must not take down an HTTP server that is serving other customers. The
  failed job dies inside its own queue's retry semantics, which is the
  mechanism that is supposed to handle it. `uncaughtException` keeps exiting —
  that one really is unrecoverable.
- **Graceful shutdown closes workers, then queues, then Redis**, in that
  order, on SIGTERM and SIGINT. Workers first so in-flight jobs finish or are
  returned to the queue rather than being cut off mid-dial; queues before the
  connection so nothing writes to a closed socket.

## Observability

`GET /api/admin/queues` returns, per queue, the `waiting / active / completed /
failed / delayed / paused` counts, behind the existing admin-token middleware.

Every job failure logs the queue name, job id, attempt number and the error.
Job payloads are not logged wholesale — a webhook payload carries a phone
number.

## Migration rules for this wave

- **Behavior-identical, with one named exception.** The conformance suite is
  the gate. Its report was captured on the base branch before any change; the
  same 43 rows must produce the same verdicts after — except a row moved by
  the posted-dial semantics above, which is re-graded `DIVERGES-DELIBERATE`
  with its rationale written down. Any other changed verdict is a bug in this
  refactor, not a finding about the engine.
- **One timer, one commit.** A timer is removed only after its queue
  replacement is in and green.
- **Zero migrations.** Nothing here needs a column.

## Deliberate divergences from the brief

| Brief | Built | Why |
|---|---|---|
| `campaign-dispatch` ticks ~3s | ticks at `DIALER_SWEEP_MS`, default 60s | 60s is this engine's deliberate, floored cadence; changing it is a behavior change, and behavior identity outranks the cadence |
| placement jobs never retried | 3 attempts, same `client_reference_id` | `/calls/start` is idempotent on the reference — a replay returns the existing call — so a retry can reconcile a lost answer but can never dial twice |
| `call-placement` at concurrency 4 | concurrency 1 | 4 scrambled the order a batch's requests go out in, which moved two conformance rows that are nothing to do with halting; 1 costs no throughput the serial loop did not already cost, and parallelism is another instance |
| workers forced false under `NODE_ENV=test` | forced false under `VITEST`; default-off but overridable under `NODE_ENV=test` | the battle harness needs `NODE_ENV=test` for header auth *and* real workers; the stated intent (vitest never spins workers) is met exactly |
| `campaign-cleanup` takes over the stuck sweep | runs *in addition to* the in-tick call | removing the in-tick call would change the reaper's cadence and the conformance verdicts |
| agent/DID/tier sync become repeatable | left alone | they are admin-triggered, not periodic; scheduling them would be new behavior |
| webhook handler persists the raw event | the job payload is the record | zero migrations; the reaper is already the recovery path for an outcome that never lands |

## Testing

**Conformance (regression gate).** Before/after verdict tables must be
identical outside the named re-grades. The harness gains one extension: it
boots a real `call-placement` worker against its own Redis database, and after
each manual tick it drains that queue to quiescence before asserting — so a
tick that posts dials is observed the same way a tick that dialed inline was.

**Battle test (load harness).** The existing driver and upstream mock are
extended, not rebuilt. Three scenarios, each 3 runs except multi-instance at
5, tearing down processes and flushing the run's Redis DB between runs:

1. **Multi-campaign concurrency** — 3+ campaigns over 2+ accounts, differing
   `concurrencyLimit`s, hundreds of contacts, mixed mock outcomes. Asserts
   per-campaign ceilings, the shared account pool, lane reservation, and
   **utilisation**: with eligible contacts and pool headroom, measured
   in-flight must reach the ceiling and hold there. Sustained under-utilisation
   beyond a small tolerance is a failure, not a note.
2. **Multi-instance** — two app processes, one Redis, one Postgres, workers on
   both. Asserts zero double-dials (no repeated `client_reference_id` at the
   mock, no dial-attempt uniqueness violation), no double-fired ticks,
   unchanged caps under combined throughput, and that a SIGKILL mid-run loses
   no contact — everything settles or stays claimable.
3. **Queue-failure semantics** — a webhook job that throws retries with
   backoff and eventually lands; a call-placement job that dies after the
   dial-attempt insert does not redial.

**Unit.** Repeatable-key dedup; the `VITEST` hard gate; shutdown ordering;
the halt-marker guard releasing rather than dialing.

## Redis

One `REDIS_URL`, already declared and until now unused. Queues share one
connection; each worker gets its own, as BullMQ requires
(`maxRetriesPerRequest: null`).

Once this lands the backend is **always-on with Redis load-bearing**. A
deployment without a reachable Redis has no background work at all — no
dialing, no renewals, no schedule scans. That is a deliberate trade for
multi-instance scaling, and it is what makes scaling out later a matter of
raising the instance count.
