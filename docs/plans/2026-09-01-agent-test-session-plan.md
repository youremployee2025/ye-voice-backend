# Agent Test Session — Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** a browser WebRTC session against one agent — started, capped, concurrency-bounded and **charged exactly as a call is** — behind two workspace routes. Design: [`2026-09-01-agent-test-session-design.md`](2026-09-01-agent-test-session-design.md).

**Architecture:** one new table (`TestSession`) modelled on `CallAttempt`, one nullable FK and two enum members on the ledger, two adapter functions, one start service, one settlement service, a fall-through in the existing `session.completed` handler, a second sweep in the existing cleanup worker, and two routes. **No new pricing code**: `resolveCallRate` and `chargeFor` are reused unchanged.

**Tech stack:** existing — Express, TypeScript, Prisma, Zod, Vitest + Supertest, BullMQ. No new dependencies.

---

## Read first

**Branch.** `feat/agent-test-session`. Do not commit to any other branch; do not push.

**This worktree needs its own two databases.** It has no `.env` (gitignored, so `git worktree add` did not carry one over). Before Task 1:

```bash
cp .env.example .env
# then edit .env so it has, at minimum:
#   DATABASE_URL="postgresql://localhost:5432/ye_voice_test_session_dev"
#   TEST_DATABASE_URL="postgresql://localhost:5432/ye_voice_test_session_test"
createdb ye_voice_test_session_dev
createdb ye_voice_test_session_test
npx prisma migrate dev            # brings the fresh dev DB up to origin/main
npm run test:prepare              # and the test DB
```

Sharing another worktree's dev database makes `prisma migrate dev` demand a reset; sharing another worktree's **test** database makes a branch you are not working on fail your suite in files you never touched. Both are worth four minutes.

**Never point either variable at Neon.** `test/setup.ts` refuses a `neon.tech` host, which is the last line of defence and not the first.

**Run vitest with the environment clean:** `env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run <file>`. `dotenv` does not override an exported variable, and a stale export silently runs the suite against another branch's database.

**The suite is flaky at roughly one full run in ten**, from cross-file bleed. A single failing file is a signal; a single failing *full run* is not. Re-run before concluding anything.

**TDD throughout.** Every task writes its failing test first and asserts exact `BigInt` values on the charge path — never `toBeCloseTo`.

---

### Task 1: Schema — the table, the enum, the ledger column

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql` (hand-edited)
- Modify: `test/setup.ts` (add `TestSession` to `truncateAll`)

**Step 1: Add the enum and model**

Copy the `TestSessionStatus` enum and the `TestSession` model verbatim from the design document, comments included. The comments are the design; a column whose reasoning is only in `docs/` is a column somebody will "simplify" next month.

**Step 2: Add the ledger column and the two types**

In `model CreditTransaction`, beside `callAttemptId`:

```prisma
  /// The browser test this row charges for. Set on `TEST_SESSION_USAGE` and
  /// `TEST_SESSION_SHORTFALL` rows only.
  testSessionId String?
```

and the relation, `Restrict` like its three siblings:

```prisma
  testSession TestSession? @relation(fields: [testSessionId], references: [id], onDelete: Restrict)
```

In `enum CreditTransactionType`, after `CALL_USAGE_SHORTFALL`:

```prisma
  /// Minutes consumed by one browser test session, charged when its completion
  /// webhook arrives. Carries `testSessionId`. NOT `CALL_USAGE`: that type's
  /// contract is that it carries a `callAttemptId`, and `LEDGER_CALL` reads it
  /// — a usage row with a null attempt renders as a charge for a call that
  /// does not exist.
  TEST_SESSION_USAGE
  /// Zero-amount marker: a test session ran and the balance could not cover
  /// it. Nothing was debited; `TestSession.costCredits` records what was owed.
  TEST_SESSION_SHORTFALL
```

**Step 3: Generate the migration**

```bash
npx prisma migrate dev --name agent_test_sessions
```

**Check the generated directory name sorts last** among `prisma/migrations/` — this repo's migrations are dated ahead of the system clock, and one that sorts early applies out of order. Rename the directory if it does not.

**Step 4: Hand-edit the migration for the partial unique index**

Prisma cannot express a partial unique index, so append it — the same arrangement `Tier.isDefault` already uses:

```sql
-- One live test session per workspace. A unique index rather than a counted
-- check, so the cap is atomic instead of a check-then-act two clicks can slip
-- between.
CREATE UNIQUE INDEX "test_sessions_one_live_per_workspace"
  ON "TestSession" ("workspaceId") WHERE status = 'ACTIVE';
