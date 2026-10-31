# Retry share split — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each campaign one number, `retrySharePercent`, that splits the slots available to already-dialed contacts between plain retries and the urgent lanes (callbacks and resumes) — and fix the in-flight count that currently makes `retryConcurrency` do nothing at all.

**Architecture:** Three changes that stack. (1) `campaignLaneInFlight` counts occupied lines off `CallAttempt.kind`, which the claim already stamps, instead of off the contact's lifetime counters — without this every budget below is permanently zero. (2) `laneBudgets.ts` gains a pure `splitPool` function that divides a pool between retry and urgent as *floors*, computed against in-flight plus pool so the ratio holds across passes. (3) `claimLanes` replaces its uncapped callback pass and its unsplit `any` borrow with one `drainSplit` helper called twice — once over the reservation, once over what the fresh lane left behind.

**Tech Stack:** TypeScript, Prisma 6 + PostgreSQL, Vitest, Express. Dashboard is Next.js App Router.

**Read first:** `docs/plans/2026-09-07-retry-share-split-design.md` — the production evidence, the two root causes, and why the default is 0.

**Worktrees (already created):**
- `ezo/.worktrees/retry-share-split/ye-voice-backend` — branch `feat/retry-share-split` off `origin/main`
- `ezo/.worktrees/retry-share-split/ye-voice-dashboard` — branch `feat/retry-share-split` off `origin/main`

**Test environment for the backend worktree.** Every `npm test` invocation below must be prefixed:

```bash
export TEST_DATABASE_URL="postgresql://postgres:test@localhost:5435/ye_test_retry_share"
export TEST_REDIS_URL="redis://localhost:6382/11"
```

The database and Redis index are dedicated to this worktree — sharing them with another worktree produces FK-constraint bleed in unrelated files. Baseline as of the branch point: **3192 passed, 16 failed**. Those 16 (`test/env.test.ts` 4, `test/upstream-dialer.test.ts` 9, `test/calls.test.ts` 3) fail for missing `CLERK_SECRET_KEY` and voice-platform credentials and are **not** a regression. Any other failure is yours.

## Test budget

**Keep the suite thin.** One case per behaviour that could plausibly break, and
none for behaviour the type system already pins. Where a task below lists more
cases than that, take the ones marked **required** and drop the rest. The
required set for the whole change is six:

1. `splitPool` floors sum to the pool exactly.
2. `splitPool` holds the ratio across passes (the in-flight terms).
3. `splitPool` at 0 reserves nothing — the migration's safety story.
4. `campaignLaneInFlight` reads the lane off `CallAttempt.kind`, not the contact.
5. The joint `urgent` lane claims callbacks and resumes, promise first.
6. **The regression**: a callback herd on a campaign with no fresh contacts
   still dials retries. This is the one that fails on today's code.

---

## Task 1: `splitPool`, the arithmetic

`laneBudgets.ts` is the one part of the dispatcher with no database and no clock, because it is the part that has to be provable. The split belongs there for the same reason.

**Files:**
- Modify: `src/lib/laneBudgets.ts`
- Test: `test/lane-budgets.test.ts`

**Step 1: Write the failing tests.** Append to `test/lane-budgets.test.ts`:

