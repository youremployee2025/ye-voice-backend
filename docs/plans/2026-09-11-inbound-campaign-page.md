# Inbound Campaign Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give an INBOUND campaign a page that describes calls received rather than calls placed, backed by endpoints that read `CampaignInboundCall`, and enrol every caller as a contact without adding a single write to the routing hot path.

**Architecture:** The routing webhook (`/webhooks/vocobase/inbound-route`) becomes read-only until the response is on the wire; the arrival row is written after `res.json`, and the completion settle can create the row itself if that write never landed. Enrolment of unknown callers happens in the settle, off the caller's path. New read surfaces are one grouped statement over `CampaignInboundCall` for the list and stats, one paged listing endpoint, and a per-contact inbound summary on the contacts endpoint. The dashboard branches once on `campaign.type === 'INBOUND'` to swap the tab set and the list row's outcome cell.

**Tech Stack:** Express + Prisma + raw SQL (backend, vitest against `TEST_DATABASE_URL`); Next.js app router + vitest/jsdom (dashboard).

**Worktrees:** backend `ezo/.worktrees/inbound-campaign-page/ye-voice-backend` (branch `feat/inbound-campaign-page`, test DB `ye_test_inbound_page`, Redis index 14); dashboard `ezo/.worktrees/inbound-campaign-page/ye-voice-dashboard` (same branch name). Deploy backend first; every new dashboard field is optional (deploy-skew rule).

**Hard rule from the user (2026-09-11):** nothing on the inbound-route hot path may write to the database or call upstream. Three indexed reads (number + claim, campaign contact, goal row), then respond. Any test that asserts a row exists after the routing response must await `flushInboundArrivals()`.

---

## Backend

### Task 1: Respond before recording the arrival

**Files:**
- Modify: `src/services/inboundRouteDecide.ts:20-136`
- Modify: `src/routes/inboundRoute.routes.ts:46-47`
- Test: `test/inbound-route.test.ts`

**Step 1: Write the failing test**

Add to `test/inbound-route.test.ts`, next to the "attribution row written" case (~:75). The seam `flushInboundArrivals` does not exist yet, so the import fails: that is the RED.

```ts
it('answers before the arrival row is written, and the row lands after', async () => {
  const { flushInboundArrivals } = await import('../src/routes/inboundRoute.routes.js');
  const s = await scenario();
  const res = await post({ from_number: s.contact.phone, to_number: s.did.did, provider_call_id: 'pc-9' });
  expect(res.status).toBe(200);
  expect(res.body.action).toBe('ANSWER_WITH_AI');
  await flushInboundArrivals();
  const rows = await prisma.campaignInboundCall.findMany({ where: { upstreamCallId: 'pc-9' } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.campaignContactId).toBe(s.cc.id);
});
```

Adjust `scenario()`'s return to expose `cc` and `did` if it does not already (read :34-57 first).

**Step 2: Run it**

```
npx vitest run test/inbound-route.test.ts -t "answers before"
```
Expected: FAIL, `flushInboundArrivals` is not exported.

**Step 3: Implement**

In `inboundRouteDecide.ts`, change the return type:

```ts
export interface InboundRouteResult {
  decision: InboundRouteDecision;
  /** The arrival write, deferred: run it AFTER the response is on the wire. */
  record: (() => Promise<void>) | null;
}
```

`decideInboundRoute` no longer awaits `recordInboundArrival`. It builds the row object and returns `{ decision, record: () => recordInboundArrival(row) }`. Both `ANSWER_BLANK` returns become `{ decision: ANSWER_BLANK, record: null }` for the unclaimed case, and `{ decision: ANSWER_BLANK, record: () => recordInboundArrival(row) }` for the unknown caller (the row is still logged, just later). Keep the doc comment and add one paragraph: *why the write is deferred — the user hears every millisecond of this handler as ring time.*

In `inboundRoute.routes.ts`:

```ts
const inflight = new Set<Promise<void>>();

/** Test seam: resolves once every deferred arrival write has settled. */
export async function flushInboundArrivals(): Promise<void> {
  await Promise.allSettled([...inflight]);
}

// in the handler, replacing :46-47
const { decision, record } = await decideInboundRoute({ fromNumber, toNumber, callId, sessionId });
res.json(decision);
if (record) {
  const p = record()
    .catch((err) => console.error('[inbound] arrival row not written:', err))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}
```