```

Note the index in the model's schema comment, so a reader of `schema.prisma` alone learns the cap exists.

**Step 5: Apply to the test database and extend the truncate helper**

```bash
npm run test:prepare
```

Add `TestSession` to `truncateAll` in `test/setup.ts`, **before** `CreditTransaction` is deleted or after — follow whatever order that function already uses for `CallAttempt`, since the ledger's `Restrict` makes the order load-bearing.

**Step 6: Verify**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/agents.test.ts
```
Expected: PASS. Nothing behavioural changed; this proves the migration applied and the truncate order still works.

**Step 7: Commit**

```bash
git add prisma/ test/setup.ts
git commit -m "Record a browser test session as a billable row"
```

---

### Task 2: Configuration — three bounds

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `.env.example`
- Test: `test/env.test.ts` (or the file that already covers `env`)

**Step 1: Failing test first**

```ts
it('bounds a test session at five minutes by default', () => {
  expect(env.testSessionMaxSecs).toBe(300);
  expect(env.testSessionMaxConcurrent).toBe(2);
  expect(env.testSessionTimeoutMins).toBe(15);
});
```

**Step 2: Run it, expect FAIL** (`testSessionMaxSecs` is not a property).

**Step 3: Implement**

Beside `dialerAttemptTimeoutMins`, using the existing `count(name, fallback, min)` helper:

```ts
  /**
   * The hard ceiling on one browser test, in seconds.
   *
   * Three jobs, deliberately one number: the browser disconnects at it, the
   * start gate requires a balance that covers it, and the reaper treats an
   * `ACTIVE` row far past it as abandoned. Three numbers would eventually
   * disagree, and the disagreement is a session billed past what the customer
   * was told it could cost.
   */
  testSessionMaxSecs: count('TEST_SESSION_MAX_SECS', 300, 30),
  /**
   * Live test sessions across the WHOLE platform, not per workspace.
   *
   * Every test takes a line from the same concurrency pool the dialer runs on,
   * and the platform's default is five. Without this ceiling, enough
   * workspaces testing at once starve outbound dialing with no campaign doing
   * anything wrong and nothing on any screen saying why.
   */
  testSessionMaxConcurrent: count('TEST_SESSION_MAX_CONCURRENT', 2, 1),
  /** When an `ACTIVE` row is reconciled against the platform. */
  testSessionTimeoutMins: count('TEST_SESSION_TIMEOUT_MINS', 15, 1),
```

Document all three in `.env.example` in the section the dialer's bounds live in.

**Step 4: Run the test, expect PASS. Step 5: Commit** — `Bound a browser test session by duration and by concurrency`.

---

### Task 3: Adapter — two upstream calls

**Files:**
- Modify: `src/adapter/vocobase.ts`
- Test: `test/vocobase-adapter.test.ts` (whichever file already covers `request()`; create `test/test-session-adapter.test.ts` if there is none)

**Step 1: Failing tests first**

- `startWebSession` POSTs `/sessions/webrtc` with `{ agent_id, variables }` and returns `{ session_id, daily_room_url, daily_token }` from a `{ success, data }` envelope.
- `startWebSession` **omits** `variables` entirely when none are given (not `{}` — an empty object and an absent key are different requests, and only one of them is what "no variables" means).
- `getSession` returns `null` on a 404 and throws `UPSTREAM_ERROR` on a 500.

**Step 2: Run, expect FAIL.**

**Step 3: Implement**, in a new `// Test sessions` section after the call-history one:

