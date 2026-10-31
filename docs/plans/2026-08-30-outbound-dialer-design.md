# The outbound calling engine — Design

Date: 2026-08-30. Scope: the module that makes a RUNNING campaign dial its
contacts, record the outcomes, and charge for the minutes — across
`ye-voice-backend`, `ye-voice-dashboard` and `ye-voice-admin`.

## What this slice is

Everything upstream of it already exists. Campaigns have a lifecycle, an agent
and a caller DID. The agent mirror is synced. DIDs are rented and renewed. The
tier resolver prices a minute. The ledger moves credits under a conditional
write. Notifications record facts. The calls surface reads history.

None of it places a call. **This slice does.** It is the first module in this
repo that spends real money and rings real phones, and it is the first that
writes to the voice platform's telephony surface at all — every previous
upstream call in this codebase is either a read or a write against agents and
their pooled resources.

That is why the safety model comes before the architecture.

---

## 1. The safety model

Four independent controls. Each one is sufficient on its own to stop every
call; they are not layered defence-in-depth around a single decision, they are
four different questions with four different owners.

### `DIALER_ENABLED` — the master switch

Default **false**. When false:

- `startDialerSweep()` is never called from `server.ts`, so no timer exists.
- `POST /campaigns/:id/{start,resume}` answers **409 `DIALER_DISABLED`**.
- The webhook receiver still verifies and still 200s, but correlates nothing
  and charges nothing.

The refusal at `start` is deliberate and it is a change to a shipped surface.
The alternative — letting a campaign go RUNNING while nothing dials — makes the
campaigns page assert something false about the customer's own data, which is
the one outcome this product's conventions forbid everywhere else. A campaign
that says RUNNING must be dialling or be able to say why. `CLAUDE.md` and
`test/campaign-lifecycle.test.ts` are updated to match.

### `DIALER_TEST_ALLOWLIST` — the bounded-blast-radius switch

A comma-separated E.164 list, empty by default. **Empty means inactive**, not
"allow nothing" — an empty allowlist is the production posture.

When non-empty, a contact whose canonical number is not in the set is
**skipped**, counted and logged, and never claimed. It is not marked
`EXCLUDED`: that is a customer's irreversible action on their own list, and a
test switch must not leave permanent marks on customer data.

Every entry is canonicalized through `src/lib/phone.ts` **at boot**, so a
malformed number is a startup failure rather than a number that silently never
matches — which would read as "the allowlist is working" while it was doing
nothing. This follows `DID_DEFAULT_MONTHLY_PRICE_CREDITS`, which is parsed at
boot for the same reason: a typo in a safety control must be found at startup,
not at the first call.

### The caps

| Control | Owner | Default |
|---|---|---|
| `Campaign.concurrency` | the customer | 2 |
| `Account.concurrencyLimit` | YE staff | `DIALER_DEFAULT_ACCOUNT_CONCURRENCY` (2) |
| `GET /calls/concurrency` → `remaining` | the voice platform | live |
| `DIALER_MAX_CALLS_PER_SWEEP` | the operator | 25 |

Narrowest wins. Section 4 works through them.

### Development and CI never place a call

Every test mocks `src/adapter/vocobase.ts` with `vi.mock`. The suite passes
with the real adapter module unloaded, and `test/dialer-sweep-startup.test.ts`
asserts — the way `renewal-sweep-startup.test.ts` already does for the renewal
timer — both that `createApp()` starts no interval and that `src/app.ts` does
not reach `dialer.ts` even transitively. An invariant held only by an import
somebody happens not to have written is not held at all.

---

## 2. The upstream contract, exactly

Four endpoints. Two are new writes; this is the first telephony write this
repo makes.

```
POST /calls/start                 → place a call            (NEW, write)
POST /voicelink/call-ready        → make a DID callable     (NEW, write)
GET  /calls/concurrency           → the account-wide pool   (NEW, read)
GET  /calls/{id}                  → reconcile a stale attempt (exists: getCall)
```

