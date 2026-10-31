# Campaign Stats Parity + Journey Transcripts — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Superseded during review, in two places.** The has-been-dialed predicate
> shipped as `lastAttemptAt IS NOT NULL` rather than the three dial counters
> this plan specifies — see the design document for why — so the task text and
> the test names below that say "all three counters" describe the intermediate
> state, not the code. `hasRecording` also gained a null-duration arm: a null
> is the reaper's `ABANDONED`, not the zero every settle path writes.

**Goal:** Replace the campaign detail page's derived outcome partition with Vocobase's two-panel model, remove every "total dials" figure, and make journey attempt rows expand in place to show their transcript and recording.

**Architecture:** No new endpoint. `/stats` already groups dispositions with no status filter (`campaigns.routes.ts:1489`) — the same query Vocobase runs — and the overview tab already fetches it (`overview-tab.tsx:98`). The page simply stops reading `campaign.outcomes` and reads `stats.byStatus` + `stats.dispositions`. One field is added to `/stats` to split `PENDING` into never-called and between-calls. The journey reuses the existing `CallTranscript` component and `GET /:workspaceId/calls/:callId`.

**Tech Stack:** Express + Prisma + Vitest (backend); Next.js App Router + React + Vitest/RTL (dashboard). Design tokens in `app/globals.css`.

**Worktrees:**
- `.worktrees/campaign-stats-parity/ye-voice-backend` (branch `feat/campaign-stats-parity`, port 3014, dev pg 5451, test pg 5452, redis 6394)
- `.worktrees/campaign-stats-parity/ye-voice-dashboard` (branch `feat/campaign-stats-parity`)

**Before running backend tests the first time in a fresh worktree:** `npm run test:prepare`. Without it every suite fails with `relation "CallRecord" does not exist`.

**The backend suite is known-flaky** — roughly 10% of full runs fail from cross-file bleed. Re-run a failure several times before treating it as real.

**Never run `npm install` on macOS here.** It prunes Linux optional deps and breaks CI's `npm ci`. Use `npm ci`.

Design: `docs/plans/2026-09-04-campaign-stats-parity-design.md`.

---

## Task 1: `/stats` splits PENDING into never-called and between-calls

**Files:**
- Modify: `src/routes/campaigns.routes.ts:1475-1512` (add a query), `:1626-1652` (add to response)
- Test: `test/campaign-stats.test.ts`

**Step 1: Write the failing test**

```ts
it('splits pending into never called and between calls, counting all three counters', async () => {
  const { campaign, workspace } = await seedCampaign({ totalContacts: 0 });

  // Never called: no counter moved.
  await seedContact(campaign.id, { status: 'PENDING' });
  // Between calls, one per counter — each independently proves a dial happened.
  await seedContact(campaign.id, { status: 'PENDING', attempts: 1 });
  await seedContact(campaign.id, { status: 'PENDING', callbackCount: 1 });
  await seedContact(campaign.id, { status: 'PENDING', followUpCount: 1 });

  const res = await get(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/stats`);

  expect(res.body.data.waiting).toEqual({ neverCalled: 1, betweenCalls: 3 });
});
```

`followUpCount` is the one the current code misses: the goal follow-up re-arm
(`dialerOutcome.ts:467`) moves only that counter, so a contact that had a real
conversation reads as never called.

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-stats.test.ts -t 'splits pending'`
Expected: FAIL — `waiting` is undefined.

**Step 3: Add the query**

In the `Promise.all` at `campaigns.routes.ts:1475`, add a fifth entry:

```ts
/**
 * PENDING, split by whether this contact has ever been dialed.
 *
 * All three counters, because each independently proves a dial happened and
 * they move on different paths: `attempts` on a retry, `callbackCount` when
 * somebody asks to be rung back, `followUpCount` on a goal follow-up. The
 * follow-up re-arm deliberately moves neither of the other two, so a
 * two-counter test reports a contact that had a full conversation as one
 * nobody has called.
 */
prisma.campaignContact.count({
  where: {
    campaignId: campaign.id,
    status: 'PENDING',
    OR: [
      { attempts: { gt: 0 } },
      { callbackCount: { gt: 0 } },
      { followUpCount: { gt: 0 } },
    ],
  },
}),
```

Destructure it as `betweenCalls`. Then in the response object:

```ts
waiting: {
  neverCalled: Math.max(0, (byStatus.PENDING ?? 0) - betweenCalls),
  betweenCalls,
},
```

Floored, because the status groupBy and this count are taken at different
instants and a contact that moved between them must not produce a negative.

