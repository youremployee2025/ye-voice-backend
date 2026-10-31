# Goal campaigns

Every calling campaign is trying to achieve something with each person —
confirm they are still looking, collect a budget and a move-in month, book a
site visit. If one conversation does not achieve it, the campaign does not give
up: it schedules another call, and that call arrives knowing where the last one
stopped and the exact line to open with. Since 2026-09-06 that is how every
campaign behaves; there is no switch and there never needs to be one.

**Read the next section before you start one.** There is nowhere in YE to
write down what a campaign is for. The objective lives in the agent's own
prompt, and a campaign set up the old way runs with its agent told nothing.

## Every campaign follows up. There is no switch.

A conversation the agent says is unfinished schedules another call, and that
call opens with what the earlier ones learned. That is how every campaign
behaves. There is nothing to turn on.

**The agent decides what "complete" means, and it decides it from its own
prompt.** YE holds no definition of the goal and never hands the agent one. At
the end of every call the agent is asked whether the conversation was finished,
and it answers out of the instructions you wrote it. Nothing YE stores about
the goal reaches a call — the conformance suite grades that, and row G1 fails
if anything goal-shaped reaches a dial at all.

There used to be a toggle here — *Follow up until the conversation is complete*
— and before that a box for the goal in your own words. Both are gone. The box
stopped being read the moment YE stopped sending it to the agent in the
call-note release; the toggle that replaced it turned off behaviour nobody
running a calling campaign actually wants turned off, and every campaign that
had it off was one whose calls quietly left no note, booked no callback and
heard no opt-out.

**So an agent whose objective lived only in that box is an agent that is never
told what it is calling about.** It will open with whatever its own prompt says,
and improvise everything the box used to supply.

**What to do instead: write the objective into the agent's own prompt.** In
your own words, outside YE's marked block, alongside everything else you have
told the agent about who it is and how it speaks. If one agent serves several
campaigns, its prompt has to cover all of their objectives — or give each
campaign its own agent.

Why it moved. The block YE writes is deliberately identical for every campaign
and every contact, which is what lets one agent serve several campaigns at
once. A goal interpolated into it was one more line the model had to reconcile
against instructions it had already been given, and the model followed the
prompt it was written with far more reliably than a variable pasted above it.
The division now is clean: **your prompt says what the call is for; YE says
where the last call stopped.**

## How hard a campaign chases: one number, on the Retry Calls panel

There are no settings of their own for the follow-ups. The Retry Calls section
already says how many times a contact may be called and how long to wait
between calls, and the follow-ups use exactly that:

| Question | Answer |
|---|---|
| How many calls may one contact get, in total? | **Retries + 1** — the first call plus the retries you set. Every kind of call counts: the first, retries after a silence, follow-ups after an unfinished conversation, and a resumed call after a dropped line. |
| How long before a follow-up? | The **same wait a no-answer gets** — your retry cooldown, or the custom cadence entry for the retry the contact is on. |
| How long before a dropped call is picked back up? | **3 minutes**, always, on every campaign. Not a setting. |
| What about a time somebody actually asked for? | **Honoured**, over any of the above — and it is the one call that is exempt from the retry reservation, though not from the total. |

There used to be four settings here — a separate follow-up budget, a separate
follow-up delay, a separate total-dials cap and a resume gap. Two ceilings over
one telephone meant whichever bound first made the other a setting that did
nothing: raising the one you could see got you no more calls. One number is
easier to reason about and it is the number you were already setting.

**Changing the retry count mid-campaign works**, and it moves the follow-ups
with it: the campaign re-reads it before every call it schedules, and contacts
the lower number has already put out of reach are settled rather than left
waiting for a call that will never come.

**What the readout counts.** "18 of 40 achieved" counts the contacts whose last
conversation the agent called complete. The agent judges that from your prompt,
so the number means whatever "done" means there — which is a reason to make it
concrete. "Collect their budget" is countable; "have a good conversation" is
not.

## What YE adds to your agent

When a campaign starts — and when it resumes — YE writes a block at the
**top** of your agent's prompt, between two marker lines:

```
[Call note — system managed, do not edit]
# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)

{{next_call_instructions_vocobaseplatform}}

========================================
[end call note]
```

An agent provisioned before this release carries the same block under older
marker lines. Nothing needs doing: the next start or resume of a campaign using
that agent replaces it with the block above.

That is the whole of it. One placeholder — no goal, no call number, no memory
paragraph.

- **Do not edit inside the markers.** YE rewrites the block on every start and
  resume, so an edit between them is replaced — and the workspace's admins get
  a notification saying the block was restored, because an edit replaced is
  somebody's work undone.
- **Your own instructions go outside the markers**, below the block, as normal.
  Everything you have written is untouched. **The campaign's objective belongs
  here**, in your own words.
- **The block sits at the top, and that is measured rather than assumed.** A
  block appended after a long prompt is not reliably read before the agent's
  first sentence: the agent runs its scripted opening and consults the note
  only once the customer says they have already spoken to somebody. If YE
  finds an intact block at the end of a prompt — written by an older release —
  it moves it to the top the next time it writes.
