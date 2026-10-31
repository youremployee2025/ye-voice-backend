# Goal verdicts — design

Status: built on `feat/goal-verdict`, 2026-09-02.

> **Superseded twice.** The variable and record contract here was replaced on
> 2026-09-03 by [`2026-09-03-call-note-design.md`](2026-09-03-call-note-design.md),
> and two decisions went on 2026-09-04: *the goal is prose*, and the dashboard's
> *goal editable in DRAFT only*. The goal is `Campaign.goalEnabled`, a boolean,
> editable while a campaign runs, and the objective itself lives in the agent's
> own prompt. The argument below for the DRAFT lock — a verdict recorded against
> words cannot survive those words being edited — is exactly why a boolean does
> not need one. See
> [`2026-09-04-goal-toggle-design.md`](2026-09-04-goal-toggle-design.md).

Replaces the goal follow-ups predicate ("every required extraction key is
non-empty") with a **bot-judged verdict**, and replaces the merged key-value
context with a **rolling memory**. The follow-up engine, the three policy
knobs, the attempt cap, the dial window and the claim lanes stay as they are.

Base: `main` @ 0b38285. Dashboard base: `main` @ 2bdfe00.
Supersedes the predicate, record and variable contract in
`2026-09-01-goal-followups-design.md`; that document's decisions on caps,
lanes, races and idempotency still hold.

## Why

Three findings against the shipped design, in order of severity.

1. **The decision ran on the wrong event.** The platform sends
   `call.status.updated` for a completed call *with* its disposition and
   `answered_by`, then runs extraction, then sends `session.completed` with
   the values. The status event carries no extraction. YE resolved a
   connected contact on the first classified event it saw, so on every
   connected goal call the settle-or-follow-up decision was judged against
   the previous calls' record alone — this call's answers were invisible. A
   first call that collected everything was still followed up; with
   `maxGoalFollowUps = 0`, every contact settled as not achieved. The mock
   emitted the status event unclassified for completed calls, which is why
   the battle and conformance runs never saw it.
2. **The predicate was about fields, not the goal.** An agent's extraction
   keys are mostly QA metrics that every conversation fills, so a goal was
   "achieved" on the first call; a refusal ("won't say") is a non-empty value
   and read as collected; "not interested" left keys empty and was followed
   up until the budget ran out. Only two things a person said could change
   the schedule: an exact callback time, and an explicit "do not call".
3. **Context only reached the bot if the operator had pasted the variable
   names into the prompt**, and it was thin when it did: field names without
   values, one line about the last call, and a summary behind a flag that
   defaulted off.

## Decisions

- **The goal is prose.** `Campaign.goal String?`; null or blank is the
  feature off and behaviorally invisible. `goalKeys` is removed.
- **YE manages a block inside the agent's prompt.** Written on start and
  resume between marker lines, replaced idempotently, removed on stop when no
  other running goal campaign shares the agent. The block's text is identical
  for every campaign; every per-campaign and per-contact fact inside it is a
  dial variable, so one agent serves many goal campaigns.
- **Extraction stays in-bot on the platform**, through one agent-level
  managed set. The in-bot extraction runs on the live context, so the model
  that judges the goal has read the goal, the memory and the whole
  conversation. The platform's transcript-only fallback cannot see the goal
  and returns null verdicts; null is "no verdict", never a guess.
- **The bot decides the next step; YE enforces the limits.** The verdict
  carries `next_action`; the caps, the window and the campaign's do-not-call
  list are applied on top of it and always win.
- **Memory is a rolling paragraph plus a last-call note.** The paragraph is
  rewritten by the bot after every conversation; the note is derived by YE
  from the outcome on every attempt, silences included.
- **Do-not-call is per campaign.** Keyed by campaign and phone, joined at
  claim time against the campaign's own list only. A second campaign in the
  workspace may still dial the number.
- **Goal decisions wait for `session.completed`.** A classified status event
  on a goal campaign still closes the attempt and frees the line, and still
  resolves silences; a connected outcome is left for the completion event.

## The prompt block

Inserted at the top of the agent's prompt, verbatim:

```
[EZO campaign context — managed by EZO, do not edit]
{{follow_up_instruction}}
Campaign goal: {{campaign_goal}}
This is call number {{call_number}} to this person. Calls before this one: {{previous_attempts}}.
What you already know about them: {{memory}}
Last call: {{last_call_note}}
Still needed for the goal: {{goal_missing}}
Never ask again for anything you already know. If they ask not to be called again, acknowledge it and wind the call up.
When the call ends you will be asked to judge whether the goal was met and to recommend a next step.
[end EZO campaign context]
```

Written through the same agent update the adapter already uses. The write
is idempotent: the block is located by its marker lines and replaced, or
prepended if absent; an intact block found at the end of a prompt is moved to
the top on the next write. A prompt whose block has been edited by hand is
re-written and an ADMIN notification says so. A write failure is a
notification, never a blocked transition — the same promise the managed-key
attach makes. Removal on stop/complete is gated on no other RUNNING or PAUSED
goal campaign referencing the agent.

## The managed extraction set

One set, `EZO campaign goals`, attached on start and resume. Descriptions
never name a campaign.

| Key | Type | Description (abridged) |
|---|---|---|
| `goal_achieved` | boolean | Was the campaign goal in your instructions fully met by the end of this conversation? Null if nobody was spoken to. |
| `goal_missing` | string | What the goal still needs, in one line. Empty if achieved. |
| `next_action` | string, pinned `done` / `call_again` / `call_back_at` / `stop` | What should happen next with this person. `stop` if they asked not to be called, are the wrong person, or made clear there is no point. |
| `next_action_reason` | string | Why, in a few words. |
| `memory` | string | The "what you already know" paragraph from your instructions, rewritten to include what this call taught you. Under 600 characters. Null if nobody was spoken to. |

The callback time is **not** in this set. The platform reserves the name
`callback_at` and refuses a partner key of that name, and the existing
`EZO campaign callbacks` set already supplies `callback_requested_at` on
every campaign with callbacks enabled. A goal campaign attaches that set
too, whatever its `callbackEnabled` says, so `next_action = call_back_at`
is read together with `callback_requested_at` by the booking that already
exists — and that booking honours the time on a goal campaign whatever
`callbackEnabled` says, for the same reason: an explicit promise beats the
configured gap, and a key attached regardless of the switch would be pointless
if the switch then refused every value it produced.

Retired: the `EZO campaign opt-outs` set (`do_not_call` is `next_action =
stop`), and the `EZO call summaries` set with `GOAL_SUMMARY_LLM`. The
reserved-name list becomes these five plus `callback_requested_at` and the
platform's `callback_at`. On the next start of any campaign, a retired set
found on the agent is detached.

Pinned values are a prompt instruction, not a schema enum, so the model may
answer null. Every verdict field is read defensively: an unknown
`next_action` string is null.

## The decision

Applied in `resolveContact`, on `session.completed` only, for a connected
outcome on a goal campaign. The verdict is read top to bottom, and the caps
enter only at the re-arm rows: a `stop` or a `done` settles whatever the
budgets say, because a person who asked to be left alone, or one who gave
everything, is not somebody a spent budget should re-arm or re-judge. The
caps decide whether a `call_again`, a `call_back_at` or a null verdict is
re-armed or settled:

| Verdict | Outcome |
|---|---|
| `next_action = stop` | settle COMPLETED, `goalAchieved` as reported (false if null); write the campaign's do-not-call row; journey says why |
| `next_action = done`, or `goal_achieved = true` | settle COMPLETED, `goalAchieved = true` |
| `next_action = call_back_at` | re-arm exactly as `call_again`; the callback booking that runs after the resolution then moves the contact to the promised `callback_requested_at`, or leaves the follow-up standing when the time cannot be read |
| `next_action = call_again` | re-arm PENDING at `now + followUpDelayHours` rolled into the window, `followUpCount + 1` |
| null verdict (extraction absent, failed, or unreadable) | as `call_again`, journey notes "no verdict" |

The caps: `maxTotalDials` (placed attempts, as today), `maxGoalFollowUps`,
`followUpDelayHours` as the minimum gap between two conversations, the dial
window, and the campaign's do-not-call list at claim. A `call_again` past
either budget settles COMPLETED with `goalAchieved = false`. A
`call_back_at` past the dial cap settles the same way and the journey says
the promise could not be kept — the rule the follow-ups design already
records. Silences keep today's retry semantics untouched.

The opt-out write stays outside the race guard, as today: a `stop` heard on
a delivery that loses its race is still a `stop`.

Idempotency is unchanged: the event key makes the charge and the resolution
exactly-once, the `claimed` predicate drops a late write, and the record is
keyed by attempt number so a replay changes nothing.

## The record and the variables

`CampaignContactGoal` keeps `attemptLog` and replaces `mergedExtraction`,
`keyAttempts` and `summaryNote` with:

```prisma
memory        String?
memoryAttempt Int?      // which attempt wrote `memory`; a stale redelivery cannot overwrite a newer one
lastCallNote  String
goalMissing   String?
```

Log entries gain `nextAction` and `reason`. `memory` moves only on a
non-empty value from an attempt at least as late as `memoryAttempt`.
`lastCallNote` is written on every attempt from the disposition and, for a
conversation, `next_action` and `next_action_reason` — "reached voicemail",
"spoke, asked to call back next Tuesday", "spoke, not interested".

The record is written **before** the re-arm in the same completion job, so a
follow-up cannot be dialled ahead of its own memory.

Variables on every dial of a goal campaign, all strings:

| Variable | Value |
|---|---|
| `follow_up_instruction` | `FOLLOW_UP_INSTRUCTION` if a memory exists, else `FIRST_CALL_INSTRUCTION` |
| `campaign_goal` | the goal text |
| `call_number` | this dial's attempt number |
| `previous_attempts` | `call_number - 1` |
| `memory` | the paragraph, or `nothing yet` |
| `last_call_note` | the note, or `first call` |
| `goal_missing` | the last non-empty answer, or `everything in the goal` |

Retired: `collected_summary`, `missing_fields`, `goal_state`.

`follow_up_instruction` is the seventh variable, added after the simulator
showed the model would not act on a follow-up conditional it had to evaluate
itself: given `call_number: '2'` and a memory, and told in three separate
places what that meant, it still ran its scripted cold opening on every
follow-up call. YE already knows the answer, so YE decides it and sends
prose that needs no reasoning — either "This is the first conversation with
this person" or an explicit instruction not to run the opening. It keys off
the presence of a memory rather than the attempt number, so a retry after
voicemail, which spoke to nobody, is still an opening call.

The engine half is inert on its own. With the variable in place and the prompt
untouched, the agent resumed correctly in 0 of 3 S04 cells — and in 0 of 3
again when the prompt gained the same instruction as a CRITICAL rule. Adding
one section that tells it what a follow-up call does differently took it to
3/3, and to 17/20 over ten drop-point scenarios in Hindi and English (20/20
discounting a scenario-expectation artefact). That prompt section is the
prompt owner's to paste in — see `docs/goal-followup-phase0-prompt-section.md`.
YE guarantees the signal, not the behaviour.

## Dashboard

- Goal editor: a text area for the goal, plus the three policy knobs; the
  key picker goes. Goal editable in DRAFT only, knobs also in PAUSED and
  CREDIT_EXHAUSTED, as today.
- Contacts: the memory paragraph and the last decision on the row; the
  do-not-call badge.
- Journey: per-call verdict and reason on follow-up rows.
- Overview: the goal-achieved tile stays; the collected-fields distribution
  goes.
- Nothing under analytics is touched.

## Schema

- `Campaign.goalKeys` → `Campaign.goal String?`.
- `CampaignContactGoal`: columns as above.
- `DoNotCall`: `campaignId` replaces `workspaceId`; unique on
  `(campaignId, phone)`; FK to `Campaign` with an index.
- No goal campaign has run in production, so the goal columns carry no data
  and none is migrated. **`DoNotCall` is the exception, and the reasoning
  above does not cover it.** Its rows are not a goal-campaign artefact: the
  opt-out is judged on every resolution of every campaign, ahead of the goal
  gate, because the opt-out extraction set is attached to the AGENT and agents
  are many-to-one with campaigns. Any campaign whose agent carries the key can
  therefore have written rows, and each one is a person who asked not to be
  called. So the workspace-scoped table is preserved rather than dropped: if
  it has rows the migration renames it to `DoNotCall_workspace_legacy` for an
  operator to review and drop by hand, and only drops it when it is empty. The
  new per-campaign list starts empty either way.

## Verification

- TDD throughout. Unit: the decision table, cap enforcement, note
  derivation, null-verdict handling, memory staleness, block insert /
  replace / remove idempotency, per-campaign DNC at claim.
- **The mock adopts the platform's real ordering** for completed calls: a
  classified `call.status.updated` first, `session.completed` with
  extraction after a delay. This is the regression gate for finding 1.
- Battle scenarios, three runs each: achieved on the first call; "not
  interested" on the first call; "call me next week"; voicemail between two
  conversations preserving memory; null verdict; replay; two goal campaigns
  on one agent; a hand-edited block.
- Conformance: the existing rows show zero verdict changes with the goal off.
- The customer guide is rewritten: write a goal, nothing else.

## Open

- The memory length cap, and whether the bot may keep personal details in it
  beyond what the goal needs. Default in this design: 600 characters, goal-
  relevant facts only, stated in the key's description.
- Whether `followUpDelayHours` should also bound a `call_back_at` that falls
  sooner than the delay. Default here: no — an explicit promise beats the
  gap, the rule the follow-ups design already keeps.
