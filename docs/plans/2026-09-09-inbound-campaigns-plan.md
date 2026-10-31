# Inbound Campaigns Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an YE campaign receive calls as well as place them — an inbound-enabled agent answers on the campaign's numbers, the caller is recognised, and the call lands on their contact journey and counts toward the campaign's goal.

**Architecture:** A campaign gains a `type` (`OUTBOUND | INBOUND | BOTH`). A `RUNNING` inbound-facing campaign claims every DID attached to it, one claim row per DID, uniqueness enforced by the primary key. Vocobase calls one account-wide **inbound routing policy** endpoint before it creates a session; that handler resolves campaign and contact from the two phone numbers, returns pre-call variables, and writes the attribution row. `session.completed` later settles that row. No `CallAttempt` is ever written for an inbound call.

**Tech Stack:** Express 5, Prisma/Postgres, Redis, Vitest + supertest. Upstream is the Vocobase V2 partner API.

**Read first:** [`2026-09-04-inbound-campaigns-design.md`](./2026-09-04-inbound-campaigns-design.md). This plan implements it and does not repeat its reasoning.

---

## Granularity note

Tasks 7, 8, 11 and 15 are load-bearing and are written out step by step with full code — they carry the invariants that break silently if got wrong. The rest are written tighter, because they are mechanical against patterns this repo already has and the existing tests show the shape. Where a task says "follow X", read X first.

## Ground rules for every task

- **TDD.** Failing test, run it, minimal implementation, run it, commit. No exceptions on tasks 7/8/11/15.
- **Tests never touch a live account.** Every suite mocks `../src/adapter/vocobase.js`, as `test/campaign-lifecycle.test.ts` does. A test that places a call or builds routing is a bug in the test.
- `npm test -- <file>` runs one file. `npm run test:prepare` applies migrations to `TEST_DATABASE_URL` after any schema change.
- **The suite is flaky at ~10% on full runs** from cross-file bleed. Re-run a failure before believing it, and only trust a failure in a file you touched.
- Commit per task, imperative mood, describing the feature as built here.

---

# Phase 1 — Agent inbound faces

Ships alone and is useful alone: an agent that answers a published line with its own prompt, no campaign involved.

### Task 1: Mirror `Agent.inboundEnabled`

**Files:**
- Modify: `prisma/schema.prisma` (model `Agent`)
- Modify: `src/services/agentSync.ts`
- Modify: `src/lib/serialize.ts` (`VISIBLE_CONFIG_KEYS` / agent projection)
- Test: `test/agent-sync.test.ts`

Add `inboundEnabled Boolean @default(false)`. Upstream returns `inbound.enabled` on every agent read.

**Critical:** the sync upsert must write `inboundEnabled` (it is configuration, which sync owns) and must still **never** write `workspaceId`. Read `src/services/agentSync.ts` before editing — the existing upsert deliberately omits ownership columns.

Migration: `npx prisma migrate dev --name agent_inbound_enabled`.

Test: a synced agent whose upstream payload carries `inbound: { enabled: true }` mirrors `true`; one carrying no `inbound` key mirrors `false` and does not throw.

### Task 2: Enable and disable inbound on an agent

**Files:**
- Modify: `src/adapter/vocobase.ts` — add `setAgentInbound(externalId, enabled, confirm?)`
- Modify: `src/routes/agents.routes.ts` — `PATCH /api/workspaces/:id/agents/:agentId/inbound`
- Test: `test/agent-inbound.test.ts` (create)

Body `{ enabled: boolean, confirm?: boolean }`. Follows the five-step write order every agent route uses: `requireAuth → requireMembership() → agentInWorkspace() → proxy upstream → refresh the mirror`.

Upstream's two-step disable surfaces as-is: pass `CONFIRM_REQUIRED` through with its `details` payload (**`details` is a sibling of `error`, not nested** — parsing it wrong is the documented trap). The dashboard renders the numbers and campaigns that would be unlinked.

Tests: enable is idempotent; disable without `confirm` returns 409 `CONFIRM_REQUIRED` with `details` intact; disable with `confirm` succeeds; a member (not just ADMIN) may do both, matching the deliberate agent-surface deviation.

### Task 3: Read and write the inbound configuration

