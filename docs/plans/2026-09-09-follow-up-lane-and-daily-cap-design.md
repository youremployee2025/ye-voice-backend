# Follow-up lane and daily cap — design

_2026-09-09. Agreed with the user in conversation; supersedes the follow-up half of the 2026-09-06 goal-always-on decision._

## Problem

Since the goal-always-on wave, a contact has one dial budget (`retryCount + 1`) and one
wait ladder. A person who answered and had a partial conversation is redialed on the same
minutes ladder as a no-answer, as often as retries allow. The immediate 3-minute resume is
now off (`IMMEDIATE_RESUME_ENABLED`, PR #61), which removed the worst case, but three
irritations remain: follow-ups come too soon, too many times, and too clustered in a day.

## Rules

A contact is in one of two lanes, decided by whether they have ever answered
(`hasSpokenAttempt`).

- **Not yet reached.** Every unanswered dial spends one retry from `retryCount` and waits
  the retry ladder (`retryDelaysMinutes[attempts] ?? cooldownMinutes`). Retries exhausted
  → FAILED. Unchanged from today.
- **Reached.** The first answered call moves the contact into the follow-up lane for good;
  leftover retries are forfeited. Complete conversation or "stop" → settle. Incomplete →
  the next dial spends one follow-up from `maxGoalFollowUps` and waits
  `followUpDelayHours`, rolled into the calling window. **A follow-up that goes unanswered
  also spends a follow-up and waits the same hours.** Follow-ups exhausted → settle with
  `goalAchieved = false`: COMPLETED when the last dial was a conversation, FAILED when it
  was a silence (the existing "what was the LAST dial" rule, kept so the stats tiles do not
  move; both read as "reached, not achieved").
- **Callbacks** the person asked for: unchanged. Booked at the requested time, capped by
  `MAX_CALLBACKS_PER_CONTACT`, exempt from both budgets and from the daily cap.
- **Daily cap.** `maxDialsPerDay` counts placed attempts against a contact in the
  campaign's local calendar day (campaign `timezone`, reset at local midnight), excluding
  CALLBACK arms and never-placed attempts. A contact at the cap is skipped by the claim
  until the next local day. Being capped never settles a contact.
- `maxGoalFollowUps = 0` means a reached-but-incomplete contact settles at once. There is
  no on/off toggle.

Effective per-contact ceiling: `retryCount + maxGoalFollowUps + 1`, plus callbacks. The API
reports that as `maxTotalDials`. `goalEnabled`, the stored `maxTotalDials` column and
`immediateCallbackMinutes` stay inert.

## Settings

| Field | Range | Default | Editable mid-run |
|---|---|---|---|
| `maxGoalFollowUps` (existing column) | 0–15 | 0 for new campaigns; stored value for existing | yes |
| `followUpDelayHours` (existing column) | 1–168 | 24 | yes |
| `maxDialsPerDay` (new column) | 1–10 | 2 | yes |

**The ceiling was raised from 5 to 15 on 2026-09-09**, after the prod audit: the
two live touchbase campaigns were already carrying `followUpCount` up to **14**
under the one-budget rule, so any ceiling below that could not express what they
were doing — and would have stranded the rows already past it, since the claim
refuses an over-budget FOLLOW_UP row and only a PATCH runs the sweep that
settles one. At 15 nothing on those campaigns strands and the deploy needs no
corrective SQL. Everything else about the field is unchanged: it is still
deliberately narrower than `MAX_MAX_TOTAL_DIALS`, which is what keeps it a real
bound rather than a restatement of the dial ceiling.

The operator's settings for those two campaigns are `maxGoalFollowUps = 15`,
`followUpDelayHours = 3`. With `maxDialsPerDay` at its default of 2 the pacing
is two calls a day whatever the budget says; the budget decides when a contact
is finally closed out, which at 15 is roughly eight working days.

New campaigns default `maxGoalFollowUps` to 0 from the dashboard form, so nothing opts a
customer into follow-ups by accident; the Prisma default stays 2 for API callers, matching
the stored value on existing campaigns.

## Backend

- **Schema.** `Campaign.maxDialsPerDay Int @default(2)`. No new index: the daily count is a
  correlated count over `CallAttempt` for one contact.
- **`campaignConfig.ts`.** Un-deprecate `maxGoalFollowUps` (0–15) and `followUpDelayHours`
  (1–168); add `maxDialsPerDay` (1–10). Add all three to `MID_CAMPAIGN_EDITABLE_FIELDS`.
  Serializer keeps answering effective values for the inert three.
- **`dialerOutcome.ts`.** Lane-aware re-arm. Never spoken + unanswered → RETRY branch as
  today. Spoken + any non-terminal outcome → FOLLOW_UP branch: `followUpCount + 1`, wait
  `followUpDelayHours` rolled into the window, allowed only while
  `followUpCount < maxGoalFollowUps`, else settle COMPLETED / goal not achieved. The
  single `budgetSpent` check is replaced by the two lane budgets.
- **`dialerClaim.ts`.** Two predicates beside `dialCap`: (1) an armed FOLLOW_UP row is
  claimable only while `followUpCount < maxGoalFollowUps`; (2) count of placed
  non-CALLBACK attempts with `createdAt >= $dayStart` is below `maxDialsPerDay`. The
  retry-lane predicate `attempts <= retryCount` no longer refuses reached contacts.
  `dayStart` is computed per pass in `dialer.ts` from the campaign timezone beside
  `evaluateWindow` and injected like `now`.
- **Sweeps.** The follow-up budget feeds `settleContactsOverDialBudget` /
  `sweepContactsOverDialBudget`; the daily cap does not.
- **Re-extraction `planRearm`.** A `follow_up_budget` refusal beside `retry_budget`; the
  daily cap is not a refusal.

## Dashboard

- **New-campaign form.** A "Follow-ups" card under the retry policy editor with the three
  fields; the payload sends them explicitly.
- **Settings tab, Pace panel.** The same three fields; `buildMidCampaignUpdatePayload`
  emits ten keys. Locked shape shows them read-only.
- **Copy.** "Resume a dropped call after" stays hidden. The retries'-share hint, queue-tab
  "Dropped calls being resumed" group (kept only when it has rows), overview note and
  journey label are reworded away from the 3-minute resume.
- Client-side range checks mirror the backend.

## Tests

Fixture rule from the always-on wave: set each retired column to a value that would change
the answer if it were read (`maxTotalDials: 99` on a campaign that must stop,
`goalEnabled: false` on one that must follow up).

- Outcome: retry-then-follow-up; unanswered follow-up spends a follow-up; 0 follow-ups
  settles on first incomplete; exhausted → settle by the last dial (COMPLETED after a
  conversation, FAILED after a silence); leftover retries forfeited.
- Claim: over-budget FOLLOW_UP not claimed and settled by the sweep; daily cap skips today,
  claims after local midnight; CALLBACK exempt; day boundary honours a zone west of UTC.
- Config: ranges, defaults, edit gate, serializer.
- Re-extraction: follow-up refusal; daily cap not a refusal.
- Conformance scenario 15: rows for both lanes and the daily cap.
- Dashboard: payload builders, form validation, Pace panel edit and locked render.

## Rollout

Existing campaigns get `maxDialsPerDay = 2` and their stored `maxGoalFollowUps` (mostly 2),
so running campaigns begin following up reached contacts on deploy. Before merging, list
prod campaigns whose stored `maxGoalFollowUps` is non-default for the user. Backend first,
dashboard after.

## Out of scope

Immediate resume stays off. The stored `maxTotalDials` stays inert. Routine-lane ordering
unchanged.
