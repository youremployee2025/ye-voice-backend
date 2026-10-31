# Splitting the non-fresh lanes: `retrySharePercent`

**Status:** design agreed 2026-09-07. Branch `feat/retry-share-split` in
`ye-voice-backend` and `ye-voice-dashboard`.

## The report

Two RUNNING campaigns — *September Touchbase Assisted Sales* and *September
Touchbase Autopay*, both `concurrencyLimit = 11`, `retryConcurrency = 3`,
`retryCount = 20` — showed ~880 retries eligible and apparently never dialed,
while callbacks and resumes went out continuously. The operator's reading was
"reserved retries are not calling these numbers; all are going to immediate".

That reading is right about the effect and wrong about the cause, and the two
causes below are independent. Either alone starves the retry lane; together
they make `retryConcurrency` inert.

## What production actually showed

Dials by kind, 15-minute buckets, 2026-09-07 (UTC):

| bucket | callback | resume | retry |
|--------|---------:|-------:|------:|
| 04:30  | **192**  | 0      | **0** |
| 04:45  | 188      | 28     | **0** |
| 05:00  | 19       | 203    | 70    |
| 05:15  | 0        | 32     | 237   |
| 05:30  | **260**  | 0      | **0** |
| 07:45  | 3        | 49     | 228   |

Retries are not permanently stalled. They go to **exactly zero** for whole
quarter-hours whenever a burst of callbacks comes due, and are crowded by
resume bursts in between.

The bursts are manufactured. The dial window is `10:00–20:00 Asia/Kolkata`
= `04:30–14:30 UTC`, and `rollIntoDialWindow` builds every booked instant
through `instantOf`, which zeroes seconds and milliseconds. Everything booked
outside the window collapses onto the opening minute:

```
2026-09-08 04:30:00   →  37 + 27 =  64 callbacks at one instant
2026-09-08 05:30:00   →  49 + 38 =  87 callbacks at one instant
```

## Cause 1 — `campaignRetryInFlight` asks about the contact, not the dial

`src/lib/concurrency.ts` counts a line as retry-occupied by reading the
contact's lifetime counters:

```ts
campaignContact: { OR: [{ attempts: { gt: 0 } }, { followUpCount: { gt: 0 } }] }
```

Both campaigns have **zero** `FRESH` contacts left. Every contact on every line
has been dialed at least once, so every in-flight call — callback, resume,
follow-up and retry alike — satisfies that predicate. With 9–10 calls up,
`activeRetry ≈ 10`, and `laneBudgets.ts` computes:

```ts
retryBudget = min(totalSlots, max(0, retryConcurrency - activeRetry))
            = min(totalSlots, max(0, 3 - 10))
            = 0
```

`claimLanes` then collapses to nothing:

```ts
const reserved    = Math.min(budgets.retryBudget, remaining);      // 0
const resumes     = await take(reserved, 'resume');                // no query
const retryTarget = Math.min(reserved - resumes.length, remaining);// 0
const retries     = await take(retryTarget, 'retry');              // no query
```

`claimContacts` returns early on `limit <= 0`, so **the reserved retry lane is
never queried on these campaigns. Not once.** Every dial they place comes out
of the borrow pass — `take(remaining, 'any')` — whose ordering is

```sql
ORDER BY (armKind='CALLBACK') DESC, (armKind='RESUME') DESC,
         (armKind='FOLLOW_UP') DESC, "createdAt" ASC
```

with `RETRY` last. The operator set a reservation of 3 and got strict priority
ordering instead.

The fix is not to loosen the predicate but to ask a different question.
`CallAttempt.kind` is stamped **at claim time** from the arm that chose the row
(`attemptKindOf(contact.armKind)`, a bijection over
`fresh | retry | callback | follow_up | resume`), so the attempt row already
records which lane spent the slot. Counting off it makes the accounting agree
with the lane that actually claimed the call — which is the same reason
`attemptKind` was moved to claim time in the first place.

## Cause 2 — the callback lane is claimed before any budget exists

