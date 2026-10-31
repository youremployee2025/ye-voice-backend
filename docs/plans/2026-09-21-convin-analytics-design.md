# Convin-style lead-centric analytics

**Status:** design agreed 2026-09-21. Not built.
**Repos:** `ye-voice-backend`, `ye-voice-dashboard` (branch `feat/convin-analytics`).

## What this is

Rebuild `/analytics` in the dashboard to match the shape of Convin Sense's
Analytics page (`activate.convin.ai/tenant/ezo/analytics`), read live on
2026-09-18 against the `ezo` tenant.

The decisive difference from what we have: **Convin counts leads, we count
calls.** `AnalyticsTotals.calls` is one row per dial. Convin's "Attempted Leads
7,809 / Connected Leads 2,912" is one row per contact. That is not a restyle —
it is a different denominator in every widget, and it needs new backend
endpoints.

## The reference, as observed

A shared filter card above four tabs. The filter defers until an explicit
**Apply Filters** — nothing refetches on each control.

| Control | Observed value |
|---|---|
| Campaigns | All Campaigns |
| Campaign Status | Active |
| Interaction Activity | Yesterday |
| Lead State | All States |
| Channel | All Channels |
| Lead Created From / Until | empty |

**Two independent date dimensions.** *Interaction Activity* windows when calls
happened; *Lead Created From/Until* windows when the contact entered. Conflating
them is the easiest way to get this wrong, so the contract carries both.

### Tabs

- **Outcome** — 4 tiles (Attempted Leads, Connected Leads, % Goal Achieved,
  % Interested Leads) → 2 bar charts (Lead State, Goal Achieved) → 2 donuts
  (Lead Qualification Status, Lead Interest Status).
- **Activity** — 4 tiles (Attempted, Connected, Lead Connectivity, Avg Talk
  Time) → Channel Activity table → AI Call Activity by Caller ID (paginated, 35
  caller IDs) → Best Time to Connect weekly heatmap → WhatsApp sections.
- **Spend** — 4 cost tiles (Total Spend, Cost/Connected Lead, Cost/Goal
  Achieved Lead, Cost/Interested Lead) → 4 pulse tiles → Spend per Channel,
  Spend by Lead Interest, Spend Timeline.
- **Reports** — 7 CSV downloads.

## What we build, and what we drop

| Widget | Source | Pools across campaigns? |
|---|---|---|
| Attempted / Connected Leads | `CampaignContact` + reached-attempt predicate | yes |
| Lead State bar | `CampaignContact.status` | yes — enum |
| Goal Achieved bar, % tile | `CampaignContact.goalAchieved` | yes — boolean |
| Qualification donut | `goalAchieved` × `status` | yes — derived |
| **Interest donut** | `campaignLeadBuckets(allCampaigns)` folded on name | **no — see below** |
| Caller ID table | `CallAttempt.fromNumber` grouped | yes |
| Best Time to Connect | `startedAt` / `answeredAt` → dow × hour | yes |
| Spend tiles, timeline | `CallAttempt.costCredits` | yes |

**Dropped — no data behind them.** Channel Activity table, both WhatsApp
sections, the four pulse tiles, Spend per Channel. YE is one channel with one
cost type; each of those renders as a single row or a single bar and says
nothing.

## The one contested decision: the pooled Interest donut

`Campaign.leadBucketKey` is a **per-campaign** extraction key and `wonBuckets`
is free text, computed at read time. Campaign A may bucket on `interest_level`,
campaign B on `gbp_work_status`. Summing them adds unlike things.

The existing `/analytics` page forbids this in its header comment, and Convin's
own page demonstrates why: their *Spend by Lead Interest* chart pools extraction
keys across campaigns and renders ~50 chips — `qualified 2.3%`,
`not interested in gbp work 2.6%`, `yes 35.0%`, `hidden_workdone 0.0%`,
`three 0.0%`, `zero 0.0%` — with ₹-labels overlapping into an unreadable smear.

**Decision (operator, 2026-09-21): pool anyway, matching Convin.** The concern
was raised and the call was reaffirmed.

Implementation keeps the decision without reproducing the rendering failure:
`campaignLeadBuckets` already caps at `MAX_REPORTED_BUCKETS = 40` and returns a
`truncated` flag, and already folds names case-insensitively across both
`CallAttempt` and `CampaignInboundCall`. The pooled donut sums those per-campaign
maps on the folded name, renders the top values, folds the long tail into
`Other` behind a disclosure, and names how many distinct keys fed it.