```ts
export interface StartWebSessionBody {
  agent_id: string;
  variables?: Record<string, string>;
}

export interface StartWebSessionResponse {
  session_id?: string;
  agent_id?: string;
  daily_room_url?: string;
  daily_token?: string;
}

/**
 * Opens one browser WebRTC session against an agent.
 *
 * The room URL and token are single-use and scoped to one room; they are the
 * only upstream values on this path that reach a browser, and neither is the
 * partner key.
 *
 * There is no `max_call_duration_secs` on this endpoint. The cap is the
 * browser's timer and the reaper, which is why `TEST_SESSION_MAX_SECS` is
 * returned to the caller rather than assumed by it.
 */
export function startWebSession(body: StartWebSessionBody): Promise<StartWebSessionResponse> {
  return request<StartWebSessionResponse>('/sessions/webrtc', { method: 'POST', body });
}

/**
 * One session, telephony or browser, by the platform's own session id.
 *
 * `null` means the platform is certain there is no such session — the same
 * distinction `getCall` draws, and for the same reason: "no such session" is
 * about the session and an outage is about the platform, and the reaper acts
 * on them differently.
 */
export async function getSession(id: string): Promise<UpstreamRecord | null> {
  const session = await request<UpstreamRecord | typeof ABSENT>(
    `/sessions/${encodeURIComponent(id)}`,
    { absentOn404: true },
  );

  return session === ABSENT ? null : session;
}
```

**Step 4: Run, expect PASS. Step 5: Commit** — `Reach the platform's browser session endpoints`.

---

### Task 4: The start gate

**Files:**
- Create: `src/lib/testSessionStart.ts`
- Create: `test/test-session-start.test.ts`

This module answers **may this session start, and at what price** — and nothing else. It does not talk to the platform and it does not insert.

**Step 1: Failing tests first**

- Resolves the rate through `resolveCallRate(owner.id, agent.voiceTierSlug)` and returns both halves of the plan.
- A `TierRateUnavailableError` surfaces as a `TestSessionRefusal` with code `TEST_SESSION_RATE_UNAVAILABLE` and status 409.
- **The balance gate uses the whole cap, not one pulse.** At rate `10_000n`/min, increment 60 and `TEST_SESSION_MAX_SECS = 300`, the required float is exactly `50_000n`. An account holding `49_999n` is refused `INSUFFICIENT_CREDITS` (402); one holding `50_000n` passes.
- A retired agent (`status: 'removed'`) is refused `AGENT_NOT_USABLE` (409) even though it is still in the workspace — `agentIsUsable` covers this and must be called, not re-derived.
- An agent whose `workspaceId` is another workspace's is refused the same way the agents surface refuses one: not found.

**Step 2: Run, expect FAIL. Step 3: Implement**

```ts
export class TestSessionRefusal extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = 'TestSessionRefusal';
  }
}

export interface TestSessionPlan {
  tierId: string;
  tierSlug: string;
  rateCreditsPerMin: bigint;
  billingIncrementSecs: number;
  /** What the session may cost at most, which is what the balance must cover. */
  maxCostCredits: bigint;
}

export async function planTestSession(
  accountId: string,
  agent: { voiceTierSlug: string | null },
): Promise<TestSessionPlan>
```

Reuse `chargeFor(rate, env.testSessionMaxSecs, increment).cost` for `maxCostCredits`. Do not compute the ceiling by hand: a second implementation of the two roundings is a second answer to "what does a minute cost".

The balance check itself belongs in the transaction in Task 5, not here — this module returns the number that must be covered.

**Step 4: Run, expect PASS. Step 5: Commit** — `Price a browser test before it starts`.

---

### Task 5: Starting and ending a session

**Files:**
- Create: `src/services/testSession.ts`
- Create: `test/test-session-service.test.ts`

**Step 1: Failing tests first** (the adapter mocked, as every other test mocks it)

1. **Happy path.** Inserts an `ACTIVE` row with every snapshot populated, calls `startWebSession` once with `{ agent_id: agent.externalId }`, stamps `upstreamSessionId`, returns `{ id, roomUrl, token, maxDurationSecs }`.
2. **Variables are forwarded** when given and the key is **absent** when not.
3. **One live session per workspace.** A second start while one is `ACTIVE` refuses `TEST_SESSION_IN_PROGRESS` (409) — and asserts it comes from the *index*, by racing two `startTestSession` calls with `Promise.allSettled` and expecting exactly one fulfilment.
4. **The platform-wide ceiling.** With `TEST_SESSION_MAX_CONCURRENT = 1` and a live session in **another** workspace, a start refuses `TEST_SESSION_UNAVAILABLE` (409).
5. **Upstream failure frees the slot.** `startWebSession` rejecting leaves the row `FAILED`, and the very next start in that workspace succeeds.
6. **A missing session id is not a silent success.** A 201 with no `session_id` marks the row `FAILED` and throws `TEST_SESSION_STARTED_UNTRACKED` (502).
7. **`endTestSession` moves `ACTIVE → ENDING`, stamps `endedAt`, charges nothing** (`chargedAt` still null, no ledger row) and frees the slot: a start immediately afterwards succeeds.
8. **`endTestSession` on another workspace's session is a 404**, identical to a nonexistent id.

