# Inbound Settings and Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair the four bugs production surfaced on the inbound campaign page on 2026-09-11 (Part 0), then close the two items `feat/inbound-campaign-page` deferred on purpose — the campaign Settings surfaces still offer dialing knobs to a campaign that never dials, and the Analytics tab is hidden for INBOUND rather than answering the questions an inbound campaign raises.

**Architecture:** Three independent pieces, in this order. (1) A backend guard: a RUNNING inbound campaign must refuse a change to the numbers it answers on, because the DID claim is taken once at start and a PATCH would silently leave it pointing at the old number. (2) A backend `inbound` block on the campaign analytics report, read off `CampaignInboundCall` and the credit ledger, present only for inbound-facing campaigns. (3) Dashboard: a new `inbound-analytics-tab.tsx` that renders that block, `analytics` back in `INBOUND_TABS`, and every dialing section removed from the four settings surfaces when the campaign's type says it never dials.

**Tech stack:** Backend — Express, Prisma, Postgres, Vitest, `npm test`. Dashboard — Next.js App Router, React, Tailwind, Vitest + Testing Library, `npx vitest run`.

**Branch:** continue on `feat/inbound-campaign-page` in both repos, worktrees at `ezo/.worktrees/inbound-campaign-page/`. If PRs #77 / #50 have already merged by the time you start, cut `feat/inbound-settings-analytics` from `main` in both repos instead — nothing here depends on unmerged work beyond what those two PRs added.

---

## Context you need before Task 1

Read this section fully. Four facts decide most of the design, and getting any of them wrong produces code that passes its tests and is wrong in production.

### 1. Inbound calls are NOT `CallAttempt` rows

They live in `CampaignInboundCall` (`prisma/schema.prisma:641`). The schema comment above the model says why in full: `CallAttempt`'s invariant — a row exists only for a call the dialer *placed* — is load-bearing for `callTimeline`, for `CampaignContact.attempts` (retries consumed), and for `attemptNo` as the dial mutual-exclusion token. **Do not add inbound calls to `CallAttempt` and do not "fix" analytics by doing so.**

The consequence for this plan: `campaignAnalytics()` (`src/services/analytics.ts:1146`) is built entirely on `CallAttempt` and `CallRecord`. Every figure it produces for an INBOUND campaign — `totals`, `funnel`, `series`, `outcomes`, `dispositions`, `attemptOutcomes`, `dialLadder` — is a truthful zero about dialing and says nothing at all about the calls the campaign actually took. That is why the tab is hidden today.

Columns on `CampaignInboundCall` you will use:

| Column | Meaning |
|---|---|
| `campaignId`, `campaignContactId`, `contactId` | Attribution. The last two are **nullable** — an unknown caller is logged, and enrolled later at settle. |
| `fromNumber` | The caller. This, not `contactId`, is what "a caller" means here. |
| `arrivedAt` | Written by the routing handler. Never null. |
| `endedAt`, `durationSecs`, `disposition` | Written at settle. Null while the call is open. |
| `extraction` | The bot's JSON. `readCallNote(extraction).outcome` reads the conversation verdict out of it. |
| `costCredits` | What the call *owed*. **Never sum this for a spend figure** — see fact 3. |

Index: `@@index([campaignId, arrivedAt])`. Every query you add here must ride it.

### 2. `arrivedAt` is the time column, not `startedAt`

The rest of the analytics service ranges on `startedAt` (`attemptScope`, `recordScope`, `campaignSeries`). `CampaignInboundCall` has no such column. Range on `arrivedAt`, which is stamped when the carrier's routing callback lands — the moment the phone rang. A call that arrives at 23:58 and ends at 00:04 belongs to the first day, which is the reading an operator wants ("when did the phone ring").

### 3. Credits come from the ledger, joined on `reference`, not from `costCredits`