**Files:**
- Modify: `src/adapter/vocobase.ts` — `getAgent(externalId, { includeInbound })`, `updateAgentInbound(externalId, payload)`
- Modify: `src/routes/agents.routes.ts` — `GET .../agents/:agentId?include=inbound`, `PUT .../agents/:agentId/inbound/config`
- Test: `test/agent-inbound.test.ts`

Reuse `updateAgentSchema` unchanged — the inbound config takes the same body. `agent_name` and `project_id` are accepted and ignored upstream; strip them here so we do not send fields we know are discarded.

`PUT` before enabling returns upstream's 404 `INBOUND_NOT_ENABLED`; pass it through rather than inventing a local code.

### Task 4: Writing extraction writes both sides

**Files:**
- Modify: `src/routes/agents.routes.ts` (the `PATCH` agent handler)
- Test: `test/agent-inbound.test.ts`

**This is the drift trap from design §11.** The face's extraction config is copied once at enable and never again. Since inbound calls must count toward campaign goals, a divergent key set makes goals silently stop matching on inbound calls.

Rule: when `PATCH /agents/:agentId` changes `extraction_config` **and** the agent has `inboundEnabled`, apply the same `extraction_config` to the inbound side in the same request. If the second write fails, the response reports `inboundConfigSynced: false` with the reason — it must not report a whole success, and it must not roll back the first write.

Test: updating extraction on an inbound-enabled agent issues both upstream calls with identical `extraction_config`; on an agent without inbound it issues one; a failing second call still 200s but flags `inboundConfigSynced: false`.

**Commit and stop here for a first shippable slice.**

---

# Phase 2 — Campaign type and the DID claim

### Task 5: `CampaignType`

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/campaignConfig.ts`, `src/lib/serialize.ts`
- Test: `test/campaigns.test.ts`

```prisma
enum CampaignType { OUTBOUND INBOUND BOTH }
model Campaign { type CampaignType @default(OUTBOUND) }
```

Validation belongs in `campaignConfig.ts` with every other campaign rule, **not** in the route's zod schema — that file owns create and update alike so the two paths cannot accept different campaigns.

Rules: `INBOUND`/`BOTH` require the campaign's agent to have `inboundEnabled` → 422 `CAMPAIGN_AGENT_INBOUND_NOT_ENABLED`. `INBOUND` refuses to dial, so `start` skips every outbound gate for it (no caller DID required, no window, no rate). Type is editable in `DRAFT` only — it decides what a campaign *is*.

### Task 6: The claim table

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `test/campaign-inbound-claim.test.ts` (create)

```prisma
model CampaignInboundClaim {
  phoneNumberId String   @id
  campaignId    String
  agentId       String
  claimedAt     DateTime @default(now())

  phoneNumber PhoneNumber @relation(fields: [phoneNumberId], references: [id], onDelete: Cascade)
  campaign    Campaign    @relation(fields: [campaignId],    references: [id], onDelete: Cascade)

  @@index([campaignId])
}
```

`phoneNumberId` as the primary key **is** the invariant — one live inbound-facing campaign per DID. Test that a second insert for the same DID raises a unique violation.

### Task 7: `assertInboundStartable`

**Files:**
- Create: `src/lib/inboundStart.ts`
- Test: `test/campaign-inbound-start.test.ts` (create)

**Step 1: Write the failing tests — one per gate, in order.**

```ts
it('is a no-op for an OUTBOUND campaign', async () => {
  await expect(assertInboundStartable(outboundCampaign, [])).resolves.toBeUndefined();
});

it('refuses when the agent has no inbound face', async () => {
  await expect(assertInboundStartable(bothCampaign, [did]))
    .rejects.toMatchObject({ status: 409, code: 'AGENT_INBOUND_NOT_ENABLED' });
});