```ts
import { computeLaneBudgets, splitPool } from '../src/lib/laneBudgets.js';

const split = (over: Partial<Parameters<typeof splitPool>[0]> = {}) =>
  splitPool({ pool: 10, retrySharePercent: 60, activeRetry: 0, activeUrgent: 0, ...over });

describe('splitting a pool between retries and the urgent lanes', () => {
  it('gives every slot to one side or the other', () => {
    const { retryFloor, urgentFloor } = split();

    expect(retryFloor).toBe(6);
    expect(urgentFloor).toBe(4);
    // The property that matters more than either number: rounding may not
    // idle a slot the account has already paid for.
    expect(retryFloor + urgentFloor).toBe(10);
  });

  it('rounds the retry floor down, so the urgent lane absorbs the remainder', () => {
    expect(split({ pool: 4, retrySharePercent: 60 })).toEqual({ retryFloor: 2, urgentFloor: 2 });
    expect(split({ pool: 3, retrySharePercent: 50 })).toEqual({ retryFloor: 1, urgentFloor: 2 });
  });

  /**
   * The property that makes the split a split rather than a per-pass coin
   * toss. Computed on in-flight PLUS pool and then reduced by in-flight, so a
   * pass with one slot to give does not round the retry floor to zero and hand
   * every marginal slot to the urgent lanes forever.
   */
  it('holds the ratio across passes, not only within one', () => {
    // Pass one: nothing up, the whole limit to divide.
    expect(split({ pool: 11 })).toEqual({ retryFloor: 6, urgentFloor: 5 });

    // Four calls end, two of each. Six retries and five urgent were up; four
    // slots are free. floor(11 * 0.6) = 6 wanted, 4 already retrying, so 2.
    expect(split({ pool: 4, activeRetry: 4, activeUrgent: 3 }))
      .toEqual({ retryFloor: 2, urgentFloor: 2 });

    // A single slot, with the retry lane already over its share: it goes to
    // urgent. Computed per-pass it would round to zero and go to urgent too —
    // the difference is that this one is a decision, not a rounding artefact.
    expect(split({ pool: 1, activeRetry: 8, activeUrgent: 2 }))
      .toEqual({ retryFloor: 0, urgentFloor: 1 });
  });

  it('never returns a floor outside the pool', () => {
    // The retry lane is far under its share; it may still claim only what the
    // pass has. A floor above `pool` would be a lane dialing past the cap.
    expect(split({ pool: 2, activeRetry: 0, activeUrgent: 20 }))
      .toEqual({ retryFloor: 2, urgentFloor: 0 });
  });

  /**
   * The column default, and the whole migration story: 0 must reproduce the
   * ordering that predates the split. It gives retries no floor — and the
   * caller's give-back pass is what still lets them take whatever urgent
   * leaves, which is exactly today's behaviour.
   */
  it('at 0 reserves nothing for retries', () => {
    expect(split({ retrySharePercent: 0 })).toEqual({ retryFloor: 0, urgentFloor: 10 });
  });

  it('at 100 reserves nothing for the urgent lanes', () => {
    expect(split({ retrySharePercent: 100 })).toEqual({ retryFloor: 10, urgentFloor: 0 });
  });

  it('refuses to divide a pool that is not there', () => {
    expect(split({ pool: 0 })).toEqual({ retryFloor: 0, urgentFloor: 0 });
    expect(split({ pool: -3 })).toEqual({ retryFloor: 0, urgentFloor: 0 });
  });
});
```

**Step 2: Run them and watch them fail.**

```bash
npm test -- test/lane-budgets.test.ts
```

Expected: every new case fails with `splitPool is not a function` / no export named `splitPool`.

**Step 3: Implement.** Append to `src/lib/laneBudgets.ts`:

```ts
export interface SplitInput {
  /** Slots this pass has for already-dialed contacts. Zero or less is no pass. */
  pool: number;
  /** Of that pool, the percent held for plain retries. 0..100. */
  retrySharePercent: number;
  /** In-flight calls claimed by the retry lane — `retry` and `follow_up`. */
  activeRetry: number;
  /** In-flight calls claimed by the urgent lanes — `callback` and `resume`. */
  activeUrgent: number;
}

export interface PoolSplit {
  retryFloor: number;
  urgentFloor: number;
}

/**
 * How one pool is divided between plain retries and the urgent lanes.
 *
 * **Floors, not ceilings.** Neither number is a cap: the caller offers each
 * lane its floor and then offers the remainder to whichever lane still has
 * rows. A campaign whose resume queue is empty dials retries with every slot
 * it has. The split binds only when both sides are contended, which is the
 * one case it exists for.
 *
 * **Computed against in-flight, not against the pool alone.** The share is a
 * property of what the campaign is *doing*, not of what one pass happened to
 * have spare. A pool of one divided per-pass rounds the retry floor to zero
 * every time and hands every marginal slot to the urgent lanes — which is the
 * present bug in miniature. So the share is taken over the whole occupancy the
 * pass would produce, and what is already up is subtracted from it.
 *
 * **The retry floor rounds down and the urgent floor takes the remainder**, so
 * the two always sum to exactly `pool`. Rounding both would idle a slot the
 * account has paid for on every odd division.
 */
export function splitPool({
  pool,
  retrySharePercent,
  activeRetry,
  activeUrgent,
}: SplitInput): PoolSplit {
  if (pool <= 0) return { retryFloor: 0, urgentFloor: 0 };

  // Re-clamped rather than trusted from the row: the validator bounds it at
  // write time, but a percent outside 0..100 arriving from an older row or a
  // path that did not re-check must not produce a floor outside the pool.
  const share = Math.max(0, Math.min(100, retrySharePercent));

  const wanted = Math.floor(((activeRetry + activeUrgent + pool) * share) / 100);
  const retryFloor = Math.max(0, Math.min(pool, wanted - activeRetry));

  return { retryFloor, urgentFloor: pool - retryFloor };
}
```