- **The block is the same text for every campaign and every contact.**
  Everything that varies is in the one variable, which is what lets one agent
  serve several campaigns at once.
- **An agent carrying the previous release's block** — the
  `[EZO campaign context …]` one, with its seven placeholders — has it replaced
  by this one on the next start, and silently: nobody edited that prompt, the
  contract moved under it.

The block is removed when the campaign stops or completes — unless another
running, paused or credit-exhausted campaign is using the same agent, in which
case it stays for that one. The block and the questions belong to the agent
rather than to this campaign, and other campaigns may be sharing them, so they
are not one campaign's to take away.

### The one variable, and when it is sent

`next_call_instructions_vocobaseplatform` is the only variable YE adds to a
dial, and it is sent **only when the previous call left a note**.

**On a first conversation nothing is sent.** The platform renders the
placeholder empty and the agent sees a header over nothing — and a header with
no instructions under it is not an instruction. That absence is the whole of
"this is a first call". A sentence saying so was tried and did not work: a
sentence is something the model has to read and reason about before it can act,
and an absence is not. A retry after voicemail is a first conversation too: the
note turns on whether anybody was actually spoken to, never on the call number.

**On a follow-up** the variable carries a small JSON object YE assembles:

```json
{
  "note": "Last call was incomplete. THIS IS A FOLLOW-UP CALL. You have already spoken to this person before. Do not restart the conversation from scratch. Use the instructions below to continue from where the previous call stopped.",
  "previous_call_end_timestamp": "Previous call ended at 2026-09-04T15:20+05",
  "instructions": "PREVIOUS CALL SUMMARY: … ALREADY COVERED: … RESUME FROM: … OPENING SCRIPT: Step 1: \"…\" → if the user agrees → Step 2: \"…\" KEEP IN MIND: …"
}
```

- `note` is **YE's** sentence, identical on every follow-up call. It is not
  asked of the agent, because an agent asked to restate "this is a follow-up"
  on every call is one that will eventually not, and the call it forgets is the
  one that opens cold.
- `previous_call_end_timestamp` appears only when the last call gave a readable
  end time. A missing field is a fact the opening does not have; an empty one is a
  sentence that trails off after "at".
- `instructions` is what the **previous call's own agent** wrote for this one,
  in the shape the extraction key asks for. It includes the exact opening lines
  to say, and those lines are the part measured to matter: the model follows a
  concrete line to say far better than a rule to apply.

It is JSON rather than a paragraph because the agent's half is model output and
by design contains quotation marks, arrows and line breaks. Escaping it means
the two halves cannot run into each other, and a stray quote in the agent's
text cannot make YE's standing sentence read as part of the agent's own
instructions.

**Your prompt does not need a section to make this land**, the way the previous
contract did. The instruction is inside the value now, under a header that says
it overrides everything else, at the top of the prompt.

## What the agent is asked at the end of each call

YE attaches a managed set of answers to your agent, called **Campaign call
note**. At the end of every call the agent is asked seven questions about the
conversation it just had:

| Answer | What the agent is asked |
|---|---|
| `call_outcome_vocobaseplatform` | `incomplete` if the conversation is incomplete against the agent's own prompt, so a callback is needed; `stop` if the person does not want further contact, is the wrong person, or there is clearly no reason to call again; `completed` if the conversation is complete against that prompt, so no callback is needed. |
| `call_outcome_reason_vocobaseplatform` | Why you marked the outcome as you did, in five words or less. |
| `immediate_callback_needed_vocobaseplatform` | `yes` if the call ended abruptly in the middle of a conversation and should be resumed right away; `no` if it ended intentionally, either by the person or by the agent. |
| `immediate_callback_needed_reason_vocobaseplatform` | Why you marked that flag as you did, in five words or less. |
| `callback_requested_time_vocobaseplatform` | The callback time, in `YYYY-MM-DDTHH:mm±HH`, scheduled from when this call ended. `null` when the outcome is `stop` or `completed`, or when the immediate flag is `yes`. |
| `next_call_instructions_vocobaseplatform` | Instructions for the next call: what happened, what was already covered, where to resume, **the exact lines to open with**, and anything worth keeping in mind. Under 1,200 characters, framed in the second person about what the agent did. |
| `call_end_timestamp_vocobaseplatform` | When this call **ended**, in the `YYYY-MM-DDTHH:mm±HH` form — the instant the callback above is scheduled from. |

YE decides whether the next call is a promise, an immediate resume or an
ordinary follow-up from the two callback questions together — there is no
"callback type" question to answer directly any more. If you (or an earlier
integration) already declared a callback-type-shaped field, it no longer means
anything to the campaign; only the two questions above do.

These seven names are reserved. Do not declare them yourself as extraction
fields on your agent, and do not pick one as a campaign's lead-sorting field:
they are the campaign's own bookkeeping rather than facts about the person, and
a field of yours under one of these names would be read ahead of the managed
one — deciding who gets called again, and what the next call is told about the
last.