**Step 4: Run the test**

Run: `npx vitest run test/campaign-stats.test.ts -t 'splits pending'`
Expected: PASS

**Step 5: Commit**

```bash
git add src/routes/campaigns.routes.ts test/campaign-stats.test.ts
git commit -m "Split /stats PENDING into never-called and between-calls"
```

---

## Task 2: `campaignOutcomes` counts a goal follow-up as worked

The campaigns **list** keeps its bar, so this aggregate stays — only its
predicate is wrong.

**Files:**
- Modify: `src/lib/campaignOutcomes.ts:107-115`
- Test: `test/campaign-outcomes.test.ts`

**Step 1: Write the failing test**

```ts
it('counts a contact re-armed for a goal follow-up as in flight, not undialed', async () => {
  const { campaign } = await seedCampaign({});
  // The exact state dialerOutcome.ts:467 leaves behind: status back to
  // PENDING, followUpCount moved, attempts and callbackCount untouched.
  await seedContact(campaign.id, {
    status: 'PENDING',
    attempts: 0,
    callbackCount: 0,
    followUpCount: 1,
    disposition: 'completed',
  });

  const outcomes = await campaignOutcomes([campaign.id]);

  expect(outcomes[campaign.id]).toMatchObject({ inFlight: 1, undialed: 0 });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-outcomes.test.ts -t 'goal follow-up'`
Expected: FAIL — `inFlight: 0, undialed: 1`.

**Step 3: Fix the predicate**

At `campaignOutcomes.ts:112`, replace the `OR` with all three counters and
update the docstring above it:

```ts
/**
 * PENDING contacts that have already been worked.
 *
 * **All three counters are required**, because they move on different paths
 * and any one of them proves a dial happened: `attempts` on a retry,
 * `callbackCount` when somebody asked to be rung back, `followUpCount` on a
 * goal follow-up. The follow-up re-arm (`dialerOutcome.ts:467`) deliberately
 * moves neither of the other two, so a contact that had a real conversation
 * and is queued to be called again matches only that counter — and read
 * without it lands in `undialed`, drawn on the bar as somebody nobody has
 * ever rung.
 */
prisma.campaignContact.groupBy({
  by: ['campaignId'],
  where: {
    ...where,
    status: 'PENDING',
    OR: [
      { attempts: { gt: 0 } },
      { callbackCount: { gt: 0 } },
      { followUpCount: { gt: 0 } },
    ],
  },
  _count: { _all: true },
}),
```

**Step 4: Run the test, then the whole outcomes suite**

Run: `npx vitest run test/campaign-outcomes.test.ts`
Expected: PASS. Existing assertions that pin `undialed` on follow-up fixtures
will need their expectations moved — check each is a fixture change, not a
behaviour regression.

**Step 5: Commit**

```bash
git add src/lib/campaignOutcomes.ts test/campaign-outcomes.test.ts
git commit -m "Count a goal follow-up as worked in the campaign outcome aggregate"
```

---

## Task 3: Dashboard types for `waiting`

**Files:**
- Modify: `lib/types.ts:463-490`

**Step 1: Add the field**

```ts
/**
 * PENDING, split by whether the contact has ever been dialed. Optional
 * because an older backend sends neither half, and absent is not zero.
 */
waiting?: { neverCalled: number; betweenCalls: number };
```

**Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

**Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "Type the /stats waiting split"
```

---

## Task 4: The two panels

**Files:**
- Create: `components/campaigns/contact-placement.tsx`
- Test: `test/campaign-contact-placement.test.tsx`

Two exported components. Neither takes `CampaignOutcomes` — that type is the
partition this work is retiring from the detail page.

**Step 1: Write the failing tests**

```tsx
describe('WhereContactsAre', () => {
  it('separates contacts nobody has called from contacts between calls', () => {
    render(<WhereContactsAre stats={statsFixture({
      byStatus: { PENDING: 461, QUEUED: 7, CALLING: 0, COMPLETED: 30, FAILED: 1, SKIPPED: 0, EXCLUDED: 0 },
      waiting: { neverCalled: 374, betweenCalls: 87 },
    })} />);

    expect(screen.getByRole('term', { name: /not called yet/i })).toBeTruthy();
    expect(screen.getByText('374')).toBeTruthy();
    expect(screen.getByText('87')).toBeTruthy();
  });

  it('falls back to one pending row when the backend sends no split', () => {
    // An older backend. One honest row beats two invented ones.
    render(<WhereContactsAre stats={statsFixture({ byStatus: { PENDING: 461 }, waiting: undefined })} />);

    expect(screen.getByText(/waiting to be called/i)).toBeTruthy();
    expect(screen.queryByText(/between calls/i)).toBeNull();
  });
});

