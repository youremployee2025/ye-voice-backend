# Call note — design

> **Revised, 2026-09-06 — the switch and the goal knobs are gone.** Follow-ups
> are always on: every campaign chases an unfinished conversation until its
> dial budget runs out, and the budget is the Retry Calls section's own
> `retryCount + 1`. `maxGoalFollowUps` no longer bounds anything; a
> non-immediate follow-up waits the retry cooldown ladder
> (`retryDelaysMinutes[attempts] ?? cooldownMinutes`) rather than
> `followUpDelayHours`; and a dropped call resumes after a fixed three minutes
> rather than `immediateCallbackMinutes`. All five columns survive, the API
> still accepts them, and the engine reads none of them — see the *One dial
> budget* section of `CLAUDE.md`. Everything below about **what the bot is
> asked and what the next call is told** is unchanged and still current; the
> caps and delays it describes are the history.
>
> **One row superseded, 2026-09-04.** The *Goal text* decision below says
> `Campaign.goal` stays the on-switch. It did not: the switch became
> `Campaign.goalEnabled`, a boolean — which is itself now retired by the note
> above. See
> [`2026-09-04-goal-toggle-design.md`](2026-09-04-goal-toggle-design.md). The
> rest of this document stands — it is what made the prose redundant.

Replaces the goal-verdict contract (five verdict keys, a rolling memory
paragraph, seven dial variables, a managed block naming them) with a
**platform-style five-key extraction and a single note** that the next call
receives under a header that overrides everything else. The engine, the
caps, the lanes, the callback booking and the do-not-call list stay as they
are; what changes is what the bot is asked at the end of a call and what it
is told at the start of the next one.