```ts
let remaining = budgets.totalSlots;
const callbacks = await take(remaining, 'callback');   // the whole pass budget
remaining -= callbacks.length;
```

A callback is exempt from the retry reservation because it spends no retry —
that part is right, and stays. What is wrong is that the exemption is also an
*unbounded first claim*. When 64 promises come due on one instant against 22
account lines, callbacks take every line for as long as it takes to work
through them, `remaining` reaches 0, and every later lane gets a target of
zero. That is the 04:30 and 05:30 rows in the table above.

## The model

Three lanes, and one number that splits the third.

**The pool being split is whatever the non-fresh side has this pass.** No
special case is needed for "the fresh list ran out": that is already the
reservation plus whatever the fresh lane leaves behind.

```
pool = retryConcurrency                      while fresh contacts are waiting
pool = retryConcurrency + unused fresh slots  once fresh is exhausted
```

With `concurrencyLimit = 10, retryConcurrency = 4`: fresh has work, so the pool
is 4 and is split x/y. Fresh is dry, so its 6 slots fall through, the pool
becomes 10, and that is split x/y.

**One column, not two.** `Campaign.retrySharePercent` is *y*, the retry share.
The urgent share is `100 - y`. Storing both would create an invariant a partial
write could violate.

**Targets are floors, not ceilings.** Whatever one side does not take, the
other may, in the same pass. `y = 60` on a pool of 10 means "retries are
guaranteed 6 and may have all 10". The split binds only when both sides are
contended — which is the 04:30 window and nothing else.

**The split holds across passes, not only within one** — the same property the
reservation has, and for the same reason. Computed on in-flight *plus* pool,
then reduced by in-flight:

```ts
const wanted      = Math.floor(((activeRetry + activeUrgent + pool) * y) / 100);
const retryFloor  = clamp(wanted - activeRetry, 0, pool);
const urgentFloor = pool - retryFloor;          // exact; no slot lost to rounding
```

Traced on the live campaign (`limit 11`, `y = 60`): pass 1 claims 6 retry and 5
urgent. Four calls end, two of each, so `pool = 4`,
`wanted = floor(11 × 0.6) = 6`, `retryFloor = 6 - 4 = 2`, urgent takes 2.
In-flight converges on 6/11. Without the in-flight terms a pool of 1 rounds
`retryFloor` to 0 and hands every marginal slot to urgent — the present bug in
miniature.

**Within urgent, a callback still outranks a resume.** A promise a human was
told beats a call the engine chose. The split bounds the two jointly; it does
not reorder them.

## The shape in `claimLanes`

One function, called twice, replacing both the uncapped callback pass and the
unsplit `any` borrow.

```ts
async function drainSplit(pool: number, y: number): Promise<ClaimedContact[]> {
  if (pool <= 0) return [];

  const { retryFloor, urgentFloor } = splitPool({ pool, y, activeRetry, activeUrgent });

  // Urgent, jointly bounded. Callback ahead of resume inside it.
  const callbacks = await take(urgentFloor, 'callback');
  const resumes   = await take(urgentFloor - callbacks.length, 'resume');
  const urgentUsed = callbacks.length + resumes.length;

  // Retry takes its floor plus everything urgent left behind.
  const retries = await take(pool - urgentUsed, 'retry');

  // And urgent takes what retry left behind, when retry was dry.
  const spare = pool - urgentUsed - retries.length;
  const extra = spare > 0 ? await take(spare, 'urgent') : [];

  return [...callbacks, ...resumes, ...retries, ...extra];
}
```

and the pass becomes three phases:

```ts
let remaining = budgets.totalSlots;

// 1. The reservation, split.
const reserved = await drainSplit(Math.min(budgets.nonFreshBudget, remaining), y);
remaining -= reserved.length;

// 2. Fresh, out of its own budget. Unchanged.
const fresh = await take(Math.min(budgets.freshBudget, remaining), 'fresh');
remaining -= fresh.length;

// 3. The borrow: the same split over what fresh did not use.
const borrowed = await drainSplit(remaining, y);
```

Phase 3 is the "fresh list is finished" case. It is where the campaigns in the
report spend all of their budget today, and where the unsplit `any` claim hands
it all to callbacks.