`inboundCredits()` (`src/lib/campaignInboundStats.ts`, added in #77) already does this correctly and documents why: a *shortfall* — a call that completed against a balance too small to cover it — writes `costCredits` but debits nothing, so summing the column overstates spend. An inbound charge carries **no `callAttemptId`**; its `CreditTransaction.reference` is the inbound call's id. That is also why `creditsSpent()` (`analytics.ts:726`), which filters on `callAttempt: attemptScope(...)`, returns `null` for an INBOUND campaign no matter how much it actually spent.

`inboundCredits()` as it stands is **lifetime**, not range-scoped. Task 4 adds the range.

### 4. The DID claim is taken once, at start

`runInboundStart()` (`src/lib/inboundStart.ts:118`) resolves the campaign's numbers and calls `claimInboundDids()`. `releaseInboundClaims()` runs at pause/stop (`campaigns.routes.ts:1119`, `:2620`). **Nothing re-claims on a settings save.** `phoneNumberIds` is in `MID_CAMPAIGN_EDITABLE_FIELDS` (`campaigns.routes.ts:409`) because rotating outbound caller-ID mid-campaign is a legitimate, harmless thing to do — the dispatcher re-reads the list on its next pass.

For an inbound-facing campaign it is neither harmless nor visible: the save succeeds, the stored list changes, `CampaignInboundClaim` still points at the old DID, and the campaign goes on answering a number its settings no longer name while the new number rings through to whatever the platform's default is. Task 1 closes that.

### 5. The draft settings form's type is live-editable

`DraftSettingsForm` holds `type` in form state (`settings-tab.tsx:310`) and renders a `CampaignTypePicker` (`:778`). So the branch for "does this campaign dial" must read **`form.type`, not `campaign.type`**, on that surface — an operator who flips the picker to INBOUND must watch the dialing panels leave immediately, and the payload built on the next render must already have dropped those fields. `campaign.type` is the right source on the mid-campaign, read-only and locked surfaces, where there is no picker.

The same is true of the create page (`app/(dash)/campaigns/new/page.tsx:89`, `:339`).

### 6. The deploy-skew rule

The dashboard ships on Vercel, the backend on Render, and the dashboard is routinely minutes ahead. `CampaignAnalytics.attemptOutcomes` carries a long comment about this: reading a new field as required once threw on `.length` and took the whole campaign page down through the `(dash)` error boundary. **Every new field is optional on the wire, and absent renders as "Not available on this build" — never as zero.** Zero is a claim about the business; absent is a claim about the deploy.

### 7. Which campaigns get the inbound block

`isInboundFacing(type)` is true for `INBOUND` and `BOTH`. `isInboundOnly` (dashboard, `lib/campaigns/inbound.ts`) is true for `INBOUND` alone.

- The backend attaches the `inbound` block when the campaign is **inbound-facing** — a BOTH campaign both dials and answers and needs both halves of the report.
- The dashboard swaps the whole tab only when the campaign is **inbound-only**. A BOTH campaign keeps the dialing analytics tab; the inbound block it receives is unrendered for now, and that is a deliberate deferral, not an oversight. Write it down in the tab.
- The settings trim applies to **inbound-only** campaigns. A BOTH campaign dials and keeps every knob.
---

# Part 0 — Four live bugs on the inbound page

Reported from production on 2026-09-11 against campaign **Dhandha Support Inbound**
(`cmtw11gux0002ru11xsydcuxa`, 137 calls, 4 callers). These outrank Parts A–C: the
page is live and three of the four make it read as broken. Root causes below are
confirmed against `origin/main` (backend `e668286`, dashboard `8af57f6`), not guessed.

## Task 0.1: The journey renders an inbound call as a failed outbound attempt

**The symptom.** Open any caller's journey. Every inbound call reads:

```
Attempt undefined — Conversation          an unreadable time
Lasted 0:46
Dialed from +917969730000.
This outcome is permanent — the retry ladder does not re-arm it.
[spinner, forever]
```

Four wrong things in five lines: no attempt number, no timestamp, "Dialed from"
naming the number that dialed *us*, and a retry-ladder sentence about a call
nobody placed.

**The cause.** `campaignJourney.ts#inboundCallEvent` (backend) emits
`kind: 'inbound_call'`. `components/campaigns/contact-journey.tsx` (dashboard)
handles `cooldown`, `callback_due` and `resume_due`, and then **falls through to
`<AttemptRow attempt={event} />` for everything else** (the bare `return` at
`contact-journey.tsx:661`). An `inbound_call` has no `attemptNo` and no
`startedAt`, so `Attempt ${attempt.attemptNo}` renders `Attempt undefined` and
`clockOf(undefined)` hits the `Number.isNaN` guard at `:110` and renders
`an unreadable time`. The dashboard was never taught the event kind.

**The fix.** An `InboundCallRow` in `contact-journey.tsx`, dispatched on
`event.kind === 'inbound_call'` **before** the fall-through. Its own words:

- Title: `Inbound call — <verdict>`, never "Attempt N". An inbound call has no
  ordinal; it is not a rung on any ladder.
- `Rang from {fromNumber}.` — not "Dialed from". The direction is the whole point
  of the row.
- No retry-ladder sentence. Nothing re-arms an inbound call; there is no dial to
  re-arm.
- `at` is `event.at` (the arrival), which is the field the event actually carries.

**Do not fix this by giving `inbound_call` a synthetic `attemptNo`.** The whole
reason inbound calls are not `CallAttempt` rows is that `attemptNo` is the dial
mutual-exclusion token (see the `CampaignInboundCall` schema comment). A fake
ordinal on the wire would be a lie that spreads.

**Test first**, in `test/campaign-contact-journey.test.tsx` (or wherever the
journey's tests live — find it before writing):

```tsx
it('draws an inbound call as a call received, not as an attempt', async () => {
  render(<ContactJourney {...propsWith({ events: [INBOUND_CALL_EVENT] })} />);

  expect(screen.getByText(/Rang from \+917969730000/)).toBeInTheDocument();
  // The four symptoms, each pinned. A single "renders correctly" assertion
  // would pass again the moment one of them came back.
  expect(screen.queryByText(/Attempt undefined/)).not.toBeInTheDocument();
  expect(screen.queryByText(/an unreadable time/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Dialed from/)).not.toBeInTheDocument();
  expect(screen.queryByText(/retry ladder/)).not.toBeInTheDocument();
});
```

Then a second test asserting an *outbound* attempt in the same timeline still
renders as `Attempt 1` — the fall-through is load-bearing for every other kind
and a branch added in the wrong place would take it out.

## Task 0.2: The journey asks for a recording with an id that cannot resolve

**The symptom.** The spinner in Task 0.1's screenshot never resolves, on every
row, including calls that certainly have audio.

**The cause, and it is a real backend bug — not a consequence of 0.1.**
`serializeInboundCall` (`src/lib/campaign.ts`) was fixed during #77's review and
now sends `upstreamCallId: row.upstreamPhoneCallId`. `inboundCallEvent`
(`src/services/campaignJourney.ts`) was **missed by the same fix** and still sends:

```ts
callId: call.upstreamCallId,                    // the carrier's provider_call_id
hasRecording: call.upstreamCallId !== null,
```

The two events describing one inbound call carry ids from different namespaces —
the routing policy sends only `call.provider_call_id`, `session.completed` sends
`call.call_id = phoneCall.id`. `GET /api/v2/calls/:id` resolves `PhoneCall.id`.
So the journey hands the recording route a carrier id and gets a 404 forever,
and `hasRecording` is `true` for rows whose audio is unreachable.

**The fix**, in `inboundCallEvent`:

```ts
// The id the calls surface resolves is `PhoneCall.id`, which arrives only on
// `session.completed` as `call.call_id`. `upstreamCallId` is the carrier's
// `provider_call_id` from the routing policy — a different namespace, and a
// guaranteed 404 on /calls/:id. serializeInboundCall was fixed for this during
// #77's review; this call site was missed.
callId: call.upstreamPhoneCallId,
hasRecording: call.upstreamPhoneCallId !== null,
```

**Grep for the third one before you commit.** Two of the three call sites had
this bug. Find every reader of `upstreamCallId` and decide, one by one, whether
it wants the carrier id or the platform id:

```bash
grep -rn "upstreamCallId" src/ test/ scripts/ --include=*.ts
```

`CampaignInboundCall.upstreamCallId` is still the right column for **settle
correlation** (the policy callback is the only event that carries it) and the
wrong one for **anything that resolves a call upstream**. Write that sentence
into the schema docstring so the next reader does not have to re-derive it.

**Test:** a backend test asserting the journey event for an inbound call carries
`callId === upstreamPhoneCallId`, and that a row with `upstreamPhoneCallId: null`
reports `hasRecording: false` — the second half is what stops the spinner on a
call whose audio genuinely is unreachable.

## Task 0.3: "Open call" is missing on 135 of 137 rows — the id is in the wrong column

**The symptom.** On the Calls tab only the newest row or two carry an
`Open call` link.

**The cause, and it is better news than it looks.** The tab gates on
`call.upstreamCallId` (`inbound-calls-tab.tsx:245`), which the backend fills from
`upstreamPhoneCallId`. That column is written only by a `session.completed` that
arrived after the `20260911090000_inbound_call_upstream_phone_call_id` deploy —
so every earlier row has it null and renders no link.

But the 135 imported rows **already hold a resolvable id**, in the column nothing
reads any more. `scripts/onboard-inbound-campaign.ts` reads `call_id` from the
platform listing (`:268`), proves it resolves by calling
`getCall(callId)` for the extraction (`:290-291`), and then writes it to
**`upstreamCallId`** (`:372`) — the carrier column — because the import predates
the `upstreamPhoneCallId` split. Every one of those ids is a `PhoneCall.id` that
`GET /api/v2/calls/:id` accepts, and the import proved it call by call.

So this is a column copy, not a re-fetch from the platform.

**The one thing that makes it not a one-line UPDATE.** A row created by the
*routing policy* also has `upstreamCallId` set, and there it is the carrier's
`provider_call_id`. Copying that into `upstreamPhoneCallId` would write a
non-resolving id into the column the **settle dedupe** keys on — a worse bug than
the one being fixed. The rows at risk are the ones settled between the campaign
starting (2026-09-10 21:22 UTC) and the deploy; they look exactly like imported
rows in the data.

**So the backfill verifies before it writes**, which is cheap at this size:

`scripts/backfill-inbound-phone-call-id.ts`
1. Select rows where `upstreamPhoneCallId IS NULL AND upstreamCallId IS NOT NULL`.
2. For each, `getCall(row.upstreamCallId)`.
3. On a resolving id, set `upstreamPhoneCallId = upstreamCallId`. On a 404, leave
   the row alone and count it — those are the policy-created rows whose platform
   id genuinely was never learned, and no amount of copying invents one.
4. `--dry-run` by default, `--production` to apply, printing both counts. Same
   shape as `onboard-inbound-campaign.ts`.

Do not use `arrivedAt < campaign.createdAt` as the discriminator. It is inferable
rather than checkable, it breaks for any campaign whose import window overlaps
its own run, and the verifying read costs one HTTP call per row on a table with
137 of them.

**Fix the import in the same task.** `onboard-inbound-campaign.ts:372` must write
the listing's `call_id` to **both** columns — `upstreamPhoneCallId` because that
is what it is, and `upstreamCallId` because the dedupe at `:313` reads it and a
re-run must still recognise what it already imported. Add a comment saying the
two hold the same value only for an imported row, and why.

**Size it first.** Production read, classifier-blocked from the agent — ask the
operator to run it:

```sql
SELECT count(*)                                                   AS rows,
       count(*) FILTER (WHERE "upstreamPhoneCallId" IS NOT NULL)  AS already_linked,
       count(*) FILTER (WHERE "upstreamPhoneCallId" IS NULL
                          AND "upstreamCallId" IS NOT NULL)       AS backfill_candidates
  FROM "CampaignInboundCall"
 WHERE "campaignId" = 'cmtw11gux0002ru11xsydcuxa';
```

Production answered `already_linked` 1, `backfill_candidates` 136 — confirmed 2026-09-11. A much smaller
candidate count would mean the import did not write the column at all and this
whole task is wrong — check before building.

**Test:** a unit test over the backfill's decision, with `getCall` stubbed to
resolve for one id and 404 for another, asserting exactly one row is written and
the other is left null and counted. That is the whole risk of this task in one
test.

## Task 0.4: "Open call" should open a rail, not navigate away

**The ask, verbatim:** clicking Open call should open a sidebar showing the
transcript and the recording, in place.

**What exists.** `components/calls/call-detail.tsx` and
`test/call-details-rail.test.tsx` — there is already a detail rail in this
codebase. **Read both before designing anything.** If the rail is already a
standalone component that takes a call id, this task is wiring, not building.

**The shape:** the Calls tab keeps its own URL state (`?icall=<id>`), the same
way the campaign page already keys the journey dialog off `?contact=`. A shared
link opens the same call. `Escape` and a backdrop click clear the key.

**Two things to get right:**

1. **The rail must handle the unresolvable row.** Task 0.3 says some rows have no
   id that resolves. The rail opens and says so — it does not spin. That is the
   same bug as 0.2 in a different place, and the reason to build the empty state
   first.
2. **This is the outbound page's problem too.** If the rail is worth having on
   inbound calls it is worth having on the Calls tab everywhere. Do the inbound
   one, note the other in the PR body, and do not silently widen the scope.

## Task 0.5: The credits tile is telling the truth and reading as a lie

**The symptom.** Overview reads `Calls received 137 · Talk time 5h 8m across
every call · Credits 25.9 charged so far`. 5h 8m at any plausible rate is not
25.9 credits, so the tile reads as broken.

**It is not broken.** The two billed calls are 6m45s → 20.25 and 1m53s → 5.65 —
both exactly 3.0 credits/minute at a 1-second increment, which is the campaign
agent's voice tier and nothing to do with the call being inbound. Consistent
across two independent rows, so the arithmetic is right. The other 135 calls
were **billed on the Vocobase platform before YE ever saw them**; they were
imported as history, not charged here. `inbound-calls-tab.tsx:236` already says
this in a comment — the comment is on the wrong surface.

**So do not change the number.** Change what the tile claims:

- `Credits` keeps its figure and its caption becomes `charged by YE`, with a
  sub-line naming the denominator: `1 of 137 calls billed here`.
- `Talk time` keeps `across every call` — it is honest, and it is the *pairing*
  that misleads.
- The count of billable-here calls comes from the same ledger join
  `inboundCredits` already runs; add it as `billedCalls` to the `/stats` inbound
  block rather than deriving it in the browser.

**The rate is not the bug, and it was checked.** `chargeInboundCall`
(`campaignInbound.ts:300-301`) calls the same `resolveCallRate(accountId,
voiceTierSlug)` and `chargeFor(rateCreditsPerMin, durationSecs, incrementSecs)`
that the outbound settle calls at `dialerOutcome.ts:864`, and `chargeFor` does
not branch on direction. 3 credits/minute at a 1-second increment is simply the
agent's voice tier — an outbound call on the same agent bills identically.
Both rows solve to it independently (405s → 20.25, 113s → 5.65), which is what
rules out a rounding artefact. Do not open a pricing investigation off this
tile.

**Test:** a tile test asserting `1 of 137 calls billed here` renders, and that a
campaign where every call was billed here says nothing extra — the sub-line is
for the mixed case and would be noise on a clean one.

## Ordering within Part 0

0.2 then 0.1 (the backend id must be right before the dashboard row is worth
looking at), then 0.3, then 0.5, then 0.4 last — it is the only one of the five
that is a new feature rather than a repair.

Backend deploys before dashboard, as always. 0.2 and 0.5's `billedCalls` are the
backend half; ship them and let Render settle before merging the dashboard.


---

# Part A — Backend

## Task 1: Refuse a number change on a live inbound campaign

The guard from fact 4. Small, independent of everything else, and it is a live data-loss-shaped bug today.

**Files:**
- Modify: `src/routes/campaigns.routes.ts` (the PATCH handler, around `assertEditable` at `:913`)
- Test: `test/campaign-inbound-claim.test.ts`

**Step 1: Write the failing test**

Open `test/campaign-inbound-claim.test.ts` and read the existing setup helpers first — reuse whatever it already has for building a campaign with a claim. Append:

```ts
describe('PATCH phoneNumberIds on an inbound-facing campaign', () => {
  it('refuses the change while the campaign is RUNNING', async () => {
    const { campaign, otherNumberId } = await seedRunningInboundCampaign();

    const res = await request(app)
      .patch(`/api/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}`)
      .set(adminAuth)
      .send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_INBOUND_NUMBERS_LOCKED');

    // The stored list is untouched: a refused save must not half-apply.
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.phoneNumberIds).toEqual(campaign.phoneNumberIds);
  });

  it('allows the same change on an OUTBOUND campaign', async () => {
    const { campaign, otherNumberId } = await seedRunningOutboundCampaign();

    const res = await request(app)
      .patch(`/api/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}`)
      .set(adminAuth)
      .send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(200);
  });

  it('allows the change on a DRAFT inbound campaign', async () => {
    // Nothing is claimed before start, so there is nothing to contradict.
    const { campaign, otherNumberId } = await seedDraftInboundCampaign();

    const res = await request(app)
      .patch(`/api/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}`)
      .set(adminAuth)
      .send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(200);
  });
});
```

