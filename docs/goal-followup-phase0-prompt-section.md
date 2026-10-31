# The prompt half of the follow-up fix — what is left of it

**For whoever owns the agent prompt. Nothing in this repo applies it.**

> ## Withdrawn: do not paste the Phase 0 section
>
> This document used to carry a `PHASE 0 — FOLLOW-UP CALL CHECK` section to
> paste into a customer's prompt. **That section is built on variables YE no
> longer sends.** A prompt carrying it now reads a campaign-context block that
> is not there any more, for a follow-up flag that never arrives.
>
> **If your prompt mentions any of these, take it out:**
> `{{follow_up_instruction}}`, `{{campaign_goal}}`, `{{call_number}}`,
> `{{previous_attempts}}`, `{{memory}}`, `{{last_call_note}}`,
> `{{goal_missing}}` — and any section that tells the agent to read "the
> campaign context block" or "Still needed for the goal".
>
> The section as published is preserved at the end of this document, as the
> record of what was measured. It is not instructions.

## What YE sends now

One variable, `next_call_instructions_vocobaseplatform`, and only on a
follow-up call. YE writes its own block at the **top** of the agent prompt,
between marker lines, and that block is the only place the variable is named:

```
[Call note — system managed, do not edit]
# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)

{{next_call_instructions_vocobaseplatform}}

========================================
[end call note]
```

The value is a JSON object carrying YE's own standing sentence — *"Last call
was incomplete. THIS IS A FOLLOW-UP CALL … continue from where the previous
call stopped"* — the previous call's timestamp when it is readable, and the
instructions the **previous call's own agent** wrote for this one, including
the exact lines to open with. On a first conversation no value is sent at all
and the placeholder renders empty, which is what makes the header inert rather
than a claim about a call that never happened.

The full contract is in [`goal-campaigns-agent-guide.md`](goal-campaigns-agent-guide.md).

## Why the prompt half is no longer needed for turn 1

Phase 0 supplied two things, and both now arrive inside the value instead:

1. **"This is a follow-up, do not run the opening."** YE's standing sentence
   says it on every follow-up call, under a header that says it overrides
   everything else, at the top of the prompt.
2. **A concrete line to say.** Phase 0's rule 2 example was the load-bearing
   half — the measurement below is what established that this model follows a
   line to say far better than a rule to apply. That finding did not change;
   **who writes the line did.** The previous call's agent now writes it, about
   this person and this drop point, instead of the prompt carrying one generic
   example for every call.

**Measured, on the full 30-scenario suite** (contender G, 2026-09-04, 60 cells;
run `h2h-G-full`, written up in
[`plans/2026-09-03-call-note-run-1.md`](plans/2026-09-03-call-note-run-1.md) —
the raw runs live on the simulator branch, which is not merged here): across
all 38 follow-up calls, turn one was the written opening line in 35 of them,
and the assembled value reached the agent on 98 of 98 dials. **Turn 1 is solved
without touching the customer's prompt**, which is the whole point of the
contract.

## What is still open, and what a prompt could still fix

**Turn 2 relapse.** The same run: twelve calls fell back into the scripted flow
at turn two or later, seven of them repeating something genuinely already said.
**Six of the eleven true repeats are the three-item menu being offered again.**

That is the one thing the old design (engine variable + Phase 0) still does
better, and it does it with a single prohibition: Phase 0's rule 3 forbids
re-offering the menu. Every contender without such a line re-offers it.

**The experiment has not been run.** The recommendation on record is one line
at the head of PHASE 4 — skip the menu entirely when the CRITICAL CONTEXT block
carries instructions — measured against contender G. Until it is run, this
document has no section to hand you: pasting the withdrawn one below would
reintroduce the dead variables, and the surviving idea has never been measured
under the current contract.

Two caveats on the numbers, both from the same reading:

- **The suite understates the problem.** Five scenarios with follow-up calls
  declare no re-ask check at all, and S23's needle list omits the menu, so
  several relapses are invisible to the scorer. Fixing that would have turned
  48/60 into roughly 42/60 — and would change what every earlier number means,
  so it is a deliberate decision rather than a tidy-up.
- **The live handset rehearsal remains the gate.** The simulator does not
  replace it.

## What your prompt must carry now

Not a follow-up section — these:

1. **The campaign's objective, in your own words.** "Campaign Goal" in YE is a
   toggle — *follow up until the conversation is complete* — and there is no
   box to write an objective into any more. An agent whose objective lived only
   in the box the toggle replaced is never told what it is calling about, and
   it is this prompt the agent judges "complete" against at the end of every
   call.
2. **The stop behaviour.** YE's block no longer tells the agent to acknowledge
   "take me off your list" and wind the call up; say it yourself.