Base: `main` @ 0af5ac3 (PR #25 merged). Simulator branch `feat/campaign-sim`.

## Why

The simulator's runs of 2026-09-02 (`2026-09-02-campaign-simulator-run-1.md`)
showed two things about the shipped contract against the production model:

1. The bot did not act on the memory it was given. Every follow-up call ran
   the scripted cold opening until the customer objected. Fixing it took an
   YE-rendered imperative *and* a new section in the customer's prompt;
   neither alone worked.
2. The memory paragraph, asked for as "what you know about this person",
   absorbed the agent's own claims as customer facts and dropped the
   *when* and *who* of what the customer said.

The note asked for here is different in kind: not facts about the person
but **instructions to the next call**, including the exact line to open
with. The runs showed this model follows a concrete line to say far better
than a rule to apply. And the customer's prompt stays untouched: the header
and the variable are written by YE at campaign start, like the old block.

## Decisions (2026-09-03)

| Question | Decision |
|---|---|
| Keys | Exactly as specified, with the `_vocobaseplatform` suffix: `call_outcome_vocobaseplatform`, `call_outcome_reason_vocobaseplatform`, `callback_type_vocobaseplatform`, `callback_requested_time_vocobaseplatform`, `next_call_instructions_vocobaseplatform`. A sixth, `call_end_timestamp_vocobaseplatform`, was added with contender E's timestamp. Descriptions verbatim from the specification. The instructions key was `context_for_next_call_vocobaseplatform` in the first revision and the timestamp key was `call_timestamp_vocobaseplatform` through contender G; both names stay reserved so a partner cannot claim one. |
| Variable | One: `next_call_instructions_vocobaseplatform`, carrying a JSON object YE assembles — `note` (YE's standing follow-up frame) and `instructions` (what the last call wrote). Sent only when a note exists; not sent on a first conversation, so the platform renders it empty under the header. See “What the bot is told”. |
| Header | Written by YE at campaign start (and resume), at the **top** of the agent prompt (measured: 0/3 on S04 at the end, 2/3 at the top, run `sim-note-top-1`), between marker lines, replaced idempotently, removed on stop when no other running note campaign shares the agent. Text verbatim: `# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)` / blank / `{{next_call_instructions_vocobaseplatform}}` / blank / `========================================`. The header no longer says “if any”: the conditional is the variable's absence, not a clause the model has to evaluate. The position is a constant; the simulator measures it. |
| Decision | `completed` → settle COMPLETED, achieved. `stop` → settle, do-not-call row. `incomplete` + `requested` → follow-up, then the callback booking moves it to `callback_requested_time`; unreadable time → the follow-up delay stands. `incomplete` + `immediate` → re-arm after **`immediateCallbackMinutes`** (a goal knob of its own, default 5, range 1–120 — *revised 2026-09-04, see “The immediate gap”*). `incomplete` + `flexible`/`null` → re-arm after `followUpDelayHours`. Null or unparseable extraction → as `flexible`. Caps (`maxTotalDials`, `maxGoalFollowUps`), the window and the DNC list apply on top and always win. |
| Record | `CampaignContactGoal.memory` holds the note (the same staleness guard by attempt). `lastCallNote` derived by YE as today from disposition + outcome + reason. `goalMissing` no longer written. `attemptLog` entries carry `outcome`, `reason`, `callbackType`, `callbackRequestedTime`. **Each re-arm also writes `CampaignContact.armKind`** (*revised 2026-09-04, see “Why the clock is set”*): `requested` → `CALLBACK` once the booking lands, and `callbackAt` with it; `immediate` → `RESUME`, `nextEligibleAt` alone and **no `callbackAt`**; `flexible`/null and every other goal re-arm → `FOLLOW_UP`; the retry ladder → `RETRY`. |
| Goal text | `Campaign.goal` stays the on-switch (non-blank = note campaign) and is no longer sent to the bot; the prompt owns the goal. |
| Dashboard | Not in this wave. The API keeps `memory` and a "last decision" per contact through a compatible mapping (`completed`→done, `stop`→stop, `incomplete`+`requested`→call_back_at, else call_again). Labels are renamed later. |
| Prompt under test | The customer's untouched export; the Phase 0 section comes out of the fixture. |

## The extraction set

**Revised for contender I (2026-09-06).** I keeps H's five labelled sections —
PREVIOUS CALL SUMMARY, ALREADY COVERED, RESUME FROM, OPENING SCRIPT, KEEP IN
MIND — and H's outcome, defined by reference to the agent's own prompt and tied
to whether a callback is needed rather than to "a genuine follow-up". What I
changes is the callback decision itself: **the single `callback_type` key is
retired**, and the model is asked two plain questions instead —
`immediate_callback_needed_vocobaseplatform` (`yes`/`no`: did the call end
abruptly mid-conversation) and `immediate_callback_needed_reason_vocobaseplatform`
(why, in five words or less) — alongside the existing
`callback_requested_time_vocobaseplatform`. The engine derives the same
`requested` / `immediate` / `flexible` / `null` distinction H's key used to
carry directly, from those two answers (see `readCallNote` /
`deriveCallbackType` in `src/lib/goalRecord.ts`), so nothing downstream —
`attemptLog`, the journey API, the dashboard's `JourneyGoal` type — has to
change shape.

**Precedence when the two answers disagree.** A real, parseable
`callback_requested_time` beats `immediate_callback_needed = "yes"` and derives
`requested`, never `immediate`. The time key's own description tells the model
to leave it blank when immediate is `yes`, so a real time arriving anyway means
the model disobeyed that instruction — and the explicit, bookable promise wins
over the flag it was told to defer to. This restates H's own precedence, where
an explicit callback request always took priority over `immediate` or
`flexible`.

The **outcome reason** now names the outcome key and its three values instead
of a bare "reason for the call outcome" instruction, so a model reading it in
isolation still knows what it is explaining. The **callback time**'s format
string keeps H's `YYYY-MM-DDTHH:mm±HH` (the operator's first draft read
`YYYY-MM-DDTHH±HH`, a dropped `:mm` that was confirmed as such and restored);
the parser accepts the minute-less form too, so a model that still emits it
books on the hour rather than failing. The **instructions** key gains one
closing sentence asking the model to frame what it did in the second person.
Everything else — the **callback time**'s anchor to when the call ended, Step 1
of the **opening script** setting context as well as pointing at the previous
call, both pinned keys stating their allowed values in prose — is H's,
unchanged.

The sixth key is renamed `call_end_timestamp_vocobaseplatform` and asks when
the call **ended**, not when it happened: the callback time is now scheduled
from it, and a conversation spanning minutes has only one instant that
arithmetic can be anchored to. YE plays it back to the next call — the one
part of contender D worth keeping. The old name
`call_timestamp_vocobaseplatform` briefly had a meaning a release fixed, so
it stays reserved and a partner cannot claim it.

Contender D moved the opening steps out of this key and into YE's standing
order, stated generically for every call; it lost turn 1 in nine of sixteen
drop cells and was abandoned. Both earlier shapes and the measurements are
recorded in [`2026-09-03-call-note-run-1.md`](2026-09-03-call-note-run-1.md).

One set, `EZO campaign call note`, attached on start and resume; the goal
set and the callbacks set are retired for note campaigns (detached on the
next start). The goal set is detached on start; the callbacks set is left in
place, because a plain campaign with callbacks on may share the agent, and a
goal campaign's booking — and its record — never read that key. Descriptions
never name a campaign.

| Key | Type | Description |
|---|---|---|
| `call_outcome_vocobaseplatform` | string, pinned `incomplete` / `stop` / `completed` | Allowed values: "incomplete", "stop", or "completed". "incomplete" if the conversation is incomplete based on the agent prompt provided, hence a callback is needed. "stop" if the user does not want further contact, is the wrong person, or there is clearly no reason to call again. "completed" if the conversation is complete based on the agent prompt provided, hence does not need a callback. |
| `call_outcome_reason_vocobaseplatform` | string | Reason for why you marked call_outcome_vocobaseplatform as "incomplete", "stop", or "completed", in 5 words or less. |
| `immediate_callback_needed_vocobaseplatform` | string, pinned `yes` / `no` | Allowed values: "yes" or "no". Based on the conversation transcript, check whether the call ended abruptly in the middle of a conversation. Mark as "yes" if it did, and hence the system should trigger a callback immediately to resume the conversation. Otherwise, mark as "no" if the call seems to have ended intentionally, either by the user or the bot. |
| `immediate_callback_needed_reason_vocobaseplatform` | string | Reason for why you marked immediate_callback_needed_vocobaseplatform as "yes" or "no", in 5 words or less. |
| `callback_requested_time_vocobaseplatform` | string | If the user has explicitly requested a time, generate the callback time accordingly. If the user requested a callback without specifying a time, suggest the most suitable time based on the calling window and the conversation context. Mark as "null" if (1) call_outcome_vocobaseplatform is marked as "stop" or "completed", or (2) immediate_callback_needed_vocobaseplatform is marked as "yes". Generate the callback time in YYYY-MM-DDTHH:mm±HH format only. Refer to the timestamp of when this call ended to schedule the callback correctly. |
| `next_call_instructions_vocobaseplatform` | string | Generate brief system instructions for the next call in less than 1,200 characters. Frame it like this: PREVIOUS CALL SUMMARY: [summary of the call and where exactly it stopped], ALREADY COVERED: [what has been discussed so far], RESUME FROM: [describe where the conversation should resume from], OPENING SCRIPT: [explicit instruction to skip the standard flow and exact lines to use for opening the next call in the following format: Step 1: “[short, generic one-liner that simply refers to the previous interaction to set the context (without going into specifics) and asks if we can continue]” → if the user agrees → Step 2: “[one-liner to set the context and continue from where the call stopped]”], KEEP IN MIND: [additional information such as user preferences, sentiment, or anything else that is important for the next call]. Do not include information that is not useful for the next call. Frame sentences in the second person while describing what this agent did in the call. |
| `call_end_timestamp_vocobaseplatform` | string | Give the timestamp of when the call ended in YYYY-MM-DDTHH:mm±HH format. |

The string `"null"` is read as null everywhere. Pinned values are a prompt
instruction, not a schema; an unknown value reads as null.

**Retired names.** The single-key callback decision this table used to carry —
`callback_type_vocobaseplatform`, string pinned `requested` / `immediate` /
`flexible` / `null` — is retired under contender I in favour of the two rows
above. It stays reserved (`RETIRED_CALL_NOTE_KEYS` in
`src/lib/extractionConfig.ts`): an agent that ran a note campaign under H still
has a set defining it, and a partner allowed to claim the name would have their
own key merged ahead of it.

## The decision, precisely

Applied on `session.completed` for a connected outcome on a note campaign,
caps first, then:

| `call_outcome` | `callback_type` | Outcome | `armKind` |
|---|---|---|---|
| `completed` | any | COMPLETED, `goalAchieved = true` | untouched (settled) |
| `stop` | any | COMPLETED, `goalAchieved = false`, DoNotCall row | untouched (settled) |
| `incomplete` | `requested` | re-arm at `now + followUpDelayHours` (windowed), `followUpCount + 1`; the booking then moves it to `callback_requested_time` when readable | `FOLLOW_UP`, then `CALLBACK` when the booking lands — with `callbackAt` |
| `incomplete` | `immediate` | re-arm at `now + immediateCallbackMinutes` (windowed), `followUpCount + 1` | `RESUME`; `nextEligibleAt` only, no `callbackAt` |
| `incomplete` | `flexible` / null | re-arm at `now + followUpDelayHours` (windowed), `followUpCount + 1` | `FOLLOW_UP` |
| null / unreadable | — | as `incomplete` + `flexible`; journey notes "no outcome" | `FOLLOW_UP` |

A re-arm past `maxGoalFollowUps` or `maxTotalDials` settles COMPLETED with
`goalAchieved = false`, as today. `callback_requested_time` in
`YYYY-MM-DDTHH:mm±HH` is read by the existing callback parser (a two-digit
offset is normalised to `±HH:00`).

### The immediate gap (revised 2026-09-04)

`incomplete` + `immediate` originally re-armed after `cooldownMinutes`. That
column belongs to Retry Calls, so tuning the retry ladder silently changed how
fast an interrupted conversation was picked back up — two sections of one form
wired together through a column neither of them named. It has its own knob now,
`Campaign.immediateCallbackMinutes`: minutes rather than hours because the
person is still sitting by the phone, default 5, refused outside 1–120 by
`validateGoalPolicy`. One minute is the floor a redial needs to clear; two
hours is already a different conversation rather than the same one continued.

**Throttled (2026-09-06).** The gap fires once an hour per contact. The
immediate re-arm stamps `CampaignContact.lastImmediateAt`; a second immediate
inside `IMMEDIATE_REPEAT_WINDOW_MINUTES` (60, fixed) of the stamp is armed a
whole window out from now — the same RESUME lane, the same follow-up spent —
and moves the stamp. Otherwise a resumed call that drops again, or a model
that answers "yes" to every abrupt ending, rang the same phone every gap until
`maxTotalDials` ran out; and `maxTotalDials` was raised from 15 to 50 the same
day, with `maxGoalFollowUps` bounded by it rather than by its own ceiling of 5.

### Why the clock is set (revised 2026-09-04)

`CampaignContact.armKind` answers "why is this row's clock set, right now", and
is only meaningful while `status = PENDING`. It exists because the columns that
used to answer it could not:

- `followUpCount` is a lifetime tally, so a plain retry of a contact that was
  once followed up read as a follow-up for ever — including in the attempt
  `kind` an operator reads back months later.
- `nextEligibleAt == callbackAt` was briefly widened to cover the immediate
  resume, on the argument that both are "a time somebody is owed". That made a
  call the engine chose to place indistinguishable from a time a person asked
  for, in the claim, in the queue tabs, in `callbacksPending` and in the
  journey. **A resume is not a promise**, and nothing customer-facing may
  describe it as one — so the widening is reverted and `callbackAt` keeps its
  narrow meaning.

`FRESH` / `RETRY` / `FOLLOW_UP` / `RESUME` / `CALLBACK`, written by every
re-arm path and read by the claim's lanes. The resume lane is drawn from the
retry reservation rather than the whole pass, so a burst of dropped calls
cannot starve fresh contacts and retries.

## What the bot is told

Every dial of a note campaign carries the contact's own variables as today.
YE adds at most one more, and nothing else: no goal, no call number, no
memory paragraph.

The block YE wrote into the prompt at campaign start is the same on every
call:

```
[EZO call note — managed by EZO, do not edit]
# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)

{{next_call_instructions_vocobaseplatform}}

========================================
[end EZO call note]
```

**A follow-up call.** The record holds a note, so the dial carries the one
variable, and its value is a JSON object YE assembles:

```json
{
  "note": "Last call was incomplete. THIS IS A FOLLOW-UP CALL. You have already spoken to this person before. Do not restart the conversation from scratch. Use the instructions below to continue from where the previous call stopped.",
  "previous_call_end_timestamp": "Previous call ended at 2026-09-04T10:00+05:30",
  "instructions": "<the note the bot wrote last call>"
}
```

`previous_call_end_timestamp` is present only when the last call answered the
timestamp key readably; a missing field is a fact the opener does not have,
where an empty one is a sentence that trails off after "at".

**A first call** — and equally a retry after a silence, where nobody has been
spoken to. The record holds no note, so no variable is sent, the platform
renders the placeholder empty, and the block is a header and a rule over
nothing.

### Why the frame is a variable and not prompt text

The "THIS IS A FOLLOW-UP CALL" sentence is the thing that actually changes the
model's behaviour — the runs of 2026-09-02 showed a concrete instruction beats
a rule to apply. But it must not stand on a first call, where it would tell
the model it has already spoken to somebody it has never dialled.

The prompt cannot express that condition. It is written once, at campaign
start, and is deliberately identical for every campaign and every contact —
which is what lets one agent serve several note campaigns at once. **YE is
the only party that knows which kind of call is being dialled**, because only
YE holds the record that says whether a conversation has happened. So YE
writes the frame, joins it to the bot's own instructions, and sends the pair
as the single value the block interpolates; a first dial simply sends no
value, and the absence is the condition.

JSON, and `JSON.stringify(…, null, 2)`, rather than concatenated prose: the
bot's half is model output and by design contains double quotes, arrows and
newlines — the key description asks for `Step 1: "…" → wait … → Step 2: "…"`.
Escaping it means the two halves cannot run together, and a stray quote in the
model's text cannot make YE's frame read as part of the model's instructions.
The two named fields also tell the model which half is standing policy and
which is this contact's history.

### The key's description is longer than the partner limit

The instructions key's description is ~900 characters, over
`MAX_EXTRACTION_KEY_DESCRIPTION_CHARS = 500`. That constant is **YE's**
validation of partner-supplied extraction config (`extractionConfigSchema`),
not a platform limit, and the managed set never passes through it — it goes
straight to `createExtractionSet`. So the partner limit stays at 500 for
partners, and a test caps the managed descriptions at 1000 instead, purely as
a guard against unnoticed growth. **The platform's own ceiling is unverified**;
the live handset rehearsal is the gate, because a set the platform refuses is
refused silently and every call of the campaign then comes back with no note.

## Verification

- Unit: outcome table, `"null"` handling, immediate vs flexible gap,
  `immediateCallbackMinutes`' own bounds, callback time normalisation, note
  staleness, header insert/replace/remove — including the migration a running
  install actually performs, an earlier release's block found at the end of a
  prompt and written at the top.
- Conformance: goal rows G1–G6 rewritten to the new keys, and **G7 added** for
  `incomplete` + `immediate` — its own gap, rolled into the window, armed
  `RESUME` with no `callbackAt`. The 46 other rows unchanged.
- Simulator: scenarios' expectations mapped to the new keys; S04 with the
  header at the end, and if it fails, at the top, both reported; then the
  full suite. Blocking rule unchanged.

## What this does not decide

The dashboard's labels; whether `goalMissing` and the follow-ups design's
"still needed" concept come back in some form; the platform's own handling
of the `_vocobaseplatform` names. The live handset rehearsal remains the
gate for everything about the platform.