Write the three `seed*` helpers against whatever factory the file already uses. If it has none, copy the shape from `test/campaign-inbound-start.test.ts`.

**Step 2: Run it and watch it fail**

```bash
npx vitest run test/campaign-inbound-claim.test.ts -t 'refuses the change'
```

Expected: FAIL — the PATCH returns 200 and the stored list has changed. **If it fails for any other reason, fix the test before writing implementation code.** A test that fails because a helper threw has not tested the guard.

**Step 3: Implement**

In `campaigns.routes.ts`, beside the existing `assertEditable` call in the PATCH handler:

```ts
/**
 * A live inbound campaign answers on the DIDs it claimed at start.
 *
 * `claimInboundDids` runs once, inside `runInboundStart`; `releaseInboundClaims`
 * runs at pause and stop. Nothing re-claims on a settings save. So a PATCH that
 * changed this list would leave `CampaignInboundClaim` pointing at the old
 * number: the campaign goes on answering a DID its own settings no longer name,
 * and the new one rings through to the platform default. The save would succeed
 * and the operator would have no way to see it had not.
 *
 * Refused rather than made to re-claim, because re-claiming mid-call is a
 * different feature: the claim is all-or-nothing across every DID (design
 * §5.1, G5-G6), and taking it again means a window where the campaign answers
 * on neither number. Stop the campaign, change the number, start it again.
 *
 * OUTBOUND is untouched: rotating caller-ID mid-campaign is re-read by the
 * dispatcher on its next pass and contradicts no call already placed, which is
 * why `phoneNumberIds` is in MID_CAMPAIGN_EDITABLE_FIELDS at all.
 */
function assertInboundNumbersUnchanged(campaign: CampaignWithAgent, changed: string[]): void {
  if (!changed.includes('phoneNumberIds')) return;
  if (!isInboundFacing(campaign.type)) return;
  if (!MID_CAMPAIGN_EDITABLE_STATUSES.includes(campaign.status)) return;

  throw new ApiError(
    400,
    'CAMPAIGN_INBOUND_NUMBERS_LOCKED',
    'A campaign that answers calls holds its numbers from the moment it starts. ' +
      'Stop the campaign to change which numbers it answers on, then start it again.',
  );
}
```