3. **Nothing that contradicts the block**, which claims to override everything
   else. A CRITICAL rule elsewhere in the prompt insisting on the scripted
   opening is a rule the model has to choose between.

Everything outside YE's markers is yours and is never rewritten.

---

## The record: what was measured under the previous contract

Kept because it is why the design went where it did. **None of it is
instructions**, and the variables it names no longer exist.

The previous contract sent a seventh dial variable, `follow_up_instruction`, as
the first line of a managed campaign block. On a follow-up call it read:

> THIS IS A FOLLOW-UP CALL. You have already spoken to this person; what you
> know is below. Do NOT run your opening: do not confirm identity, do not ask
> for two minutes, do not say you have news, do not offer your menu of items.
> Your first sentence refers to the last call, and then you continue with what
> is still needed and nothing already covered.

**1. The bisect — what the prompt had to contain.** The engine variable is in
place in every row; only the prompt changes. Scenario S04, three languages:

| Prompt, with the engine variable always present | S04 |
|---|---|
| Untouched | **0 / 3** |
| + a CRITICAL-rule paragraph only | **0 / 3** |
| + the Phase 0 section only | **3 / 3** |
| + all five candidate additions | **3 / 3** |

Phase 0 was the whole of the effect and also the minimum. A CRITICAL-rule
version of the same instruction did nothing.

**2. The head-to-head.** Contender B was that design (engine variable +
Phase 0). Contender A carried the whole instruction inside a model-written
note, with no prompt change at all:

| | A: note contract, no prompt change | B: engine variable + Phase 0 |
|---|---|---|
| S11–S20, ten varied situations × 3 languages | 28 / 30 | **30 / 30** |
| S21–S30, ten drop points × Hindi, English | 5 / 20 | **17 / 20** |
| drop points, discounting the "done on call 1" artefact | 6 / 20 | **20 / 20** |

A was rejected, and its fourteen misses were all the same failure: the note was
at the top of the prompt, accurate, carrying an exact resume line, and the
agent still ran the cold opener on call 2.

**3. What changed between A and the shipped contract.** A is not what shipped.
The contract that did — contenders C through G — kept A's premise that the
prompt stays untouched and fixed the three things A got wrong: the header
became `# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)`, the block moved
to the top of the prompt, and the "this is a follow-up" sentence became **YE's
own words wrapped around the model's note** rather than something the model was
asked to restate. On the drop set (16 cells) that took the resumption failures
from A's 11 to G's 2, against B's 0 — a plateau that F, E, C and G share, and
which B still leads by the PHASE 4 prohibition described above.

The contenders, their runs and their failure classifications are in
[`plans/2026-09-03-call-note-run-1.md`](plans/2026-09-03-call-note-run-1.md).

### The withdrawn section, as published

Preserved verbatim for the record. **Do not paste this**; every variable and
block it refers to is gone.

```
-----------------------------------------

PHASE 0 — FOLLOW-UP CALL CHECK (runs before Phase 1, every call)

-----------------------------------------

The campaign context block at the top of these instructions says whether this is the first conversation or a FOLLOW-UP CALL, and what you already know about this person. Read it before you speak.

→ First conversation → continue to Phase 1 as normal.

→ FOLLOW-UP CALL → the rules below override Phase 2, Phase 4, Persona rule 8 and T_ATTEMPT2 for this call:

1. Do NOT confirm identity again if the memory says you spoke to the owner. Do NOT ask for two minutes again. Do NOT say "कुछ news तैयार है".

2. Open by referring to the last call in one line, then go straight to what is still needed. Example shape (adapt to the memory, keep it to one sentence): "नमस्ते {{tbshortbusinessname}} जी, रचना बोल रही हूँ धंधा से — पिछली बार बात बीच में रह गयी थी, reviews वाली बात पूरी करनी थी। दो minute हैं?"

3. Never offer the three-item menu again. Every item the memory marks as delivered is DONE. Offer only what "Still needed for the goal" lists, and if only one thing is left, do not offer a choice — go to that phase directly.

4. Never re-read report numbers the memory says were already heard, unless the customer asks for them.

5. If the memory records a commitment with a time (for example "tonight at 9"), acknowledge it as already agreed and do not ask for the same commitment again; ask only whether it is done, or move on.

6. If the last call note says the customer asked to be called at a particular time, this call IS that callback: say so in the opening line and do not ask when to call.

7. Everything else in these instructions still applies: language rules, CRITICAL-1 to CRITICAL-9, the review appeal if not yet made, the mandate alert if the mandate is broken, and exactly ONE action item at the close.
```

Rule 3 is the one still worth something: it is the menu prohibition, and it is
the residual difference between the shipped contract and the design it
replaced. It would have to be rewritten to read the CRITICAL CONTEXT block
rather than "the memory" and "Still needed for the goal", and then measured.
