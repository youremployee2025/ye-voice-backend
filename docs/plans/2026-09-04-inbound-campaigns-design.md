# Inbound campaigns — design

**Status:** design agreed, not built.
**Scope:** give an agent a separate inbound configuration, let a campaign answer
calls as well as place them, and attribute an inbound call to the campaign that
owns the number it arrived on.

---

## 1. What the platform gives us, and what it does not

Three separate upstream capabilities, and only the first two exist.

**An agent can hold two independent configurations.** `PATCH /agent/{id}/inbound`
`{ enabled: true }` creates the second one as a deep copy of the first; from then
on the two are independent — prompt, voice, transfer target, knowledge base,
tools and lifecycle hooks all split. It is idempotent, and re-enabling after a
disable restores the existing configuration rather than rebuilding it.

The inbound configuration **has no id of its own**. Every request is addressed
with the *agent's* id; an internal identifier obtained some other way is refused
with `AGENT_IS_FACE`. Sessions, webhooks, billing and campaign lookups continue
to see one agent, which is what makes this a configuration split rather than a
second agent to mirror, assign and reconcile.

**A DID routes to exactly one agent for inbound.** Only one active row per
number may carry `inbound_enabled: true`. This is enforced upstream, so it is
physics rather than policy.

**There are no inbound campaigns.** `POST /api/v2/campaigns` takes a name, an
agent and contacts, and has no direction field. Inbound campaigns exist inside
the voice platform's own product and are not exposed to partners — the only
place the partner API mentions them is the list of things a disable would pause.

This service does not use upstream campaigns anyway; it runs its own dialer and
places calls one at a time. So the campaign half of this feature is entirely
ours to define, and everything below section 3 is our design, not a port.

## 2. The two halves, and why they are separable

**Half one — inbound faces.** An agent gains a second configuration, editable
through this service. Useful on its own: an agent that answers a published
support line with its own prompt and its own knowledge base, no campaign
involved.

**Half two — inbound campaigns.** A campaign gains a direction, claims the
numbers it answers on, and collects the calls that arrive on them.

Half two depends on half one. Half one ships alone and is worth shipping alone.

---

## 3. The relationship model

The chain reads "DID to inbound agent to campaign", but the second link is not a
function — one agent answers many numbers and runs on many campaigns. Written
out:

| Edge | Cardinality | Enforced by |
|---|---|---|
| DID → inbound agent | 1:1 | upstream: one `inbound_enabled` row per number |
| agent → DIDs | 1:many | — |
| agent → campaigns | 1:many | — |
| **DID → live campaign** | **1:1** | **nothing today. This is what we add.** |

So **the claim is on the DID, and the agent is derived** from whichever campaign
holds it. Two campaigns sharing an agent on *different* numbers is ordinary and
must not warn: one support persona answering five regional lines from five
campaigns is the shape this product is for.

### The rule

> A campaign whose type is `INBOUND` or `BOTH` and whose status is `RUNNING`
> claims **every DID attached to it**. No other `INBOUND`/`BOTH` campaign may
> start or resume holding **any** of those DIDs.

`OUTBOUND` campaigns do not contend. They keep sharing DIDs freely as caller-id
rotation, which they do today and which breaking would be a regression.

### What the rule buys

**It removes the silent re-point.** Campaign A holds a DID pointed at Meera;
campaign B starts wanting the same DID pointed at Ravi. Upstream can only route
that number to one agent, so B's provisioning would re-point it — and A stays
`RUNNING`, its number still rings, and the wrong persona answers, with no error
raised on either campaign. It is the only failure in this feature with no
recoverable symptom, and the claim makes it unreachable.

**It makes attribution a lookup rather than a heuristic.** At most one live
campaign holds a DID, so an inbound call on that DID has exactly one candidate
campaign. There is no most-recently-dialed tiebreak to write, no contact-set
overlap to score, and no case where two campaigns both have a plausible claim on
the same call. Everything in section 6 follows from this one sentence.

### Only `RUNNING` holds a claim

`DRAFT` never provisioned anything. `PAUSED`, `CREDIT_EXHAUSTED`, `STOPPED` and
`COMPLETED` all release, and releasing unbinds the number (section 5.2).

This is a deliberate choice with a consequence that has to be shown, not
discovered: **pausing a campaign can lose its numbers.** A rival campaign may
claim a DID while the first is paused, and the resume will then be refused
rather than silently re-pointing the number away from whoever is now using it.
The refusal is correct; the surprise is not. So pause on an `INBOUND`/`BOTH`
campaign says so at the click:

> Pausing stops answering calls on +91…. Another campaign can claim it while
> you are paused, and you may not be able to resume.