**Nine names from earlier releases stay reserved for the same reason**, though
nothing asks them and nothing reads them: `goal_achieved`, `goal_missing`,
`next_action`, `next_action_reason`, `memory`, the note's three earlier names
`context_for_next_call_vocobaseplatform`,
`memory_for_next_call_vocobaseplatform` and `call_timestamp_vocobaseplatform`,
and the callback-type key an earlier release of this note asked directly,
`callback_type_vocobaseplatform`. An agent that already carries one keeps it
and can still be saved; nobody may newly declare one.

**Sets from earlier releases are removed.** `EZO campaign goals`, `EZO campaign
opt-outs` and `EZO call summaries` are detached from the agent the next time a
campaign starts — and so are the branded names the two current sets used to
carry, `EZO campaign call note` and `EZO campaign callbacks`, which are now
`Campaign call note` and `Campaign callbacks`. A set cannot be renamed upstream,
so the new name is a new set and the old one is taken off once the new one is on. An agent asked two sets' questions at once answers the
old vocabulary for nobody, and you would be paying for the extraction.

If nobody was actually spoken to — voicemail, no answer, a busy line — there is
nothing to answer and the agent answers nothing. YE treats a missing note as
"no outcome", never as a failure and never as a judgement about the person, and
writes its own one-line record of what happened so the next call knows there
was a call at all.

## What each answer does

The agent reports; YE decides. The campaign's own limits are applied on top
and always win.

| The call came back | What the campaign does |
|---|---|
| `completed` | Settles the contact, goal achieved. No more calls. |
| `stop` | Settles the contact and adds the number to **this campaign's** do-not-call list. |
| `incomplete` + a real, parseable `callback_requested_time` | Books the time the person asked for. See below. Wins even if `immediate_callback_needed` also says `yes` — a real time is a promise a human can act on, and the time's own description already tells the agent to leave it blank when immediate is `yes`, so a real time arriving anyway means an explicit request that should win. |
| `incomplete` + `immediate_callback_needed = yes`, no real time | Calls back after **3 minutes** — minutes rather than hours, because the person is still sitting by the phone. The same three minutes on every campaign. **Once an hour, though:** if the previous immediate for this contact was less than an hour ago, this one waits a full hour from now instead, so a line that keeps dropping is not rung every three minutes for as long as the budget lasts. |
| `incomplete`, neither of the above | Calls again after the campaign's retry cooldown — the same wait a no-answer gets. |
| nothing at all | The same as the row above. The journey says "no outcome" for that call. |

Every one of these waits is rolled into the campaign's calling hours: a call
that would land after the window closes moves to the next opening instead.

**A promised time beats the cooldown.** If somebody asks to be called on
Tuesday afternoon, the next call is booked for then rather than for the retry
wait — an explicit promise is better information than a guess. One thing can
stop a promise being kept, and it is your own retry count rather than anything
the conversation did: the call that carried the promise was the last one the
contact's total allows.

**A dropped call is not a promise.** `immediate` is YE deciding to ring back,
not the person asking to be rung back — so it is scheduled and shown as a
resumed call and never as a callback somebody requested, and its three-minute
gap is fixed rather than drawn from the retry cooldown. Tuning the Retry Calls
section changes when a follow-up lands; it does not change how fast an
interrupted conversation is picked back up.

## When somebody asks not to be called

If a conversation makes clear the person does not want further calls — "take me
off your list", "stop calling me" — the agent should acknowledge it and wrap up
politely, and answer `stop`. Say so in your own prompt, in whatever words suit
your script; YE's block no longer carries that instruction.

The number then goes on **this campaign's** do-not-call list:

- This campaign will not dial it again, even if the contact is deleted and
  re-imported later. Contacts already waiting in its queue are settled out.
- **Other campaigns in the workspace are unaffected.** Somebody who says "stop
  calling me about this" has opted out of the conversation they were called
  about, not of every conversation you might ever have with them — so a
  different campaign, run for a different reason, asks its own list.
- The contact's journey shows why calling stopped, and an admin can read the
  campaign's list and unlist a number.

Unlisting makes the number dialable by that campaign again, but it does not put
a contact the exclusion already settled back into the queue — that is a
decision somebody should make deliberately, by adding them again.

**Every campaign records opt-outs**, because every campaign's agent is asked
the question. There is no longer a shape of campaign that hears "take me off
your list" and dials the number again.

## What ends the follow-ups

For each contact, calling stops when the first of these happens:

- **The conversation is complete** — the agent answers `completed`, judging
  that against your prompt. The contact completes, goal achieved.
- **The person opts out** — `stop`. The contact completes and the number is
  listed for this campaign.
- **The calls run out** — the contact has had retries + 1 calls of every kind.
  The contact completes with the goal marked not achieved; everything the
  campaign learned about them is kept and is visible on the contact.

Silences — voicemail, no answer, busy — are retried under the campaign's
ordinary retry settings, and they spend the same budget: a contact whose calls
all went to voicemail has used them up just as surely as one that kept
answering. They are not conversations, though, and the agent is never asked to
judge one.