Call it immediately after `assertEditable(...)`, so a body that is illegal for two reasons reports the general lock first — the operator's remedy for that one is the same and the message is the one they already know.

**Step 4: Run the tests**

```bash
npx vitest run test/campaign-inbound-claim.test.ts
```

Expected: PASS, all three.

**Step 5: Commit**

```bash
git add src/routes/campaigns.routes.ts test/campaign-inbound-claim.test.ts
git commit -m "Hold an inbound campaign's numbers from the moment it starts

The DID claim is taken once, in runInboundStart, and nothing re-claims on a
settings save — so a mid-campaign phoneNumberIds change left the claim on the
old number and the campaign answering a DID its settings no longer named.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DMAHdpsNRV9LX2xnyo4rvj"
```

---

## Task 2: The inbound daily series

**Files:**
- Modify: `src/lib/campaignInboundStats.ts`
- Test: `test/analytics-service.test.ts`

**Step 1: Write the failing test**

```ts
describe('inboundSeries', () => {
  it('groups by the day the call ARRIVED, not the day it ended', async () => {
    const campaignId = await seedInboundCampaign();
    // Rings 23:58 UTC on the 1st, hangs up 00:04 on the 2nd.
    await seedInboundCall(campaignId, {
      arrivedAt: new Date('2026-03-01T23:58:00Z'),
      endedAt: new Date('2026-03-02T00:04:00Z'),
      durationSecs: 360,
    });

    const rows = await inboundSeries(campaignId, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-03T00:00:00Z'),
    });

    expect(rows.find((r) => r.date === '2026-03-01')).toEqual({
      date: '2026-03-01',
      calls: 1,
      talkSecs: 360,
    });
    expect(rows.find((r) => r.date === '2026-03-02')).toEqual({
      date: '2026-03-02',
      calls: 0,
      talkSecs: 0,
    });
  });

  it('densifies every day in the range, including days with no calls', async () => {
    const campaignId = await seedInboundCampaign();
    await seedInboundCall(campaignId, { arrivedAt: new Date('2026-03-02T10:00:00Z') });

    const rows = await inboundSeries(campaignId, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-03T23:59:59Z'),
    });

    expect(rows.map((r) => r.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('counts an open call and gives it no talk time', async () => {
    // A call still on the line has arrived and has no duration. It is one call
    // and zero seconds — not a call that lasted no time.
    const campaignId = await seedInboundCampaign();
    await seedInboundCall(campaignId, {
      arrivedAt: new Date('2026-03-02T10:00:00Z'),
      endedAt: null,
      durationSecs: null,
    });

    const [day] = await inboundSeries(campaignId, {
      from: new Date('2026-03-02T00:00:00Z'),
      to: new Date('2026-03-02T23:59:59Z'),
    });

    expect(day).toEqual({ date: '2026-03-02', calls: 1, talkSecs: 0 });
  });
});
```

**Step 2: Watch it fail**

```bash
npx vitest run test/analytics-service.test.ts -t inboundSeries
```

Expected: FAIL — `inboundSeries is not a function`.

**Step 3: Implement**

Append to `src/lib/campaignInboundStats.ts`:

```ts
export interface InboundPoint {
  /** `YYYY-MM-DD`, a UTC day — the `AnalyticsPoint` convention. */
  date: string;
  calls: number;
  talkSecs: number;
}

/**
 * Calls received per day, over a range.
 *
 * Grouped on `arrivedAt` and not on `endedAt`: the question a daily bar answers
 * is "when did the phone ring", and a call that arrives at 23:58 and hangs up
 * at 00:04 rang on the first day. `arrivedAt` is also the only one of the two
 * that is never null, so an open call is on the chart rather than missing from
 * it until it settles.
 *
 * Talk time is `COALESCE(SUM(durationSecs), 0)`. A day whose only call is still
 * on the line reads one call and no seconds — the seconds are not yet known,
 * and the chart says so by the call being there with a flat bar beside it.
 *
 * Densified over the whole range, zeros included, for the reason `densify`
 * gives for the outbound series: a chart that omitted its empty days would
 * compress a quiet week into a busy-looking one.
 */
export async function inboundSeries(
  campaignId: string,
  range: { from: Date; to: Date },
): Promise<InboundPoint[]> {
  const rows = await prisma.$queryRaw<Array<{ day: Date; calls: bigint; talk_secs: bigint }>>`
    SELECT date_trunc('day', "arrivedAt")           AS day,
           COUNT(*)::bigint                          AS calls,
           COALESCE(SUM("durationSecs"), 0)::bigint  AS talk_secs
      FROM "CampaignInboundCall"
     WHERE "campaignId" = ${campaignId}
       AND "arrivedAt" >= ${range.from}
       AND "arrivedAt" <= ${range.to}
     GROUP BY 1`;

  const byDay = new Map(
    rows.map((r) => [
      r.day.toISOString().slice(0, 10),
      { calls: Number(r.calls), talkSecs: Number(r.talk_secs) },
    ]),
  );

  const out: InboundPoint[] = [];
  const cursor = new Date(
    Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()),
  );

  while (cursor <= range.to) {
    const date = cursor.toISOString().slice(0, 10);
    out.push({ date, calls: 0, talkSecs: 0, ...byDay.get(date) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}
```

Note `date_trunc` runs in UTC here, matching `campaignSeries`. If you find that `campaignSeries` has since grown an `AT TIME ZONE`, match it exactly rather than leaving two day-boundaries on one page.

**Step 4: Run**

```bash
npx vitest run test/analytics-service.test.ts -t inboundSeries
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/campaignInboundStats.ts test/analytics-service.test.ts
git commit -m "Group a campaign's inbound calls into a daily series

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DMAHdpsNRV9LX2xnyo4rvj"
```

---

## Task 3: The conversation-outcome and repeat-caller breakdowns

Two grouped statements. The first answers "how did these conversations go" off the bot's own verdict; the second answers "is the same person ringing us again".

**Files:**
- Modify: `src/lib/campaignInboundStats.ts`
- Test: `test/analytics-service.test.ts`

**Step 1: Write the failing test**