### `POST /calls/start`

```json
{
  "agent_id":            "<Agent.externalId>",
  "to_number":           "<Contact.phone, E.164>",
  "provider":            "voicelink",
  "from_number":         "<PhoneNumber.did>",
  "client_reference_id": "ezo:<campaignId>:<contactId>:<attemptId>",
  "variables":           { ... }
}
```

Answers **201** with `call_id`, `session_id`, `status`, `from_number`,
`to_number`, `agent_id`.

`from_number` must be *"an active phone number on the selected connection"* —
which is what makes the call-ready step in section 6 a precondition rather than
a nicety.

`variables` keys *"must match agent variable names"*. The dialer therefore
projects the contact's CSV `metadata` (plus `name`) **through
`Agent.variables`** — the string array the mirror already stores — and sends
nothing else. A contact row can carry arbitrary customer columns; the agent
declares which ones its prompt references, and only those cross the wire.

### The four failure branches, and why they are four

`POST /calls/start` documents these:

| Status | Code | What it actually means |
|---|---|---|
| 400 | `VALIDATION_ERROR` | this number/agent will never work |
| 404 | `NOT_FOUND` | this agent or connection is gone |
| 403 | `FORBIDDEN` | **YE** is out of credit with the voice platform |
| 429 | `LIMIT_REACHED` | the shared account is at its concurrency ceiling |
| 502 | `INTERNAL_ERROR` | the provider failed to place it |

Collapsing these is how a dialer burns a customer's retry budget for reasons
that have nothing to do with them. A 429 raised because **another** integrator
filled the shared account must not consume this contact's attempt; a 403 raised
because YE forgot to top up must not pause fifty customers' campaigns.

**This requires an adapter change.** `unwrap` currently maps 400, 404 and 409
and collapses *everything else* — 403, 429, 500, 502 alike — into
`502 UPSTREAM_ERROR`. Under that mapping the sweep cannot tell "slow down" from
"YE is out of credit" from "the platform is down", and all three take the same
branch. `unwrap` gains two more passthroughs, 403 → `UPSTREAM_FORBIDDEN` and
429 → `UPSTREAM_RATE_LIMITED`, both with generic customer-facing messages (the
customer must not learn that YE's supplier account is short, which is the same
rule that keeps `credits_used` off the calls surface).

### One documentation gap, deliberately not depended on

`client_reference_id` is described by the webhooks pages as *"Partner-supplied
correlation key from `POST /calls/start`"* and is implemented by the platform,
but it is **absent from the request-body table** of the `/calls/start` API
reference. So the design does not rest on it:

- **Correlation** keys on `call_id` and `session_id`, both recorded from the
  201 response. The reference id is a third fallback.
- **Idempotency** — the platform replaying an existing call when a reference id
  repeats — is treated as a *bonus to confirm on the first live test*, never as
  a load-bearing guarantee.

If it turns out to be honoured, a sweep that dies between POST and record gets
the same call back instead of dialling twice. If it is ignored, the reaper in
section 7 is what covers that window. Either way the module is correct.

---

## 3. The data model

Additive only. No existing migration is edited or reordered.

```prisma
enum CallAttemptStatus {
  QUEUED       // claimed and launched; upstream has not reported progress
  RINGING
  IN_PROGRESS
  COMPLETED    // terminal, answered, ended
  FAILED       // terminal, never answered or carrier-failed
  ABANDONED    // the reaper closed it; the outcome was never learned
}
```

`QUEUED | RINGING | IN_PROGRESS` is the non-terminal set, chosen to match the
platform's own `statuses_counted` on `GET /calls/concurrency` — *"PENDING,
RINGING, IN_PROGRESS"*. Two systems counting "in flight" differently is how a
local cap and a remote cap disagree about the same call.