it('refuses and names the campaign already holding a DID', async () => {
  await prisma.campaignInboundClaim.create({
    data: { phoneNumberId: did.id, campaignId: rival.id, agentId: otherAgent.id },
  });
  await expect(assertInboundStartable(bothCampaign, [did]))
    .rejects.toMatchObject({ status: 409, code: 'CAMPAIGN_INBOUND_DID_CONFLICT' });
});
```

**Step 2: Run — expect failure.** `npm test -- test/campaign-inbound-start.test.ts`

**Step 3: Implement.** Gate order matters; every local gate runs before any upstream call, matching `assertCampaignDialable`.

```ts
export async function assertInboundStartable(
  campaign: CampaignWithAgent,
  dids: PhoneNumber[],
): Promise<void> {
  // G0 — an outbound-only campaign takes no new gate. This feature must never
  // refuse a start that succeeds today.
  if (campaign.type === 'OUTBOUND') return;

  if (!env.inboundEnabled) {
    throw new ApiError(409, 'INBOUND_DISABLED',
      'Inbound calling is turned off on this deployment.');
  }

  // G2 — refuse, never auto-enable. Enabling deep-copies the knowledge base in
  // the background, and a call placed before that finishes is answered by an
  // agent with an empty KB, silently. That race must not sit under a live
  // campaign start.
  if (!campaign.agent?.inboundEnabled) {
    throw new ApiError(409, 'AGENT_INBOUND_NOT_ENABLED',
      'Turn Inbound on for this agent before starting a campaign that receives calls.');
  }

  if (dids.length === 0) {
    throw new ApiError(409, 'CAMPAIGN_INBOUND_DID_REQUIRED',
      'Attach at least one phone number before starting this campaign.');
  }

  for (const did of dids) {
    if (!phoneNumberIsUsable(did, campaign.workspaceId)) {
      throw new ApiError(409, 'CAMPAIGN_INBOUND_DID_UNAVAILABLE',
        `${did.did} is no longer available to this workspace.`);
    }
  }
}
```

**Step 4: Run — expect pass. Step 5: Commit.**

### Task 8: Claim on start, all-or-nothing

**Files:**
- Modify: `src/services/campaignStart.ts`
- Modify: `src/lib/inboundStart.ts` — add `claimInboundDids`
- Test: `test/campaign-inbound-start.test.ts`

**Step 1: Write the failing test.**

```ts
it('claims every DID or none', async () => {
  // rival holds the third of three
  await prisma.campaignInboundClaim.create({
    data: { phoneNumberId: didC.id, campaignId: rival.id, agentId: agent.id },
  });
  await expect(claimInboundDids(campaign, [didA, didB, didC])).rejects.toMatchObject({
    code: 'CAMPAIGN_INBOUND_DID_CONFLICT',
  });
  // A and B must NOT be left claimed
  expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(0);
});
```

**Step 2: Run — expect failure.**

**Step 3: Implement.** One transaction; the unique violation is the refusal.

```ts
export async function claimInboundDids(campaign, dids): Promise<void> {
  if (campaign.type === 'OUTBOUND') return;
  try {
    await prisma.$transaction(
      dids.map((did) =>
        prisma.campaignInboundClaim.create({
          data: {
            phoneNumberId: did.id,
            campaignId: campaign.id,
            agentId: campaign.agentId!,
          },
        }),
      ),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Name the collision. Without this the operator hunts through rotations by
    // hand for which of twenty numbers is taken.
    const held = await prisma.campaignInboundClaim.findMany({
      where: { phoneNumberId: { in: dids.map((d) => d.id) } },
      include: { campaign: { select: { name: true } }, phoneNumber: { select: { did: true } } },
    });
    const first = held[0];
    throw new ApiError(409, 'CAMPAIGN_INBOUND_DID_CONFLICT',
      `${first.phoneNumber.did} is already answering for the campaign "${first.campaign.name}". ` +
      `Stop that campaign or choose a different number.`);
  }
}
```

**Step 4: Run. Step 5: Provision upstream, sequentially, after the claim.** For each DID call `voicelinkInboundReady(did, agentExternalId)` and require `ready === true && readiness.inbound.ready === true`. Sequential, not concurrent — a burst of routing writes against a shared telephony account is how one campaign's start becomes somebody else's incident. On any failure, release the claims and unbind what was bound, then throw `CAMPAIGN_DID_NOT_INBOUND_READY`.

**This readiness map is not `BLOCKING_READINESS`.** That one deliberately ignores `NO_VOCOBASE_AGENT` because outbound passes an explicit agent per call. For inbound that state is exactly the failure. Write a separate map; do not extend the existing one.

**Step 6: Commit.**

### Task 9: Release on every exit from `RUNNING`

**Files:**
- Modify: `src/lib/campaignLifecycle.ts`
- Modify: `src/adapter/vocobase.ts` — `clearPhoneNumberAgent(phoneNumberExternalId)`
- Test: `test/campaign-inbound-start.test.ts`

Pause, stop, complete, credit exhaustion and delete all: delete this campaign's claim rows, then per DID call `PUT /api/v2/phone-numbers/{id} { agent_id: null }`. That sets `agent_id = null, inbound_enabled = false` upstream; the call then reaches the bot, resolves no agent, and is rejected. Idempotent, and it writes nothing to VoiceLink, so there is nothing to unwind.

**Only `RUNNING` holds a claim.** A paused campaign releases, and a rival may take its numbers — so pause must warn (Task 21). `CREDIT_EXHAUSTED` releases with the rest.

Tests: pausing releases and nulls; a rival can then claim; resuming the first campaign now fails `CAMPAIGN_INBOUND_DID_CONFLICT`, and that is correct rather than a bug.

---

# Phase 3 — The routing-policy endpoint

The heart of the feature. Synchronous, on a live call's critical path.

### Task 10: Signature verifier

**Files:**
- Create: `src/lib/inboundRouteSignature.ts`
- Test: `test/inbound-route-signature.test.ts` (create)

`v1=hmac_sha256(timestamp.rawBody)`, timing-safe, 300s skew. Model on `src/lib/webhookSignature.ts` but **do not call it** — different secret (`INBOUND_ROUTE_POLICY_SECRET`), different header (`X-Vocobase-Signature`).

Two rules that file already learned the hard way: compare buffer **lengths before** `timingSafeEqual` (it throws on unequal lengths, turning a forged signature into a 500), and an **unset secret rejects everything**.

### Task 11: The decide endpoint

**Files:**
- Create: `src/routes/inboundRoute.routes.ts`
- Create: `src/services/inboundRouteDecide.ts`
- Modify: `src/app.ts` — mount outside `/api`, **before** `express.json()`, with its own `express.raw`
- Test: `test/inbound-route.test.ts` (create)

**Step 1: Write the failing tests.**

```ts
it('returns the contact variables for a claimed DID', async () => {
  const res = await post('/webhooks/vocobase/inbound-route', body({
    from_number: '+919876543210', to_number: did.did,
  }));
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    action: 'ANSWER_WITH_AI',
    variables: { name: 'Rahul', last_outcome: 'no_answer' },
  });
});