**Step 4: Run them and watch them pass.**

```bash
npm test -- test/lane-budgets.test.ts
```

Expected: PASS, and the existing `computeLaneBudgets` cases untouched.

**Step 5: Commit.**

```bash
git add src/lib/laneBudgets.ts test/lane-budgets.test.ts
git commit -m "Divide a pool between retries and the urgent lanes, as floors"
```

---

## Task 2: Count the lanes off the dial, not off the contact

This is the fix that makes every budget below non-zero. Do it before touching `claimLanes`, so the sweep tests in Task 6 are grading the split and not this.

**Files:**
- Modify: `src/lib/concurrency.ts` (replace `campaignRetryInFlight`, keep `campaignInFlight`)
- Modify: `src/services/dialer.ts:1240-1250`
- Test: `test/concurrency.test.ts`

**Step 1: Write the failing test.** Append to `test/concurrency.test.ts`:

```ts
/**
 * The count the reservation is built on.
 *
 * It used to read the contact's lifetime counters — `attempts > 0 OR
 * followUpCount > 0` — which answers "has this contact ever been dialed",
 * not "which lane is holding this line". On a campaign whose FRESH queue is
 * exhausted every contact answers yes to the first question, so every
 * in-flight call of every kind counted as a retry, `retryBudget` was
 * permanently zero, and the reserved retry lane was never queried at all.
 *
 * `CallAttempt.kind` is stamped at claim time from the arm that chose the row,
 * so it is the only reading a later re-arm or settle cannot move.
 */
describe('lane occupancy', () => {
  it('reads the lane off the dial, not off the contact', async () => {
    // One contact per kind, every one of them long since dialed — the shape
    // of a campaign whose fresh list has run out.
    await addAttempt({ kind: 'retry', status: 'IN_PROGRESS', attempts: 4 });
    await addAttempt({ kind: 'follow_up', status: 'RINGING', attempts: 4 });
    await addAttempt({ kind: 'callback', status: 'QUEUED', attempts: 4 });
    await addAttempt({ kind: 'resume', status: 'IN_PROGRESS', attempts: 4 });
    await addAttempt({ kind: 'fresh', status: 'QUEUED', attempts: 0 });
    // Settled, so it holds no line.
    await addAttempt({ kind: 'retry', status: 'COMPLETED', attempts: 4 });

    await expect(campaignLaneInFlight(prisma, campaignId)).resolves.toEqual({
      all: 5,
      fresh: 1,
      urgent: 2,
      retry: 2,
    });
  });

  it('counts a kind it does not recognise against the cap', async () => {
    await addAttempt({ kind: 'something_else', status: 'RINGING', attempts: 1 });

    // `all` is the authority for `totalSlots`, so an unknown kind can never
    // let a campaign past its limit. It is credited to `retry` rather than to
    // `fresh` because that direction under-serves the non-fresh side; the
    // other would widen its budget and let it over-dial.
    await expect(campaignLaneInFlight(prisma, campaignId)).resolves.toMatchObject({
      all: 1,
      fresh: 0,
      retry: 1,
    });
  });

  it('ignores another campaign's calls', async () => {
    await addAttempt({ kind: 'retry', status: 'RINGING', campaignId: otherCampaignId });

    await expect(campaignLaneInFlight(prisma, campaignId)).resolves.toMatchObject({ all: 0 });
  });
});
```

Follow the existing helpers in that file for `addAttempt`; extend it with a `kind` argument if it does not take one.

**Step 2: Run it and watch it fail.**

```bash
npm test -- test/concurrency.test.ts
```

Expected: FAIL, no export named `campaignLaneInFlight`.

**Step 3: Implement.** In `src/lib/concurrency.ts`, delete `campaignRetryInFlight` and add:

```ts
export interface LaneOccupancy {
  /** Every non-terminal attempt, whatever its kind. `totalSlots` is built on
   *  this, so no lane accounting below can let a campaign past its cap. */
  all: number;
  fresh: number;
  /** `callback` and `resume`. */
  urgent: number;
  /** `retry`, `follow_up`, and any kind this release does not recognise. */
  retry: number;
}

/**
 * Which of this campaign's lanes are holding lines, read off the dial.
 *
 * **Counted from `CallAttempt.kind`, which the claim stamps from the arm that
 * chose the row.** The predicate this replaced read the contact's lifetime
 * counters, which answer a different question — "has this contact ever been
 * dialed" rather than "which lane spent this slot" — and on a campaign whose
 * FRESH queue is exhausted every contact answers yes. Every in-flight call of
 * every kind then counted as a retry, `retryBudget` was permanently zero, and
 * the reserved lane was never queried. The reservation was a setting that did
 * nothing.
 *
 * One `groupBy` where there were two `count`s, so this is also one round trip
 * cheaper per campaign per pass.
 *
 * An unrecognised kind — another release's vocabulary — is credited to
 * `retry`. It counts against `all` either way; the choice only decides which
 * budget it narrows, and narrowing the non-fresh side is the direction that
 * cannot over-dial.
 */
export async function campaignLaneInFlight(db: Db, campaignId: string): Promise<LaneOccupancy> {
  const rows = await db.callAttempt.groupBy({
    by: ['kind'],
    where: { campaignId, ...IN_FLIGHT },
    _count: { _all: true },
  });

  const occupancy: LaneOccupancy = { all: 0, fresh: 0, urgent: 0, retry: 0 };

  for (const row of rows) {
    const count = row._count._all;
    occupancy.all += count;

    if (row.kind === 'fresh') occupancy.fresh += count;
    else if (row.kind === 'callback' || row.kind === 'resume') occupancy.urgent += count;
    else occupancy.retry += count;
  }

  return occupancy;
}
```

**Step 4: Rewire the caller.** In `src/services/dialer.ts`, replace the three-way `Promise.all` at ~L1240:

```ts
const [lanes, accountCalls] = await Promise.all([
  campaignLaneInFlight(prisma, campaign.id),
  accountInFlight(prisma, owner.id),
]);
```

and every later reader of `ownCalls` / `activeRetry` / `activeFresh` takes it from `lanes` — `lanes.all` wherever `ownCalls` was (including the `bindingCap({ activeAll })` call), `lanes.retry`, `lanes.urgent`, `lanes.fresh` for the budgets. Delete the `Math.min(retryCalls, ownCalls)` clamp: the counts now partition `all` by construction, so nothing needs bounding.

Leave `campaignInFlight` in place — `src/routes/campaigns.routes.ts:1663` still uses it and wants only the total.

**Step 5: Run the affected suites.**

```bash
npm test -- test/concurrency.test.ts test/dialer-sweep.test.ts test/lane-budgets.test.ts
```

Expected: `concurrency` and `lane-budgets` PASS. `dialer-sweep` may now fail on cases written around the old inert reservation — read each failure before touching it. A case that asserted retries do *not* dial while urgent calls are up was pinning the bug; update it and say so in the commit.

**Step 6: Commit.**

```bash
git add src/lib/concurrency.ts src/services/dialer.ts test/concurrency.test.ts test/dialer-sweep.test.ts
git commit -m "Count a campaign's lanes off the dial, not off the contact's counters"
```

---

## Task 3: Rename the reservation to what it now reserves

`retryConcurrency` reserves slots for *everything already dialed*, not for plain retries. The column name is the customer's and stays; the internal budget name should stop lying, or Task 4 reads as if it were splitting a retry-only pool.

**Files:**
- Modify: `src/lib/laneBudgets.ts` (`retryBudget` → `nonFreshBudget`, `activeRetry` → `activeNonFresh`)
- Modify: `src/services/dialer.ts`
- Test: `test/lane-budgets.test.ts`

**Step 1:** Rename in the test file first, run, watch it fail on the missing property.
**Step 2:** Rename in `laneBudgets.ts` and `dialer.ts`; pass `activeNonFresh: lanes.retry + lanes.urgent`.
**Step 3:** `npm test -- test/lane-budgets.test.ts test/dialer-sweep.test.ts` — PASS.
**Step 4:** Commit: `"Name the reservation for what it holds: every contact already dialed"`.

---

## Task 4: The joint urgent lane

`drainSplit` needs a claim that draws from callbacks and resumes together, so the give-back pass can offer retry's unused slots to the urgent side without preferring one of them arbitrarily.

**Files:**
- Modify: `src/services/dialerClaim.ts` (`ClaimLane`, `laneFilter`, `claimOrder`)
- Test: `test/dialer-claim.query.test.ts`