```ts
describe('inboundOutcomeBreakdown', () => {
  it('counts every outcome the note can carry, zeros included, plus the notes that carry none', async () => {
    const campaignId = await seedInboundCampaign();
    await seedInboundCall(campaignId, { extraction: { call_outcome_vocobaseplatform: 'completed' } });
    await seedInboundCall(campaignId, { extraction: { call_outcome_vocobaseplatform: 'completed' } });
    await seedInboundCall(campaignId, { extraction: { call_outcome_vocobaseplatform: 'stop' } });
    // No extraction at all: the call ended before the bot wrote a note.
    await seedInboundCall(campaignId, { extraction: null });
    // An extraction that is not an object, and an outcome the enum does not know.
    await seedInboundCall(campaignId, { extraction: { call_outcome_vocobaseplatform: 'banana' } });

    const rows = await inboundOutcomeBreakdown(campaignId, WHOLE_RANGE);

    expect(rows).toEqual([
      { outcome: 'incomplete', count: 0 },
      { outcome: 'stop', count: 1 },
      { outcome: 'completed', count: 2 },
      // Unreadable and absent land together: in both cases we do not know how
      // the conversation went, and splitting them would put a bar on the chart
      // about our JSON rather than about the calls.
      { outcome: null, count: 2 },
    ]);
  });
});

describe('inboundRepeatCallers', () => {
  it('buckets callers by how many times they rang', async () => {
    const campaignId = await seedInboundCampaign();
    await seedInboundCall(campaignId, { fromNumber: '+911111111111' });
    await seedInboundCall(campaignId, { fromNumber: '+912222222222' });
    await seedInboundCall(campaignId, { fromNumber: '+912222222222' });
    await seedInboundCall(campaignId, { fromNumber: '+913333333333' });
    await seedInboundCall(campaignId, { fromNumber: '+913333333333' });
    await seedInboundCall(campaignId, { fromNumber: '+913333333333' });

    expect(await inboundRepeatCallers(campaignId, WHOLE_RANGE)).toEqual({
      callers: 3,
      repeatCallers: 2,
      histogram: [
        { calls: 1, callers: 1 },
        { calls: 2, callers: 1 },
        { calls: 3, callers: 1 },
      ],
    });
  });

  it('is empty rather than zero-filled when nobody has rung', async () => {
    const campaignId = await seedInboundCampaign();

    expect(await inboundRepeatCallers(campaignId, WHOLE_RANGE)).toEqual({
      callers: 0,
      repeatCallers: 0,
      histogram: [],
    });
  });
});
```

**Step 2: Watch both fail**

```bash
npx vitest run test/analytics-service.test.ts -t 'inboundOutcomeBreakdown|inboundRepeatCallers'
```

**Step 3: Implement**

Append to `src/lib/campaignInboundStats.ts`. Import `CALL_OUTCOMES` and `CALL_OUTCOME_KEY` from `./extractionConfig.js`.

```ts
export interface InboundOutcomeCount {
  /** `null` is a real bucket: no note, or a note we could not read. */
  outcome: (typeof CALL_OUTCOMES)[number] | null;
  count: number;
}

/**
 * How the conversations went, by the bot's own verdict.
 *
 * Read straight out of the extraction JSON in SQL rather than through
 * `readCallNote` in TypeScript, because this is an aggregate: pulling every
 * row into the process to classify it would make the cost of the chart grow
 * with the campaign's call volume, which is exactly what a chart of a busy
 * campaign must not do. The key is the same constant `readCallNote` reads,
 * so the two cannot drift apart on the name; they can drift on the ENUM, which
 * is why the values are filtered against `CALL_OUTCOMES` here too.
 *
 * Every bucket is present, zeros included — the outcome list's rule: a
 * breakdown that omitted its empty rows would change shape between two
 * readings of one page and hide that a category exists.
 */
export async function inboundOutcomeBreakdown(
  campaignId: string,
  range: { from: Date; to: Date },
): Promise<InboundOutcomeCount[]> {
  const rows = await prisma.$queryRaw<Array<{ outcome: string | null; count: bigint }>>`
    SELECT "extraction" ->> ${CALL_OUTCOME_KEY} AS outcome,
           COUNT(*)::bigint                     AS count
      FROM "CampaignInboundCall"
     WHERE "campaignId" = ${campaignId}
       AND "arrivedAt" >= ${range.from}
       AND "arrivedAt" <= ${range.to}
     GROUP BY 1`;

  const byOutcome = new Map<string | null, number>();
  let unknown = 0;

  for (const row of rows) {
    // An outcome outside the enum is not a new bucket — the platform's value
    // set can grow without either side deploying, and a chart that invented a
    // bar for it would be reporting our vocabulary rather than the calls.
    if (row.outcome !== null && (CALL_OUTCOMES as readonly string[]).includes(row.outcome)) {
      byOutcome.set(row.outcome, Number(row.count));
    } else {
      unknown += Number(row.count);
    }
  }

  return [
    ...CALL_OUTCOMES.map((outcome) => ({ outcome, count: byOutcome.get(outcome) ?? 0 })),
    { outcome: null, count: unknown },
  ];
}

export interface InboundRepeatCallers {
  callers: number;
  /** Callers who rang more than once in this range. */
  repeatCallers: number;
  /** One row per distinct call count, ascending. Empty when nobody rang. */
  histogram: Array<{ calls: number; callers: number }>;
}

/**
 * Whether the same people are ringing back.
 *
 * Keyed on `fromNumber` and not on `contactId`, for `inboundOutcomes`' reason:
 * an unknown caller has no contact row until a settle enrols them, and a
 * stranger who rang three times before that would otherwise be three anonymous
 * calls and no caller at all.
 *
 * Scoped to the range like everything else on this report, which makes
 * `callers` here a smaller number than the lifetime `callers` on the Overview
 * strip. That is not a disagreement — one counts the people who rang this
 * month and the other everyone who has ever rung — and the tab labels its
 * range above the tile.
 */
export async function inboundRepeatCallers(
  campaignId: string,
  range: { from: Date; to: Date },
): Promise<InboundRepeatCallers> {
  const rows = await prisma.$queryRaw<Array<{ calls: bigint; callers: bigint }>>`
    SELECT calls, COUNT(*)::bigint AS callers
      FROM (
        SELECT "fromNumber", COUNT(*)::bigint AS calls
          FROM "CampaignInboundCall"
         WHERE "campaignId" = ${campaignId}
           AND "arrivedAt" >= ${range.from}
           AND "arrivedAt" <= ${range.to}
         GROUP BY "fromNumber"
      ) per_caller
     GROUP BY calls
     ORDER BY calls`;

  const histogram = rows.map((r) => ({ calls: Number(r.calls), callers: Number(r.callers) }));

  return {
    callers: histogram.reduce((sum, row) => sum + row.callers, 0),
    repeatCallers: histogram
      .filter((row) => row.calls > 1)
      .reduce((sum, row) => sum + row.callers, 0),
    histogram,
  };
}
```

**Step 4: Run** — expect PASS.

**Step 5: Commit.**

---

## Task 4: Range-scope the inbound credits

`inboundCredits()` is lifetime. The analytics report is range-scoped, so it needs the range.

**Files:**
- Modify: `src/lib/campaignInboundStats.ts`
- Test: `test/analytics-service.test.ts`

**Step 1: Write the failing test**

```ts
describe('inboundCredits', () => {
  it('counts only charges for calls that arrived in the range', async () => {
    const campaignId = await seedInboundCampaign();
    const inRange = await seedInboundCall(campaignId, { arrivedAt: new Date('2026-03-02T10:00:00Z') });
    const before = await seedInboundCall(campaignId, { arrivedAt: new Date('2026-02-01T10:00:00Z') });
    await seedCallUsage(inRange.id, 30_000n);
    await seedCallUsage(before.id, 90_000n);

    const credits = await inboundCredits(campaignId, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-31T23:59:59Z'),
    });

    expect(credits).toBe(30_000n);
  });

  it('ignores a shortfall — a call that owed credits and was never debited', async () => {
    // costCredits records what was owed; the ledger records what was taken.
    // Only the ledger is spend.
    const campaignId = await seedInboundCampaign();
    await seedInboundCall(campaignId, {
      arrivedAt: new Date('2026-03-02T10:00:00Z'),
      costCredits: 50_000n,
    });

    expect(await inboundCredits(campaignId, MARCH)).toBe(0n);
  });
});
```