it('answers unseeded for an unclaimed DID rather than failing', async () => {
  const res = await post('/webhooks/vocobase/inbound-route', body({
    from_number: '+919876543210', to_number: unclaimed.did,
  }));
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ action: 'ANSWER_WITH_AI' });
});

it('answers unseeded for a caller who is not a contact', async () => { /* … */ });
it('rejects an invalid signature with 401', async () => { /* … */ });
```

**Step 2: Run — expect failure.**

**Step 3: Implement.**

```ts
export async function decideInboundRoute(from: string, to: string) {
  // Two indexed reads. Never the queue, never an upstream call — timeout_ms is
  // 250-5000 with a live caller holding, and this is the only synchronous path
  // in this service on a call's critical path.
  const number = await prisma.phoneNumber.findFirst({
    where: { did: canonicalizeE164(to) ?? to },
    select: { id: true, workspaceId: true, inboundClaim: { include: { campaign: true } } },
  });

  const claim = number?.inboundClaim;
  if (!claim) return { action: 'ANSWER_WITH_AI' as const };   // unclaimed: answer blank

  const phone = canonicalizeE164(from);
  const cc = phone
    ? await prisma.campaignContact.findFirst({
        where: { campaignId: claim.campaignId, contact: { phone, workspaceId: number.workspaceId } },
        include: { contact: true },
      })
    : null;

  // An unknown caller is logged, not enrolled (design §11). Attribution to the
  // campaign still happens; only the contact is absent.
  await recordInboundArrival({ claim, campaignContact: cc, fromNumber: from });

  if (!cc) return { action: 'ANSWER_WITH_AI' as const };

  return {
    action: 'ANSWER_WITH_AI' as const,
    variables: buildInboundVariables(claim.campaign, cc),
  };
}
```

`buildInboundVariables` reuses the dialer's variable builder over `Campaign.variableMap` and `Contact.metadata`, then adds what only inbound knows: `last_outcome`, `attempts_so_far`, `last_called_at`. **Every value must be a string** — the platform's own call-time fields are all strings so template substitution and the JSON payload stay well-formed.

**Step 4: Run — expect pass.**

**Step 5: Fail open, always.** Wrap the handler so any throw still answers `200 { action: 'ANSWER_WITH_AI' }`. A slow query or a deploy blip must degrade to an agent answering without variables, never to a dropped customer call. Add a test that a thrown error still 200s.

**Step 6: Commit.**

### Task 12: Register the policy

**Files:**
- Modify: `src/adapter/vocobase.ts` — `upsertInboundRoutePolicy()`
- Modify: `src/routes/admin/*` — a staff action to register/inspect it
- Test: `test/inbound-route.test.ts`

One account-wide (`PARTNER`) policy for the whole partner account: `webhook_url`, `webhook_secret`, `timeout_ms: 2000`, `failure_action: 'ANSWER_WITH_AI'`, `allowed_actions: ['ANSWER_WITH_AI']`.

Account-wide, not per-DID, deliberately: the claim table already knows which campaign owns a number, so a per-DID policy would be a second lifecycle to keep in step with the first. Upstream answers 409 `POLICY_ALREADY_EXISTS` per scope target — treat that as success and update.

Registration is a **staff action, not campaign start**. It is deployment configuration, and doing it per start would write to a shared partner account on every click.

---

# Phase 4 — Attribution and the retry re-base

### Task 13: `CampaignInboundCall`

**Files:** `prisma/schema.prisma`, `src/lib/serialize.ts`

```prisma
model CampaignInboundCall {
  id                String   @id @default(uuid())
  campaignId        String
  campaignContactId String?          // null: an unknown caller
  contactId         String?
  workspaceId       String
  phoneNumberId     String
  fromNumber        String
  upstreamCallId    String?  @unique
  upstreamSessionId String?  @unique
  arrivedAt         DateTime @default(now())
  endedAt           DateTime?
  durationSecs      Int?
  disposition       String?
  extraction        Json?
  costCredits       BigInt?
  @@index([campaignId, arrivedAt])
  @@index([campaignContactId])
}
```

**Never a `CallAttempt`.** That table's invariant — an attempt exists only for a call the dialer placed — is load-bearing in three places: `callTimeline` reports `timelineSource: none` when there are none, `CampaignContact.attempts` counts retries consumed, and `attemptNo` is the dial mutual-exclusion token. Writing inbound calls there corrupts all three.

### Task 14: `session.completed` settles the row

**Files:** `src/services/webhookOutcome.ts`, `test/inbound-outcome.test.ts` (create)

Today `if (!attempt) { warn; return; }`. Add a branch before that return: look the session up in `CampaignInboundCall` by `upstreamSessionId`/`upstreamCallId` and settle it — `endedAt`, `durationSecs`, `disposition`, `extraction`.

The row already exists from Task 11, so this **settles** rather than derives. That is what removes the pause-mid-call race: a claim released during a live call cannot orphan an answered call, because attribution was decided before the session existed.

### Task 15: Re-base the next attempt

**Files:**
- Modify: `src/services/campaignInbound.ts` (new) — called from Task 14
- Test: `test/inbound-outcome.test.ts`

**Step 1: Write the failing tests. The exemptions are the point.**

```ts
it('pushes the next retry out from the inbound call', async () => { /* nextEligibleAt moves */ });