**Step 1: Write the failing tests.** In `test/dialer-claim.query.test.ts`:

```ts
it('the urgent lane draws from callbacks and resumes together', async () => {
  const resume = await addContact({ armKind: 'RESUME', nextEligibleAt: minutes(-5) });
  const callback = await addContact({
    armKind: 'CALLBACK', nextEligibleAt: minutes(-5), callbackAt: minutes(-5),
  });
  await addContact({ armKind: 'RETRY', nextEligibleAt: minutes(-5) });

  const claimed = await claim(10, 'urgent');

  expect(claimed.map((c) => c.id)).toEqual([callback, resume]);
});

/**
 * A promise a human was told, ahead of a call the engine chose. The joint lane
 * bounds the two together; it must not reorder them.
 */
it('puts a promise ahead of a resume inside the urgent lane', async () => {
  const resume = await addContact({ armKind: 'RESUME', nextEligibleAt: minutes(-30) });
  const callback = await addContact({
    armKind: 'CALLBACK', nextEligibleAt: minutes(-1), callbackAt: minutes(-1),
  });

  // The resume has been waiting far longer. It still goes second.
  expect((await claim(2, 'urgent')).map((c) => c.id)).toEqual([callback, resume]);
});

it('takes neither a fresh contact nor a follow-up', async () => {
  await addContact({ armKind: 'FRESH' });
  await addContact({ armKind: 'FOLLOW_UP', nextEligibleAt: minutes(-5) });

  expect(await claim(10, 'urgent')).toEqual([]);
});
```

**Step 2:** Run `npm test -- test/dialer-claim.query.test.ts`. Expected: FAIL, `'urgent'` is not assignable to `ClaimLane`.

**Step 3: Implement.** In `src/services/dialerClaim.ts`:

- Add `'urgent'` to `ClaimLane` and document it in the doc comment above the type: *"`urgent` — `CALLBACK` and `RESUME` together, for the give-back pass that offers the retry lane's unused slots back. Ordered promise-first, so bounding the two jointly does not reorder them."*
- `laneFilter`: `if (lane === 'urgent') return Prisma.sql\`AND cc."armKind" IN ('CALLBACK', 'RESUME')\`;`
- `claimOrder`: a promise first, then each lane's own clock, then the id —

```ts
if (lane === 'urgent') {
  return Prisma.sql`ORDER BY (${prefix}"armKind" = 'CALLBACK') DESC,
                             COALESCE(${prefix}"callbackAt", ${prefix}"nextEligibleAt") ASC,
                             ${prefix}id ASC`;
}
```

`COALESCE` because a resume writes no `callbackAt` — nothing but a real promise writes that column — and ordering it on a null would leave the resumes in an undefined order among themselves, which is a rotation that is not a rotation.

**Step 4:** Run `npm test -- test/dialer-claim.query.test.ts`. Expected: PASS.

**Step 5: Commit.**

```bash
git add src/services/dialerClaim.ts test/dialer-claim.query.test.ts
git commit -m "Add the joint urgent lane: a promise and a resume, claimed together"
```

---

## Task 5: The column, the migration, the validator

**Files:**
- Modify: `prisma/schema.prisma` (model `Campaign`, beside `retryConcurrency`)
- Create: `prisma/migrations/20260907XXXXXX_campaign_retry_share/migration.sql`
- Modify: `src/lib/campaignConfig.ts`
- Modify: `src/lib/campaign.ts` (the serializer, so the dashboard receives it)
- Test: `test/campaign-config.test.ts`

**Step 1: Write the failing validator tests** in `test/campaign-config.test.ts`, matching the shape of the existing `retryConcurrency` cases: accepts 0, accepts 100, accepts 60, rejects `-1`, rejects `101`, rejects `50.5`, rejects `"60"`, and leaves the field absent when not supplied.

**Step 2:** `npm test -- test/campaign-config.test.ts`. Expected: FAIL.

**Step 3: Add the column** to `prisma/schema.prisma`:

```prisma
/// Of the slots available to contacts already dialed, the percent held for
/// plain retries; the remainder is the urgent lanes, `CALLBACK` and `RESUME`.
///
/// A floor and not a ceiling — whichever lane runs dry, the other takes its
/// slots in the same pass — so this binds only while both sides have rows
/// waiting. `retryConcurrency` decides how many slots reach this split;
/// this decides how they are shared once they do.
///
/// **0 is the default and reproduces the ordering that predates the split**:
/// retries get no floor and take whatever the urgent lanes leave, which is
/// exactly what the dispatcher did before. Setting it is opting in.
retrySharePercent Int @default(0)
```

