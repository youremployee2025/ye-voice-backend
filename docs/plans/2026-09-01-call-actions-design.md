# In-house pre-call and post-call actions

*Design proposal, 2026-09-01. Nothing here is built; this document exists to
be reviewed first.*

## Why in-house

The platform runs its own lifecycle hooks around a call: pre-call actions that
assemble variables before the bot speaks, post-call actions that push what the
call produced. The dashboard now mirrors them read-only (`GET
…/agents/:agentId/lifecycle-hooks`), but they are configured platform-side,
per agent, by YE staff, with the platform's own toolset and the platform's own
failure reporting — which YE customers cannot see and YE cannot extend.

Meanwhile everything those hooks need already flows through this backend: the
dialer chooses when a contact is dialed and with what variables, and every
`session.completed` lands in our webhook route with the extraction, the
outcome and the correlation ids. Owning the pre-call assembly and the
post-call fan-out here means: per-campaign (not only per-agent) configuration,
customer-visible failure reporting in our dashboard, retries under our
control, and no waiting on platform features.

The split this design proposes:

| Stage | Where it runs | Why |
|---|---|---|
| **Pre-call** | our dispatcher, at dial time | we already resolve variables per dial; the platform accepts them on call start |
| **Runtime** (mid-call functions/tools) | **stays platform-side** | only the platform sits inside the live call loop; latency and barge-in belong to it. Optionally the functions it calls are YE-hosted endpoints (below) |
| **Post-call** | our workers, off our stored `session.completed` events | we already receive, dedupe and persist the event; fan-out is ordinary queue work |

## Pre-call: variable sources resolved at dial time

Today the dialer projects `Contact.metadata` through the agent's declared
variables, or through `Campaign.variableMap` when one exists. This design
generalises that into an ordered list of **variable sources**, resolved per
dial, later sources overwriting earlier ones:

1. **`static`** — a flat map on the config. Campaign-wide constants
   (`agent_name`, an offer code).
2. **`contact`** — today's behaviour, named: CSV metadata / contact fields
   through the variable map. Stays the default; a campaign with no
   `callActions` config behaves exactly as today.
3. **`http`** — a fetch against a customer endpoint at dial time:
   `{ url, method, headers?, query template, expose: [{ from, to }] }`.
   Template tokens (`{{callee_phone}}`, `{{campaign_id}}`, any
   already-resolved variable) are substituted into url/query/body. The
   response is JSON; `expose` picks fields out of it into variable names.
   This is also how "a customer's sheet" is served without building a Sheets
   integration first: a published-CSV or Apps-Script URL is just an endpoint.
   A first-party Sheets source can be added later as a fourth type without
   changing the schema.