**Step 2: Run, expect FAIL. Step 3: Implement**

```ts
export async function startTestSession(input: {
  workspace: { id: string; ownerAccountId: string };
  agent: Agent;
  startedByAccountId: string;
  variables?: Record<string, string>;
}): Promise<{ id: string; roomUrl: string; token: string; maxDurationSecs: number }>
```

Three writes, in this order and no other:

1. **`prisma.$transaction`**: count live rows platform-wide (`status: { in: ['ACTIVE'] }`) against `env.testSessionMaxConcurrent`; re-read the owner's balance and compare against `plan.maxCostCredits`; insert the `ACTIVE` row with the snapshots. A `P2002` on the partial index becomes `TEST_SESSION_IN_PROGRESS` — catch the Prisma error rather than counting first, or the cap is a check-then-act.
2. **`startWebSession`.** On rejection, `update` the row to `FAILED` and rethrow as `UPSTREAM_ERROR`; the slot is free either way.
3. **Stamp `upstreamSessionId`.** Retry once. On a second failure mark the row `FAILED` and throw `TEST_SESSION_STARTED_UNTRACKED` — the same shape as `AGENT_CREATED_UNASSIGNED`, message saying the session started, could not be recorded, and to contact support rather than retry.

Holding the slot **before** calling upstream is deliberate: a burst of clicks then costs one platform call rather than one per click.

```ts
export async function endTestSession(workspaceId: string, id: string): Promise<void>
```

`updateMany({ where: { id, workspaceId, status: 'ACTIVE' }, data: { status: 'ENDING', endedAt: new Date() } })`. A count of zero is a 404 — foreign, already ended and nonexistent all answer identically, which is the rule every other surface here holds.

**Step 4: Run, expect PASS. Step 5: Commit** — `Start and release a browser test session`.

---

### Task 6: Settlement

**Files:**
- Create: `src/services/testSessionOutcome.ts`
- Create: `test/test-session-outcome.test.ts`

**Step 1: Failing tests first.** These are the money tests; write them all before any implementation.

1. **A 47-second session on a 60-second increment at `10_000n`/min** charges `10_000n`, stores `durationSecs 47` and `billedSecs 60`, stamps `chargedAt` and `resolvedAt`, and writes one `TEST_SESSION_USAGE` row carrying `testSessionId` and `reference = session.id`.
2. **A zero-duration session writes no ledger row** and still stamps `chargedAt`. Assert `creditTransaction.count()` is `0` and the account balance is unchanged.
3. **Exactly once.** Calling `settleTestSession` twice with the same `eventKey` charges once — the second returns `'already_closed'` and the balance moves once.
4. **Exactly once across two different event keys.** The webhook's key and the reaper's key differ deliberately; the `chargedAt IS NULL` guard in the `updateMany`'s `where` is what covers this, not the ledger's unique. Assert the balance moved once.
5. **Shortfall fails closed.** An account holding less than the cost: balance unchanged, `shortfall: true`, one zero-amount `TEST_SESSION_SHORTFALL` row, `chargedAt` still stamped so a later delivery cannot retry the charge.
6. **The snapshot is what bills.** Re-price the tier between start and settlement; assert the charge uses the row's `rateCreditsPerMin`, not the tier's current one.
7. **A null `billingIncrementSecs`** — a row written before the column existed — bills per second, not per minute.

**Step 2: Run, expect FAIL. Step 3: Implement**

```ts
export interface TestSessionOutcome {
  sessionId: string;        // the local TestSession id
  eventKey: string;
  durationSecs: number;
  upstreamStatus: string | null;
  endedAt: Date | null;
}

export async function settleTestSession(
  outcome: TestSessionOutcome,
): Promise<'charged' | 'already_closed' | 'unknown'>
```

