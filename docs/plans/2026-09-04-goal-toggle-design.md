# The goal becomes a switch

Base: `main` @ b814f2d. Dashboard base: `main` @ 3682287.
Supersedes the *Goal text* decision in `2026-09-03-call-note-design.md`, which
says `Campaign.goal` stays the on-switch, and the "the goal is prose" and
DRAFT-only-editing decisions in `2026-09-02-goal-verdict-design.md`. Both carry
a banner pointing here.

`Campaign.goal` is prose an operator writes, and YE stops sending it to the
model in the call-note release: `GOAL_VARIABLE_NAMES` is one variable and
conformance G1 asserts the goal must not reach a dial. What the column actually
does now is answer one question — `hasGoal()`, non-blank — so it is a boolean
wearing a paragraph.

That is worse than untidy. A field an operator writes into, which the panel
implies the agent reads, and which nothing sends, teaches the wrong model of the
product: the objective lives in the agent's own prompt and always did after the
swap. This replaces the prose with the switch it already was.

## Decisions

| | |
|---|---|
| **Switch** | New `Campaign.goalEnabled Boolean @default(false)`. |
| **The prose** | `Campaign.goal` stays one release: not read, not sent, not shown. Dropped later, once nobody misses it. |
| **Editability** | Like the four knobs it gates: PAUSED and CREDIT_EXHAUSTED, not DRAFT-only as the text was. Never on RUNNING — no config field is. |
| **Vocabulary** | `goalEnabled` in schema and code; the whole `goal*` family already speaks it and renaming a Prisma column family is the migration `tsc` cannot prove finished. |
| **Label** | Panel stays *Campaign Goal*; the toggle reads *Follow up until the conversation is complete*. |

## Why the DRAFT lock goes

The goal was locked after DRAFT because every recorded `goalAchieved`, every
follow-up armed or not, was judged against the words standing at the time, and
editing them rewrote what that history claimed. A boolean has no words, so the
rationale does not survive it. What is left is ordinary dispatcher policy, which
the next claim re-reads — the same argument that already puts `maxTotalDials`
and the retry ladder in `MID_CAMPAIGN_EDITABLE_FIELDS`.

The `goalRecoverable` allowance and its `CampaignContactGoal` count go with it.

## The attach

`prepareCampaignAgent` attaches the managed extraction set and writes the prompt
block, and it runs **only on a start or resume transition**. The PATCH therefore
calls it itself when `goalEnabled` or `callbackEnabled` goes false to true.

**Corrected during implementation.** This section first claimed a live bug: that
a toggle flipped on a RUNNING campaign would leave the agent unprepared. It
would not, because it cannot be flipped there. `MID_CAMPAIGN_EDITABLE_STATUSES`
is `['PAUSED', 'CREDIT_EXHAUSTED']` and `assertEditable` refuses *any* changed
field on RUNNING — and both editable statuses re-enter dialing only through
`resume`, which already prepares the agent off the post-write row.

So this attach is a **second holder of the invariant, not the only one**, and
the `callbackEnabled` gap it also closes is latent rather than live. It is worth
having anyway: it is attached to the change rather than to a later transition,
so it survives a status joining the editable list, or a top-up reviving a
CREDIT_EXHAUSTED campaign without a transition. The comment at the call site
says that rather than claiming a bug it does not fix.

It must also never turn a saved edit into a failed one. The row is already
committed by the time this runs, so an unhandled rejection here returns 500 on a
PATCH that actually succeeded — worse than the same failure at a transition. The
block is wrapped and logged, matching `releaseGoalPromptBlock`'s posture, and a
test pins both the 200 and the log.

## Turning it off mid-campaign

Contacts already armed `FOLLOW_UP` or `RESUME` keep their dial. On resolution
`hasGoal` is false, so no further follow-up is armed and the contact settles on
the ordinary path. Nothing is swept, nothing is cancelled: a conversation the
engine already promised to continue is worth finishing, and the operator's
change takes effect from the next decision rather than retroactively.

The managed extraction set stays attached to the agent, as it does today when a
goal campaign ends — agents are many-to-one with campaigns and the set is not
this campaign's to remove.

## Compatibility

The route keeps **accepting and ignoring** a `goal` field for one release. Only
the dashboard sends it — no V2 partner surface exposes it — but the dashboard
and the backend deploy independently, and a 400 on an unknown field during the
skew is avoidable for the cost of one ignored key.

## Shape of the change

**Backend.** `hasGoal({goalEnabled})` replaces `hasGoal({goal})` across ~28 call
sites; every Prisma `select` feeding one swaps `goal: true` for
`goalEnabled: true`. Prisma's generated types are exact, so `tsc` catches a
missed select — that is the safety net for the mechanical half. `validateGoal`
becomes a boolean read; `MAX_GOAL_CHARS` and the length rule go.

**Dashboard.** `GoalDraft.goal: string` becomes `goalEnabled: boolean`. The
textarea and the `LockedGoal` panel go; the four knobs stay behind the toggle,
restore-on-hide included.

**Harnesses.** `CampaignSpec.goal` becomes `goalEnabled` in conformance and
battle; scenarios seed the boolean.

## Migration

Catalogue-only `ADD COLUMN` with a constant default, then one `UPDATE` over
`Campaign` — one row per campaign, not per contact, so unlike
`contact_arm_kind` this needs no hand on it at any table size.

```sql
ALTER TABLE "Campaign" ADD COLUMN "goalEnabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Campaign" SET "goalEnabled" = true
 WHERE "goal" IS NOT NULL AND btrim("goal") <> '';
```

## Verification

Unit: the boolean validator, `goalEnabled` in the mid-campaign field list,
`prepareCampaignAgent` firing on both flips, `hasGoal` reading the column, and a
campaign whose goal is turned off mid-flight settling its armed contacts rather
than re-arming them. Conformance and battle carry the seed change. Dashboard:
the toggle, the knobs' visibility, restore-on-hide, and the payload shape.