**Step 4: Generate the migration.**

```bash
npx prisma migrate dev --name campaign_retry_share
```

Read the generated SQL. It must be a single `ALTER TABLE "Campaign" ADD COLUMN "retrySharePercent" INTEGER NOT NULL DEFAULT 0;` and nothing else. `Campaign` is 8 rows / 144 kB in production, so this is instant and needs no preflight — but if the migration contains anything beyond that one statement, stop and find out why.

**Step 5: Implement the validator** in `src/lib/campaignConfig.ts`, beside the `retryConcurrency` block:

```ts
if (supplied(fields, 'retrySharePercent')) {
  const value = fields.retrySharePercent;

  // No cross-field invariant, which is the point of storing one number: the
  // urgent share is `100 - retrySharePercent` and cannot disagree with it.
  if (!isIntegerInRange(value, 0, 100)) {
    throw new ApiError(400, 'VALIDATION_ERROR',
      'retrySharePercent must be an integer between 0 and 100.');
  }

  data.retrySharePercent = value;
}
```

Add `retrySharePercent?: number` to the update interface, and the field to the campaign serializer in `src/lib/campaign.ts`.

**Step 6:** `npm test -- test/campaign-config.test.ts test/campaign-parity.test.ts`. Expected: PASS.

**Step 7: Commit.**

```bash
git add prisma/ src/lib/campaignConfig.ts src/lib/campaign.ts test/campaign-config.test.ts
git commit -m "Add retrySharePercent: one number, defaulted to today's behaviour"
```

---

## Task 6: `drainSplit`, and the three phases

The change the whole plan is for.

**Files:**
- Modify: `src/services/dialer.ts` (`claimLanes`, and `CAMPAIGN_INCLUDE` needs nothing — `retrySharePercent` is a scalar on `Campaign`)
- Test: `test/dialer-sweep.test.ts`

**Step 1: Write the failing regression test** — the 04:30 window from the design doc, which fails on today's code:

```ts
/**
 * The report this change exists for.
 *
 * The dial window opens and every promise booked while it was shut comes due
 * on the same minute — `rollIntoDialWindow` builds each instant through
 * `instantOf`, which zeroes seconds, so a night's bookings land together.
 * Production saw two quarter-hours of 192 and 260 callback dials against
 * ZERO retries on exactly this shape.
 *
 * The callback lane used to be claimed out of the whole pass budget before
 * any split existed, so the herd took every line and every later lane got a
 * target of zero.
 */
it('dials retries through a callback herd', async () => {
  const campaign = await makeRunningCampaign({
    concurrencyLimit: 11,
    retryConcurrency: 3,
    retrySharePercent: 60,
  });

  // No fresh contacts left: the campaign in the report had none, and it is
  // what pushes every slot through the borrow phase.
  await addContacts(campaign, { armKind: 'CALLBACK', count: 64, dueAt: NOW });
  await addContacts(campaign, { armKind: 'RETRY', count: 880, dueAt: NOW });

  const result = await runDialerPass({ now: NOW });

  expect(result.posted).toBe(11);

  const dialed = await prisma.callAttempt.groupBy({
    by: ['kind'], where: { campaignId: campaign.id }, _count: { _all: true },
  });
  const byKind = Object.fromEntries(dialed.map((r) => [r.kind, r._count._all]));

  // 60% of 11, floored, is 6 — and the herd takes the other 5.
  expect(byKind.retry).toBe(6);
  expect(byKind.callback).toBe(5);
});

it('gives the retry lane every slot when nothing urgent is due', async () => {
  const campaign = await makeRunningCampaign({
    concurrencyLimit: 11, retryConcurrency: 3, retrySharePercent: 60,
  });
  await addContacts(campaign, { armKind: 'RETRY', count: 20, dueAt: NOW });

  const result = await runDialerPass({ now: NOW });

  // Floors, not ceilings: the urgent share is not idled when it has no rows.
  expect(result.posted).toBe(11);
});

it('gives the urgent lanes every slot when no retry is due', async () => {
  const campaign = await makeRunningCampaign({
    concurrencyLimit: 11, retryConcurrency: 3, retrySharePercent: 60,
  });
  await addContacts(campaign, { armKind: 'RESUME', count: 20, dueAt: NOW });

  expect((await runDialerPass({ now: NOW })).posted).toBe(11);
});

/**
 * The default, and the migration's whole safety story. At 0 the pass must
 * place the same calls in the same order it placed before the split existed.
 */
it('at retrySharePercent 0 keeps the urgent lanes ahead of retries', async () => {
  const campaign = await makeRunningCampaign({
    concurrencyLimit: 11, retryConcurrency: 3, retrySharePercent: 0,
  });
  await addContacts(campaign, { armKind: 'CALLBACK', count: 64, dueAt: NOW });
  await addContacts(campaign, { armKind: 'RETRY', count: 880, dueAt: NOW });

  await runDialerPass({ now: NOW });

  const callbacks = await prisma.callAttempt.count({
    where: { campaignId: campaign.id, kind: 'callback' },
  });
  expect(callbacks).toBe(11);
});
```