4. **`context`** — accumulated history from our own tables: the contact's
   prior attempts on this campaign (last outcome, attempt number, a prior
   call's extraction values). Read-only over data we already hold; no network.

Resolution rules, all of which exist to keep a dial from silently degrading:

- **Budgeted.** Each `http` source has `timeout_ms` (default 3000, max 8000)
  and the whole pre-call stage has a ceiling (default 10s). The dial does not
  wait longer than the ceiling, ever.
- **`required: false` by default.** A failed or timed-out source is skipped,
  the dial proceeds, and a `CallActionRun` row records the miss (below). With
  `required: true` the contact's attempt is **given back** — rescheduled, not
  spent — and the campaign surfaces the failure; a required source that fails
  repeatedly pauses the campaign the way credit exhaustion does, because
  dialing people with a hole in the script is the thing the flag forbids.
- **Only declared variables are sent.** The agent's declared list is the
  allow-list, exactly as the dialer does today — a source cannot inject a
  token the prompt never asks for.
- **Values are strings; `null`/absent means the key is omitted**, never sent
  as `""` — an empty string is spoken.

### Where the stage runs, relative to the dialer's lease

**Decision: resolution runs inside the claim, and the lease TTL is set from
the stage ceiling rather than independently of it.**

The two placements are not equally bad. Resolving *before* the claim means a
worker fetches variables for a contact it may never win, and the values it
did resolve are already up to 10s stale by the time the winner dials — the
`http` source exists precisely because the answer changes minute to minute.
Resolving *after* the claim is correct on freshness, and its whole risk is the
lease expiring mid-resolution: a second worker re-claims, and the same person
is dialed twice. That risk is a number we control, and being dialed twice is
the failure customers notice.

So:

- The pre-call stage runs **after** the contact is claimed, before the call
  start is issued.
- **`lease_ttl > pre_call_ceiling + dial_timeout + margin`**, checked at boot
  rather than left as folklore: with the 10s ceiling this makes the floor
  roughly 45s, and a config that violates it fails to start. A raised ceiling
  (see Q10) must raise the TTL with it — the two are one setting in two
  places, which is exactly how they drift apart.
- A worker that overruns the ceiling **abandons the dial** rather than issuing
  it: past the ceiling it can no longer prove it still holds the lease. The
  attempt is given back, as with a failed `required` source.
- The lease is **not** heartbeat-extended during resolution. It could be, and
  that is the upgrade path if the ceiling ever has to exceed the TTL, but a
  renewal racing an expiry is a harder thing to reason about than a ceiling
  that is comfortably inside the lease.

## Post-call: queued actions on stored `session.completed`

The webhook route already dedupes deliveries through `WebhookEvent` (unique
`eventKey`, written inside the applying transaction). Post-call actions hang
off that same event, as **outbox rows**, one per (event × matching action):
the webhook transaction enqueues and returns; workers deliver. The
queue-worker pattern already adopted elsewhere in this backend — post and
move on, replay-safe retries — applies unchanged.

Action types, v1:

1. **`http_webhook`** — POST the event projection to a customer URL, signed
   (HMAC-SHA256 over `{event_id}.{timestamp}.{body}`, secret shown once at
   creation, dual-secret rotation window). HTTPS only, private-address
   ranges refused at connect time, no redirects, response capped.
2. **`sheet_write`** — append a row to a connected Google Sheet (via the
   platform connection the workspace owns, or a customer-supplied endpoint in
   v1 if the connector path is not ready). Column list is configured as
   `[{ header, value template }]`.
3. **`whatsapp_notify`** — send a template message to a configured operator
   number ("lead marked hot: {{contact_name}}") through whatever messaging
   channel YE runs. v1 can ship with `http_webhook` + `sheet_write` only if
   the messaging channel is not settled; the schema does not change.

Each action has a **filter**: which events (`completed` only, or all
terminal), optionally an extraction predicate (`{ key, in: [values] }`, e.g.
only leads whose bucket is a won bucket). Filters run at enqueue time; a row
is only created for an event the action wants.

### Execution and retry semantics

- **Immutable payload.** The delivery row freezes its rendered payload at
  enqueue. Retries and manual redeliveries send exactly the same bytes; a
  later edit to the action changes future events only.
- **One row per (action, event)**, unique-indexed, so a replayed webhook
  cannot enqueue twice.
- **Lease-claimed workers**: `updateMany … where status in (PENDING,RETRYING)
  and next_attempt_at <= now() and (locked_at is null or expired)` — the same
  claim shape the dialer uses, safe under two workers.
- **Bounded ladder**: 30s, 2m, 10m, 1h, 4h, 12h, 24h, then `DEAD`. `408/425/
  429/5xx` retry; other 4xx are terminal (the customer's endpoint said no).
  `Retry-After` may lengthen an existing slot, never add slots.
- **Redeliver** is a manual action on a `DEAD`/`DELIVERED` row: same payload,
  fresh ladder, `cycle + 1`.
- A **paused action** stops delivery but keeps enqueuing, so unpausing drains
  the gap instead of having silently dropped it.

## Config schema

Two tables, plus the run/delivery records:

```prisma
/// One configured action. Scope is workspace-wide, per-agent or per-campaign:
/// exactly one of agentId / campaignId is set, or neither (workspace-wide).
/// At dial/event time the applicable set is workspace ∪ agent ∪ campaign,
/// ordered by the TOTAL order below — later rows overwrite earlier ones, so
/// campaign rows win. "Campaign last" alone is not an order: two campaign
/// sources both at position 0 are tied, and a tie resolved by whatever the
/// query returned makes the variable set of a contact differ between two
/// dials of the same contact.
///
///   ORDER BY scope_rank, position, id
///
/// with scope_rank = 0 workspace, 1 agent, 2 campaign — expressed in SQL as
/// the ordering, not applied in memory afterwards, and `id` last so the order
/// is total even when an operator leaves every position at its default.
model CallAction {
  id          String  @id @default(cuid())
  workspaceId String
  agentId     String?
  campaignId  String?
  stage       CallActionStage       // PRE_CALL | POST_CALL
  type        String                // static|contact|http|context / http_webhook|sheet_write|whatsapp_notify
  name        String
  position    Int      @default(0)
  enabled     Boolean  @default(true)
  required    Boolean  @default(false)   // pre-call only
  timeoutMs   Int      @default(3000)
  config      Json                   // per-type shape, zod-validated per type
  filter      Json?                  // post-call only
  secretEnvelope Json?               // http_webhook signing secret, encrypted
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([workspaceId, stage])
  @@index([campaignId]) @@index([agentId])
}

/// One pre-call resolution or post-call delivery. THE failure-visibility row.
model CallActionRun {
  id           String   @id @default(cuid())
  actionId     String
  workspaceId  String                  // denormalized for listing
  callAttemptId String?                // pre-call: the dial it fed
  eventKey      String?                // post-call: the WebhookEvent it followed
  status       CallActionRunStatus     // PENDING|RUNNING|OK|SKIPPED|RETRYING|FAILED|DEAD|DELIVERED
  payload      Json?                   // post-call: frozen projection
  attemptCount Int      @default(0)
  cycle        Int      @default(1)
  nextAttemptAt DateTime?
  lockedAt     DateTime?
  lastHttpStatus Int?
  lastError    String?                 // sanitized; never the raw response body
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([actionId, eventKey])
  @@index([status, nextAttemptAt])
  @@index([workspaceId, createdAt])
  /// The call detail reads this table by attempt to draw its pre-call rows.
  /// Unindexed it is a sequential scan of every run ever recorded, on a page
  /// opened per call — the same FK-index miss the analytics review caught.
  @@index([callAttemptId])
}

Two shapes above are still open and are called out in the questions below:
`@@unique([actionId, eventKey])` permits exactly one row per (action, event),
so **Redeliver** as described — same payload, fresh ladder, `cycle + 1` —
must overwrite the row it retries and loses the previous cycle's outcome. If
delivery history is wanted per attempt, this wants splitting into a delivery
row and an attempt row rather than one mutable record. Note also that
`eventKey` is null for every pre-call run, and Postgres treats nulls as
distinct in a unique index, so pre-call rows are unconstrained by it —
deliberate, since a pre-call run is not deduplicated, but it means nothing
stops a replayed dispatch from recording two.
```

Credential material (webhook secrets, header values for `http` sources) is
stored encrypted, write-only through the API (key names are readable, values
are not) — the rule the platform's own function headers already follow.

## Failure visibility in the dashboard

- **Per action**: a Deliveries/Runs list — status pill, `Cycle n, attempt m`,
  `HTTP 503` or `Network error`, timestamps; **Redeliver** offered only on
  `DEAD`. Errors are sanitized sentences, never raw bodies.
- **Per campaign**: the campaign's dialer-state banner grows one more state —
  "a required pre-call source is failing; dialing is paused" — with the same
  next-step copy discipline as the existing states.
- **Per call**: the call detail's timeline gains pre-call rows ("looked up
  lead in 240ms", "source X skipped: timed out") from `CallActionRun` keyed by
  `callAttemptId`.
- The three claims stay distinct everywhere, as on every other surface:
  skipped (optional source missed), failed (required, dial given back), and
  nothing-configured are different sentences.

## Isolation

- Every `CallAction` and `CallActionRun` is workspace-keyed; every route
  resolves membership → workspace → row, the identical-404 rule unchanged.
- `sheet_write` may only name a connection the workspace's mapping owns —
  `resourceInWorkspace('CONNECTION', …)` before anything is stored, the same
  gate `PUT …/tools/:slug` uses.
- Outbound HTTP (pre-call `http`, post-call `http_webhook`) goes through one
  egress guard: HTTPS only, DNS-resolved address checked against private
  ranges at connect time, no redirects, size and time caps. A customer URL is
  a customer-controlled server; the guard is what keeps it from being a probe
  into YE's network.
- Payload projections are allow-listed fields off our own rows — never the
  raw platform webhook body, which carries platform ids and account-wide
  fields no customer should hold.

## What stays platform-side, and why

- **Runtime functions and tools.** The mid-call loop (ASR → LLM → tool call →
  TTS) runs on the platform; only it can call a function inside a turn. We do
  not proxy or intercept it. **Option, not requirement:** a "function" the
  platform calls can be an YE-hosted endpoint (`/api/hosted-fns/:workspace/:slug`)
  so the logic and its logs live with us — that is an ordinary platform
  function whose URL happens to be ours, and it needs no new platform feature.
- **Platform lifecycle hooks already configured** keep working and stay
  visible read-only in the dashboard. In-house actions are additive; nothing
  migrates until a per-agent hook is deliberately recreated as an YE action
  and switched off platform-side. Running both on one agent is legal but the
  dashboard should say both exist.
- **Voice, transcription, extraction** — platform capabilities we mirror, not
  reimplement.

## Turning it off

Per-action pause exists and is the right instrument for one misbehaving
customer endpoint. It is not a rollback: it is per row, it is a customer
action, and it does not exist until someone has already worked out which of
several actions is the problem. Nothing in the design disables call actions
for a workspace, or at all.

- **`CALL_ACTIONS_ENABLED`** (default off until v1 ships, then on): a boot
  gate. Off, the pre-call stage is skipped entirely — the dialer falls back to
  today's `Contact.metadata` / `Campaign.variableMap` projection, which is the
  `contact` source under another name, so a dial still happens with the
  variables it has today. Post-call enqueue stops; already-enqueued rows are
  left for the workers to drain rather than cancelled.
- **Per-workspace disable**, staff-set, for the case where one customer's
  configuration is the problem and the platform is fine.
- **What we turn off first**, in order, because these are not equally
  destructive:
  1. the offending **action** (customer-visible pause, already designed),
  2. the **workspace**,
  3. **post-call fan-out globally** — deliveries queue up and drain later, so
     the cost of being wrong is delay,
  4. **pre-call resolution globally** — last, because it changes what the bot
     is told on live calls, and a dial with a hole in the script is the thing
     the `required` flag exists to prevent.

The order matters more than the switches: the instinct under an incident is to
kill the loudest thing, and the loudest thing here (pre-call) is the one whose
absence a customer hears.

## What this design does not yet meet

The lifecycle-hooks surface this PR shipped answers "where does this variable
come from" — `supplies` on each hook row, derived in `hookSupplies()` from the
upstream hook's own shape. The Variables surface is expected to keep answering
it once actions are ours.

`CallAction` as drafted cannot. It stores an opaque `config Json`, validated
per type on write and never interpreted afterwards, with no declared-outputs
column. So the Variables surface would have to re-derive "what does this
action supply" from that blob, per type, in a second place — a second
implementation of a fact we already compute, which is how the two drift into
disagreeing about which source wins a variable.

Two ways out, either acceptable, but one of them has to be chosen before the
table is created:

- a **`supplies String[]`** column computed on save from the validated config
  (cheap to read, cheap to index, and wrong only if a migration forgets to
  recompute it), or
- **one shared deriver** taking `(type, config)` and returning the variable
  names, living beside `serializeLifecycleHooks` so the platform-hook path and
  the YE-action path call the same function.

The second is the better shape; the first is the better query. What must not
happen is neither, which is what the current schema implies.

## Open questions (for review before anything is built)

1. **Scope granularity for v1.** The schema allows workspace / agent /
   campaign. Is campaign-only enough to ship first (it matches how YE runs
   today), with agent/workspace rows arriving later?
2. **Who edits. — RECOMMENDED, should not ship open.** The proposal reached
   for parity with agents, but the justification for member-editable agents
   does not transfer. That justification is quoted verbatim in
   `agents.routes.ts:43-51`: the blast radius is bounded because "nothing here
   spends credits or reaches another workspace". An `http_webhook` action
   POSTing extraction values to a URL the member chose does both — it is
   egress of call content to an address of the editor's choosing, and no
   amount of read-only rendering elsewhere makes that a prompt edit.

   **Recommendation: split the gate by whether the action has an egress
   target.**

   | Types | Gate |
   |---|---|
   | `http`, `http_webhook`, `sheet_write`, `whatsapp_notify` | **ADMIN** |
   | `static`, `contact`, `context` | member-editable, like agents |

   The line is the egress target, not the stage: a pre-call `http` source
   sends `{{callee_phone}}` to a customer-chosen URL and belongs on the ADMIN
   side, while a post-call `static`-shaped action would not. Gating by stage
   instead would put the wrong half of pre-call in the wrong place.

   This also answers half of Q7: with ADMIN on the egress types, **extraction
   in the payload is opt-in per action**, so turning it on is a deliberate act
   by someone who can already see it, rather than a default a member inherits.
3. **Required-source pause semantics.** After how many consecutive required
   failures does a campaign pause — first failure, N in a row, or a rate?
   And is the give-back a retry-slot spend or free?
4. **`sheet_write` v1 transport.** Wait for the connector path (workspace-
   mapped platform connection), or ship v1 with customer-endpoint sheets only?
5. **WhatsApp notify channel.** Which sender does YE run this through, and
   is it settled enough to be in v1?
6. **Retention.** `CallActionRun` grows per dial and per event.
   `WebhookEvent` deliberately has no retention window yet; do both get one
   decision here (e.g. 30/90 days), and does DEAD survive longer than OK?
   Note the question under-costs the table: it is not one row per action, it
   is **a write per dial for every pre-call source plus a write per delivery
   event, then an update per attempt**, against four indexes, on the dialer's
   hot path. The write amplification is the cost to size before the retention
   window is, and it lands on the one path where added latency is dropped
   calls.
7. **Payload contract for `http_webhook`.** Freeze v1 fields now (event id,
   campaign/contact/call ids, outcome, duration, extraction, variables?) —
   and is extraction included by default or opt-in per action, given it is
   the most sensitive part?
8. **Hosted function endpoints.** Is the YE-hosted-function option (runtime
   stays platform-side, URL is ours) wanted in v1, or parked?
9. **Delivery history vs. one row per (action, event).** Does Redeliver need
   to preserve what the previous cycle did — which means a delivery row plus
   an attempt row — or is overwriting the single record acceptable?
10. **Serial resolution vs. the pre-call ceiling.** Template tokens may
    reference "any already-resolved variable", which forces sources to resolve
    in order; four `http` sources at the 3000 ms default already exceed the
    10 s stage ceiling. Either the ceiling rises, or sources that reference no
    earlier variable are resolved concurrently and only genuine dependants are
    serialized. The second is the better answer but needs the dependency to be
    derivable from the template before anything is built.
11. **Egress guard and DNS rebinding.** Resolving the address and then letting
    the HTTP client connect by hostname re-resolves — the check and the
    connection are not the same lookup. The guard has to pin the address it
    validated, or the private-range check is advisory only.
12. **Where the encryption key lives.** `secretEnvelope` and the `http` source
    header values are "stored encrypted"; the key's home, and its rotation,
    are not settled here.