```prisma
model CallAttempt {
  id                String  @id @default(cuid())

  campaignId        String   // denormalized: the in-flight count is per campaign
  campaignContactId String
  workspaceId       String   // snapshot, like CreditTransaction.workspaceId
  accountId         String   // who is billed — the OWNER at dial time
  attemptNo         Int

  upstreamCallId    String? @unique
  upstreamSessionId String? @unique

  status       CallAttemptStatus @default(QUEUED)
  disposition  String?   // verbatim free text; never an enum
  upstreamStatus String?
  answeredBy   String?
  hangupCause  String?

  startedAt    DateTime  @default(now())
  answeredAt   DateTime?
  endedAt      DateTime?
  durationSecs Int?

  tierId            String?
  tierSlug          String?
  rateCreditsPerMin BigInt?   // SNAPSHOT — see below
  costCredits       BigInt?
  chargedAt         DateTime?
  shortfall         Boolean   @default(false)

  launchError  String?

  @@index([campaignId, status])
  @@index([accountId, status])
  @@index([campaignContactId])
}
```

**`accountId` and `rateCreditsPerMin` are snapshots, and that is the whole
point.** The renewal sweep charges `rentedPriceCredits` — the price the
customer agreed to — and never the catalog price, because reading a live value
at charge time re-bills everybody whenever staff edit a number. The same
hazard applies here: a call launched under one tier rate must be charged at
that rate even if staff re-price the tier, or retire it, while the phone is
ringing. And billing the workspace's owner *at dial time* means an ownership
change mid-call cannot redirect the charge to somebody who never placed it —
the same reasoning `didRenewal.ts` gives for re-reading the owner inside its
transaction.

**`disposition` is verbatim free text.** Provider-controlled and growing; the
calls surface already refuses to enum it and this must not either.

### The correlation key gains a fourth segment

`src/lib/callCorrelation.ts` today parses exactly three segments,
`ezo:<campaignId>:<campaignContactId>`, and is strict about it on purpose. The
dialer needs a *per-attempt* key: a contact is dialled up to `maxAttempts`
times, and if the platform does honour `client_reference_id` as an idempotency
key, a repeated three-segment key would make attempt 2 replay attempt 1's call
and retries would silently never happen.

So `formatCorrelationId` takes an optional attempt id and `parseCorrelationId`
accepts **three or four** segments, returning `attemptId` only for the latter.
The call-history surface reads the first two fields and is untouched; every key
this dialer stamps carries four.

### Other tables

```prisma
model WebhookEvent {
  id         String   @id @default(cuid())
  eventKey   String   @unique
  event      String
  receivedAt DateTime @default(now())
  @@index([receivedAt])
}
```

```
Campaign.concurrency        Int   @default(2)
Account.concurrencyLimit    Int?              // null → env default; 0 is real
Agent.voiceTierSlug         String?           // written by sync
CreditTransaction.callAttemptId String?       // FK, onDelete: Restrict
CreditTransactionType += CALL_USAGE, CALL_USAGE_SHORTFALL
```

`Agent.voiceTierSlug` is free: `agentSync` already fetches the voice catalogue
to resolve `voiceName`, so it writes the tier slug in the same pass. Without it,
pricing a call means an upstream read per dial against a rate limit every
customer shares.

It is written by **sync**, which is consistent with the mirror invariant every
other table here holds: sync owns platform facts, staff own tenancy and money.
A tier *slug* is a platform fact. A tier *price* is YE's, and stays in `Tier`.

`WebhookEvent` has **no retention policy**, exactly as `Notification` has none.
Both grow without bound and both need a window somebody has decided on; the
index on `receivedAt` is there so that pruning is cheap when it is written.

---

## 4. Concurrency: a third resold resource

YE buys a pool of simultaneous calls from the voice platform and sells slices
of it to accounts. That is structurally identical to what this repo already
does twice — DIDs (platform inventory, rented to a workspace, snapshot price)
and tiers (platform catalogue, assigned to an account, per-account override) —
so it follows the tier shape rather than inventing a third pattern.

