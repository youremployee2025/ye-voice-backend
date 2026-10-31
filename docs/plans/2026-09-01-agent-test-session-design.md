# Testing an agent from the browser

An operator editing an agent's prompt has no way to hear it. The only way to
find out what a change did is to put the agent on a campaign and dial a real
phone, which costs a contact and takes minutes. This adds a **Test** button to
the agent page that opens a live WebRTC session to that agent in the browser.

The voice platform exposes this as `POST /sessions/webrtc`: it returns a Daily
room URL and a token, the browser connects to them with the Pipecat client, and
the platform bills the partner account **1 credit per 60 seconds** exactly as it
bills a phone call. So this is not a free preview. It is a call without a
carrier, and it is designed as one.

## What this is not

- **Not a new billing model.** Rate resolution, the two roundings, the
  fail-closed shortfall and the exactly-once ledger guard are all reused from
  the dialer. Nothing about pricing is restated here.
- **Not a call.** No `CallAttempt` row, no campaign, no contact, no DID, no
  correlation key. A test session belongs to a person and an agent, and the
  campaign machinery has no opinion about it.
- **Not a session viewer.** The panel shows the agent talking and nothing else.
  Transcript, extraction and recording already have a home on the calls surface
  and do not get a second one here.

## The record

A test session is charged, so it needs a row to charge against. `TestSession`
is modelled on `CallAttempt` — same snapshot discipline, same charge columns,
same names — because the two answer the same question in different
circumstances, and a reader who knows one should not have to learn the other.

```prisma
enum TestSessionStatus {
  /// Live. Holds the workspace's one slot.
  ACTIVE
  /// The browser said it hung up. Frees the slot; still unsettled.
  ENDING
  COMPLETED
  /// The platform refused, or never gave us a session id.
  FAILED
  /// The platform has no record of it. Settled at zero.
  ABANDONED
}

model TestSession {
  id String @id @default(cuid())

  /// Snapshots, captured at start, exactly as `CallAttempt` captures its
  /// workspace and account. Plain columns and no foreign key: this row is a
  /// billing record and must outlive everything it names.
  workspaceId String
  /// WHO IS BILLED: the workspace owner at the moment the session started. An
  /// ownership change mid-session must not redirect the charge to somebody who
  /// never started it.
  accountId   String
  agentId     String
  /// Who pressed Test. Not who pays — that is `accountId` — but a charge
  /// nobody can attribute to a person is one nobody can explain.
  startedByAccountId String

  /// The platform's own id, recorded from the 201. Unique, so a duplicate
  /// delivery cannot attach to two rows. Null only between the insert that
  /// holds the slot and the stamp that follows the 201.
  upstreamSessionId String? @unique

  status TestSessionStatus @default(ACTIVE)
  upstreamStatus String?

  /// SNAPSHOTS of the plan this session started under, both halves resolved
  /// together. Read back at settlement rather than resolved again: staff may
  /// re-price or re-pulse the tier while somebody is still talking.
  tierId               String?
  tierSlug             String?
  rateCreditsPerMin    BigInt?
  billingIncrementSecs Int?

  /// Billed on `duration_seconds` and never on anything else, for the reason
  /// the dialer gives: the completion webhook carries only this one.
  durationSecs Int?
  /// `durationSecs` rounded UP to `billingIncrementSecs`. Always >= it, always
  /// a whole number of pulses.
  billedSecs   Int?
  costCredits  BigInt?
  /// Set even for a zero-duration session, so one cannot be charged twice.
  chargedAt    DateTime?
  shortfall    Boolean @default(false)

  startedAt  DateTime  @default(now())
  endedAt    DateTime?
  resolvedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  ledgerRows CreditTransaction[]

  @@index([workspaceId, startedAt])
  @@index([status, startedAt])
  @@index([accountId, status])
}
```

`CreditTransaction` gains a nullable `testSessionId` with `onDelete: Restrict`,
matching `callAttemptId` and for the identical reason: a ledger documented as
append-only cannot lose its referent.

Two new `CreditTransactionType` members:

| Member | Meaning |
|---|---|
| `TEST_SESSION_USAGE` | Minutes consumed by one browser test. Carries `testSessionId`. |
| `TEST_SESSION_SHORTFALL` | Zero-amount marker: the session ran and the balance could not cover it. |

**Not `CALL_USAGE`.** That type's contract is that it carries a
`callAttemptId`, and `LEDGER_CALL` in `serialize.ts` is the include that reads
it. A usage row with a null attempt would render on the billing surface as a
charge for a call that does not exist, which is worse than an unfamiliar word.

`reference = testSession.id`, so the existing `@@unique([accountId, reference])`
makes a second charge for one session unreachable at the database — the same
guard `CALL_USAGE` leans on.

## Starting one

Ordered, and every refusal names one thing to fix.

| # | Gate | Refusal |
|---|---|---|
| 1 | `requireAuth` → `requireMembership()` | 403 |
| 2 | `testSessionLimiter` — 6 starts/min per workspace | 429 `RATE_LIMITED` |
| 3 | `agentInWorkspace()` + `agentIsUsable` | 404, or 409 `AGENT_NOT_USABLE` |
| 4 | `resolveCallRate(owner.id, agent.voiceTierSlug)` | 409 `TEST_SESSION_RATE_UNAVAILABLE` |
| 5 | Balance covers `TEST_SESSION_MAX_SECS` at that rate | 402 `INSUFFICIENT_CREDITS` |
| 6 | One live session per workspace; `TEST_SESSION_MAX_CONCURRENT` platform-wide | 409 `TEST_SESSION_IN_PROGRESS` / `TEST_SESSION_UNAVAILABLE` |

**Any member, deliberately.** The permission matrix already grants members
"use agents, campaigns and sessions", and testing an agent you are allowed to
edit is not a larger act than editing it — an operator who can rewrite the
prompt but cannot hear it is the situation this feature exists to end. The
spend is bounded by gates 2, 5 and 6 rather than by role, which is the right
place to bound it: an ADMIN looping the button would cost exactly as much.

**Unpriced is not free** (gate 4). A platform with no default tier and an agent
on an unknown voice has no resolvable rate, and starting anyway means deciding
the cost after the money is spent. The dialer refuses to launch for this
reason; so does this.

**The balance gate is the whole cap, not one pulse** (gate 5). A session that
cannot be paid for in full should not start, and at 300 seconds the sum is a
couple of credits. This makes the shortfall path unreachable except under
concurrent spend. It is still implemented — unreachable is not removed, and the
one thing worse than a shortfall is a shortfall with no code path.

**Two caps, and the second is the important one** (gate 6). One live session per
workspace is enforced by a partial unique index, hand-written in the migration
because Prisma cannot express it — the same arrangement `Tier.isDefault` uses:

```sql
CREATE UNIQUE INDEX test_sessions_one_live_per_workspace
  ON "TestSession" ("workspaceId") WHERE status = 'ACTIVE';
```

That alone is not enough. Every test takes a line from the **same concurrency
pool the dialer runs on**, and the platform's default is five. Eight workspaces
testing at once would starve outbound dialing with no campaign doing anything
wrong and nothing on any screen saying why. `TEST_SESSION_MAX_CONCURRENT`
(default 2) is the platform-wide ceiling that stops it, counted in the same
transaction as the insert.

Deliberately **not** folded into `concurrency.ts`. That module counts
`CallAttempt` rows in one raw claim statement on the dispatcher's hot path, and
widening it to a union across two tables to bound a draw that is already capped
at two is a change to the dialer to solve a problem outside it.

### The three writes, and the one that can orphan

1. **Insert `ACTIVE`** with a null `upstreamSessionId`. This holds the slot, and
   the partial index makes the cap atomic rather than a check-then-act.
2. **`POST /sessions/webrtc`** with `agent_id` and the caller's `variables`.
   A failure marks the row `FAILED` and frees the slot.
3. **Stamp `upstreamSessionId`.** Retried once. A second failure answers 502
   `TEST_SESSION_STARTED_UNTRACKED`, whose message says the session started and
   could not be recorded and to contact support rather than retry — the same
   shape as `AGENT_CREATED_UNASSIGNED`. A session we cannot name is one we can
   never settle, and the reaper will close it as `ABANDONED` at zero.

