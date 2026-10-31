# Campaign stats parity + journey transcripts — design

_2026-09-04. Spans `ye-voice-backend` and `ye-voice-dashboard`._

## Why

A campaign showing "In flight 27" beside a banner saying "using its 7
simultaneous calls" sent an operator looking for a fault. There is no fault.
The two numbers are computed from different tables and mean different things,
and the tile's number is additionally wrong.

Measured on staging (`September Touchbase Assisted Sales`, 500 contacts):

| Page said | Truth |
|---|---|
| 30 dialed | 126 contacts have a `CallAttempt` |
| 30 reached a person | 90 contacts carry `disposition='completed'` |
| In flight 41 | 7 on a call, 87 mid-journey |
| Not dialed yet 429 | 374 — 54 had a conversation |

Two causes, both in `lib/campaignOutcomes.ts`:

1. **Line 112 tests the wrong counter.** It asks `attempts > 0 OR
   callbackCount > 0`. The goal follow-up re-arm (`dialerOutcome.ts:467`)
   moves only `followUpCount`, so a contact that had a real conversation
   matches neither arm and lands in `undialed`. The dialer's own predicates
   (`dialerClaim.ts` `NEVER_CALLED`, `concurrency.ts:113`) use `followUpCount`.
2. **`settledOf()` is the denominator for "N dialed" and "% of dialed"**, and
   it counts only settled contacts. On a goal campaign every conversation
   re-arms the contact to `PENDING`, so success removes itself from the
   denominator. The better the campaign performs, the worse it reads.

Webhooks were investigated and cleared: `WebhookEvent` holds 327
`session.completed:*` rows and **zero** `reconcile:*` rows, so the reaper has
never once recovered a missed delivery. The `session.completed` timeouts
visible in Axiom belong to a second endpoint registered on the shared partner
account (a Google Apps Script), which is the only subscriber YE does not
share `call.status.updated` with — and that event has zero failures.

## Reference: what Vocobase does

`backend/src/routes/campaign.routes.ts:515` returns raw status counts
(`queued`, `inProgress`, `completed`, `failed`, `skipped`) and groups
dispositions with **no status filter**:

```ts
prisma.campaignContact.groupBy({
  by: ['disposition'],
  where: { campaignId: id, disposition: { not: null } },
})
```

`frontend/components/campaigns/campaign-overview.tsx` renders that as two
panels that deliberately do not sum — *"Where contacts are"* and *"How the
last call landed"* — under one clarifying line: *"A contact waiting out a
retry cooldown is counted as queued."*

There is no derived partition and no "in flight" anywhere.

## Decision

Adopt the two-panel model. Stop trying to make one bar partition the roster.

**YE's `/stats` already matches Vocobase.** `campaigns.routes.ts:1489` groups
dispositions with no status filter, and `byStatus` is the zero-filled status
count. The detail page fetches `/stats` at `overview-tab.tsx:98` and then
ignores both, reading `campaign.outcomes` instead — a deliberate choice
recorded at `campaigns.routes.ts:640`, made because `/stats` does not
partition and the bar needed it to.

Dropping the bar removes that requirement, so the page reads the numbers it
already has.

### Backend — one addition

Split `PENDING` in `/stats`, using the three-counter test:

```ts
waiting: { neverCalled: number, betweenCalls: number }
// betweenCalls: attempts > 0 OR callbackCount > 0 OR followUpCount > 0
```

All three counters, because each independently proves a dial happened.
Cross-checked on staging: the three-counter test and `disposition IS NOT NULL`
both return 87, against the current code's 33.

`campaignOutcomes.ts:112` is separately corrected to the same predicate — the
campaigns **list** still draws its bar from that aggregate.

> **Superseded during review.** The predicate shipped as
> `lastAttemptAt IS NOT NULL` (`HAS_BEEN_DIALED_SQL`), not the three counters.
> None of the counters moves on the four paths that hand a claimed contact back
> to PENDING — a failed attempt insert and `rollbackLaunch` (`dialer.ts`),
> `releaseStaleClaims` (`dialerReaper.ts`), `giveBack`
> (`dialerPlacement.ts`) — so after a rate-limited sweep the counter reading
> called work already in hand work nobody had started, while the analytics
> funnel and the bucket panel, which read `lastAttemptAt`, called the same
> contacts dialled. One column, one answer, on all four surfaces.

### Dashboard

- Two panels, replacing `OutcomeBar` on the detail page.
  - *Where contacts are*: Not called yet · Waiting between calls · On a call
    now · Completed · Failed · Skipped.
  - *How calls landed*: dispositions over every contact carrying one.
  - Captions state that the panels answer different questions.
- Going further than Vocobase on purpose: they fold cooldowns into "queued"
  and footnote it. Splitting never-called from between-calls is the exact
  distinction that caused this investigation, so the panel encodes it.
- `MetricStrip` loses the `N dialed` hint entirely and the *In flight* tile.
  Becomes Contacts · Reached a person · Projected finish.

## Journey: inline transcript and recording

Everything needed exists. `JourneyAttempt` carries `callId`, `hasRecording`,
`sessionId`, `durationSecs` and the goal verdict. `GET
/:workspaceId/calls/:callId` returns `transcript`, `extraction`,
`recordingAvailable` and `processingComplete`. `components/calls/transcript.tsx`
already renders the transcript union and distinguishes four different
absences — which is what a ladder full of `no_answer` needs.

- Only attempt rows with a `callId` are interactive. Cooldown and
  callback-due markers have nothing to open and stay inert rather than
  rendering an affordance that promises a fact they do not have.
- Row header becomes a `<button>` with `aria-expanded`/`aria-controls`; the
  panel is a `role="region"` labelled by the row title.
- Single-open accordion, reusing the existing `player` state
  (`contact-journey.tsx:684`, renamed `openAttempt`), so transcript and audio
  stop being two separate toggles.
- Call detail fetched **on expand only** and cached per attempt — the
  laziness the recording token already uses, and the reason the journey route
  mints no tokens up front.
- Panel contents: player bar, transcript, collected extraction values, goal
  verdict.

**The rail runs through the open panel rather than stopping at it.** A journey
is one thread with pauses; breaking the line to show a transcript would say
these were separate events. Typed nodes carry the meaning — filled for a call
placed, hollow for a wait, clock for a promise. Numbering is legitimate here
because the sequence genuinely is the information.

Motion is one `grid-template-rows` 0fr→1fr transition, disabled under
`prefers-reduced-motion`.

## Out of scope

- Renaming `concurrency.ts`'s `IN_FLIGHT`. It mirrors the platform's own
  `statuses_counted` and a divergence there means the local cap and the remote
  ceiling count different calls.
- The campaigns list bar. It keeps its partition; only the predicate is fixed.
- Total dials. Deliberately not shown anywhere.