```
resolveAccountConcurrency(account)
  → account.concurrencyLimit          (staff's number for this account)
  → env.dialerDefaultAccountConcurrency  (the platform default)
```

In `src/lib/concurrency.ts` **and nowhere else**, for the reason
`tierPricing.ts` gives: three copies of a rule eventually say three different
things. `??`, never `||` — a deliberate `0` means *this account may not dial*
and is not the same as unset, and `||` would step straight over it onto the
default. That is the identical trap the tier resolver documents, and it is
worse here because the failure is silent: an account staff deliberately stopped
would quietly start dialling again.

### The four caps

```
slots = min(
  campaign.concurrency      − campaignInFlight,   // the customer's own fairness
  accountLimit              − accountInFlight,    // what YE sold them
  platformRemaining,                              // what the platform sold YE
  sweepBudget                                     // the operator's blast radius
)
```

**In-flight is counted, never stored.** The brief specified a counter to
decrement. A stored counter that misses one decrement — a crash between webhook
and update, a duplicate delivery, an attempt closed by the reaper — pins a
campaign at its cap permanently, and nothing surfaces it: the campaign simply
stops dialling and looks idle. `COUNT(*)` over `@@index([campaignId, status])`
cannot drift, costs an index scan of a handful of rows, and needs no repair
path. The same argument applies to the account-level count.

**`platformRemaining` is read once per pass**, not per call. The docs name
`GET /calls/concurrency` as the pacing endpoint and return `remaining: null`
for an unlimited account. Reading it first is what stops the sweep discovering
the ceiling one wasted 429 at a time.

**A failed concurrency read launches nothing that pass.** A skipped interval
self-heals in sixty seconds and costs nobody anything; guessing at the headroom
of a shared account does not. This is the same posture as `resolveTierRate`
refusing an unpriced tier and `tiersForAccount` refusing to invent a default —
this codebase consistently prefers a visible refusal to a plausible guess.

### Overallocation is permitted and displayed, never refused

Allotting 150 lines out of a 100-line pool is legitimate: not every account
dials at once, and deliberate overcommit is an operator strategy, not a
mistake. Refusing it would also couple a staff write to a live upstream read,
which makes an admin form fail when the platform is unreachable.

So the console **states** it: pool, total allotted, and headroom or overcommit,
the way the billing projection states a shortfall rather than blocking a
rental. An unlimited pool (`limit: null`, `limit_source: partner_unlimited`)
says there is nothing to divide; per-account allotments still bind, because
they are YE's commercial decision rather than a technical ceiling.

**The customer never sees the pool.** They see their own lines in use out of
their own allotment. Publishing YE's supply publishes YE's margin — the same
rule that keeps `credits_used` and `provider` off the calls surface.

### Fairness between a customer's campaigns

Campaigns are visited **least-recently-dialled first**, ordered by the most
recent `CallAttempt.startedAt` for the campaign, nulls first. Without an
ordering, one busy campaign holds every slot its account owns and a second
campaign started an hour later never dials.

This is deliberately not the reservation-plus-burst allocator the problem
eventually wants. Round-robin is obviously correct, needs no new columns, and
can be replaced without touching anything else once somebody has an opinion
about reserved floors.

---

## 5. The sweep

`src/services/dialer.ts`, modelled directly on `src/services/didRenewal.ts`:
started from `server.ts` and **never** from `createApp()`, re-entrancy-guarded
so a slow pass is not joined by the next one, `unref`'d, bounded, and logging
what it did rather than discarding the result.

One pass:

1. Return immediately unless `DIALER_ENABLED`.
2. Read `GET /calls/concurrency`. On failure, log and return.
3. Load RUNNING campaigns, bounded, with agent, DID, workspace and owner.
4. For each, in least-recently-dialled order:
   - **Re-resolve the agent and the DID** through `agentIsUsable` and
     `phoneNumberIsUsable`. Unusable → auto-PAUSE + notify. `start` checked them
     once and staff can unassign either afterwards through an UPDATE no foreign
     key can see; this is the same four-states argument `CLAUDE.md` makes for
     `Campaign.agentId`, applied at the only place that would otherwise dial
     into it.
   - **Evaluate the dialing window** in the campaign's timezone. Closed → skip,
     do not pause: a closed window is the campaign working correctly.
   - **Check the owner's balance** against `DIALER_MIN_BALANCE_CREDITS`. Below →
     auto-PAUSE + notify `ADMINS_ONLY`, linking `/settings/billing`.
   - **Compute slots** per section 4. Zero → next campaign.
   - **Claim, launch, record** each contact.
5. **Reap** stale attempts (section 7).
6. **Complete** campaigns whose eligible pool is empty and whose in-flight is
   zero: `updateMany where { id, status: 'RUNNING' }` → COMPLETED, notify.
   Conditional, so two runners cannot both announce it.

### The dialing window

The campaigns slice deliberately enforced no cross-field rule on `fromTime`,
`toTime` and `timezone`, and said the dispatcher would decide what a window
means. It decides here.

- **Neither end set** → the campaign dials at any hour. This is the documented
  behaviour and stays.
- **Both ends and a timezone set** → evaluated in that zone via
  `Intl.DateTimeFormat` with `hour12: false` — no new dependency. `from > to`
  wraps midnight, so a 21:00–06:00 window is a real window and not an empty one.
- **Partial** — one end without the other, or a window with no timezone → the
  campaign **auto-PAUSEs** with a notification naming the incomplete window.

The last one is the interesting case, and it fails closed on purpose. An
operator who set `fromTime: "09:00"` and nothing else was expressing a
restriction. Reading that as "dial at any hour" is how a campaign calls a
customer at 3am, and it would be this module's fault, not the API's. Pausing is
visible, honest, and fixed by one edit.

### Claiming, and the three ways a launch fails

The claim is a conditional write, matching the renewal sweep's compare-and-set:

```
updateMany where { id, status: PENDING|FAILED, <retry-due predicate> }
        data  { status: QUEUED, attempts: +1, lastAttemptAt: now }
```

`count === 0` means another runner took it. This is the whole of the
idempotency guarantee, and it makes the sweep safe on N processes rather than
merely on one.

Eligible contacts are `PENDING` with no attempts, plus `PENDING` or `FAILED`
with `attempts < maxAttempts` and `lastAttemptAt <= now − retryDelayMins`.

Then the upstream POST, and its failure modes are **not one branch**:

| Result | Contact | Attempt | Pass |
|---|---|---|---|
| 400 / 404 — will never work | `FAILED`, attempt kept | `FAILED` + `launchError` | continues |
| 502 / timeout — transient | `PENDING`, attempt **decremented** | `FAILED` + `launchError` | continues |
| 429 `LIMIT_REACHED` | `PENDING`, attempt **decremented** | `FAILED` + `launchError` | **halts** |
| 403 `FORBIDDEN` — YE short | `PENDING`, attempt **decremented** | `FAILED` + `launchError` | **halts**, loud |
| `UPSTREAM_WRITE_UNCONFIRMED` | stays `QUEUED` | stays `QUEUED` | continues |

The brief said a failed launch "rolls back to PENDING with the error recorded".
That is right for a transient failure and wrong for the other two.

- **Rolling back a permanent failure without consuming the attempt hot-loops.**
  A number the platform will always reject would be re-claimed every pass
  forever, spending the sweep budget and the shared rate limit, and the
  campaign would never complete because its pool never drains. Consuming the
  attempt lets `maxAttempts` bound it, which is what `maxAttempts` is for.
- **Rolling back an unconfirmed write can double-dial.** The response was lost;
  the call may be ringing. The adapter already distinguishes this case
  (`UPSTREAM_WRITE_UNCONFIRMED` exists precisely because "could not reach the
  platform" reads as *nothing happened* and makes callers retry into a
  duplicate). The attempt stays `QUEUED` and the reaper resolves it against
  the platform's own record.