The transaction is `applyTerminalOutcome`'s, minus every campaign concern:

```
tx.webhookEvent.create({ eventKey })                       ← the exactly-once marker
tx.testSession.updateMany({ where: { id, chargedAt: null }, data: { … } })
  ↳ count === 0  → 'already_closed'
if (cost === 0n) return 'charged'                          ← no ledger row, by design
tx.account.updateMany({ where: { id: accountId, credits: { gte: cost } },
                        data: { credits: { decrement: cost } } })
  ↳ count === 0  → shortfall branch
tx.creditTransaction.create({ … TEST_SESSION_USAGE … })
```

**No campaign row lock.** There is no campaign, which also means the lock-ordering hazard `applyTerminalOutcome` documents does not exist on this path — say so in a comment, or the next reader will add a lock to match.

Status is `COMPLETED` when upstream said so and `FAILED` otherwise; both are settled, and `chargedAt` is what says so.

**Step 4: Run, expect PASS. Step 5: Commit** — `Charge a browser test session from the platform's own account of it`.

---

### Task 7: The webhook fall-through

**Files:**
- Modify: `src/routes/webhooks.routes.ts`
- Test: `test/webhooks.test.ts` (extend)

**Step 1: Failing tests first**

1. A `session.completed` whose `session_id` matches a live `TestSession` charges it.
2. A `session.completed` matching **neither** an attempt nor a test session still answers **200**, writes nothing, and logs only the id. This test already exists in some form — extend it, and make sure it still passes. The endpoint is account-wide and receives every other integrator's completions, transcripts included.
3. An event whose `session_id` matches an attempt is **not** looked up as a test session (assert the test-session lookup is not reached, or simply that no `TestSession` row was touched).

**Step 2: Run, expect FAIL. Step 3: Implement**

In `handleSessionCompleted`, where the handler currently logs an unknown call and returns: before that line, try `prisma.testSession.findUnique({ where: { upstreamSessionId: sessionId } })` and, on a hit, delegate to `settleTestSession` with the same `eventKey` the handler already builds. Everything after stays exactly as it is.

Add a comment saying why the order is attempt-first: an attempt is the far more common event and the test-session table is the smaller, newer one, so the hot path is not made to pay for the rare one.

**Step 4: Run, expect PASS. Step 5: Commit** — `Settle a browser test from its completion event`.

---

### Task 8: The reaper

**Files:**
- Create: `src/services/testSessionReaper.ts`
- Modify: `src/lib/queue/workers/campaign-cleanup.worker.ts`
- Create: `test/test-session-reaper.test.ts`

**Step 1: Failing tests first**

1. An `ENDING` row older than 60 seconds is reconciled; a fresher one is left alone.
2. An `ACTIVE` row older than `TEST_SESSION_TIMEOUT_MINS` is reconciled; a fresher one is left alone.
3. `getSession` returning a completed session with `duration_seconds: 90` settles and charges it.
4. `getSession` returning `null` — the platform has never heard of it — marks it `ABANDONED`, charges nothing, and stamps `chargedAt` so it cannot be charged later.
5. `getSession` still reporting `active` leaves the row `ACTIVE` for the next tick. **The reaper never guesses a duration.**
6. A row with a null `upstreamSessionId` — the untracked-start case — goes straight to `ABANDONED` without an upstream call.
7. One unreadable row does not stop the rest: an adapter throwing on the first of three still reconciles the other two.

**Step 2: Run, expect FAIL. Step 3: Implement**

```ts
/** Bounded like every other pass here: a large stale set is a symptom, and
 *  working through all of it in one tick is not the fix. */
const BATCH = 50;

export async function closeStaleTestSessions(now: Date): Promise<number>
```

Two cutoffs in one `OR`, `chargedAt: null` on both arms, `orderBy: { startedAt: 'asc' }`, `take: BATCH`. The event key is `testSession.reap:<id>` — deliberately different from the webhook's key, which is exactly why Task 6's test 4 exists.

Then, in `createCampaignCleanupWorker`, beside `closeStaleAttempts` and `releaseStaleClaims`:

```ts
      // The third thing a killed instance leaves behind: a browser test whose
      // completion event never arrived. Free by construction to call twice, on
      // the same compare-and-set argument this worker already makes.
      const settled = await closeStaleTestSessions(now);
```