Use the file's existing campaign and contact helpers rather than the invented names above; the assertions are the specification.

**Step 2:** `npm test -- test/dialer-sweep.test.ts`. Expected: the herd case FAILS with `byKind.retry` undefined (all 11 dials are callbacks) — the bug, reproduced.

**Step 3: Implement.** Replace `claimLanes` in `src/services/dialer.ts`. Rewrite the doc comment above it: the old one describes the callback lane as unbounded and the resume lane as sharing the retry reservation, and both stop being true. Say what the design doc says — the herd, the two phases the pool comes from, and floors rather than ceilings.

```ts
async function claimLanes(
  campaign: SweepCampaign,
  budgets: { totalSlots: number; nonFreshBudget: number; freshBudget: number },
  lanes: LaneOccupancy,
  now: Date,
): Promise<ClaimedContact[]> {
  const onlyPhones = env.dialerTestAllowlist.size > 0 ? [...env.dialerTestAllowlist] : undefined;

  const take = (limit: number, lane: ClaimLane) =>
    claimContacts(prisma, {
      campaignId: campaign.id,
      limit,
      lane,
      retryCount: campaign.retryCount,
      maxTotalDials: totalDialsFor(campaign),
      now,
      onlyPhones,
    });

  /**
   * One pool, divided. Floors and not ceilings: each lane is offered its
   * floor, and then whatever the other did not take is offered back — so a
   * campaign with an empty resume queue dials retries with every slot it has,
   * and the split binds only while both sides have rows waiting.
   *
   * Three claims at most, and each returns without a round trip on a limit of
   * zero. This runs for every RUNNING campaign on the platform every minute.
   */
  const drainSplit = async (pool: number): Promise<ClaimedContact[]> => {
    if (pool <= 0) return [];

    const { retryFloor, urgentFloor } = splitPool({
      pool,
      retrySharePercent: campaign.retrySharePercent,
      activeRetry: lanes.retry,
      activeUrgent: lanes.urgent,
    });

    // A promise ahead of a resume, inside the share the two hold jointly.
    const urgent = await take(urgentFloor, 'urgent');

    // The retry lane's floor plus everything the urgent lanes left behind.
    const retries = await take(pool - urgent.length, 'retry');

    // And the urgent lanes take what the retry lane left, when it was dry.
    const spare = pool - urgent.length - retries.length;
    const extra = spare > 0 ? await take(spare, 'urgent') : [];

    return [...urgent, ...retries, ...extra];
  };

  const claimed: ClaimedContact[] = [];
  let remaining = budgets.totalSlots;

  // 1. The reservation, split.
  const reserved = await drainSplit(Math.min(budgets.nonFreshBudget, remaining));
  claimed.push(...reserved);
  remaining -= reserved.length;

  // 2. Fresh, out of its own budget. Unchanged.
  const freshTarget = Math.min(budgets.freshBudget, remaining);
  const fresh = await take(freshTarget, 'fresh');
  claimed.push(...fresh);
  remaining -= fresh.length;

  /**
   * 3. The borrow: the same split over what the fresh lane did not use.
   *
   * This is the pass a campaign whose import is finished spends ALL of its
   * budget in, and it used to be one unfiltered `any` claim ordered
   * `CALLBACK, RESUME, FOLLOW_UP, createdAt` — which is why a herd of
   * promises took every line and the retry queue sat still for a quarter of
   * an hour at a time.
   */
  claimed.push(...(await drainSplit(remaining)));

  return claimed;
}
```