`CREDIT_EXHAUSTED` releases along with the rest. Inbound calls are gated on
credits upstream exactly as outbound calls are — an empty balance stops
customers reaching you, not only your dialling — so an insolvent campaign
cannot answer anyway, and holding a number it cannot use is hoarding.

---

## 4. Schema

```prisma
enum CampaignType { OUTBOUND  INBOUND  BOTH }

model Campaign {
  type  CampaignType @default(OUTBOUND)
  // …existing fields
}

model Agent {
  inboundEnabled  Boolean @default(false)   // mirrored from `inbound.enabled`
  // …existing fields
}

/// One row per DID held by a RUNNING inbound-enabled campaign.
/// `phoneNumberId` is the primary key: that IS the invariant.
model CampaignInboundClaim {
  phoneNumberId  String   @id
  campaignId     String
  agentId        String
  claimedAt      DateTime @default(now())

  phoneNumber  PhoneNumber @relation(fields: [phoneNumberId], references: [id], onDelete: Cascade)
  campaign     Campaign    @relation(fields: [campaignId],    references: [id], onDelete: Cascade)

  @@index([campaignId])
}
```

**The claim is a table, not a check.** Two starts in the same second both read
"no rival" and both proceed; a rule without a constraint behind it is a
check-then-act. Making `phoneNumberId` the primary key means the second insert
fails on the key rather than on our reading of the world — the same reasoning
that makes a double DID rental unreachable rather than unlikely.

It is expressible as a key only *because* the rule admits no legal sharing. A
design that warned and allowed could not be a unique index, and would have
needed a lock plus a policy about what the lock protects.

`Agent.inboundEnabled` is written by sync from the agent payload's
`inbound.enabled`, which upstream returns on every agent read. It follows the
mirror's existing rule: sync owns configuration, staff own assignment.

---

## 5. Lifecycle

### 5.1 Start and resume

`assertInboundStartable` runs after the existing outbound gates and before any
upstream call, matching `assertCampaignDialable`: every local gate first, so a
start that is going to be refused never writes to a partner account every
customer shares.

```
G0  type == OUTBOUND                    → return clear
      an outbound-only campaign takes no new gate. This feature must not be
      able to refuse a start that succeeds today.

G1  env.inboundEnabled == false         → 409 INBOUND_DISABLED
      local kill switch, the shape DIALER_ENABLED already has.

G2  agent.inboundEnabled == false       → 409 AGENT_INBOUND_NOT_ENABLED
      refuse, never auto-enable. See below.

G3  dids == []                          → 409 CAMPAIGN_INBOUND_DID_REQUIRED

G4  any did not phoneNumberIsUsable()   → 409 CAMPAIGN_INBOUND_DID_UNAVAILABLE
      the existing rule: ASSIGNED | PAST_DUE, this workspace's.

G5  INSERT one CampaignInboundClaim per DID, one transaction
      conflict on any row                → 409 CAMPAIGN_INBOUND_DID_CONFLICT
      all-or-nothing. The error NAMES the colliding DID and the campaign
      holding it, or the operator is hunting through rotations by hand.

G6  per DID, sequentially:
      POST /voicelink/inbound-ready { did_number, agent_id, connection_id, bot_name }
      require data.ready AND data.readiness.inbound.ready
      any failure → unbind what was bound, release the claims, 409
                    CAMPAIGN_DID_NOT_INBOUND_READY
```

**G2 refuses rather than enabling.** Turning inbound on deep-copies the
knowledge base *in the background*, and a call placed before the copy finishes
is answered by an agent with an empty knowledge base — no error, no warning, it
simply behaves as though it knows nothing. Folding the enable into `start` would
put that race directly underneath a live customer campaign. Enabling is an
earlier, explicit act with its own sync wait.

**G6 is stricter than its outbound twin, and the asymmetry is the point.**
`ensureCallerNumberReady` deliberately ignores `NO_VOCOBASE_AGENT`, because
outbound passes an explicit `agent_id` on every call. For inbound,
`NO_VOCOBASE_AGENT` is precisely the thing that breaks it: the number rings, the
call reaches the bot, no agent resolves, and the call is rejected. Upstream is
explicit that an `assign_agent: skipped` result is a failed setup rather than a
partial success. Same field, opposite meaning, so it needs its own readiness map
rather than sharing `BLOCKING_READINESS`.

**Sequential, not concurrent**, for the reason `syncPurchasedDids` is: a burst of
routing writes against a shared telephony account is how one campaign's start
becomes somebody else's incident.

`resume` runs this identical list, as it already does for the outbound gates.

### 5.2 Pause, stop, complete, credit exhaustion, delete