- **429 and 403 are not this contact's fault at all.** The attempt is given
  back, and the pass halts rather than working through the remaining campaigns
  to collect the identical error — the ceiling and the supplier balance are
  both account-wide.

---

## 6. Campaign start now reaches the platform

`start` and `resume` gain gates. Every local gate runs **before** the single
upstream write, so a refused start never touches the platform.

| Gate | Failure |
|---|---|
| `DIALER_ENABLED` | 409 `DIALER_DISABLED` |
| a usable caller DID | 409 `CAMPAIGN_PHONE_NUMBER_REQUIRED` |
| a resolvable per-minute rate | 409 `CAMPAIGN_RATE_UNAVAILABLE` |
| owner balance ≥ the float | 402 `INSUFFICIENT_CREDITS` |
| a complete-or-absent window | 409 `CAMPAIGN_WINDOW_INCOMPLETE` |
| the DID is call-ready | 409 `CAMPAIGN_DID_NOT_CALL_READY` |

**A caller DID is now required.** The campaigns slice explicitly deferred this
— *"the dialer slice decides whether a number is required, because it is the
thing that will fail without one"* — and the answer is yes. `from_number` must
name an active number on the connection, and a campaign without one would
dial from whatever the connection defaults to: some other customer's caller ID.

### What `start` does upstream

One idempotent call: `POST /voicelink/call-ready { did_number }`. It resolves
the DID, imports it into the platform's own inventory if missing, ensures a
WebSocket bot exists, and points outbound routing at it — preserving existing
inbound routing, which is why it is the documented safe path rather than the
raw routing update that replaces the record.

Done at **start**, not at rent time, exactly as briefed: renting is an internal
book-keeping act that creates no upstream state, and a number nobody dials from
should not have routing built for it.

Readiness is then checked, and **`NO_VOCOBASE_AGENT` alone does not block**.
That state means the platform's local `PhoneNumber` row has no agent bound,
which governs *inbound* routing; this slice places outbound calls with an
explicit `from_number` and an explicit `agent_id`. Every other blocking state —
`NO_CLIENT_MAPPING`, `NO_BOT`, `ROUTING_MISSING`, `ROUTING_CHANGED`,
`REMOTE_DID_EXPIRED` — refuses the start.

Readiness codes are mapped to **our own sentences**. The platform's
`action_items` labels say "VoiceLink", and which supplier sits under this
product is not something a customer learns from an error — the two-registers
rule `CLAUDE.md` sets for every other customer-facing string.

### The gap this leaves, stated rather than papered over

`call-ready` maps an unmapped DID to a client **only when handed an explicit
`client_id`**, never auto-creating one. This backend has no such column and
does not model platform clients at all. So a DID that has never been
client-mapped **cannot be made callable from this product**, and start refuses
it with a message naming the step.

That is the fail-closed choice. Adding a staff-settable client id would let
this backend perform a mapping write on a shared partner account off a value
somebody typed, and mapping is the one step in that workflow that is not
idempotent in a recoverable direction. It stays an operator prerequisite.

---

## 7. Outcomes: the webhook receiver

`POST /webhooks/vocobase`, mounted in `app.ts` **before** `express.json()` with
`express.raw({ type: '*/*' })`, outside `/api`, no Clerk, no membership.

### Verification

HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` with `VOCOBASE_WEBHOOK_SECRET`,
compared timing-safely against `X-Webhook-Signature: sha256=<hex>`, with
`X-Webhook-Timestamp` rejected beyond 300 seconds' skew.

Length is checked before `timingSafeEqual`, which throws rather than returning
false on unequal buffers — a comparison that throws is a comparison that
crashes the route instead of rejecting the request.

**An unset secret rejects everything.** The same rule `RECORDING_TOKEN_SECRET`
and `ADMIN_STAFF_TOKEN` already hold: a missing secret must never mean an open
door. `env.ts` reads it through the existing `secret()` helper with a 32-char
floor, because a short secret fails *open* while looking fine.

### Idempotency is a database constraint, not a code path

`eventKey` follows the platform's own recommendation —
`session.completed:{session_id}` and
`call.status.updated:{call_id}:{status}:{occurred_at}` — and is `@unique`.

The marker row is written **inside the same transaction as the effect**. A
duplicate delivery violates the constraint, the whole transaction rolls back,
and the charge is applied exactly once. Writing the marker first and processing
afterwards would lose the effect entirely if the process died between them,
which for a charge means a call nobody is billed for; writing it afterwards
would double-charge on a retry.

### Two events, two jobs

- **`call.status.updated`** with `terminal: true` closes the attempt, sets the
  contact's status, and releases the slot. The platform says plainly: *"Do not
  wait for `session.completed` to release a dialer slot."*
- **`session.completed`** is the sole charging event, and carries the duration.

`session.completed` alone would very nearly do — the live docs confirm it fires
even for calls that were never answered, with `duration_seconds: 0`,
`transcript: null` and a `call.status` of `no_answer`/`busy`/`failed`. Handling
both is a latency decision, not a correctness one: a slot held until post-call
processing finishes is a slot the customer paid for and cannot use.

Correlation, in order: `data.call.call_id` → `upstreamCallId`; then
`data.session_id` → `upstreamSessionId`; then
`parseCorrelationId(data.call.client_reference_id)`.

### What an unknown call means

The endpoint is **account-wide** on a partner account YE shares, so it
receives every other integrator's `session.completed` payloads — transcripts
included.

An event that correlates to no attempt is **logged by id and 200'd**, and
nothing about it is persisted or logged in full. This is not politeness toward
the platform's retry policy; it is the same isolation rule the calls surface
holds, where a call matching neither the agent leg nor the campaign leg is
*absent* rather than forbidden.

The endpoint declares `events: ["session.completed", "call.status.updated"]`,
which at least stops WhatsApp traffic arriving. Per-agent scoping would narrow
it further, but each agent-scoped endpoint carries its **own secret**, so that
means N encrypted secrets in the database and a registration lifecycle tied to
agents that move between workspaces. Account-wide with strict correlate-or-drop
is the right trade, and the residual exposure is stated here rather than
discovered.

**The receiver processes synchronously and then answers 200.** The platform's
guidance is to answer immediately and process asynchronously, and for most
integrations that is right. Here the effect is a credit charge: a background
job that dies takes the charge with it and nothing retries, whereas a 500
brings a delivery the platform will retry four more times over eight hours. One
transaction is comfortably inside the ten-second budget.

### The reaper

Attempts non-terminal past `DIALER_ATTEMPT_TIMEOUT_MINS` (60) are reconciled
against `GET /calls/{id}` — documented as the missed-webhook recovery path, and
already in the adapter as `getCall()` with `absentOn404`. A terminal call is
closed and charged properly. Only a call the platform does not know, or one
still live past the timeout, becomes `ABANDONED`.

`ABANDONED` is its own status rather than `FAILED` because *"we never found
out"* and *"the callee did not answer"* are different facts, and a report that
conflates them misstates the campaign's own results.

---

## 8. Charging

On `session.completed` for a known attempt, in one `$transaction` with the
`WebhookEvent` marker:

```
cost = rate × durationSecs / 60      (BigInt, truncated)
```

- **The rate is the attempt's snapshot**, resolved at dial time. Section 3.
- **Billed on `duration_seconds`**, not `bill_duration_seconds`. Call details
  carries both; `session.completed` carries only the former. Billing on a field
  that only one of the two paths carries would make the same call cost a
  different amount depending on whether we learned of it by webhook or by
  reconciliation.
- **Truncated, not rounded.** At the 10000× multiplier the loss is at most
  0.0001 display credits per call, it always favours the customer, and it is
  monotonic. A rule stated is worth more than a hundredth of a credit.
- **Zero duration writes no ledger row.** `chargedAt` is still set so the
  attempt cannot be charged twice. The DID release markers are zero-amount rows
  because they carry a fact nothing else records; a zero-credit call carries
  nothing the attempt does not already say.

The debit is the conditional write this repo uses everywhere:

```
updateMany where { id: accountId, credits: { gte: cost } }
        data  { credits: { decrement: cost } }