**Step 2: Watch it fail** — the current signature takes one argument, so this is a type error first. That counts as a red; fix the signature in step 3, not before.

**Step 3: Implement**

Change the signature to `inboundCredits(campaignId: string, range: { from: Date; to: Date })` and add the two bounds to the `WHERE`:

```sql
WHERE c."campaignId" = ${campaignId}
  AND c."arrivedAt" >= ${range.from}
  AND c."arrivedAt" <= ${range.to}
  AND t.type = 'CALL_USAGE'
```

Update the existing caller in `campaigns.routes.ts` (`/stats`). **`/stats` wants the lifetime figure**, so pass an unbounded range there rather than changing what that endpoint reports — a strip that silently became month-to-date would be a regression in #77's shipped behaviour. Define the sentinel next to the function:

```ts
/** Every call, for the callers that want the campaign's whole life. */
export const ALL_TIME = { from: new Date(0), to: new Date('9999-12-31T23:59:59Z') };
```

**Step 4: Run the whole inbound + stats surface**, because you changed a shipped caller:

```bash
npx vitest run test/analytics-service.test.ts test/campaign-stats.test.ts test/inbound-billing.test.ts
```

Expected: PASS. If `campaign-stats.test.ts` fails, you changed what `/stats` reports — go back to step 3.

**Step 5: Commit.**

---

## Task 5: Attach the `inbound` block to the campaign report

**Files:**
- Modify: `src/services/analytics.ts` (`CampaignReport` at `:390`, `campaignAnalytics` at `:1146`)
- Test: `test/analytics-routes.test.ts`, `test/analytics-service.test.ts`

**Step 1: Write the failing test**

```ts
describe('campaign analytics for an inbound campaign', () => {
  it('carries an inbound block with the calls received', async () => {
    const campaign = await seedInboundCampaign({ type: 'INBOUND' });
    await seedInboundCall(campaign.id, { arrivedAt: MARCH_2, durationSecs: 120 });

    const report = await campaignAnalytics(campaign.workspaceId, campaign.id, MARCH);

    expect(report?.inbound).toMatchObject({
      calls: 1,
      callers: 1,
      talkSecs: 120,
      avgTalkSecs: 120,
    });
    expect(report?.inbound?.series.some((p) => p.date === '2026-03-02' && p.calls === 1)).toBe(true);
  });

  it('carries it on a BOTH campaign too, beside the dialing figures', async () => {
    const campaign = await seedInboundCampaign({ type: 'BOTH' });

    const report = await campaignAnalytics(campaign.workspaceId, campaign.id, MARCH);

    expect(report?.inbound).toBeDefined();
    expect(report?.dialLadder).toBeDefined();
  });

  it('omits it entirely on an OUTBOUND campaign', async () => {
    // Absent, not zeroed: a zero would assert this campaign answers calls and
    // took none, which is a different claim and a false one.
    const campaign = await seedCampaign({ type: 'OUTBOUND' });

    const report = await campaignAnalytics(campaign.workspaceId, campaign.id, MARCH);

    expect(report?.inbound).toBeUndefined();
    expect('inbound' in (report ?? {})).toBe(false);
  });

  it('reports avgTalkSecs as null when no call has a duration yet', async () => {
    const campaign = await seedInboundCampaign({ type: 'INBOUND' });
    await seedInboundCall(campaign.id, { arrivedAt: MARCH_2, durationSecs: null });

    const report = await campaignAnalytics(campaign.workspaceId, campaign.id, MARCH);

    // Not 0. Zero seconds is a call that ended instantly; this is a call whose
    // length we do not know.
    expect(report?.inbound?.avgTalkSecs).toBeNull();
  });
});
```

Add a route-level test in `test/analytics-routes.test.ts` asserting `GET /:workspaceId/campaigns/:campaignId/analytics` puts the block on the JSON body for an INBOUND campaign, and that a MEMBER (not just an ADMIN) can read it — the route is `requireMembership()` with no role floor and must stay that way.

**Step 2: Watch them fail.**

**Step 3: Implement**

Add to `CampaignReport`:

```ts
  /**
   * What this campaign RECEIVED, over the range.
   *
   * Present only when the campaign is inbound-facing, and **absent rather than
   * zeroed** on an OUTBOUND one: a zero here would assert that a campaign which
   * answers calls took none, which is a claim about the business. Absent says
   * the question does not apply.
   *
   * Beside the dialing figures rather than instead of them, because a BOTH
   * campaign does both. On an INBOUND campaign every dialing figure in this
   * report is a truthful zero — there are no `CallAttempt` rows to count — and
   * the dashboard renders this block on its own tab instead of them.
   */
  inbound?: CampaignInboundReport;
```

```ts
export interface CampaignInboundReport {
  calls: number;
  callers: number;
  repeatCallers: number;
  /** Calls with no contact attached at read time. Shrinks as settles enrol. */
  unknownCalls: number;
  talkSecs: number;
  /** Over calls that HAVE a duration; null when none do. */
  avgTalkSecs: number | null;
  /** Decimal string, from the ledger. Null when nothing was charged. */
  creditsSpent: string | null;
  series: InboundPoint[];
  outcomes: InboundOutcomeCount[];
  dispositions: DispositionCount[];
  callerHistogram: Array<{ calls: number; callers: number }>;
}
```

In `campaignAnalytics`, widen the campaign `select` to include `type`, then after the existing `Promise.all`:

```ts
  const inbound = isInboundFacing(campaign.type)
    ? await inboundReportFor(campaignId, range)
    : undefined;
```

Write `inboundReportFor` in `analytics.ts` as one `Promise.all` over the four helpers plus a `dispositions` group and a duration aggregate. Compute `avgTalkSecs` as `talkSecs / callsWithDuration`, `null` when the divisor is zero — the rule `totals.avgDurationSecs` already follows and for the same reason.

Return `...(inbound ? { inbound } : {})` in the report literal, **not** `inbound` — spreading a bare `undefined` key would put `"inbound": undefined` in the object, which `JSON.stringify` drops but `'inbound' in report` does not, and the third test above pins that difference.

**Step 4: Run the analytics suite**

```bash
npx vitest run test/analytics-service.test.ts test/analytics-routes.test.ts test/analytics-isolation.test.ts
```

`analytics-isolation.test.ts` matters: it pins that a report never leaks another workspace's rows. Your new queries are campaign-scoped only — the route has already checked ownership, but every neighbouring query here carries a redundant `workspaceId` filter on purpose ("two independent filters mean a later refactor of that lookup cannot silently widen this query"). `CampaignInboundCall` has a `workspaceId` column. **Add it to all four WHERE clauses** and pass it down from `campaignAnalytics`. Do this now rather than as a follow-up.

**Step 5: Full backend suite, then commit**

```bash
npm test 2>&1 | tail -20 && npx tsc --noEmit
```

Per `ezo-backend-suite-flaky`: roughly one full run in ten fails from cross-file bleed. If something unrelated to your files fails, re-run before believing it.

---

## Task 6: Document the new read surface

**Files:** `CLAUDE.md` (backend), `docs/deploy.md` if it carries an endpoint table.

Add the `inbound` block to whatever section #77 added for `outcomes.inbound` and `/stats.inbound`. State the three rules a reader needs: it is present only for inbound-facing campaigns, it is range-scoped on `arrivedAt`, and its credits come from the ledger. Commit.

---

# Part B — Dashboard: the inbound analytics tab

## Task 7: The wire types