describe('HowCallsLanded', () => {
  it('counts every contact carrying a disposition, not only settled ones', () => {
    render(<HowCallsLanded stats={statsFixture({
      dispositions: { completed: 90, no_answer: 24, voicemail: 4, failed: 1 },
    })} />);

    expect(screen.getByText('90')).toBeTruthy();
  });

  it('says nothing has landed yet rather than rendering an empty list', () => {
    render(<HowCallsLanded stats={statsFixture({ dispositions: {} })} />);

    expect(screen.getByText(/no call has landed yet/i)).toBeTruthy();
  });
});
```

**Step 2: Run and watch fail**

Run: `npx vitest run test/campaign-contact-placement.test.tsx`
Expected: FAIL — module not found.

**Step 3: Implement**

Follow the existing panel idiom in `components/campaigns/` — a `<section>`
with a bordered header and a `<dl>` of rows, tokens only, no new colours.
Rows for `WhereContactsAre`, in journey order:

| Row | Source |
|---|---|
| Not called yet | `waiting.neverCalled` |
| Waiting between calls | `waiting.betweenCalls` |
| On a call now | `byStatus.QUEUED + byStatus.CALLING` |
| Completed | `byStatus.COMPLETED` |
| Failed | `byStatus.FAILED` |
| Skipped | `byStatus.SKIPPED` |
| Removed | `byStatus.EXCLUDED`, only when > 0 |

Caption: *"A contact waiting between calls has already been dialed — it is
cooling down before its next attempt, or waiting on a callback somebody
asked for."*

`HowCallsLanded` renders `DISPOSITION_TIERS` order from
`lib/campaigns/presentation.ts`, dropping zero rows, plus `settledUnknown` as
"Outcome not recorded" when non-zero. Caption: *"One entry per contact, from
its most recent call. Counts every contact that has been dialed, so it does
not sum to the panel beside it."*

**Step 4: Run tests**

Run: `npx vitest run test/campaign-contact-placement.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add components/campaigns/contact-placement.tsx test/campaign-contact-placement.test.tsx
git commit -m "Add the two campaign contact panels"
```

---

## Task 5: Wire the panels in, retire the bar and the dials figure

**Files:**
- Modify: `app/(dash)/campaigns/[id]/overview-tab.tsx:153-270`
- Modify: `components/campaigns/metric-strip.tsx:52-83`
- Test: `test/campaign-overview-tab.test.tsx`, `test/campaign-metric-strip.test.tsx`

**Step 1: Write the failing tests**

```tsx
it('shows no total-dials figure anywhere on the strip', () => {
  render(<MetricStrip campaign={campaignFixture()} outcomes={outcomesFixture()} />);
  expect(screen.queryByText(/dialed/i)).toBeNull();
});

it('has no In flight tile — the contacts panel says it better', () => {
  render(<MetricStrip campaign={campaignFixture()} outcomes={outcomesFixture()} />);
  expect(screen.queryByText(/in flight/i)).toBeNull();
});
```

**Step 2: Run and watch fail**

Run: `npx vitest run test/campaign-metric-strip.test.tsx`
Expected: FAIL — both strings present.

**Step 3: Implement**

In `metric-strip.tsx`: delete the `In flight` `<Figure>` (`:70-74`) and both
`hint` expressions that read `${settled} dialed` (`:59`) and
`${...}% of dialed` (`:66`). Keep `Reached a person` as a bare count. Grid
becomes `sm:grid-cols-3`.

In `overview-tab.tsx`: replace the `OutcomeBar` card (`:197-270`) with
`<WhereContactsAre stats={stats} />` and `<HowCallsLanded stats={stats} />`
side by side. Delete the `outcomes`/`segments`/`dispositions` locals at
`:160-168` and the `outcomeSegments` import.

Leave `components/campaigns/outcome-bar.tsx` and `outcome-cell.tsx` alone —
the campaigns list still uses them.

**Step 4: Run the dashboard suite**

Run: `npm test`
Expected: PASS. `campaign-overview-tab.test.tsx` will have assertions on the
bar; move them onto the panels rather than deleting the coverage.

**Step 5: Commit**

```bash
git add app components test
git commit -m "Replace the campaign outcome bar with the two contact panels"
```

---

## Task 6: Journey rows expand to their transcript and recording

**Files:**
- Modify: `components/campaigns/contact-journey.tsx` (`AttemptRow` `:680`, `Recording` `:792`, `JourneyBody` state `:217`)
- Test: `test/campaign-contact-journey.test.tsx`

**Step 1: Write the failing tests**

```tsx
it('opens an attempt to its transcript when the row is activated', async () => {
  server.use(callDetail({ transcript: { kind: 'turns', turns: [
    { role: 'bot', content: 'Hi, is this Ravi?', timestamp: null },
    { role: 'user', content: 'Speaking.', timestamp: null },
  ] } }));

  render(<ContactJourney {...props} />);
  const row = screen.getByRole('button', { name: /attempt 2/i });
  expect(row).toHaveAttribute('aria-expanded', 'false');

  await userEvent.click(row);

  expect(row).toHaveAttribute('aria-expanded', 'true');
  expect(await screen.findByText('Speaking.')).toBeTruthy();
});

