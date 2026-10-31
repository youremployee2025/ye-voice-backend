# Review before starting a campaign

Status: built 2026-09-03. Five corrections to the design are recorded inline,
each marked **Built:**.
Spans `ye-voice-backend` and `ye-voice-dashboard`.

## Why

An operator typed a goal into a DRAFT campaign's settings form and pressed
Start. The campaign dialled with no goal: no verdict extraction set on its
agent, no managed block in the agent's prompt, none of the seven goal
variables on any dial. The engine was correct throughout — `hasGoal(updated)`
was false because the goal had never been saved.

`SettingsTab`'s draft form is keyed `` `${campaign.id}:${campaign.status}` ``
and holds the goal in local state. `LifecycleActions` passes `onChanged={load}`,
so Start refetches the campaign, the status flips DRAFT→RUNNING, and the form
remounts — discarding whatever was typed. Nothing in that file tracks dirty
state, so nothing could warn.

The file's own header comment reasoned about this, but only for a transition
somebody else causes:

> a scheduled start fires, or a colleague presses Start — and a form that kept
> its state across that transition would hold edits nothing will ever accept …
> Remounting discards them, which is the honest outcome.

That holds when a colleague starts the campaign. It is wrong when the operator
presses Start themselves, because the edit was saveable a moment earlier.

And the loss is unrecoverable. `goal` is not in `MID_CAMPAIGN_EDITABLE_FIELDS`,
so the server refuses it past DRAFT with `CAMPAIGN_CONFIG_LOCKED`. The campaign
cannot be given a goal for the rest of its life; the operator has to stop it
and build a new one.

## Decisions

1. **Start saves first, then shows a review.** Not a warning and not a block.
   Pressing Start flushes pending settings edits, then opens a review; a
   button there is what actually starts the campaign.
2. **The review is unskippable** for a DRAFT or SCHEDULED campaign. It is the
   only door to `start`.
3. **`resume` is untouched.** `start` and `resume` are separate actions in
   `lifecycleActionsFor`, so gating `start` leaves Resume alone. Scheduled
   starts fire in the sweep with no operator present and are unaffected.
4. **The start checks live on the server**, exposed read-only. A second copy in
   the client would drift from the one that refuses the start.
5. **Config rows only.** No cost estimate. No rendering of the agent-facing
   block.
6. **A goal stays editable while paused only until a verdict exists.**

## The preflight endpoint

`GET /api/campaigns/:id/preflight` — workspace-scoped, read-only.

**Built:** `requireMembership()`, not ADMIN. Reads on this surface are
membership-wide and the campaign detail route beside it already is; a MEMBER
who cannot press Start can still see why it would be refused.

`assertCampaignDialable` in `lib/campaignStart.ts` currently throws on the
first failure. Its predicates become one ordered list, and both callers
consume it: the start path throws on the first blocked entry, the endpoint
reports all of them. This is the whole reason for choosing a server endpoint —
one list, not two.

**Built:** there are **five** local gates, not four. The design missed
`credits`, which is the most actionable of them.

**Built:** `ensureCallerNumberReady` is excluded, and not only because a
preview should be cheap: it *makes* a DID usable rather than asking whether it
is. A read-only preview must not write to a partner account every customer
shares. So a start can still be refused after a clean report, and the review
screen shows that refusal rather than pretending it cannot happen.

The predicates, unchanged in meaning:

| key | blocked when |
|---|---|
| `dialer` | `env.dialerEnabled` is false |
| `caller_number` | no `phoneNumber`, or it is not usable in this workspace |
| `dialing_window` | the window is `incomplete` |
| `voice_tier` | the agent's tier has no resolvable rate |
| `credits` | the owner cannot cover `dialerMinBalanceCredits` |

Response:

```json
{
  "ok": false,
  "checks": [
    { "key": "caller_number", "status": "blocked",
      "label": "Caller number", "detail": "No usable number is attached.",
      "fixHref": "/campaigns/<id>?tab=settings" }
  ]
}
```

`status` is `ok` or `blocked`. There is no `warning` tier: a campaign either
starts or it does not, and a third state would be a row nobody knows what to
do with.

The endpoint does not report an absent goal as blocked — a campaign without a
goal is a legitimate plain campaign. The review shows the goal row empty, which
is what makes the omission visible.

## Goal editable while paused

`goal` joins `MID_CAMPAIGN_EDITABLE_FIELDS`, gated on no goal verdict having
been recorded for the campaign yet.

The narrow rule rather than a blanket one, because the DRAFT-only restriction
was deliberate: what the goal *is* changes the meaning of every verdict already
judged against it. A campaign that has been judging against real words stays
locked. A campaign started without a goal has no verdicts at all — its agent
never carried the extraction set — so it recovers, which is the case this is
for.

The check is one `count` on the goal-record table, in the same edit gate that
already refuses locked fields.

## The review page

Route `app/(dash)/campaigns/[id]/start/page.tsx` — a real route rather than a
modal, so browser Back works and the layout gets a full page.

Rows, in the order an operator checks them: Goal, Agent, Contacts ready,
Dialing window, Caller number, Calls at once. Blocked checks are grouped above
the rows with their fix link. `Start campaign` is disabled while `ok` is false,
with the reason stated beside it rather than as a tooltip.

An empty goal renders as a stated absence — "No goal. This campaign will not
pursue one." — not as a blank. That sentence is what would have caught the bug.

## The save-then-start handoff

**Built:** the dashboard already has an unsaved-work system — `useUnsavedGuard`
and `hasUnsavedWork` in `lib/unsaved.ts`, plus `useDirtyForm` — and the campaign
settings tab was not among its users. That absence is the underlying gap. The
guard intercepts anchors, though, and Start is a button, so it would not have
caught this even had the tab adopted it; the explicit handoff below is still
what this needs. Adopting the guard for the tab's other exits is worth doing
and is not in this change.

**Built:** the review reports a start refusal through `lifecycleMessage`, not
`userMessage`. The upstream readiness step has seven distinct customer-facing
sentences that the API writes itself, and `userMessage` passes a code's own
message through only for a short allow-list. A test caught this: without it an
operator would read "Could not start this campaign" in place of the one line
telling them what to do about it.

`SettingsTab` gains one prop: a registration callback for a `saveIfDirty()`
function it owns. `page.tsx` keeps it in a ref. Start awaits it before
navigating.

An imperative handle rather than lifting 1163 lines of form state into the
page, which would be a refactor with its own risk and no other beneficiary.

- Settings tab not mounted → nothing registered → nothing to flush.
- Save rejects on validation → **do not navigate.** Switch to the Settings tab
  and show the error where the offending field is.
- Save fails on the network → same: stay put, report it.

## Testing

Backend: the predicate list is shared, so a test asserts the endpoint reports
exactly what the start path refuses, for each of the four. The goal-edit gate
gets a test either side of a recorded verdict.

Dashboard: Start with a dirty goal field saves before navigating; a save that
400s does not navigate; a blocked preflight disables the start button; an empty
goal renders the stated absence.

## Not in this change

Cost estimation. The agent-facing block preview. Any change to `resume`,
to scheduled starts, or to what `assertCampaignDialable` actually checks.