Every exit from `RUNNING`, in one transaction plus a bounded upstream pass:

```
DELETE the campaign's CampaignInboundClaim rows
per DID:  PUT /api/v2/phone-numbers/{id} { agent_id: null }
```

That second call sets `agent_id = null` and `inbound_enabled = false` on the
platform's own phone-number row. For VoiceLink numbers it writes nothing to
VoiceLink — the bot and the routing record stay as they are — so there is
nothing to unwind and the call is idempotent. An inbound call then reaches the
bot, resolves no agent, and is **rejected**: no agent answers, which is the
required behaviour.

**The caller experience is a dead line, not a closed-hours message.** A polite
"we are closed" would mean keeping an agent bound with an after-hours prompt,
which is the opposite of unbinding. Accepted deliberately.

`PATCH` on a `RUNNING` campaign's numbers is already refused with
`CAMPAIGN_PHONE_NUMBER_LOCKED`, so the attached set cannot drift underneath a
held claim. No new guard is needed there.

---

## 6. Attribution

An inbound call carries **no correlation id**. `client_reference_id` is stamped
by the caller at dial time, so `findAttempt` misses and `handleSessionCompleted`
logs an unknown call and returns. That miss is the hook.

```
session.completed, direction inbound
  canonicalize to_number → PhoneNumber.did → id
  → CampaignInboundClaim[phoneNumberId]     (absent → unattributed, done)
  → campaign
  → canonicalize from_number → Contact(workspaceId, phone)
  → CampaignContact(campaignId, contactId)
```

The claim lookup is the whole disambiguation. A DID with no claim — paused,
stopped, or never inbound-enabled — yields an unattributed call in Call History,
which is now the *only* possible outcome for those states rather than a guess.

**An inbound call must not write a `CallAttempt`.** That table's stated
invariant is that an attempt exists only for a call the dialer placed, and it is
load-bearing in three places: `callTimeline` renders attempts and reports
`timelineSource: none` when there are none, `CampaignContact.attempts` counts
retries consumed, and `attemptNo` is the dial mutual-exclusion token. Writing
inbound calls there would corrupt all three. A separate `CampaignInboundCall`
row keeps the invariant true and lets the journey merge the two streams by
time.

**The retry budget is untouched.** An inbound call consumes no attempt and
re-arms nothing.

---

## 7. Pre-call variables on an inbound call