The order matters in that direction. Holding the slot before calling upstream
means a burst of clicks costs one platform call, not one per click.

## Settling one

The same pair the dialer has, for the same reason: a webhook is a delivery, not
a guarantee.

**The webhook.** `session.completed` already arrives at `/webhooks` and already
resolves a `CallAttempt` by call id, session id, then correlation key. When none
of the three matches, it now tries `TestSession.upstreamSessionId` before
falling through to the existing "not ours — log the id, persist nothing, 200".
That fall-through stays exactly as it is: the endpoint is account-wide and
receives every other integrator's completions.

Charging goes through `settleTestSession()` in
`src/services/testSessionOutcome.ts`, guarded by the identical `WebhookEvent`
marker inside the transaction. The key is unchanged —
`session.completed:{session_id}` — and a test session and an attempt are
different sessions, so the two can never contend for one key.

The transaction is the dialer's, minus everything about campaigns:

```
WebhookEvent marker (exactly-once)
  → updateMany TestSession WHERE id AND chargedAt IS NULL   (the second guard)
  → if cost == 0n: return                                   (no ledger row)
  → conditional debit: WHERE credits >= cost                (never read-modify-write)
  → shortfall branch, or the TEST_SESSION_USAGE row
```

No campaign lock is taken, because there is no campaign — which also means the
lock-ordering hazard that transaction documents does not exist here.

**The reaper.** `closeStaleTestSessions()` in the worker, beside
`closeStaleAttempts` and bounded the same way:

| Status | Cutoff | Then |
|---|---|---|
| `ENDING` | 60s | `GET /sessions/{id}` |
| `ACTIVE` | `TEST_SESSION_TIMEOUT_MINS` (15) | `GET /sessions/{id}` |

A duration settles and charges. A 404 — the platform has no record of it —
becomes `ABANDONED` at zero, which is its own status rather than a failure,
exactly as the dialer's abandoned path is. Still `active` upstream re-checks on
the next tick rather than guessing.

The reaper does not guess a duration. Ever. A tab closed without a disconnect is
settled by what the platform reports, because the platform is the only party
that knows when the audio stopped.

## Routes

| Route | Role | Notes |
|-------|:----:|-------|
| `POST /api/workspaces/:id/agents/:agentId/test-session` | member | `{ variables? }` → `{ id, room_url, token, max_duration_secs }` |
| `POST /api/workspaces/:id/test-sessions/:sessionId/end` | member | marks `ENDING`. Frees the slot; never charges |

`:sessionId` is the **local** row id, resolved by id *and* workspace in one
query, so a session from another workspace 404s exactly as a nonexistent one
does. The platform's session id never reaches the browser: it is an upstream
handle on a shared partner account, and `serialize.ts` already keeps that class
of id off the wire.

`room_url` and `token` do reach the browser, necessarily — they are what the
Pipecat client connects to. Both are single-use and scoped to one room, and
neither is the partner key.

**The end route never charges.** It records that the browser let go, which frees
the workspace's slot immediately; what the session cost is still decided by the
platform's own account of it. A route that charged on the caller's say-so would
bill whatever a browser claimed.

## Configuration

| Variable | Default | What it bounds |
|---|---|---|
| `TEST_SESSION_MAX_SECS` | `300` | The client's hard disconnect, the balance gate's basis, and the reaper's horizon |
| `TEST_SESSION_MAX_CONCURRENT` | `2` | Live sessions across the whole platform |
| `TEST_SESSION_TIMEOUT_MINS` | `15` | When an `ACTIVE` row is reconciled |

`max_duration_secs` is returned in the start response rather than published as a
public env value, so the browser's cap and the server's gate cannot drift.

## Deliberately not here

- **A test-session history surface.** The rows are the billing record and the
  billing surface will show the charges; a second listing of five-minute
  sessions is not something anyone has asked to read.
- **Transcript, extraction and recording.** All three are already on the calls
  surface. `GET /sessions/{id}` returns them and the reaper reads it, but
  nothing is stored and nothing is served.
- **Inbound test calls.** Different mechanism, different gates.
- **Counting test sessions in the dialer's concurrency budget.** Argued above.