it('does NOT consume a retry', async () => {
  expect(after.attempts).toBe(before.attempts);
});

it('LEAVES AN ARMED CALLBACK ALONE', async () => {
  // nextEligibleAt === callbackAt, both non-null
  await settleInbound(...);
  const row = await prisma.campaignContact.findUnique({ where: { id: cc.id } });
  expect(row.nextEligibleAt).toEqual(armedAt);   // the promise survives
  expect(row.callbackAt).toEqual(armedAt);
});

it('leaves a QUEUED contact alone', async () => { /* a dial is in flight */ });
it('does not reopen a COMPLETED contact', async () => { /* … */ });
```

**Step 2: Run — expect failure.**

**Step 3: Implement.**

```ts
// The contact rang in, so the clock restarts — calling them ten minutes after
// they just spoke to us is what this prevents. The ladder position and the
// retry budget are untouched: `attempts` counts retries CONSUMED, and an
// inbound call consumes none.
//
// An ARMED CALLBACK IS EXEMPT. `nextEligibleAt == callbackAt`, both non-null,
// is the sole marker of one, so moving nextEligibleAt alone would destroy a
// promise the customer explicitly asked for. Written null-safely: SQL's
// NOT (a = b) is NULL when either side is NULL, and a NULL predicate excludes
// the row — which would silently skip exactly the contacts this must move.
await prisma.campaignContact.updateMany({
  where: {
    id: campaignContactId,
    status: 'PENDING',                     // not QUEUED (dial in flight), not settled
    OR: [
      { callbackAt: null },
      { nextEligibleAt: null },
      { NOT: { nextEligibleAt: { equals: prisma.campaignContact.fields.callbackAt } } },
    ],
  },
  data: { nextEligibleAt: addMinutes(inboundEndedAt, cooldownForRung(campaign, attempts)) },
});
```

Note `NOT: { equals: fieldRef }` — `{ not: fieldRef }` does not work at runtime in Prisma. This is the third spelling of the invariant; the other two live in `dialerClaim.ts` and `campaignLifecycle.ts`.

**Step 4: Run. Step 5: Commit.**

### Task 16: Journey merge

**Files:** `src/services/campaignJourney.ts`, `test/campaign-journey.test.ts`

Merge `CampaignInboundCall` rows into the existing attempt timeline, ordered by instant, each tagged as an inbound event. `timelineSource` stays honest: a contact with only inbound calls is not `none`.

---

# Phase 5 — Goals and billing

### Task 17: Goals and buckets count inbound calls

**Files:** `src/services/campaignBucketReport.ts`, `src/lib/campaignBuckets.ts`, `src/services/analytics.ts`, `src/lib/goalRecord.ts`

Every goal, lead-bucket and won-bucket read currently keys off `CallAttempt`. Union `CampaignInboundCall`. Without this, Task 4 and design §11 are both defeated — inbound calls extract correctly and count toward nothing.

**Grep beyond `src/`.** `scripts/` holds the conformance and battle suites, which assert these contracts too and stay stale while `tsc` and `npm test` are green.

### Task 18: Charge inbound calls

**Files:** `src/services/dialerOutcome.ts` or a sibling, `test/inbound-billing.test.ts` (create)

Charging runs through `applyTerminalOutcome({ attemptId })`, and an inbound call has no attempt — so today it is not charged to the workspace at all. Harmless while inbound traffic is someone else's; the day this ships it is YE paying the supplier for minutes it never bills on.

Charge from `CampaignInboundCall` on the same `session.completed`, through the same conditional write and the same `duration_seconds` the outbound path bills on. Only `src/services/didRental.ts`, `dialerOutcome.ts` and `testSessionOutcome.ts` move credits today — this becomes the fourth, and it must follow the same conditional-write-in-a-transaction rule.

---

# Phase 6 — Dashboard

Repo: `ye-voice-dashboard`.

### Task 19: Campaign type and inbound numbers

Type selector in the campaign form, `DRAFT`-only. Inbound-facing types show which DIDs the campaign will answer on. An agent without an inbound face is offered with the reason and the fix, not silently hidden.

### Task 20: The pause warning

For `INBOUND`/`BOTH` only:

> Pausing stops answering calls on +91…. Another campaign can claim it while you are paused, and you may not be able to resume.

This turns the design's deliberate trap into a decision. Do not soften it.

### Task 21: Fix the `agent_type` hint

Three places say *"Inbound answers calls; outbound places them"* — `components/agents/tab-settings.tsx:89`, `app/(dash)/agents/new/page.tsx:209`, `components/labs/surfaces/agent.tsx:304`. It is false: `agent_type` is a filing label and controls nothing. Direction comes from the inbound face and the DID binding.

Ship this in the same wave that makes the real control exist, or the two controls are indistinguishable on screen.

---

## Verification before calling it done

1. `npm test` — full suite, twice. Ignore the known ~10% cross-file flake; investigate only failures in files this plan touched.
2. `npm run conformance` — the campaign engine's acceptance gate. Re-run after any dialer change; Task 15 is one.
3. `npm run battle` — the queue under load across two processes.
4. `npx tsc --noEmit` in both repos.
5. Confirm by hand that a paused inbound campaign's DID **stops answering** — that is the one behaviour with no test that can prove it locally.