Update every existing caller/test of `decideInboundRoute` to read `.decision` (grep `decideInboundRoute(`).

**Step 4: Run the file**

```
npx vitest run test/inbound-route.test.ts
```
Expected: all pass. The existing "attribution row written" case must now `await flushInboundArrivals()` before asserting.

**Step 5: Commit**

```
git add src/services/inboundRouteDecide.ts src/routes/inboundRoute.routes.ts test/inbound-route.test.ts
git commit -m "Answer the inbound route before writing the arrival row"
```

### Task 2: The settle creates the arrival row when none landed

**Files:**
- Modify: `src/services/campaignInbound.ts:300-327` (`findInboundCall`) and `:51-70`
- Test: `test/inbound-outcome.test.ts`

**Step 1: Failing test**

```ts
it('settles an inbound completion with no arrival row by creating one from the claim', async () => {
  const s = await scenario();
  await prisma.campaignInboundCall.deleteMany({ where: { campaignId: s.campaign.id } });
  await processWebhookEvent(completed({ call: { call_id: 'ic-late', direction: 'inbound',
    from_number: s.contact.phone, to_number: s.did.did, duration_seconds: 42 } }));
  const row = await prisma.campaignInboundCall.findUnique({ where: { upstreamCallId: 'ic-late' } });
  expect(row).not.toBeNull();
  expect(row!.campaignId).toBe(s.campaign.id);
  expect(row!.campaignContactId).toBe(s.cc.id);
  expect(row!.endedAt).not.toBeNull();
});
```

Match the payload builder `completed()` at `:33-44` for the exact envelope shape; read it before writing the case.

**Step 2:** run, expect FAIL (`row` is null).

**Step 3: Implement**

In `settleInboundCall`, when `findInboundCall` returns null and `s.direction` is inbound and `s.toNumber` resolves to a `PhoneNumber` with an `inboundClaim`, create the row: `{ campaignId: claim.campaignId, workspaceId: number.workspaceId, phoneNumberId: number.id, fromNumber: canonical(s.fromNumber), upstreamCallId: s.providerCallId ?? s.callId, upstreamSessionId: s.sessionId, arrivedAt: s.endedAt - durationSecs*1000 }` plus `campaignContactId`/`contactId` from the same lookup `decideInboundRoute` does (extract that lookup into a shared `findCampaignContactByPhone(campaignId, workspaceId, phone)` in `inboundRouteDecide.ts` and import it). Then continue with the normal update path. Log one line: `[inbound] arrival row missing for <id>; created at settle`.

**Step 4:** run `test/inbound-outcome.test.ts test/inbound-correlation.test.ts` green.

**Step 5: Commit** `Create the inbound arrival row at settle when the answer-time write was lost`.

### Task 3: Enrol unknown callers at settle, INBOUND campaigns only

**Files:**
- Modify: `src/services/campaignInbound.ts` (new `enrolInboundCaller`)
- Modify: `test/inbound-route.test.ts:96-108` (the unknown-caller case keeps `contact.count === 0` at answer time — that assertion is still right; add "after settle" cases in outcome test)
- Test: `test/inbound-outcome.test.ts`

**Step 1: Failing tests**

```ts
it('enrols an unknown caller as a settled contact on an INBOUND campaign', async () => {
  const s = await scenario();
  await prisma.campaignInboundCall.create({ data: { campaignId: s.campaign.id, workspaceId: s.ws.id,
    phoneNumberId: s.did.id, fromNumber: '+919900000077', upstreamCallId: 'ic-stranger' } });
  await processWebhookEvent(completed({ call: { call_id: 'ic-stranger', duration_seconds: 20 } }));
  const contact = await prisma.contact.findUnique({ where: { workspaceId_phone: { workspaceId: s.ws.id, phone: '+919900000077' } } });
  expect(contact).not.toBeNull();
  const cc = await prisma.campaignContact.findUnique({ where: { campaignId_contactId: { campaignId: s.campaign.id, contactId: contact!.id } } });
  expect(cc).toMatchObject({ status: 'COMPLETED', disposition: 'completed' });
  const row = await prisma.campaignInboundCall.findUnique({ where: { upstreamCallId: 'ic-stranger' } });
  expect(row!.campaignContactId).toBe(cc!.id);
  const campaign = await prisma.campaign.findUnique({ where: { id: s.campaign.id } });
  expect(campaign!.totalContacts).toBe(s.campaign.totalContacts + 1);
});

it('does not enrol on a BOTH campaign', async () => { /* same, type BOTH, expect contact null */ });
it('is idempotent: a redelivered completion enrols once', async () => { /* process twice, count 1 */ });
```