it('fetches a transcript only when the row is opened', async () => {
  render(<ContactJourney {...props} />);
  expect(callDetailRequests).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: /attempt 2/i }));
  expect(callDetailRequests).toHaveLength(1);
});

it('does not fetch again when the same row is reopened', async () => {
  render(<ContactJourney {...props} />);
  const row = screen.getByRole('button', { name: /attempt 2/i });
  await userEvent.click(row);
  await userEvent.click(row);
  await userEvent.click(row);
  expect(callDetailRequests).toHaveLength(1);
});

it('leaves a cooldown marker inert — it has no call to open', () => {
  render(<ContactJourney {...props} />);
  expect(screen.queryByRole('button', { name: /cooldown/i })).toBeNull();
});

it('opens one attempt at a time', async () => {
  render(<ContactJourney {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /attempt 1/i }));
  await userEvent.click(screen.getByRole('button', { name: /attempt 2/i }));
  expect(screen.getByRole('button', { name: /attempt 1/i })).toHaveAttribute('aria-expanded', 'false');
});

it('says a transcript is still coming rather than claiming there is none', async () => {
  server.use(callDetail({ transcript: { kind: 'unavailable', reason: null }, processingComplete: false }));
  render(<ContactJourney {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /attempt 2/i }));
  expect(await screen.findByText(/still being processed/i)).toBeTruthy();
});
```

**Step 2: Run and watch fail**

Run: `npx vitest run test/campaign-contact-journey.test.tsx`
Expected: FAIL — rows are not buttons.

**Step 3: Implement**

- Rename `JourneyBody`'s `player` state to `openAttempt` and keep it
  `number | null`; one open row at a time.
- In `AttemptRow`, wrap the header in a `<button type="button">` with
  `aria-expanded` and `aria-controls`, **only when `attempt.callId` is
  non-null**. Otherwise render the existing static header — a row with
  nothing behind it must not offer an affordance.
- Add a `useCallDetail(workspaceId, callId, open)` hook in the same file:
  fetches `GET /api/workspaces/${workspaceId}/calls/${callId}` on first open,
  caches in a `Map` ref keyed by `callId`, returns
  `{ detail, loading, error }`. Do not refetch on reopen.
- Panel body, in order: the existing `Recording` player (promoted from a
  button to a persistent bar when the panel is open), `<CallTranscript
  transcript={detail.transcript} processingComplete={detail.processingComplete} />`,
  collected extraction values, and the goal verdict already rendered inline.
- Panel is `role="region"` with `aria-labelledby` pointing at the row title id.
- **Guard the cancellation:** the fetch must not set state after unmount or
  after the open row changes. `useCallback`-dropped cancellation guards have
  bitten this codebase before.

**Step 4: Run the suite**

Run: `npx vitest run test/campaign-contact-journey.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add components/campaigns/contact-journey.tsx test/campaign-contact-journey.test.tsx
git commit -m "Open a journey attempt to its transcript and recording in place"
```

---

## Task 7: The rail runs through the open panel

**Files:**
- Modify: `components/campaigns/contact-journey.tsx` (`Row` `:894`)
- Test: `test/campaign-contact-journey.test.tsx`

**Step 1: Write the failing test**

```tsx
it('animates the panel open unless the reader asked for less motion', () => {
  matchMedia.mock('(prefers-reduced-motion: reduce)', true);
  render(<ContactJourney {...props} />);
  const panel = screen.getByRole('region', { name: /attempt 2/i });
  expect(getComputedStyle(panel).transitionDuration).toBe('0s');
});
```

**Step 2: Run and watch fail**

**Step 3: Implement**

- The rail is a single absolutely-positioned 1px column on the row container
  in `--border`, running the full height **including** the expanded panel, so
  the sequence never breaks.
- Typed nodes on the rail: filled disc for a placed attempt (tinted by
  outcome tier), hollow ring for a cooldown, small clock glyph for a callback
  due. Node colours come from the existing `--outcome-*` tokens; add none.
- Expansion is one `grid-template-rows: 0fr → 1fr` transition on a wrapper
  with `overflow: hidden`, 160ms, `ease-out`. Inside
  `@media (prefers-reduced-motion: reduce)`, set `transition: none`.
- Focus ring on the row button uses the existing focus token; the panel is
  not focus-trapped — it is inline content, not a dialog.

**Step 4: Run the suite and check both themes**

Run: `npm test`
Then start the app (`npm run dev`) and check the journey in light and dark.

**Step 5: Commit**

```bash
git add components/campaigns/contact-journey.tsx test/campaign-contact-journey.test.tsx
git commit -m "Run the journey rail through the open attempt panel"
```

---

## Task 8: Full verification

**Step 1: Backend**

```bash
cd .worktrees/campaign-stats-parity/ye-voice-backend
npx tsc --noEmit && npm test
```

Re-run a failure several times before believing it — the suite is flaky.

**Step 2: Dashboard**

```bash
cd .worktrees/campaign-stats-parity/ye-voice-dashboard
npx tsc --noEmit && npm run lint && npm test
```

**Step 3: Straggler grep**

Assertions live in `scripts/` too — `battle-test.ts` and `scripts/conformance/`
pin contracts, and `tsc` and `npm test` both stay green while they go stale.

```bash
grep -rn "inFlight\|In flight\|of dialed\|settledOf" scripts/ src/ ../ye-voice-dashboard/{app,components,lib,scripts} 2>/dev/null
```

Every remaining hit must be either `concurrency.ts`'s line count (correct, keep)
or the campaigns list bar (keep).

**Step 4: Check the lockfiles did not move**

```bash
git status --porcelain   # package-lock.json must not appear
```

**Step 5: Commit and open PRs**

Backend PR first — the dashboard reads `waiting` and degrades to one pending
row without it, but the panels are only fully correct once it ships.

---

## Task 9: A call that never connected does not offer a recording

Observed in production: an attempt that failed at `0:00`, disposition
`failed`, marked *"This outcome is permanent"*, rendered a **Play recording**
link. Clicking it can only 404.

**Files:**
- Modify: `src/services/campaignJourney.ts:336-342`
- Test: `test/campaign-journey.test.ts`

**Step 1: Write the failing test**

```ts
it('offers no recording for a call that never connected', async () => {
  const { campaign, contact } = await seedCampaign({});
  await seedAttempt(contact.id, {
    upstreamCallId: 'call_abc',   // the id exists
    durationSecs: 0,              // but nobody ever spoke
    status: 'FAILED',
    disposition: 'failed',
  });

  const journey = await campaignContactJourney(campaign, contact.id);
  const attempt = journey.events.find((e) => e.kind === 'attempt');

  expect(attempt.hasRecording).toBe(false);
});

