# Lead-Centric Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the call-centric `/analytics` page with a lead-centric,
four-tab page matching Convin Sense's Analytics, backed by new workspace-level
lead rollup endpoints.

**Architecture:** A new `leadAnalytics.ts` service computes lead-level
aggregates over `CampaignContact` (the row-per-contact table) rather than
`CallAttempt` (row-per-dial). Three tab-scoped routes keep any one tab
cancellable. The dashboard page becomes a shell — filter card + tab bar — with
one component per tab. Existing primitives are reused wherever they exist:
`reachedContactsFilter`, `REACHED_ATTEMPT`, `campaignLeadBuckets`,
`parseAnalyticsRange`.

**Tech Stack:** Express + Prisma + Postgres (raw SQL for the grouped
aggregates), Vitest; Next.js App Router + Tailwind on the dashboard.

**Design:** `docs/plans/2026-09-21-convin-analytics-design.md`

---

## Ground rules, carried from the existing page

These are not style preferences. Each is a bug that shipped once.

1. **A rate with a zero denominator is `null`, never `0`.** `0%` asserts that
   calls were placed and none connected.
2. **A failed read is never rendered as a measurement.** No empty array
   standing in for an error.
3. **`metered` is read from the payload, never assumed.**
4. **Counts are computed in SQL.** Nothing loads a workspace's contacts into
   Node to count them.
5. Every new endpoint is workspace-scoped through `requireMembership()` and
   `workspaceOf(req)` — never a `workspaceId` read straight from params.

## Environment

Worktree: `ye-voice-agent/.worktrees/convin-analytics/`
- backend DB: `ye_voice_convin_analytics` (5436), test DB
  `ye_test_convin_analytics` (5435)
- Run backend tests with `npm test`. Per project history the suite is ~10%
  flaky from cross-file bleed — **re-run a failure 5-10x before believing it.**

---

# Phase 1 — Backend

## Task 1: Lead totals over a workspace

**Files:**
- Create: `src/services/leadAnalytics.ts`
- Test: `test/lead-analytics.test.ts`

**Step 1: Write the failing test**

Seed one workspace, two campaigns, and contacts in known states: some never
dialled, some dialled and not reached, some reached. Assert:

```ts
const result = await leadOutcome(workspace.id, { range: RANGE, campaigns: [] });

expect(result.totals.attemptedLeads).toBe(4);
expect(result.totals.connectedLeads).toBe(2);
expect(result.totals.connectivity).toBeCloseTo(0.5);
```

And the rule that matters most — a workspace with no dialled leads:

```ts
expect(empty.totals.connectivity).toBeNull();   // NOT 0
```

**Step 2: Run it and watch it fail**

`npx vitest run test/lead-analytics.test.ts -t 'lead totals'`
Expected: FAIL — `leadOutcome is not a function`.

**Step 3: Implement `leadOutcome` totals only**

- `attemptedLeads`: `CampaignContact` where `lastAttemptAt` is not null.
- `connectedLeads`: `callAttempts: { some: REACHED_ATTEMPT }` — reuse
  `REACHED_ATTEMPT` from `campaignOutcomes.ts`, do not re-define "reached".
- `connectivity`: `connected / attempted`, or `null` when `attempted === 0`.

**Step 4: Run, expect PASS. Step 5: Commit.**

`feat(analytics): lead-level attempted/connected totals`

---

## Task 2: Lead State and Goal Achieved distributions

**Files:** Modify `src/services/leadAnalytics.ts`, `test/lead-analytics.test.ts`

**Step 1: Failing test** — assert `leadState` groups by
`CampaignContact.status` and that `SETTLED_STATUSES` collapse to `Completed`
while the rest read `Active`; assert `goal` splits `goalAchieved` into
`yes` / `no` / `notEvaluated`, with **null meaning not evaluated, never `no`**.

```ts
expect(result.goal).toEqual({ yes: 3, no: 5, notEvaluated: 2 });
```

