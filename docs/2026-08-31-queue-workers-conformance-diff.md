# Conformance, before and after the queue-worker wave

The campaign-engine conformance suite is this wave's regression gate. It drives
the real dial engine on a virtual clock against the local upstream mock and
grades a 45-row behaviour matrix over 13 scenarios. Every phase of the refactor
was measured against the same baseline, and the rule was stated before any code
moved: a row that changes **because of the posted-dial semantics** is re-graded
`DIVERGES-DELIBERATE` with its rationale written down; a row that changes for
any other reason is a bug in the refactor.

## The result

**Nothing moved.** All 45 verdicts and all 13 per-scenario failed-run counts are
identical to the baseline. There are **no re-grades in this wave**.

| | Before | After |
|---|---|---|
| Scenarios | 13 | 13 |
| Verdict rows | 45 | 45 |
| Failed runs | 0 | 0 |
| `MATCHES` | 35 | 35 |
| `DIVERGES-DELIBERATE` | 10 | 10 |
| `DIVERGES-BUG` | 0 | 0 |

The ten `DIVERGES-DELIBERATE` rows (`D6`, `D10`, `X3`, `X4`, `CB6`, `W1`, `S1`,
`S3`, `B2`, `B4` — as graded by `ROW_BASE`) are the engine's pre-existing,
documented divergences from the behaviour matrix. This wave neither added to
them nor resolved any. An earlier draft of this table said 36/9 — a counting
error; the list below it always carried ten ids. `ROW_BASE` declares a 46th
row, `D5` (sweep cadence), which no scenario machine-grades: it is graded by
configuration inspection and now appears in the results table saying exactly
that, rather than being silently dropped from the count.

The baseline is kept beside the suite as
[`scripts/conformance-results/baseline-before-queues.md`](../scripts/conformance-results/baseline-before-queues.md),
and `scripts/conformance-results/latest.md` is the current run. Wall times
differ between runs and are not part of the comparison; verdicts and
failed-run counts are.

## The two rows that did move, and what was done about them

Zero movement was not the first result. Two rounds of movement were found and
each was resolved by changing the thing that had actually broken.

### `D2` and `N1` — dial order, at placement concurrency 4

The design specified the `call-placement` worker at concurrency 4, and at 4 the
suite moved two rows that have nothing to do with halting:

- **`D2`** — a campaign's list is dialed in the order it was uploaded.
- **`N1`** — the i-th dial of a batch comes from the i-th number of the
  rotation, read off the dial log in order.

Four workers racing a batch keep the *pairing* — which contact dials from which
number is decided by the tick, and travels in the job — but scramble the order
the requests actually leave in. Neither property is enforced anywhere
downstream; both were properties of dialing a batch in a loop, and a worker pool
is exactly where they would have been dropped without anyone deciding to.

**Resolved by lowering placement concurrency to 1**, not by re-grading. It costs
nothing this engine was not already paying — the loop it replaces dialed
serially too, inside the tick — and it has a second effect worth as much: with
one worker, every job that follows a refusal reads the batch's halt marker
before it dials, so `X4` holds as well.

### `D3` — the lane-budget sample, after webhooks moved off the request path

The lane-budget scenario samples the world *between* passes to build its
eligibility picture, and did so by advancing the mock and reading immediately.
That was correct while a delivery did its work on the request thread: an advance
that had returned was an advance whose outcomes were in the database. Once the
webhook handler began verifying and enqueueing, "delivered" stopped meaning
"applied", and the sample counted every resolving retry as still live — so no
tick ever presented retries and fresh work together, and the reservation was
never exercised.

**Resolved in the harness**, which is where the fault was. `Driver.deliverPending()`
advances the mock *and* drains the webhook queue, and both `tick()` and the
lane-budget scenario use it. The engine was not changed.

## What the harness gained

Two extensions, both needed for the suite to keep observing a whole pass:

- **A real `call-placement` worker**, on its own pinned Redis database (13),
  started by the production factory at the production concurrency. `tick()`
  drains that queue to quiescence after the sweeps and before the mock is
  advanced — the mock cannot deliver a webhook for a call that has not been
  placed, so draining after the advance would leave every dial one tick behind
  its own outcome.
- **A real `webhook-processing` worker**, drained after every advance. The mock
  awaits each delivery before its `advance` returns, so by the time an advance
  is done every event it fired is durable on the queue; the drain is therefore
  race-free rather than a sleep.

The Redis database is pinned in `boot.ts` exactly as the Postgres one is, and
the preflight refuses anything else. The suite now both publishes and consumes,
and a run pointed at a database a dev server also uses would place that server's
dials.

## What this gate does not cover

Two changes are real and are outside what a single-instance virtual-clock
harness can observe. Both are graded by the battle test instead.

- **A halt no longer stops the campaigns after it in the same pass.** The batch
  that met the wall is still stopped — that is the marker, and it is what keeps
  `X4` — but a later campaign in the same tick has already been claimed and
  posted under its own batch id, so its jobs meet the refusal themselves. No
  conformance scenario runs two campaigns of one account through a single pass
  in which the first is refused.
- **Everything about running more than one instance.** The suite runs one.