A reader who wants an honest single-key reading filters to one campaign, which
yields exactly Convin's view.

## Backend contract

Four endpoints — one per tab, not one fat payload. Convin loads each tab
independently (each had its own spinner) and Outcome alone took ~30s there;
tab-scoped queries keep any one of them cancellable.

```
GET /:workspaceId/analytics/leads/outcome
GET /:workspaceId/analytics/leads/activity
GET /:workspaceId/analytics/leads/spend
    Reports reuses the existing /:workspaceId/analytics/export
```

Shared query params on all three: `days` | `from`+`to`, `campaign[]`,
`campaignStatus`, `leadState`, `leadCreatedFrom`, `leadCreatedUntil`.

Rules carried over from the existing page, non-negotiable:

- A rate with a zero denominator is `null`, never `0%`.
- A failed read is never rendered as a measurement.
- `metered` is read from the payload, never assumed.

## Dashboard structure

```
app/(dash)/analytics/
  page.tsx           shell: filter card + tab bar + suspense
  outcome-tab.tsx
  activity-tab.tsx
  spend-tab.tsx
  reports-tab.tsx
```

Tab lives in the URL (`?tab=activity`), same reasoning the current page applies
to `?campaign=`: a filtered view is worth linking to.

**New components** (`components/analytics/`): `filter-card.tsx`, `tab-bar.tsx`,
`metric-tile.tsx` (Convin-weight variant over `StatTile`), `chart-card.tsx`,
`caller-id-table.tsx`, `weekly-heatmap.tsx`.

**Reused as-is:** `donut.tsx`, `bar-chart.tsx`, `delta-pill.tsx`, `legend.tsx`,
`campaign-filter.tsx`, `range-picker.tsx`, `export-button.tsx`,
`lib/analytics-palette.ts`.

`StatTile` already carries the icon chip, accent slot, delta pill, note and the
null branch — Convin's tile is the same anatomy in a heavier layout (40px chip
top-right, larger numeral, delta inline). A variant, not a rewrite.

## Build order

Backend first; the dashboard cannot be verified against stubs.

1. `leadAnalytics.ts` service + 3 routes + tests → backend PR
2. Dashboard shell + Outcome tab
3. Activity + Spend tabs
4. Reports tab (cheapest — re-skins the existing export)

## What this replaces

The current call-centric `/analytics` — calls per day, outcomes donut,
campaigns table — has no home in Convin's four tabs. The campaigns table moves
onto the Outcome tab (Convin has no equivalent, but dropping it loses
per-campaign drill-down). Calls-per-day goes; Spend Timeline covers the shape.

## Known issue, deliberately out of scope

On production, the campaign filter on `/analytics` shows **"This workspace has
no campaigns yet"** on a workspace rendering 12,420 calls and 16,948 credits.

Investigation reached two live hypotheses and stopped there:

- **H1** — the `/api/workspaces/:id/campaigns` read failed and
  `page.tsx:276-278` swallowed it: `catch { setCampaigns([]) }`, commented *"An
  empty list, so the control renders and says the workspace has none."* The list
  route is heavy — full `CAMPAIGN_INCLUDE`, `_count.contacts`,
  `campaignOutcomes`, and `campaignLeadBuckets` raw SQL over every attempt's
  extraction JSON — so a timeout is plausible.
- **H2** — the read returned `[]` honestly and every one of those calls arrived
  through the platform sync rather than an YE campaign.

Circumstantial support for H1: `sources` is a required field the backend always
emits (`analytics.ts:1103`), and the screenshot shows no "N campaign calls … and
N other calls" line, which happens when `otherCalls === 0` — every call being a
campaign call. Campaign calls with no campaigns is contradictory. The inference
dies if production runs a backend old enough to omit `sources`, so it is not
proven.

Not proven, not fixed. Deciding evidence is the status of
`GET /api/workspaces/…/campaigns` on that page.

Separately and regardless of which hypothesis wins: rendering a failed read as
the assertion "this workspace has no campaigns" is the exact failure the page's
header comment forbids. `CampaignFilter` has no error state to render — it takes
only `campaigns` and `loading`. Worth fixing on its own, with a test.