**Files:**
- Modify: `lib/types.ts`
- Test: none of its own — types are pinned by the tab tests.

Add `CampaignInboundReport`, `InboundPoint`, `InboundOutcomeCount` mirroring the backend, and `inbound?: CampaignInboundReport` on `CampaignAnalytics`. **Optional**, with the `attemptOutcomes` docstring's reasoning copied in your own words: the dashboard ships ahead of the backend, absent means this backend does not report it, and the tab must say so rather than draw an empty chart. Commit.

## Task 8: `formatTalkTime` already exists — reuse it

`lib/campaigns/inbound.ts` has `formatTalkTime` and `callOutcomeLabel` from #77. Do not write a second duration formatter in the analytics tab; `analytics-tab.tsx` has its own `duration`/`longDuration` for the outbound page, and a third spelling on one product is how two panels come to disagree about what 3661 seconds is called. If the outbound formatters are the better ones, move them into a shared module and have both tabs read it — but pick one, and say in a comment which and why.

## Task 9: Build `inbound-analytics-tab.tsx`

**Files:**
- Create: `app/(dash)/campaigns/[id]/inbound-analytics-tab.tsx`
- Create: `test/campaign-inbound-analytics-tab.test.tsx`
- Modify: `app/(dash)/campaigns/[id]/page.tsx` (`INBOUND_TABS` at `:53`, the render ternary at `:398`)

Mirror `inbound-overview-tab.tsx` for the fetch/loading/error shape — it is the pattern this wave already established, including the mounted-ref guard and `userMessage(err)` for the failure line.

**Panels, in this order:**

1. **`RangePicker`**, reused from `components/analytics/range-picker`. Same URL key the outbound tab uses, so a shared link means the same thing on both.
   **No `ExportButton`.** The CSV export behind it is `campaignCallsExport.ts`, which reads `CallAttempt` and whose own comment says "Every campaign call this service places is outbound" — it would hand an operator an empty file. Render nothing and put the reason in a comment. Extending the export to inbound calls is a separate piece of work; note it in the PR body as deferred.
2. **Stat tiles** (`components/analytics/stat-tile`): Calls received, Callers, Repeat callers, Talk time, Average call, Credits. `avgTalkSecs: null` renders as an em dash, never `0s`. `creditsSpent: null` renders "No charges in this range", never `0` — the existing tile already has this rule; copy it, do not re-derive it.
3. **Daily calls** — `components/analytics/bar-chart` over `inbound.series`.
4. **How the conversations went** — `Donut` or bars over `inbound.outcomes`, labelled through `callOutcomeLabel`. The `null` bucket is labelled "No note" and is always drawn.
5. **Carrier dispositions** — the same list the outbound tab renders, reusing whatever component it uses.
6. **Repeat callers** — bars over `callerHistogram`, x = "rang N times", y = callers.
7. **`LeadBucketsPanel`** — keep it. Inbound calls count toward buckets and the goal (backend commit `991b087`), so this panel is meaningful and already correct for INBOUND. Do not gate it out.

**The skew case, tested first:**

```tsx
it('says the figures are unavailable when the backend does not send the block', async () => {
  // Absent is a fact about the deploy, not about the campaign. Zero would be a
  // claim that this campaign answered no calls.
  api.mockResolvedValue({ ...ANALYTICS_FIXTURE, inbound: undefined });

  render(<InboundAnalyticsTab {...props} />);

  expect(await screen.findByText(/not available/i)).toBeInTheDocument();
  expect(screen.queryByText('0 calls received')).not.toBeInTheDocument();
});
```

Then a rendering test per panel, then the error path. For the error path, note the trap the previous session hit and left in `test/campaign-inbound-overview-tab.test.tsx`: `api.mockRejectedValue(new Error('boom'))` produces an unhandled rejection that vitest reports as a separate failure. Use `api.mockImplementation(() => { throw new Error('offline'); })`, and give the mocked `ApiError` a real constructor — copy the block from the overview tab's test file.

Then wire it in:

```ts
const INBOUND_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'calls', label: 'Calls' },
  { key: 'callers', label: 'Callers' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'settings', label: 'Settings' },
] as const;
```

and a branch in the render ternary before the existing `tab === 'analytics'` arm:

```tsx
) : tab === 'analytics' && isInboundOnly(campaign) ? (
  <InboundAnalyticsTab key={campaign.id} campaign={campaign} workspaceId={workspaceId!} />
) : tab === 'analytics' ? (
```

Update the `INBOUND_TABS` docstring at `:47` — it currently says an inbound campaign gets "no dial ladder to analyse", which stops being the whole story once the tab is back. Say what the tab now shows instead.

`test/campaigns-url-state.test.tsx` asserts the inbound tab set and the fallback for a dialing tab named in a link. **It will fail** once `analytics` is a legal inbound key. Update it in the same commit and check that `?tab=queue` on an inbound campaign still falls back to Overview.

**Commit** each panel as you finish it; the tab is large enough that one commit would be unreviewable.

---

# Part C — Dashboard: trim the dialing settings

The same edit on four surfaces. Do them one at a time, each with its own test and commit. Read fact 5 again before starting: two of the four branch on live form state and two on the saved campaign.

The shared rule, and the only thing all four must agree on:

```ts
/**
 * Whether this campaign's settings should offer dialing at all.
 *
 * Takes the type as an argument rather than the campaign, because two of the
 * four surfaces that ask are editing a campaign whose type is in a picker on
 * the same screen — and a panel that stayed on `campaign.type` would keep
 * drawing a retry ladder under a picker that now says INBOUND.
 *
 * INBOUND alone. A BOTH campaign dials its list and keeps every knob.
 */
export function dialsCalls(type: CampaignType | undefined): boolean {
  return type !== 'INBOUND';
}
```

Put it in `lib/campaigns/inbound.ts` beside `isInboundOnly`, with a unit test in `test/campaign-inbound.test.ts` covering `'INBOUND'`, `'BOTH'`, `'OUTBOUND'` and `undefined` (the pre-column campaigns — `undefined` dials, matching `isInboundOnly`).

## Task 10: The create page

**Files:** `app/(dash)/campaigns/new/page.tsx`, `test/` (find the create-page test; if none exists, create `test/campaign-create-inbound.test.tsx`)

Hide sections **2. Dialing window**, **3. Calls per contact** and **4. Contacts** when `!dialsCalls(form.type)`. Renumber the remaining headings — a form that jumps from "1." to "4." is a form that looks broken.

Drop `fromTime`, `toTime`, `timezone`, `dialDays`, `defaultCountry`, `concurrencyLimit`, `retryConcurrency`, `retrySharePercent`, `retryCount`, `cooldownMinutes`, `retryDelaysMinutes`, `maxGoalFollowUps`, `followUpDelayHours` and `maxDialsPerDay` from the POST body (`:339`) on the same condition.

**Test the blocking rule too.** Whatever `blocking`/`submitted` validation the page runs, it must not refuse an INBOUND create because of a box that is no longer on screen. Write that test explicitly:

```tsx
it('creates an INBOUND campaign with no dialing settings filled in', async () => {
  // The dialing boxes are gone, so their values are whatever the form was
  // initialised with. A validation that still read them would block a create
  // on a control the operator cannot see.
  ...
  expect(api).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    body: expect.not.objectContaining({ retryCount: expect.anything() }),
  }));
});
```

## Task 11: `DraftSettingsForm`

**Files:** `app/(dash)/campaigns/[id]/settings-tab.tsx:293-1062`, `lib/campaigns/payload.ts:146`, `test/campaign-settings-tab.test.tsx`