it('still offers a recording for a connected call', async () => {
  // ... durationSecs: 42 → hasRecording true
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-journey.test.ts -t 'never connected'`
Expected: FAIL — `true`.

**Step 3: Fix the predicate**

```ts
/**
 * Whether playback is worth offering — an upstream id AND a call that
 * actually carried audio.
 *
 * The id alone is not enough. A launch that was refused, a blocked number
 * and a carrier failure all record an id and zero seconds, and there is no
 * audio of a call nobody had: the route answers 404 and the reader learns
 * that by clicking. A row must not offer what it cannot deliver.
 *
 * Still existence-only and still mints nothing — the authoritative answer is
 * `recordingAvailable` on the call detail, which the expanded panel fetches
 * when somebody actually opens the attempt.
 */
hasRecording: attempt.upstreamCallId !== null && (attempt.durationSecs ?? 0) > 0,
```

**Step 4: Run the test**

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/campaignJourney.ts test/campaign-journey.test.ts
git commit -m "Offer no recording on a call that never connected"
```

**Also worth a look while in there (do not fix blind):** the same screenshot
showed the goal block headed *"Settled with no verdict"* with the subtitle
*"The agent's own verdict, against what its prompt asks for"* on a call that
never connected. A call nobody answered cannot produce a verdict, so framing
its absence as the agent falling short is the wrong fact. Check
`GoalStanding` (`contact-journey.tsx:429`) against a never-connected attempt
and report what it does before changing it.