**Revised 2026-09-09.** This section previously concluded that inbound routing
policies could not reach VoiceLink and recommended a `PRE_CALL` lifecycle hook.
That is no longer true. Vocobase shipped VoiceLink policy evaluation on
2026-09-06 (backend #522, dashboard #181, api-docs #63). The hook approach is
abandoned; the policy is strictly better and removes work rather than adding it.

We dial Contact 1 with their name and renewal date. They miss it. They ring back
an hour later — and without something, the inbound face knows none of it, because
`Session.variables` is `{}` for an inbound call.

### The mechanism

A policy registers an HTTPS endpoint Vocobase calls **before it creates any
session**, carrying `from_number`, `to_number`, `phone_number.id` and `agent.id`.
We answer:

```json
{ "action": "ANSWER_WITH_AI",
  "variables": { "name": "…", "renewal_date": "…", "last_outcome": "no_answer" } }
```

`POLICY_CAPABLE_PROVIDERS` now includes `VOICELINK`, so either `PHONE_NUMBER` or
account-wide scope is available. **Use account-wide.** One registration for the
whole partner account, nothing to create or delete per campaign — the claim table
already knows which campaign owns a DID, so a per-DID policy would be a second
lifecycle to keep in step with the first. It fires for every inbound call on the
account, including unclaimed DIDs; those answer with no variables.

`TRANSFER` is refused for VoiceLink upstream (no call control on that path). The
other three actions work.

### It replaces the attribution path too

This is the simplification. The callback arrives **before the session exists**
and carries both numbers, so one synchronous handler resolves campaign *and*
contact and returns variables in the same response:

```
to_number   → PhoneNumber → CampaignInboundClaim → campaign
from_number → Contact(workspaceId, phone) → CampaignContact
→ variables built as the dialer builds them, plus call-history context
→ ANSWER_WITH_AI + variables, and the attribution row written here
```

So section 6's `session.completed` reconstruction becomes a *settle* of a row
that already exists, not a derivation. Three things fall away with it: the
per-face hook attachment, the ingest-time campaign lookup, and the
pause-mid-call race where a claim released during a live call left an answered
call attributable to nothing.

### Constraints on the endpoint

**Latency.** `timeout_ms` is 250-5000 (default 2000) with a live caller holding.
Two indexed reads, direct — never the job queue, never an upstream call.

**`failure_action` is `ANSWER_WITH_AI`, never `REJECT`.** A deploy blip must
degrade to an agent answering without variables, not to dropped customer calls.
Every failure path upstream already falls through to an unseeded answer.

**Its own secret and verifier.** `v1=hmac_sha256(timestamp.raw_body)` over raw
bytes — the shape `webhookSignature.ts` implements, but a different secret and
header, so it is a sibling of the existing verifier, mounted before
`express.json()`.

## 8. Inbound calls are not billed to the workspace today

Charging runs entirely through `applyTerminalOutcome({ attemptId })`. No
attempt, no charge — which the call-detail surface already states as a fact:
`billing` is null rather than zero for such a call, because it is not charged to
the workspace at all.

That was written when inbound traffic on the shared account belonged to somebody
else. The moment this service provisions inbound for its own customers, it
becomes **this platform paying the supplier for minutes it never bills on**.

Closing it means charging from `CampaignInboundCall` on the same
`session.completed` event, through the same conditional write and the same
`duration_seconds` the outbound path bills on. It should land in this wave.
Deferring it is a decision to run the feature at a loss, not an omission.

---

## 9. Errors

| Code | HTTP | Meaning |
|---|---|---|
| `INBOUND_DISABLED` | 409 | deployment kill switch is off |
| `AGENT_INBOUND_NOT_ENABLED` | 409 | the agent has no inbound configuration yet |
| `CAMPAIGN_INBOUND_DID_REQUIRED` | 409 | an inbound campaign with no numbers |
| `CAMPAIGN_INBOUND_DID_UNAVAILABLE` | 409 | a number this workspace no longer holds |
| `CAMPAIGN_INBOUND_DID_CONFLICT` | 409 | another running campaign holds one; names it |
| `CAMPAIGN_DID_NOT_INBOUND_READY` | 409 | upstream provisioning did not reach ready |

---

## 10. A shipped label that is wrong

`agent_type` is presented in three places as though it controlled direction —
*"Inbound answers calls; outbound places them"* in `tab-settings.tsx`,
`agents/new/page.tsx` and the labs surface. It does not. Upstream is explicit
that it is a label for the operator's own filing, and direction is decided by
the inbound configuration and the DID binding.

An operator reading that hint will create an "inbound" agent, bind a number, and
get no answer. The copy has to change in the same wave that makes the real
control exist, or the two controls will be indistinguishable on screen.

---

## 11. Settled, and what each implies

Decided 2026-09-09.

**An inbound call does not stop the chase; it re-bases it.** Retries and
follow-ups continue exactly as configured. The contact's *currently armed* next
attempt is cancelled and rescheduled — `nextEligibleAt` moves to the inbound
call's end plus the cooldown for the rung it is on. The retry budget is
untouched: `attempts` does not increment, and the ladder position does not move.
Calling someone ten minutes after they just spoke to us is the thing this
prevents.

> **A promised callback is exempt.** Re-basing moves `nextEligibleAt`, and
> `nextEligibleAt == callbackAt` is the sole marker of an armed callback — so a
> naive re-base silently destroys a callback the customer explicitly asked for.
> An armed pair is left alone, the same exemption the retry-lowering sweep and
> the dispatcher's budget check already carry.

Two cases fall out with it: a contact currently `QUEUED` is left alone (a dial is
in flight and cannot be safely re-timed), and a contact already settled
`COMPLETED`/`FAILED` is not reopened — the call is logged and attributed, and
nothing is rescheduled.

**An unknown caller is logged, not enrolled.** No `Contact` row is created and no
`CampaignContact`. `CampaignInboundCall.contactId` and `campaignContactId` are
both nullable, and the campaign is still attributed through the DID claim.

**Inbound calls count toward the campaign's goal.** Extraction runs on them and
feeds `leadBucketKey`, won-buckets and the goal verdict exactly as an outbound
call does.

> **The face's extraction config must be kept in step.** The inbound face is an
> independent configuration whose extraction settings are copied once at enable
> and never again. Change the outbound agent's extraction keys and the face keeps
> the old ones — inbound calls then extract different keys and the goal silently
> stops matching on precisely the calls this decision says should count. Writing
> extraction to an agent must write it to both sides, or the drift is invisible.

Also implied: goal and bucket reads currently key off `CallAttempt`, which an
inbound call never has. Every such read must union `CampaignInboundCall`, or
inbound calls count toward nothing regardless of this decision.

## 12. Out of scope

Upstream inbound campaigns (not exposed to partners), inbound routing policies,
per-DID after-hours behaviour, and any second agent row — an inbound face is a
configuration on an existing agent and is never mirrored as its own `Agent`.