Branch on **`form.type`**. Hide the "Dialing window" panel (`:904`) and the `RetryPolicyEditor` (`:942`). Inside "Basics" (`:747`), keep name, description, agent, numbers and the type picker; hide the concurrency controls.

Keep the "Contact fields the agent receives" panel (`:971`). The variable map is how a known caller's fields reach the bot on an inbound answer — `buildInboundVariables` reads it — so it is not a dialing setting.

`buildUpdateCampaignPayload` takes a `DraftSettingsDraft`. Add the branch **inside the builder**, not at the call site: the builder's own comment says it is "the one canonical statement of what this form means", and `useIsDirty` compares its serialized output. If the form hid a panel but the builder still sent the field, Save would stay armed forever on an untouched inbound campaign — the dirty check would see a payload key that never changes but is present, which is harmless, and then a *later* refactor that changed a default would arm Save on load. Put it in one place.

```ts
// A campaign that never dials sends nothing about dialing. Not merely
// cosmetic: these columns would sit in the database describing a schedule
// that governs nothing, and the next reader of that row would believe it.
if (form.type !== 'INBOUND') {
  payload.fromTime = orNull(form.fromTime);
  ...
}
```

Test that flipping the picker from OUTBOUND to INBOUND both removes the panels and shrinks the payload, in one test — that pairing is the behaviour, and two tests would each pass while the pair was broken.

## Task 12: `MidCampaignSettingsForm`

**Files:** `settings-tab.tsx:1085-1533`, `lib/campaigns/payload.ts:212`, `test/campaign-settings-tab.test.tsx`

Every field this form edits is a dialing field, and Task 1 has just locked the one remaining exception. So for an inbound-only campaign this shape has **no form at all**: render the lock strip, `ReadOnlyConfig`, and the lead-buckets card — the same three things the `locked` shape renders, minus the retry-share card.

Route it in `SettingsTab` (`:170`) before the shape ternary:

```tsx
// A running inbound campaign has nothing on this shape left to edit. Its pace
// knobs govern dials it never places, and its numbers are held by the claim it
// took at start (the API refuses a change: CAMPAIGN_INBOUND_NUMBERS_LOCKED).
// Showing the form and letting every save 400 would be worse than showing none.
if (shape === 'mid-campaign' && isInboundOnly(campaign)) { ... }
```

The lock strip needs its own sentence. `LOCK_STRIP_MID` promises the pace stays editable, which is now false here:

```ts
const LOCK_STRIP_INBOUND_LIVE =
  'A campaign that answers calls holds its agent and its numbers from the moment it starts. ' +
  'Stop it to change either, then start it again.';
```

## Task 13: `ReadOnlyConfig` and `LockedConfigCard`

**Files:** `settings-tab.tsx:1536-1746`, `test/campaign-settings-tab.test.tsx`

Branch on `campaign.type` — no picker on these surfaces. `LockedConfigCard` already branches for the numbers label (`:1668`); follow that shape.

Hide the "Calls per contact" panel (`:1547`) and the dialing-window and pace rows in "Configuration" (`:1644`) for INBOUND. Keep agent, numbers, variable map, lead buckets.

Watch the `NOT_SENT` path: `'Not sent by this build'` distinguishes a field an older backend omitted from a field set to nothing. Do not let the inbound branch turn a legitimately-absent value into a hidden row somewhere the reader still needs it — hide the whole row, not the value inside it.

## Task 14: The `tab-settings.test.tsx` and seed tests

`test/campaign-settings-seed.test.tsx` and `test/tab-settings.test.tsx` will have assertions about panels that no longer render for INBOUND fixtures. Run the suite, read each failure, and decide per assertion whether the test encoded the old behaviour (update it) or caught a real regression on OUTBOUND (fix the code). Do not bulk-update.

Per `ezo-stats-parity-wave`: fixtures in this repo have encoded states the engine cannot produce. If a settings fixture is an INBOUND campaign carrying a retry ladder, that is a fixture worth fixing rather than asserting against.

---

# Part D — Verify and ship

## Task 15: Full verification

Backend:

```bash
cd ezo/.worktrees/inbound-campaign-page/ye-voice-backend
npm test 2>&1 | tail -20
npx tsc --noEmit
```

Dashboard:

```bash
cd ezo/.worktrees/inbound-campaign-page/ye-voice-dashboard
npx vitest run 2>&1 | tail -8
npm run lint 2>&1 | tail -8
npm run build 2>&1 | tail -25
```

All four must be clean. `next build` is not optional — it is the only thing that catches a server/client boundary mistake in a new `'use client'` tab.

**Straggler grep** (`ezo-straggler-grep-must-cover-scripts`): `tsc` and `npm test` both stay green while `scripts/` goes stale, because the conformance and battle harnesses assert contracts too.

```bash
grep -rn "inboundCredits\|CampaignReport\|campaignAnalytics" scripts/ test/ --include=*.ts | grep -v node_modules
```

`inboundCredits` changed signature in Task 4. Anything in `scripts/` calling it will compile against the new shape or not at all — check by eye.

**Never run `npm install`** in either worktree (`ezo-lockfile-npm-install-trap`): a macOS install prunes the Linux optional deps and CI's `npm ci` then fails. If a dependency is genuinely missing, stop and ask.

## Task 16: Ship

Push both branches. If #77 and #50 are still open, these commits join them and the PR bodies need updating — move "Settings tab still shows retry and window sections for INBOUND" and "Analytics tab is hidden for INBOUND" out of *Deferred* and into what the PR does.

**Deploy order is backend first, and it is a hard dependency this time**, unlike #77/#50. The dashboard tab renders `inbound` and falls back to "Not available" without it — so shipping the dashboard first is *safe*, but every inbound campaign's Analytics tab reads unavailable until Render catches up. Merging the backend is a production deploy (`ezo-merge-is-prod-deploy`); hand the merge command to the user, it is classifier-blocked from the tool.

**After the backend deploys**, check it against the live campaign rather than a fixture — `ezo-campaign-export-wave` found three bugs that only a run against prod could see:

```
Campaign: Dhandha Support Inbound  cmtw11gux0002ru11xsydcuxa
Workspace: Arvind                  cmth8k9ts0014h83ltfrwpofc
```

It holds 135 imported calls from 4 callers. Open its Analytics tab and check three things:
1. Calls received over a range covering the import matches 135.
2. Repeat callers is 3 or 4 — those 135 calls came from 4 numbers, so almost everyone is a repeat caller. If it reads 0, the histogram is grouping on the wrong column.
3. Credits is **not** null. Inbound calls are charged; a null here means the ledger join found nothing, which would mean the `reference` convention differs from what `inboundCredits` assumes.

## Task 17: Update the memory note

Append to `inbound-campaigns-shipped` in the cpine memory dir what shipped, the `CAMPAIGN_INBOUND_NUMBERS_LOCKED` rule (operators will hit it), and whatever the prod check in Task 16 turned up.

---

## Known deferrals — state these in the PR body, do not silently skip them

- **The calls CSV export is outbound-only.** `campaignCallsExport.ts` reads `CallAttempt`. The inbound analytics tab renders no export button at all rather than an empty one.
- **A BOTH campaign gets the inbound block and does not render it.** Its Analytics tab is still the dialing one. Rendering both halves on one tab is a design question nobody has been asked yet.
- **Inbound calls still do not write the cross-call memory.** Parked since 2026-09-10, unrelated to this plan, and the reason the "Inbound memory write" plan option exists.
- **`inbound.callers` here is range-scoped and the Overview strip's is lifetime.** They will differ on the same screen-load. Both are labelled; if operators still read it as a bug, the fix is to label harder, not to make one of them wrong.