**Step 2-5:** fail → implement with a single `groupBy` per dimension → pass →
commit `feat(analytics): lead state and goal distributions`.

**Note:** `goalAchieved` is null for two different reasons — the campaign has
no goal, or the contact has not settled. Both read as `notEvaluated` here; the
tile copy must not say "missed".

---

## Task 3: Qualification donut

**Files:** Modify `src/services/leadAnalytics.ts`, `test/lead-analytics.test.ts`

Derived, not stored. Definition, to be encoded in one place and commented:

| Bucket | Predicate |
|---|---|
| Qualified | settled AND `goalAchieved = true` |
| Not Qualified | settled AND `goalAchieved = false` |
| In Progress | not settled |
| Not Evaluated | settled AND `goalAchieved IS NULL` |

**Step 1: Failing test** asserting the four counts sum to the contact total —
that sum is the invariant worth testing, because a contact falling through all
four predicates would silently shrink the donut.

**Steps 2-5:** fail → implement → pass → commit.

---

## Task 4: Pooled Interest donut

**Files:** Modify `src/services/leadAnalytics.ts`, `test/lead-analytics.test.ts`

Per the design's contested decision: pool across campaigns.

**Step 1: Failing test** — two campaigns with *different* `leadBucketKey`s,
each with bucket values. Assert the pooled donut sums them on the folded
(lowercased, trimmed) name, and that `distinctKeys` reports `2`:

```ts
expect(result.interest.distinctKeys).toBe(2);
expect(result.interest.buckets).toContainEqual({ name: 'hot', count: 3 });
```

Also assert case folding: `Hot` and `hot` are one bucket.

**Step 2-5:** fail → implement by calling `campaignLeadBuckets(campaigns)` and
reducing the per-campaign maps on folded name → pass → commit.

**Do not re-implement bucket extraction.** `campaignLeadBuckets` already reads
the latest extraction per contact across **both** `CallAttempt` and
`CampaignInboundCall`, folds case, caps at `MAX_REPORTED_BUCKETS = 40` and
reports `truncated`. Reducing its output is the whole task.

Carry `truncated` through: if any campaign truncated, the pooled result is
truncated and the card must say so.

---

## Task 5: `GET /:workspaceId/analytics/leads/outcome`

**Files:** Modify `src/routes/analytics.routes.ts`, create
`test/lead-analytics-routes.test.ts`

**Step 1: Failing test** covering, in order of how badly each has bitten
before:

1. 200 shape for a member.
2. **404 for a workspace the caller is not a member of** — not 403, matching
   the existing routes' reasoning that distinguishing them lets a caller sort
   ids into real and unreal.
3. 400 for a malformed range.
4. Campaign filter: `?campaign=<id>` narrows, and an id from **another**
   workspace is rejected rather than silently widening the read.

**Steps 2-5:** fail → wire the route with `requireAuth`,
`requireMembership()`, `parseAnalyticsRange` → pass → commit.

---

## Task 6: `GET /analytics/leads/activity`

**Files:** Modify `src/services/leadAnalytics.ts`, `src/routes/analytics.routes.ts`, tests

Three payload parts:

- **Tiles**: attempted, connected, connectivity, `avgTalkSecs` — the mean of
  `durationSecs` over **reached attempts only**. Averaging over all attempts
  would fold 0-second failed dials into talk time.
- **Caller IDs**: group `CallAttempt` by `fromNumber` over the range →
  attempted, connected, noAnswer, failed, connectivity. Paginated, ordered by
  connectivity desc. `fromNumber` is nullable; null rows group under a single
  "Unknown" entry rather than being dropped.
- **Weekly pattern**: `date_trunc`/`EXTRACT(dow, hour)` over `startedAt` in the
  workspace's timezone, with attempted and connected per cell.

**Timezone warning:** the existing overview returns UTC days and says so on the
page. The heatmap is about *human calling hours*, so a UTC bucket is actively
misleading. Use `AT TIME ZONE` with an explicit zone and state the zone in the
payload, the way `WorkspaceOverview.timezone` already does.