**Step 2:** run, FAIL.

**Step 3: Implement**

```ts
async function enrolInboundCaller(row: CampaignInboundCall): Promise<string | null> {
  if (row.campaignContactId) return row.campaignContactId;
  const campaign = await prisma.campaign.findUnique({ where: { id: row.campaignId }, select: { type: true, workspaceId: true } });
  if (!campaign || campaign.type !== 'INBOUND') return null;
  const phone = canonicalizeE164(row.fromNumber);
  if (!phone) return null;
  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.upsert({ where: { workspaceId_phone: { workspaceId: campaign.workspaceId, phone } }, create: { workspaceId: campaign.workspaceId, phone }, update: {} });
    const existing = await tx.campaignContact.findUnique({ where: { campaignId_contactId: { campaignId: row.campaignId, contactId: contact.id } } });
    const cc = existing ?? (await tx.campaignContact.create({ data: { campaignId: row.campaignId, contactId: contact.id, status: 'COMPLETED', disposition: 'completed', lastAttemptAt: row.arrivedAt, nextEligibleAt: null } }));
    if (!existing) await tx.campaign.update({ where: { id: row.campaignId }, data: { totalContacts: { increment: 1 }, completedCount: { increment: 1 } } });
    await tx.campaignInboundCall.update({ where: { id: row.id }, data: { campaignContactId: cc.id, contactId: contact.id } });
    return cc.id;
  });
}
```

Call it in `settleInboundCall` right after the row update and before `reBaseNextAttempt`, and feed its result to the goal/re-base calls. Settled `COMPLETED` on purpose: the dispatcher never claims a settled row, and an INBOUND campaign's type is locked after start, so nothing can ever dial an enrolled caller. Write that sentence in the doc comment.

**Step 4:** file green. **Step 5: Commit** `Enrol unknown callers at settle on INBOUND campaigns`.

### Task 4: Inbound aggregates for the list and stats

**Files:**
- Create: `src/lib/campaignInboundStats.ts`
- Modify: `src/lib/campaignOutcomes.ts:277-288` (add `inbound?: CampaignInboundOutcomes` to the type; do NOT compute it there)
- Modify: `src/routes/campaigns.routes.ts:657-670` (list) and `:1870-2046` (stats)
- Test: `test/campaign-stats.test.ts`

**Step 1: Failing tests** (in the list-outcomes describe at :524)

```ts
it('an INBOUND campaign carries outcomes.inbound with calls, callers and talk time', async () => {
  // campaign type INBOUND, two callers: A with 2 calls (30s + 45s), B with 1 call (0s, unknown caller: campaignContactId null)
  // expect outcomes.inbound toEqual({ calls: 3, callers: 2, unknownCalls: 1, talkSecs: 75, lastCallAt: <B's endedAt ISO> })
});
it('an OUTBOUND campaign carries no outcomes.inbound', ...);
it('/stats on an INBOUND campaign carries inbound with credits from the ledger', async () => {
  // one inbound call with costCredits 5000n and a CALL_USAGE ledger row reference = row.id amount -5000
  // expect body.inbound.credits === '0.5'
});
```

**Step 2:** run, FAIL.

**Step 3: Implement** `campaignInboundStats.ts`:

```ts
export interface CampaignInboundOutcomes { calls: number; callers: number; unknownCalls: number; talkSecs: number; lastCallAt: string | null }

export async function inboundOutcomes(campaignIds: readonly string[]): Promise<Record<string, CampaignInboundOutcomes>> {
  if (campaignIds.length === 0) return {};
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; calls: bigint; callers: bigint; unknown_calls: bigint; talk_secs: bigint | null; last_call_at: Date | null }>>`
    SELECT "campaignId",
           COUNT(*)                                            AS calls,
           COUNT(DISTINCT "fromNumber")                        AS callers,
           COUNT(*) FILTER (WHERE "campaignContactId" IS NULL) AS unknown_calls,
           COALESCE(SUM("durationSecs"), 0)                    AS talk_secs,
           MAX(COALESCE("endedAt", "arrivedAt"))               AS last_call_at
    FROM "CampaignInboundCall"
    WHERE "campaignId" IN (${Prisma.join([...campaignIds])})
    GROUP BY "campaignId"`;
  // fold to numbers; ISO string for lastCallAt
}

export async function inboundCredits(campaignId: string): Promise<bigint> {
  const [row] = await prisma.$queryRaw<Array<{ credits: bigint | null }>>`
    SELECT COALESCE(SUM(-t.amount), 0) AS credits
    FROM "CreditTransaction" t
    JOIN "CampaignInboundCall" c ON c.id = t.reference
    WHERE c."campaignId" = ${campaignId} AND t.type = 'CALL_USAGE'`;
  return row?.credits ?? 0n;
}
```