Three consequences worth stating out loud:

- **The `retryConcurrency <= 0` short-circuit goes away.** With no reservation
  the phase-1 pool is simply 0 and everything arrives through phase 3, still
  split. This makes the split govern every campaign sitting on the column
  default — which is why the default below is what it is.
- **`take` gains one lane**, a joint `armKind IN ('CALLBACK','RESUME')` filter
  for the give-back claim, ordered callback-first.
- **Query cost** rises from 5 claims per campaign per pass to 7 in the worst
  case. `claimContacts` returns early on `limit <= 0`, so a quiet campaign
  still issues almost none.

## Counting the lanes

`campaignInFlight` and `campaignRetryInFlight` are replaced by one `groupBy`,
which is a net query saving:

```ts
export async function campaignLaneInFlight(db: Db, campaignId: string) {
  const rows = await db.callAttempt.groupBy({
    by: ['kind'], where: { campaignId, ...IN_FLIGHT }, _count: { _all: true },
  });

  let all = 0, fresh = 0, urgent = 0, retry = 0;
  for (const { kind, _count } of rows) {
    all += _count._all;
    if (kind === 'fresh') fresh += _count._all;
    else if (kind === 'callback' || kind === 'resume') urgent += _count._all;
    else retry += _count._all;   // retry, follow_up, and anything unrecognised
  }
  return { all, fresh, urgent, retry };
}
```

`all` remains the authority for `totalSlots`, so a kind this release does not
recognise still counts against the cap and can never let a campaign past it.
An unrecognised kind is credited to `retry` rather than to `fresh` because that
direction under-serves the non-fresh side; crediting it to `fresh` would widen
`nonFreshBudget` and let the non-fresh side over-dial past its reservation,
which is the failure being fixed.

## Schema, validation, default

```prisma
/// Of the slots available to non-fresh work, the percent held for plain
/// retries. The remainder goes to callbacks and resumes. 0 keeps the priority
/// ordering that predates the split: urgent first, retries after.
retrySharePercent Int @default(0)
```

`Campaign` is 8 rows / 144 kB in production; the migration is instant and needs
no preflight.

**The default is 0, deliberately.** Under floors-not-ceilings, `y = 0` gives
retries no floor while still letting them take everything urgent leaves —
which is exactly today's behaviour. So the migration re-paces nobody, and the
two campaigns in the report opt in by setting a value. Whether to move the
platform default is a decision for after they prove it out, not for this PR.

Validation lives beside the existing `retryConcurrency` check in
`campaignConfig.ts`: an integer 0–100. There is no cross-field invariant, which
is the point of storing one number.

## Dashboard

- `app/(dash)/campaigns/[id]/settings-tab.tsx` and `app/(dash)/campaigns/new/page.tsx`
  — the field, beside the reservation.
- `app/(dash)/campaigns/[id]/overview-tab.tsx` and the same sentence in
  `settings-tab.tsx` — today they read *"3 of those slots are reserved for
  contacts on a retry"*, which stops being true the moment the split exists and
  has to name both halves.
- `lib/types.ts` — the field on `Campaign`.

**Deploy order:** backend first. The column is defaulted, so a dashboard build
that does not send it keeps saving; a dashboard that sends it to a backend
without the column would 400.

## Tests

Failing first, per `superpowers:test-driven-development`.

| Suite | What it pins |
|-------|--------------|
| `test/lane-budgets.test.ts` | `splitPool` as pure arithmetic: floors sum to the pool exactly; the in-flight terms converge across passes; `y = 0` reproduces today's ordering; `y = 100` still lets urgent dial when retry is dry |
| `test/dialer-claim.query.test.ts` | the joint `CALLBACK OR RESUME` lane, and that its ordering keeps callback ahead of resume |
| `test/dialer-sweep.test.ts` | the three phases in order |
| `test/dialer-sweep.test.ts` | **the regression**: a 64-strong callback herd on `limit 11`, `retryConcurrency 3`, `y = 60`, `FRESH` empty — retries must still dial. Fails on today's code |
| `test/dialer-sweep.test.ts` | `campaignLaneInFlight` counts off `CallAttempt.kind`, so `nonFreshBudget` is non-zero with a dry `FRESH` queue |