**Step 1: Failing test** — a call at 23:30 local must land in the local hour
bucket, not the UTC one. This is the assertion that catches the whole class.

---

## Task 7: `GET /analytics/leads/spend`

**Files:** Modify `src/services/leadAnalytics.ts`, `src/routes/analytics.routes.ts`, tests

- `totalSpend`: sum of `CallAttempt.costCredits` over the range.
- `costPerConnectedLead` / `costPerGoalLead` / `costPerInterestedLead`: total
  over the respective lead count, **null when the denominator is zero**.
- `timeline`: credits per day.

**Step 1: Failing test** asserting every cost-per-lead is `null`, not `0`, when
no lead qualifies — and that `metered: false` suppresses all four rather than
reporting zeroes.

**Credits are BigInt.** Serialize as a decimal string exactly as
`AnalyticsTotals.creditsSpent` does; never `Number(bigint)`.

---

## Task 8: Backend green + PR

Run the full suite. Per project history expect ~10% flake from cross-file
bleed — re-run any failure 5-10x before investigating, and only investigate a
failure that reproduces.

```bash
npm test
npx tsc --noEmit
```

Commit, push, open the backend PR. **Merging backend `main` auto-deploys to
Render**, so the PR merge is a production deploy — hand the merge command to
the operator rather than running it.

---

# Phase 2 — Dashboard shell + Outcome tab

## Task 9: Types

**Files:** Modify `lib/types.ts`

Mirror the three payloads. Every count is required; every **rate is
`number | null`**; every credits figure is `string | null`. Fields added after
this branch cut are optional, and absent must read as the safe direction —
the same convention `WorkspaceAnalytics` documents.

## Task 10: Filter card

**Files:** Create `components/analytics/filter-card.tsx`, test

Seven controls; **Apply Filters** commits to the URL. Deferred, not live: these
queries are slow enough that live filtering would leave several in flight and
render whichever landed last.

**Test:** changing a control without pressing Apply must not change the URL.

## Task 11: Tab bar + shell

**Files:** Modify `app/(dash)/analytics/page.tsx`, create `components/analytics/tab-bar.tsx`

Tab in the URL as `?tab=`. Unknown value falls back to `outcome` rather than
rendering blank.

## Task 12: Outcome tab

**Files:** Create `app/(dash)/analytics/outcome-tab.tsx`

4 tiles → 2 bars → 2 donuts → campaigns table (carried over from the old page).

**The Interest donut card must state its own weakness**: how many distinct
bucket keys fed it, and that values from different campaigns are pooled. The
long tail folds into `Other` behind a disclosure. This is the honesty the
design traded away by pooling; the label is what is left of it.

---

# Phase 3 — Activity + Spend tabs

## Task 13: `metric-tile.tsx` + `chart-card.tsx`
Convin-weight variant over the existing `StatTile` — 40px chip top-right,
larger numeral, delta inline. **Wrap, do not fork:** `StatTile` already owns
the null branch and the delta-suppression rule.

## Task 14: `caller-id-table.tsx` — paginated, tinted numerals, connectivity pills
## Task 15: `weekly-heatmap.tsx` — dow × hour, Activity/Leads toggle
## Task 16: `activity-tab.tsx`
## Task 17: `spend-tab.tsx`

---

# Phase 4 — Reports tab

## Task 18: `reports-tab.tsx`
Card list over the existing `/analytics/export`. Only the reports whose data
exists — do not list a CSV that returns an empty file.

---

# Phase 5 — Verify

## Task 19: Run it
Backend on 3001, dashboard on 3000, against the worktree DB with seeded data.
Walk all four tabs. **Verify the null-vs-zero rule in the browser**, not only
in tests: a workspace with no dialled leads must show `—`, never `0%`.

## Task 20: Full suite both repos, tsc clean, PRs opened

---

## Out of scope, tracked

The production "This workspace has no campaigns yet" bug — see the design doc's
final section. Two live hypotheses, unproven, deliberately not fixed here.