```

The ledger row carries `callAttemptId` **and** `reference = attempt.id`. The
FK is for querying a campaign's spend; the reference rides the existing
`@@unique([accountId, reference])`, so a second charge for one attempt is
refused by the database even if every other guard were bypassed. Two mechanisms
because one of them is a constraint and constraints do not have bugs.

### Insufficient balance fails closed

`count === 0` on the debit means the owner cannot cover it. Then, in the same
transaction:

- a **zero-amount** `CALL_USAGE_SHORTFALL` row carrying the attempt and the
  amount owed,
- `attempt.shortfall = true` with `costCredits` recording the debt,
- the campaign auto-PAUSEs,
- an `ADMINS_ONLY` notification linking `/settings/billing`.

Nothing is partially debited. The ledger rule is that a balance never goes
negative and every movement pairs with a row; a partial charge would break both
to save a fraction of a credit.

This is also why the sweep checks `DIALER_MIN_BALANCE_CREDITS` *before*
launching. Charging happens minutes after dialling, so a balance check at
launch is the only thing standing between a campaign and a queue of calls it
cannot pay for.

---

## 9. What the customer sees

`/campaigns/[id]`, Stats tab, made real:

- counts by contact status (exists), plus **in flight**, **lines in use out of
  the account's allotment**, and **spend so far** from the ledger.
- an attempts feed, reusing `components/calls/` — `StatusPill` already renders
  an unrecognised value as itself, which is exactly right for a free-text
  disposition.

Two new routes rather than one, matching the billing surface's split: `/stats`
gains the live block and is read once per page load; `.../attempts` is
paginated and re-read on its own.

**Honest states, per the repo's rule:**

| State | What it says |
|---|---|
| paused, insufficient credits | exactly that, with a link to billing |
| paused, incomplete window | which field is missing |
| paused, agent or number gone | which one, and that it must be reassigned |
| running, window closed | when it will next dial, in the campaign's zone |
| running, at the line limit | how many lines, and that more are available on request |
| dialing disabled | that this deployment does not dial |

The distinction that matters most is the fifth: a campaign with 200 pending
contacts and two calls out looks broken. Saying "2 of 2 lines in use" turns a
suspected fault into a visible, purchasable limit.

`ye-voice-admin` gains `/concurrency`: the live pool, total allotted,
headroom or overcommit, and per-account allotments editable inline — the same
shape `/tiers` already uses for list prices, including saying out loud how many
accounts an edit moves.

---

## 10. Known limits

- **No reconciliation sweep for calls we never launched.** The reaper resolves
  our own stale attempts; nothing detects a call the platform placed under our
  reference id that we have no attempt row for. That needs the listing walk the
  call-history surface already documents as bounded at 2,000 rows.
- **`WebhookEvent` and `Notification` both grow without bound.** Neither has a
  retention window. Both want the same decision.
- **Round-robin, not reserved floors.** A campaign cannot be guaranteed a share
  of its account's lines, only a fair rotation.
- **The shared partner account is the real ceiling.** Every YE customer and
  every other integrator on that account draws from one pool of concurrent
  calls, one rate limit, and one credit balance. This slice paces against it
  and reports it; it cannot enlarge it.
- **A transferred call is billed for the bot leg only.** `session.completed`
  fires when the bot leaves, not when the caller hangs up with the human, and
  its `duration_seconds` covers the bot leg — which is also what the platform
  bills YE for.