## Out of scope

The herd itself. 64 promises on `2026-09-08 04:30:00` and 87 on `05:30:00` are
still 151 calls due at two instants; the split only decides they take 40% of
the lines rather than 100%. Spreading `rollIntoDialWindow` — jittering the
rolled instants across the first minutes of the window instead of collapsing
them onto one — is a separate and smaller change, and belongs in its own PR.


---

# Addendum, written after implementation

Two things in the design above are **wrong as written**, and the existing suite
caught both. What shipped is recorded here rather than by editing the sections
above, so the correction is legible.

## 1. The fresh lane's contracts, which the phase order broke

The design has three phases — reservation split, fresh, borrow split — and that
order breaks three contracts the dispatcher already held, none of which was the
bug being fixed:

- **A promise beats a list position.** With `retryConcurrency = 0` the
  reservation is 0, so the fresh phase ran before any urgent row was claimed
  and a due callback lost to an undialled contact. The old code's unbounded
  first pass was wrong in being *unbounded*, not in being *first*.
- **With no reservation the pass is settled by age.** The design replaced the
  `retryConcurrency <= 0` short-circuit with "the phase-1 pool is simply 0";
  that also removed the FIFO contest between the retry queue and the fresh
  list, which is the behaviour `retryConcurrency` exists to let an operator
  *change* — and the column's default is 0, so it is what nearly every campaign
  on the platform does.
- **A reservation costs no throughput when one side is empty.** The old borrow
  claimed `any`, which includes `FRESH`; the design's borrow covers only the
  two non-fresh sides, so an unused reservation idled a slot beside a queue.

What shipped keeps the short-circuit (with the urgent pass bounded inside it)
and adds a fourth phase that hands the fresh list whatever neither non-fresh
lane could use.

## 2. `'any'` is not retired, and a `routine` lane was needed

The design says the `'any'` lane goes. It cannot: the shared pass still exists
for `retryConcurrency = 0`, and `any` orders `CALLBACK` and `RESUME` first —
using it there would let a herd straight past the bound it was just held to. So
the shared pass claims a new **`routine`** lane, `armKind IN ('FRESH', 'RETRY',
'FOLLOW_UP')`, ordered follow-up-first then by age: `any` minus the urgent arms.

`'any'` itself stays in the union with no dispatcher caller, because ~15 cases
across three suites claim through it to exercise the predicates that belong to
no lane — the dial cap, the do-not-call list, the eligibility window, the retry
budget. Its comment now says so instead of describing a borrow pass that no
longer exists.

## 3. The split is carried within a pass, not only across passes

`splitPool` holds the ratio across passes by counting in-flight. Spread over
two pools **inside one pass** it still rounds down twice: a reservation of 3
and a borrow of 8 at `retrySharePercent = 60` holds
`floor(3 x 0.6) + floor(8 x 0.6) = 5` of 11 for retries rather than 6, with the
remainder falling to the urgent side both times. `claimLanes` therefore carries
`takenRetry` and `takenUrgent` forward between its own phases and adds them to
the in-flight terms. The herd regression test pins the difference: 6/5, not 5/6.

## The order that shipped

```
if retryConcurrency == 0:
    urgent, bounded by its share of the pass
    routine, settled by age                       # unchanged behaviour
else:
    1. drainSplit(min(nonFreshBudget, remaining))  # the shared reservation
    2. fresh, out of freshBudget
    3. drainSplit(remaining)                       # the borrow
    4. fresh, for what neither non-fresh lane used
```

`drainSplit` is three claims: urgent at its share, retry at its share plus what
urgent left, urgent again for what retry left.

## Verification

Full suite on the branch: **3202 passed, 16 failed** — the same 16 env-only
failures (`env.test.ts`, `upstream-dialer.test.ts`, `calls.test.ts`, all missing
credentials) as the branch point, with 10 tests added.