Include it in the returned count and in the log line's condition.

**Step 4: Run, expect PASS.** Also run `test/queue-*.test.ts` — the cleanup worker has its own coverage and its return value changed.

**Step 5: Commit** — `Reconcile a browser test whose completion never arrived`.

---

### Task 9: Routes

**Files:**
- Create: `src/routes/testSessions.routes.ts`
- Modify: `src/app.ts`
- Modify: `src/lib/writeLimiter.ts` (add a second, tighter limiter beside it)
- Create: `test/test-session-routes.test.ts`

**Step 1: Failing tests first**

1. `POST /api/workspaces/:id/agents/:agentId/test-session` as a **MEMBER** succeeds — this is the deliberate deviation and a test is what keeps somebody from "fixing" it.
2. A non-member gets 403; an agent in another workspace gets 404; a nonexistent agent gets the same 404.
3. `{ variables: { contact_name: 'Asha' } }` reaches the adapter; `{ variables: { a: 1 } }` (a non-string value) is a 400 `VALIDATION_ERROR`; more than 50 keys is a 400.
4. The response body carries `max_duration_secs` and **does not carry the upstream session id** — assert the serialized body's keys explicitly. That id is an upstream handle on a shared partner account and belongs to the same class `serialize.ts` already keeps off the wire.
5. The 7th start in a minute from one workspace is 429.
6. `POST /api/workspaces/:id/test-sessions/:sessionId/end` returns 204 and another workspace's session id returns 404.

**Step 2: Run, expect FAIL. Step 3: Implement**

The Zod body: `variables: z.record(z.string().min(1).max(64), z.string().max(1000)).optional()`, at most 50 keys via `.refine`. Bound it here rather than trusting the platform, for the reason `agentPayload.ts` gives about every other field it bounds.

Middleware order, exactly as every other write route has it:

```
requireAuth → requireMembership() → testSessionLimiter → handler
```

`testSessionLimiter` beside `writeLimiter`, keyed on the workspace, `limit: 6, windowMs: 60_000`, with a comment naming the platform's documented **10 starts/minute per key, account-wide** as the budget being protected — the same reasoning `writeLimiter` gives about a partner rate limit every customer shares.

Mount in `app.ts` with the other workspace routers: `app.use('/api/workspaces', testSessionRoutes)`.

Map the refusals in the handler's catch, one code per thing to fix: `TEST_SESSION_IN_PROGRESS` and `TEST_SESSION_UNAVAILABLE` → 409, `TEST_SESSION_RATE_UNAVAILABLE` → 409, `AGENT_NOT_USABLE` → 409, `INSUFFICIENT_CREDITS` → 402, `TEST_SESSION_STARTED_UNTRACKED` → 502.

**Step 4: Run the whole suite** (`env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run`). Expect PASS, allowing for the known ~10% flake — re-run any failure in isolation before treating it as yours.

**Step 5: Commit** — `Expose starting and ending a browser test session`.

---

### Task 10: Documentation

**Files:** `CLAUDE.md`

**Step 1:** Add a `## Browser test sessions` section after `## Call history`, carrying: the routes table, the six ordered gates, the two concurrency caps and why the platform-wide one exists, the settlement pair (webhook + reaper), and the three env values. State plainly that a test session is charged like a call and shares the platform's concurrency pool with the dialer.

**Step 2:** Add `TEST_SESSION_USAGE` / `TEST_SESSION_SHORTFALL` to the credits section's account of the machine-written types, and note that `dialerOutcome.ts` and `didRental.ts` are no longer the only modules that move credits — `testSessionOutcome.ts` is the third.

**Step 3:** Add the two new codes to the route-conventions list if it enumerates them.

**Step 4: Commit** — `Document browser test sessions`.

---

## Done when

- `env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run` passes (allowing the known flake, confirmed by re-running failures in isolation).
- `npm run build` is clean.
- A live start against the real platform returns a room URL and a token, and the session appears as an `ACTIVE` row — verified manually once, from the dashboard half of this feature.
- Ending it produces exactly one `TEST_SESSION_USAGE` ledger row whose `billedSecs` is a whole number of the account's increment, and the balance moved by exactly that amount.