Note the rider: `callers` counts distinct numbers, not contact rows, so an unknown caller counts once. Add an index in a migration: `@@index([campaignId, campaignContactId])` is not needed; the existing `[campaignId, arrivedAt]` covers the scan.

List handler: compute `inboundOutcomes(inboundIds)` for `campaigns.filter(c => isInboundFacing(c.type))` only, and spread `...(inbound[c.id] ? { inbound: inbound[c.id] } : {})` into `outcomes`. Stats handler: for inbound-facing campaigns add `inbound: { ...inboundOutcomes([id])[id] ?? EMPTY, credits: toDisplayCredits(await inboundCredits(id)) }`, else omit the key.

**Step 4:** `npx vitest run test/campaign-stats.test.ts` green. **Step 5: Commit** `Report inbound calls, callers and talk time on the list and stats`.

### Task 5: `GET /campaigns/:cid/inbound-calls`

**Files:**
- Modify: `src/routes/campaigns.routes.ts` (new handler after `/attempts`, ~:2090)
- Modify: `src/lib/campaign.ts` (add `serializeInboundCall`)
- Test: create `test/campaign-inbound-calls.test.ts`

**Step 1: Failing tests** (model on `test/campaign-contacts.test.ts:262` and `:486-492`)

- newest first, `{ items, page, limit, total }` (the `/attempts` shape, via `parsePagination`); each item `{ id, fromNumber, contact: { id, name } | null, arrivedAt, endedAt, durationSecs, disposition, callOutcome, costCredits, upstreamCallId }` with `costCredits` a display string or null and `callOutcome` from `readCallNote(extraction).outcome`.
- `?limit=` capped at 100, `?offset=`.
- MEMBER can read; another workspace's campaign is 404 `NOT_FOUND`; an OUTBOUND campaign answers an empty list (not an error).

**Step 2:** FAIL (404 route). **Step 3:** implement with `parsePagination` (the `/attempts` handler is the template), `campaignInWorkspace` first, `findMany({ where: { campaignId }, orderBy: [{ arrivedAt: 'desc' }, { id: 'desc' }], skip, take })` + `count`, then one `contact.findMany` for the page's `contactId`s to attach `{ id, name }`. **Step 4:** green. **Step 5: Commit** `List a campaign's inbound calls`.

### Task 6: Per-contact inbound summary on the contacts endpoint

**Files:**
- Modify: `src/routes/campaigns.routes.ts:1578-1608`
- Test: `test/campaign-contacts.test.ts`

**Step 1: Failing test:** on an INBOUND campaign, each contact row carries `inbound: { calls, lastCallAt, talkSecs }`; on an OUTBOUND campaign the key is absent.

**Step 3:** one `campaignInboundCall.groupBy({ by: ['campaignContactId'], where: { campaignContactId: { in: pageIds } }, _count: { _all: true }, _sum: { durationSecs: true }, _max: { endedAt: true } })`, only when `isInboundFacing(campaign.type)`. **Step 5: Commit** `Carry an inbound summary on each contact of an inbound campaign`.

### Task 7: Docs

Modify `CLAUDE.md`: the campaigns route table (new row for `/inbound-calls`), a paragraph under the inbound section stating the hot-path rule from Task 1 and the settle-side enrolment from Task 3, and `outcomes.inbound` / `stats.inbound` shapes. Commit `Document the inbound read surface and the hot-path rule`.

**Verify:** `npx tsc --noEmit` and `npx vitest run` (expect only the 17 env-only baseline failures). Push, PR to `main`.

---

## Dashboard

All in `ezo/.worktrees/inbound-campaign-page/ye-voice-dashboard`. Run `npm test -- <file>`.

### Task 8: Types and the type predicate

**Files:**
- Modify: `lib/types.ts` (`CampaignOutcomes.inbound?`, `CampaignStats.inbound?`, `CampaignContact.inbound?`, new `CampaignInboundCall`, `CampaignInboundCallPage`)
- Create: `lib/campaigns/inbound.ts` with `isInboundOnly(campaign: Pick<Campaign,'type'>): boolean` (`type === 'INBOUND'`; undefined reads OUTBOUND per the skew rule)
- Test: `test/campaign-inbound.test.ts`

TDD the predicate (undefined → false, 'INBOUND' → true, 'BOTH' → false). Commit `Add inbound campaign types and predicate`.

### Task 9: List row for an INBOUND campaign

**Files:**
- Modify: `components/campaigns/outcome-cell.tsx:68-116`
- Modify: `app/(dash)/campaigns/page.tsx:256-271`
- Test: `test/campaign-outcome-cell.test.tsx`

Failing tests: given `outcomes.inbound = { calls: 135, callers: 4, ... }` and `type: 'INBOUND'`, `OutcomeCell` renders "135 calls · 4 callers" and no ring; `ProgressCell` renders "Last call <relative>" or "No calls yet"; the Contacts column shows callers; the Retries column shows "Answers on +91…" instead of a retry policy. With `outcomes.inbound` absent on an INBOUND campaign (old backend) render "Not available". Implement `InboundOutcomeCell` in the same file. Commit `Show calls and callers on an inbound campaign's list row`.