The `retryConcurrency <= 0` short-circuit and the `'any'` lane both go: with no reservation the phase-1 pool is zero and everything arrives through phase 3, still split. Delete `'any'` from `ClaimLane`, `laneFilter` and `claimOrder` once nothing references it — and delete its query tests, or convert them to the `urgent`/`retry` pair they now describe.

The "proven dry" guard goes too. It existed to skip an unfiltered claim over lanes already known empty; every claim here is now filtered and returns without a round trip on a zero limit, so there is nothing left for it to save.

**Step 4:** `npm test -- test/dialer-sweep.test.ts test/dialer-claim.query.test.ts`. Expected: PASS.

**Step 5: Run the whole suite.**

```bash
npm test
```

Expected: 16 failures, the known env-only set, and nothing else.

**Step 6: Commit.**

```bash
git add src/services/dialer.ts src/services/dialerClaim.ts test/
git commit -m "Split the non-fresh pool by percentage, in the reservation and in the borrow"
```

---

## Task 7: The dashboard

**Files (in `ezo/.worktrees/retry-share-split/ye-voice-dashboard`):**
- Modify: `lib/types.ts` — `retrySharePercent: number` on `Campaign`
- Modify: `app/(dash)/campaigns/[id]/settings-tab.tsx:254, 425, 646`
- Modify: `app/(dash)/campaigns/new/page.tsx:79, 205, 264, 461`
- Modify: `app/(dash)/campaigns/[id]/overview-tab.tsx:255` and `settings-tab.tsx:1007`
- Test: `test/campaign-settings.test.tsx` (or the file that already covers the reservation field)

**Step 1:** `ln -s ../../../ye-voice-agent/ye-voice-dashboard/node_modules node_modules` — dashboard worktrees get no install of their own.

**Step 2: Write the failing test** for the settings field: renders the stored value, clamps to 0–100, submits `retrySharePercent` in the PATCH body.

**Step 3:** `npm test -- test/campaign-settings.test.tsx`. Expected: FAIL.

**Step 4: Implement** the field beside the reservation input, following the `wholeInRange` pattern already there:

```ts
const retrySharePercent = wholeInRange(form.retrySharePercent, 0, 100, 0);
```

**Step 5: Fix the sentence that stops being true.** `overview-tab.tsx:255` and `settings-tab.tsx:1007` currently read *"3 of those slots are reserved for contacts on a retry."* Once the split exists that sentence names one half of a division and hides the other. It has to say both, and it has to say floors rather than caps — a reader who takes "40% for callbacks" as a cap will not understand why a quiet hour dials 100% retries. Something in the register of the existing copy:

> 3 of those slots are reserved for contacts already called. 60% of them go to retries and the rest to callbacks and resumes — whichever runs out first, the other takes the slack.

**Step 6:** `npm test && npm run lint && npm run build`. Expected: PASS. If CI later reports `Vitest caught 1 unhandled error / ReferenceError: window is not defined`, check for "Test Files N passed" first — that is the known `surfaces-agents.test.tsx` flake, not this change.

**Step 7: Commit.**

```bash
git add lib/types.ts app/ test/
git commit -m "Campaign settings: split the reserved slots between retries and callbacks"
```

---

## Task 8: Verify against production's own shape

Before opening either PR, re-run the two diagnostics from the design doc against production and record the numbers in the PR body, so the review has the before to compare a later after against:

```sql
SELECT date_trunc('hour', ca."createdAt") AS hr, ca.kind, count(*)
FROM "CallAttempt" ca JOIN "Campaign" c ON c.id = ca."campaignId"
WHERE c.status = 'RUNNING' AND ca."createdAt" > now() - interval '12 hours'
GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;
```

Ask the user for `YE_PROD_DATABASE_URL`; it is not stored anywhere in the tree.

**Deploy order after both PRs merge:** backend first. The column is defaulted, so a dashboard build that does not send `retrySharePercent` keeps saving; a dashboard that sends it to a backend without the column would 400.

**Then, and only then:** set `retrySharePercent` on the two campaigns in the report and watch a window opening. `2026-09-08 04:30:00 UTC` has 64 promises stacked on it and `05:30:00` has 87 — either is the natural test.

---

## Out of scope

The herd itself. Spreading `rollIntoDialWindow` — jittering the rolled instants across the first minutes of the window rather than collapsing them onto one — is a separate and smaller change, and belongs in its own PR.