### Task 10: Tab set for an INBOUND campaign

**Files:**
- Modify: `app/(dash)/campaigns/[id]/page.tsx:30-43, 101-104, 346-365, 371-441`
- Test: `test/campaigns-url-state.test.tsx`

`TABS` becomes a function of the campaign: INBOUND → `overview | calls | callers | settings`; otherwise unchanged. `?tab=queue` on an INBOUND campaign falls back to `overview`. Failing test first (render page with an INBOUND fixture, assert nav links). Commit `Give inbound campaigns their own tab set`.

### Task 11: Inbound overview tab

**Files:**
- Create: `app/(dash)/campaigns/[id]/inbound-overview-tab.tsx`
- Test: `test/campaign-inbound-overview-tab.test.tsx`

Fetches `/stats`; renders tiles from `stats.inbound`: Calls received, Callers, Talk time (minutes, one decimal), Credits, Last call. `stats.inbound` absent → one line "Inbound figures are not available yet". Reuse the tile components `overview-tab.tsx` already uses (read it first; do not restyle). Commit.

### Task 12: Inbound calls tab

**Files:**
- Create: `app/(dash)/campaigns/[id]/inbound-calls-tab.tsx`
- Test: `test/campaign-inbound-calls-tab.test.tsx`

Paged table over `/inbound-calls?limit=50&page=N` (`?ipage=` in the URL like `?cpage=`): Caller (name or number), When, Duration, Outcome (`callOutcome`), Credits, and a "Call" link to `/calls/${upstreamCallId}` when present. Empty state "No calls received yet". Model the fetch on `contacts-tab.tsx:400-436` including the currency guard. Commit.

### Task 13: Callers tab

**Files:**
- Create: `app/(dash)/campaigns/[id]/inbound-callers-tab.tsx`
- Test: `test/campaign-inbound-callers-tab.test.tsx`

Reads `/contacts?limit=50&offset=…` (same endpoint, now carrying `inbound`). Columns: Caller, Calls, Last call, Talk time, Journey link (reuse the `?contact=` dialog). No status chips, no attempt pips, no next action, no CSV panel. Copy above the table: "Everyone who has called this number. New callers are added automatically after their first call." Commit.

### Task 14: Wire the tabs and hide outbound-only header bits

Modify `page.tsx:280-325` so an INBOUND campaign's header says "N callers" not "N contacts" and the export menu still works. Modify `:371-441` to mount the three new tabs. Run the whole dashboard suite (`npm test`), `npm run lint`, `npm run build`. Commit `Mount the inbound campaign page`.

**Verify:** dashboard PR to `main`, merged only after the backend PR is live.

---

## Out of scope, stated

- Settings tab still shows retry and window sections for INBOUND (they are inert). Follow-up.
- Analytics tab is hidden for INBOUND rather than made inbound-aware. Follow-up.
- Memory write on inbound calls: parked design.
- BOTH campaigns keep outbound rendering; `outcomes.inbound` is computed for them but not shown.
