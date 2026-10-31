# Call note — run 1 and the head-to-head

Engine: `feat/campaign-sim` on `main` @ 0af5ac3 with the call-note contract
(`2026-09-03-call-note-design.md`). Prompt: the customer's untouched export.

## Full run on S01–S10 (`sim-note-full-1`, note at the END)

21/30. Engine checks all held (callbacks from the `±HH` form booked, DNC,
note carried on every follow-up dial and absent on first dials, caps,
78 dials / 0 duplicate refs). 9.6M input tokens, 7.5 min.

- **S04 ×3 BLOCKED**: the note was correct and rendered at the end of the
  prompt; the bot ran the cold opener anyway. Same as the old block at the end.
- **S07 ×3 FAIL** (non-blocking): the evasive customer was judged
  `completed` on call 1 ("report shared, actions discussed"). The outcome
  description has no objective in it. Open.
- **S10 ×3 FAIL** (non-blocking): a vague "later" became `requested` with a
  suggested time (per the spec's own wording). Open.

**Position**: S04 alone at the TOP (`sim-note-top-1`): 2/3, turn one was the
note's own line. The default is now `top` (commit bd6be7a).

## Head-to-head, two contenders, twenty new scenarios

- **A**: call-note contract, header at the top, untouched prompt.
- **B**: goal-verdict + `follow_up_instruction` + Phase 0 in the prompt
  (commit d76b633), i.e. the earlier winner, which edits the prompt.

S11–S20 (ten varied situations, three languages each):

| | A | B |
|---|---|---|
| cells passed | 28/30 | 30/30 |
| misses | S12 double-drop: hinglish re-asked the owner on call 3; hindi judged call 3 `incomplete`+`immediate`, contact ended FAILED | none |

S21–S30 (ten S04 variants dropping at ten different phases; Hindi and
English only):

| drop right after… | A | B |
|---|---|---|
| S21 owner confirmed | 0/2 | 2/2 |
| S22 agreed to two minutes | 2/2 | 2/2 |
| S23 menu offered | 0/2 | 2/2 |
| S24 first report number | 0/2 | 2/2 |
| S25 report fully delivered | 2/2 | 2/2 |
| S26 festival tip | 0/2 | 2/2 |
| S27 hidden-work item | 0/2 | 2/2 |
| S28 action explained, no commitment yet | 1/2 | 2/2 |
| S29 after the commitment | 0/2 | 1/2 † |
| S30 during the mandate alert | 0/2 ‡ | 0/2 † |
| **total** | **5/20** | **17/20** |

† B's three misses and ‡ one of A's are the same artefact: the report and
one commitment had happened before the drop, the bot judged call 1
`done`, the engine settled, no second call happened. The scenario expected
a follow-up; the verdict was defensible. Counting those as passes: A 6/20,
B 20/20.

A's other fourteen misses are all the cold opener on call 2 ("owner?", "two
minute call, some news"), with the note present at the top of the prompt
and carrying an exact resume line. The note is followed only sometimes.

## Reading

1. **B is the stronger design by a wide margin**, and the difference is the
   Phase 0 section in the prompt: a place in the script that tells the bot
   what to do with the context it was given. Without it, this model reads the
   note at the top of the prompt inconsistently (S04 2/3, drops 5/20).
2. **The note contract's other half is good.** The notes themselves were
   consistently accurate and actionable; callbacks, DNC and the engine paths
   behaved identically under both contracts.
3. **The two open judgement questions are contract questions, not position
   questions**: "polite but uncommitted = completed" (S07) and "vague later =
   requested with a suggested time" (S10). Both are one sentence in a key
   description.
4. Harness notes: the drop scenarios S29/S30 need `nextAction` on call 1 to
   admit `done`; S18/S09-style advisory scenarios run unscripted follow-up
   dials.

Runs: `scripts/simulation-results/{sim-note-full-1,sim-note-top-1,h2h-A-note-top,h2h-A-drops}.md`
in this worktree and `h2h-B-verdict-phase0`, `h2h-B-drops` in
`.worktrees/campaign-sim-b`. Failed cells with every attempt's variables,
transcript and extraction under each run's `failed/`.

## Contender C — the JSON follow-up instruction (`h2h-C-json`)

Your five keys with the fifth renamed `next_call_instructions_vocobaseplatform`
and given the prescriptive description (summary, where it dropped, covered vs
remaining, skip the standard flow, an exact two-step opener, where to resume).
YE assembles the whole JSON object into that one variable and renders it at
the TOP of the prompt; on a first conversation the variable is not sent, so
the block is just its header. **The customer's prompt is untouched — no Phase 0.**

All 30 scenarios, Hindi and English, 60 cells: 47 passed.

### Resumption, the check that measures the actual problem

`resume.no_reask` failures, Hindi and English only, like for like:

| contender | all cells | the ten drop points (20 cells) |
|---|---|---|
| A — free-form note, top, no prompt change | 15 / 40 | **15 / 20 failed** |
| B — goal-verdict + follow-up variable + Phase 0 in the prompt | 3 / 40 | **3 / 20 failed** |
| C — JSON instruction, top, no prompt change | 6 / 60 | **5 / 20 failed** |

Discounting the S29/S30 "judged done on call 1, so no second call happened"
artefact, which hits every contender: B fails 1 of 20 drop points, C fails 3
of 20 (S24/english, S25/hindi, and S29/hindi's cascade), A fails 13 of 20.

### Reading

1. **C is close to B without touching the prompt.** The prescriptive
   description is what closed most of A's gap: asking the bot for an exact
   two-step opener produces a line the next call actually says, where a
   free-form "note" did not. The standing `"note"` field carrying the
   unconditional order does the rest.
2. **B still edges it.** Two or three drop points out of twenty resume
   correctly under B and not under C. If the prompt can carry Phase 0, B is
   the safer choice; if it cannot, C costs two or three drop points in twenty
   and no prompt change at all.
3. **C's other failures are not resumption.** S12/S22/S23 in Hindi are the
   synthetic customer refusing to cooperate on the second call and hanging
   up — the agent had resumed correctly. S07 and S10 are the two open
   description questions, unchanged by any contender.
4. **First calls are clean under C.** Rendering nothing when there is no
   previous call was the right call: every first-call scenario passed.

### Unverified

The new description is 644 characters. Nothing in YE validates managed
descriptions against the 500-character partner limit, but the platform's own
ceiling is unknown; the live rehearsal must confirm the set attaches.

## Three-way comparison, like for like

Hindi and English only, the languages all three contenders ran.

| set | A cells passed | B | C |
|---|---|---|---|
| S11–S20, ten varied situations (20 cells) | 19 | 20 | 19 |
| S21–S30, ten drop points (20 cells) | 5 | 17 | 13 |

Cell counts mix in persona variance and the two open description questions,
so the decisive measure is `resume.no_reask` per drop point. `r` is the
number of resumption failures of two cells:

| drop right after… | A | B | C |
|---|---|---|---|
| S21 the owner confirms identity | 0/2 r2 | 2/2 r0 | 2/2 r0 |
| S22 the two-minute ask | 2/2 r0 | 2/2 r0 | 1/2 r0 |
| S23 the menu is offered | 0/2 r2 | 2/2 r0 | 1/2 r0 |
| S24 the first report number | 0/2 r2 | 2/2 r0 | 1/2 **r1** |
| S25 the report is delivered | 2/2 r0 | 2/2 r0 | 1/2 **r1** |
| S26 the festival tip | 0/2 r2 | 2/2 r0 | 2/2 r0 |
| S27 the hidden-work item | 0/2 r2 | 2/2 r0 | 2/2 r0 |
| S28 the action is explained | 1/2 r1 | 2/2 r0 | 2/2 r0 |
| S29 the commitment is given | 0/2 r2 | 1/2 r1 | 1/2 r1 |
| S30 the mandate alert starts | 0/2 r2 | 0/2 r2 | 0/2 r2 |

S29 and S30 are the artefact: the goal was already met before the drop, every
contender's bot judged call 1 `done`, the engine settled, and no second call
happened — so "no recorded call 2" counts as a resumption failure for all
three equally. **On the eight drop points where a second call actually
happened (16 cells): B fails 0, C fails 2, A fails 11.**

The cells C loses without a resumption failure (S22, S23, S25 in Hindi) are
the synthetic customer refusing to cooperate on the second call after the
agent had resumed correctly.

## Contender D — a memory, a timestamp, and YE's own opening steps (`h2h-D-menu-skip`)

The fifth key stops being a script and becomes an account: **`memory_for_next_call_vocobaseplatform`**,
asked for as "summarize the last call in less than 800 characters … how it
ended, what was discussed, from where the conversation should resume, and
preferences or sentiment". A sixth key, **`call_timestamp_vocobaseplatform`**,
asks when the call happened. The header becomes `# CRITICAL INSTRUCTION`, and
the variable YE assembles carries three fields:

```json
{
  "instruction": "Last call was incomplete. THIS IS A CONTINUATION CALL. … open this call in three steps: Step 1: ALWAYS start with a short, natural, generic one-liner referring to the previous interaction and ask if they can continue now. If the last interaction was more than 1 hour ago, also mention when it happened. Step 2: Wait for their response. Step 3: If they agree, acknowledge and continue …",
  "last_interaction_time": "Last interaction happened at 2026-09-04T10:00+05:30.",
  "memory": "<the ≤800-character account the last call wrote>"
}
```

The opening steps move from the bot to YE. Where C asked the model, at the
end of each call, to write the exact two lines the next call should open
with, D states the steps once, identically for every campaign and every
contact, and leaves the model only the account of what happened. **The
customer's prompt is untouched — no Phase 0, and no PHASE 4 change.**

Ten drop points, Hindi and English, 20 cells. 7.7M input tokens, 6.5 minutes.

### The result

**6 of 20 cells passed; `resume.no_reask` failed in 14.** On the eight drop
points where a second call actually happened (16 cells), **D fails 10** —
against B's 0, C's 2 and A's 11.

| drop right after… | A | B | C | **D** |
|---|---|---|---|---|
| S21 the owner confirms identity | 0/2 r2 | 2/2 r0 | 2/2 r0 | **0/2 r2** |
| S22 the two-minute ask | 2/2 r0 | 2/2 r0 | 1/2 r0 | **2/2 r0** |
| S23 the menu is offered | 0/2 r2 | 2/2 r0 | 1/2 r0 | **1/2 r1** |
| S24 the first report number | 0/2 r2 | 2/2 r0 | 1/2 r1 | **1/2 r1** |
| S25 the report is delivered | 2/2 r0 | 2/2 r0 | 1/2 r1 | **1/2 r1** |
| S26 the festival tip | 0/2 r2 | 2/2 r0 | 2/2 r0 | **0/2 r2** |
| S27 the hidden-work item | 0/2 r2 | 2/2 r0 | 2/2 r0 | **0/2 r2** |
| S28 the action is explained | 1/2 r1 | 2/2 r0 | 2/2 r0 | **1/2 r1** |
| S29 the commitment is given | 0/2 r2 | 1/2 r1 | 1/2 r1 | **0/2 r2** |
| S30 the mandate alert starts | 0/2 r2 | 0/2 r2 | 0/2 r2 | **0/2 r2** |
| **cells passed / resume failures** | 5/20 r15 | 17/20 r3 | 13/20 r5 | **6/20 r14** |

`r` is the number of `resume.no_reask` failures of two cells. S29 and S30 are
the artefact that hits every contender: the goal was met before the drop, the
bot judged call 1 `completed`, the engine settled, and no second call
happened.

### The failure classification

Every one of the ten failures on S21–S28 is a genuine resumption failure.
None is the synthetic customer refusing to cooperate: `resume.no_reask` is in
the failed-check list of every failed cell, and each one's detail quotes the
agent's own opening words. S23/english's five extra failures
(`verdict.*`, `terminal.*`, contact ended FAILED) all cascade from its
resumption failure — the customer got annoyed and the campaign ran out of
dials.

The failure is at **turn 1**, and it is bimodal:

- **Nine of the sixteen cells opened with the PHASE 2 script**, eight of them
  the same sentence word for word: *"जी मैं रचना बोल रही हूँ धंधा Growth Team
  से। आप हमारे काफी पुराने member हैं, इसलिए personally call कर रही हूँ। दो
  minute की call है …"*. S27/hindi went further back still and reopened at
  PHASE 1 — *"Kaur Beauty Salon के owner बोल रहे हैं?"* — asking a person it
  had already identified who they were.
- **The other seven opened exactly as the order asks**, and those openers are
  the best of any contender, because they use the timestamp: *"हमारी कल सुबह
  दस बजे बात हुई थी, पर एक client आ गए थे तो call कट गया था। क्या हम अभी
  continue कर सकते हैं?"* (S21/english), *"हम सुबह दस बजे बात कर रहे थे …"*
  (S22/hindi), *"हमारी पिछली बात landline की वजह से बीच में रुक गयी थी, जो
  आज सुबह दस बजे हुई थी"* (S28/english).

**The memories themselves are not the problem.** They are accurate,
specific and correctly scoped in all sixteen cells — *"Delivered Phase 5A
(Monthly Report) including last month's views (222), leads (8) … Resume from
Phase 6"*. Several of the cells that failed carried a better account of the
call than the cells that passed. The model read the memory and still opened
with the script.

**Nor is it the plumbing.** `variables.instructions_carried` held 36/36:
every follow-up dial carried the assembled object, with the standing order,
the timestamp and the memory, under the header at the top of the prompt. No
first dial carried anything.

### Reading

1. **The hypothesis is refuted, and the reason is the opposite of the one
   expected.** D was meant to test whether a single prohibition was the
   load-bearing part of B's PHASE 0. It never got that far: D regressed to
   near-A (r14 against A's r15) by changing something else entirely, and the
   menu re-offer that cost C five cells barely appears in D's failures
   because the agent usually never reached turn 2 in a resumed state at all.
2. **The bot-written opener was the load-bearing part of C, not the standing
   order.** C and D carry the same unconditional "you have spoken to this
   person before" frame in the same place. The only difference is that C's
   fifth key produced *a concrete line, written for this contact and this
   drop*, and D's produces *a rule to apply* — "start with a short, natural,
   generic one-liner". This is the 2026-09-02 finding again, and sharper:
   this model follows a line to say and does not reliably follow an
   instruction to compose one. Making the steps generic and identical for
   every call is what made them ignorable.
3. **The timestamp is a real improvement, worth keeping in whatever wins.**
   Where the order was followed, naming when the last call was produced the
   most natural openers in any run — and it costs one key and one field. It
   is orthogonal to the opener question and should be carried into C.
4. **A three-step order is not better than a two-step one.** Nothing in the
   failures suggests the count was the problem; the failures are total, not
   partial. No cell followed Step 1 and then dropped Step 3.

### Recommendation

**B if the prompt can be edited; C if it cannot.** D should not ship.

- **B** (goal-verdict keys + `follow_up_instruction` + a 29-line PHASE 0
  section in the customer's prompt) remains the only design that resumes at
  every drop point where a second call happens: 0 failures of 16.
- **C** (five keys, the bot writes the next call's exact two-step opener, no
  prompt change) costs 2 of 16 and requires nothing of the customer. If the
  customer's prompt is not ours to edit — which is the constraint that
  started this comparison — C is the answer.
- **D** costs 10 of 16 and should be abandoned as a whole, but **its
  timestamp key should be lifted into C**: add
  `call_timestamp_vocobaseplatform`, play it back as
  `last_interaction_time` beside C's standing order, and tell the bot's
  opener to use it. That is a small, separately measurable change to C, and
  D's transcripts are the evidence it helps.
- The still-open question the handoff named — whether one prohibition at the
  head of PHASE 4 buys most of PHASE 0 — is **unanswered**, because D never
  tested it. It is still worth one run, applied to C rather than to D.

Run: `scripts/simulation-results/h2h-D-menu-skip.md`; every failed cell with
its dial variables, both transcripts and both extractions under
`scripts/simulation/runs/h2h-D-menu-skip/failed/`, written by
`scripts/simulation/exportFailed.ts`.

## Contender E — C's opener, D's timestamp (`h2h-E-opener-timestamp`)

The combination the D run pointed at. `next_call_instructions_vocobaseplatform`
returns and again asks the bot for the next call's **exact opening lines**,
with the format stated:

> Step 1: "[short, generic one-liner that simply points at the previous
> interaction (without going into specifics) and asks if we can continue]"
> → if the user agrees → Step 2: "[one-liner to set the context and continue
> from where the call stopped]"

plus a sixth point for preferences and sentiment. `call_timestamp_vocobaseplatform`
is kept from D. The header returns to `# CRITICAL CONTEXT`, and the value YE
assembles is `{note, previous_call_timestamp?, instructions}`. The customer's
prompt is untouched.

Ten drop points, Hindi and English, 20 cells. 390s.

### The result

**14 of 20 cells passed; `resume.no_reask` failed in 5.** On the eight drop
points where a second call actually happens (16 cells), **E fails 2** — level
with C, far ahead of A and D, still behind B.

| drop right after… | A | B | C | D | **E** |
|---|---|---|---|---|---|
| S21 the owner confirms identity | 0/2 r2 | 2/2 r0 | 2/2 r0 | 0/2 r2 | **2/2 r0** |
| S22 the two-minute ask | 2/2 r0 | 2/2 r0 | 1/2 r0 | 2/2 r0 | **1/2 r0** |
| S23 the menu is offered | 0/2 r2 | 2/2 r0 | 1/2 r0 | 1/2 r1 | **2/2 r0** |
| S24 the first report number | 0/2 r2 | 2/2 r0 | 1/2 r1 | 1/2 r1 | **2/2 r0** |
| S25 the report is delivered | 2/2 r0 | 2/2 r0 | 1/2 r1 | 1/2 r1 | **1/2 r1** |
| S26 the festival tip | 0/2 r2 | 2/2 r0 | 2/2 r0 | 0/2 r2 | **2/2 r0** |
| S27 the hidden-work item | 0/2 r2 | 2/2 r0 | 2/2 r0 | 0/2 r2 | **1/2 r1** |
| S28 the action is explained | 1/2 r1 | 2/2 r0 | 2/2 r0 | 1/2 r1 | **2/2 r0** |
| S29 the commitment is given | 0/2 r2 | 1/2 r1 | 1/2 r1 | 0/2 r2 | **1/2 r1** |
| S30 the mandate alert starts | 0/2 r2 | 0/2 r2 | 0/2 r2 | 0/2 r2 | **0/2 r2** |
| **cells passed / resume failures** | 5/20 r15 | 17/20 r3 | 13/20 r5 | 6/20 r14 | **14/20 r5** |

**On the eight drop points where a second call happens (16 cells): B fails 0,
C fails 2, E fails 2, D fails 10, A fails 11.**

### The failure classification

- **Two genuine resumption failures**, both English, both turn 1, both the
  verbatim PHASE 2 script: S25/english and S27/english. Same shape as C's and
  D's losses.
- **S22/english is not a resumption failure.** Its turn 1 was a correct
  continuation opener — *"पिछली बार हमारी बात बीच में ही कट गयी थी, क्या हम
  continue कर सकते हैं?"*. It lost on `verdict.next_action` and the terminal
  checks: call 2 was judged `incomplete` + `flexible` where the scenario
  expected `completed`, so the engine spent a third dial and the contact ended
  FAILED. That is the synthetic customer and the outcome description, not the
  design.
- **S29/hindi, S30/hindi, S30/english are the artefact** — goal met before the
  drop, call 1 judged `completed`, contact settled, no second call. It hits
  every contender.
- **S29/english passed** — the first time any contender has passed an S29
  cell. One cell is not a fix for the artefact, but it is the first crack in it.

**15 of the 17 second calls opened with a proper continuation line**, and the
mechanism is visible in the artefacts: the agent recites the instructions'
Step 1 *verbatim*. S24/english's dial carried
`Step 1: "नमस्ते! मैं धंधा Growth Team से रचना बोल रही हूँ, पिछली बार बात बीच
में रह गयी थी, क्या हम continue कर सकते हैं?"` and turn 1 was that sentence,
character for character.

### The timestamp is inert as specified

`previous_call_timestamp` reached **every** follow-up dial correctly
(`variables.instructions_carried` 37/37, and the field is present in the
recorded variables). **Nothing used it: 0 of 17 second-call openers name when
the last call was.**

The reason is in the key description, not the plumbing. The bot composes Step 1
at the end of the *previous* call, before any timestamp is rendered, and E's
format tells it to keep Step 1 "generic … without going into specifics". So the
line it writes cannot refer to a time, and the agent recites that line. D's
openers *did* name the time — *"हमारी कल सुबह दस बजे बात हुई थी"* — because D's
standing order told the model to do it at dial time, when the timestamp was in
front of it.

Two ways to make it earn its place, both one sentence:

1. Add to Step 1's description: *"if the previous call was more than an hour
   ago, also mention when it happened"*, and let the bot write the time into
   the line. It has `call_timestamp_vocobaseplatform` in the same extraction,
   so it knows it.
2. Or leave the key and drop the field from the assembled value, accepting that
   the opener stays timeless.

Until one of those is done, the sixth key is a key the platform must accept
and nothing reads.

### Reading

1. **E ties C on the measure that matters and is tidier in form.** Both fail
   2 of 16. E passes one more cell overall (14 vs 13) and its openers are far
   more uniform, because the format is stated rather than left to the model.
2. **E's openers are more reliable but less specific than C's.** C's named the
   actual reason the line dropped — *"आपकी delivery आ गयी थी"*, *"आपकी बेटी का
   call आ गया था"*. E's are deliberately generic. That is what the description
   asks for, and it is a real trade: the generic form is what makes them
   uniform, and it is also why the timestamp goes unused.
3. **B still leads.** 0 of 16 against E's 2. The gap is the same gap as
   before: a place in the customer's own script that tells the agent what to
   do with the context it was given.
4. **The two E failures are both English and both at turn 1.** Nothing
   distinguishes S25 and S27 from the eight drop points E handled cleanly, so
   this reads as residual variance in following a recited line, not a
   structural hole.

### Recommendation, unchanged in shape

**B if the customer's prompt can be edited; E if it cannot** — E rather than C,
since they are level on resumption and E's stated format gives more consistent
openers for the same cost. Fix the timestamp before shipping E: either make
Step 1 name the time or stop sending the field.

The PHASE 4 prohibition question is still unanswered and is now worth running
against E.

Run: `scripts/simulation-results/h2h-E-opener-timestamp.md`; failed cells under
`scripts/simulation/runs/h2h-E-opener-timestamp/failed/`.

## Contender F — E's contract, instructions framed into sections (`h2h-F-framed`)

One change from E, nothing else: the instructions key asks for its answer
under five labelled headings rather than as running prose.

```
(1) PREVIOUS CALL SUMMARY: […]
(2) DISCUSSED SO FAR: […]
(3) RESUME FROM: […]
(4) OPENING SCRIPT: [skip the standard flow, Step 1: "…" → if the user agrees → Step 2: "…"]
(5) KEEP IN MIND: […]
```

The block, the assembled `{note, previous_call_timestamp?, instructions}`
value, `call_timestamp_vocobaseplatform` and the 1200-character cap are
unchanged, so any movement is attributable to the framing alone. The
description grows from 876 to 939 characters.

### The result

**16 of 20 cells passed; `resume.no_reask` failed in 4.** On the eight drop
points where a second call actually happens (16 cells), **F fails 1** —
against B's 0 and E's 2.

| drop right after… | B | E | **F** |
|---|---|---|---|
| S21 the owner confirms identity | 2/2 r0 | 2/2 r0 | **1/2 r1** |
| S22 the two-minute ask | 2/2 r0 | 1/2 r0 | **2/2 r0** |
| S23 the menu is offered | 2/2 r0 | 2/2 r0 | **2/2 r0** |
| S24 the first report number | 2/2 r0 | 2/2 r0 | **2/2 r0** |
| S25 the report is delivered | 2/2 r0 | 1/2 r1 | **2/2 r0** |
| S26 the festival tip | 2/2 r0 | 2/2 r0 | **2/2 r0** |
| S27 the hidden-work item | 2/2 r0 | 1/2 r1 | **2/2 r0** |
| S28 the action is explained | 2/2 r0 | 2/2 r0 | **2/2 r0** |
| S29 the commitment is given | 1/2 r1 | 1/2 r1 | **1/2 r1** |
| S30 the mandate alert starts | 0/2 r2 | 0/2 r2 | **0/2 r2** |
| **cells passed / resume failures** | 17/20 r3 | 14/20 r5 | **16/20 r4** |

**On S21–S28 (16 cells): B 16/16 r0, F 15/16 r1, E 13/16 r2.**

### The failure classification

- **One genuine resumption failure: S21/english.** Unlike E's two, which were
  one turn late, this one never spoke the written Step 1 at all — turn 1 was
  the cold opener, turn 2 the three-item menu, turn 3 the report. A full
  restart.

  It is also the drop point where a restart is hardest to distinguish from
  correct behaviour. The instructions said `(3) RESUME FROM: Phase 2 Step 3
  (Introduction and micro-commit)` — at the earliest drop the resume target
  *is* the introduction, so an agent obeying the summary and an agent running
  its script produce nearly the same words. Contender D lost S21 both ways for
  the same reason.
- **S29/hindi, S30/hindi, S30/english are the artefact** — goal met before the
  drop, call 1 judged `completed`, contact settled, no second call. It hits
  every contender. S29/english passed, as under E.
- **No cell failed for any non-resumption reason.** E's S22/english verdict
  loss does not recur; F passed that cell.

### The frame held, and it is cheap

- **36 of 36 instructions carried all five labels.** Not one answer drifted
  back to prose.
- **372–794 characters**, against a 1200 cap — the framing did not inflate the
  answer, and `KEEP IN MIND` earned its place with lines like *"Customer was
  polite but busy; keep the intro brief and high-value."*
- `variables.instructions_carried` held **37/37**.

### Reading

1. **Framing the same request into labelled sections halved E's resumption
   failures** (2 → 1 of 16) and recovered three cells (13 → 15 of 16). The
   material asked for is identical; only the shape of the answer changed.
2. **F is now within one cell of B**, without touching the customer's prompt —
   the closest any prompt-untouched contender has come.
3. **F's single failure is at the hardest drop point**, where the correct
   resume target and the cold opening coincide. That is worth separating from
   ordinary disobedience before treating it as a gap.
4. **The timestamp remains unused**, exactly as under E: no F opener names when
   the last call was, because Step 1 is still specified as generic and is still
   composed a call earlier. Unchanged recommendation — either let Step 1 name
   the time, or stop sending the field.
5. **Callback acknowledgement is still absent.** Measured separately on
   S02/S03/S11/S19 (`h2h-E-callbacks`, and B's `h2h-B-verdict-phase0`): neither
   B nor E ever opens a requested callback by saying so. F changes nothing
   about that, because the Step 1 spec it inherits does not mention callbacks.

### Recommendation

**F is the one to ship if the customer's prompt cannot be edited**, replacing
the earlier "E if it cannot". B still leads by one cell of sixteen, and that
gap is the same PHASE 0 hook it has always been.

Before shipping F, two one-clause fixes worth making together and measuring
once: let Step 1 name when the previous call was (which uses the timestamp
already being sent), and let Step 1 say so when the customer asked to be
called back.

Run: `scripts/simulation-results/h2h-F-framed.md`; failed cells under
`scripts/simulation/runs/h2h-F-framed/failed/`.

## Contender G — the full suite (`h2h-G-full`)

Contender F with the five sections unnumbered and two reworded: `DISCUSSED SO
FAR` → `ALREADY COVERED`, and `RESUME FROM` asks the bot to *describe* where
to resume rather than to list pending tasks. Block, assembled value,
`call_timestamp_vocobaseplatform` and the 1200-character cap all unchanged.
The description shrinks from F's 939 to 879 characters.

**All 30 scenarios, Hindi and English — 60 cells.** 20.1M input tokens,
1,485 completions, 3h56m. The first full-suite run of any contender since C.

### The result

**48 of 60 cells passed.** Engine invariants clean: `dnc.no_dial_after_stop`
8/8, `variables.instructions_carried` **98/98**.

| failure | cells | what it is |
|---|---|---|
| `resume.no_reask` | S04/hi, S12/hi, S25/en, S27/en | genuine, all at **turn 2** |
| settled-on-call-1 artefact | S29 ×2, S30 ×2 | the goal was met before the drop |
| S07 (advisory) | ×2 | the open "polite but uncommitted = completed" question |
| S10 (advisory) | ×2 | the open "vague later = requested + invented time" question |

On the drop set **S21–S28 (16 cells): G fails 2** — level with E and C,
one behind F, two behind B.

| | A | B | C | D | E | F | **G** |
|---|---|---|---|---|---|---|---|
| resume failures, S21–S28 (16 cells) | 11 | **0** | 2 | 10 | 2 | 1 | **2** |

F's 1 and E's, C's and G's 2 are within each other's noise; B's 0 is not.

### Turn 1 is solved. Turn 2 is not.

Across **all 38 follow-up calls in the run**, checked directly against the
three scripted phrases rather than only where the scorer looks:

- **Turn 1 was the script in 3 calls** (S10/hindi ×2, S11/hindi). The opening
  line the previous call wrote is now recited almost universally.
- **Turn 2 or later relapsed into the script in 12 calls.**

Splitting those 12 by whether the thing repeated had *actually been said
before*:

| | count |
|---|---|
| true repeat — already said in an earlier call | 7 |
| legitimate — the menu genuinely had not been offered yet | 5 |

Counting whole cells, **10 of the run's cells contain a true repeat**:
S02/hi, S04/hi, S10/hi, S11/hi, S12/hi, S15/hi, S23/en, S23/hi, S25/en,
S27/en. **The scorer flagged 4 of those 10.**

**Six true repeats went unmeasured**, for two separate reasons:

1. **Five scenarios with follow-up calls declare no `mustNotReask` at all** —
   S02, S10, S11, S15, S19. Only S04, S12 and S21–S30 carry the check. So a
   relapse in the callback and double-drop scenarios is invisible.
2. **S23's needle list omits the menu.** S23 is *drop at the menu*, so the
   menu had been offered; re-offering it is a repeat. Its `mustNotReask` is
   `['दो minute की call है', 'owner बोल रहे हैं']`, inherited from S21 and S22
   where the menu genuinely had not been reached. Both S23 cells re-offered
   the menu on turn 2 and both passed.

**Six of the eleven true-repeat instances are the three-item menu.** That is
the same PHASE 4 re-offer that cost contender C five of its eight lost cells,
and it is now the single dominant remaining failure mode.

### Reading

1. **The opening-line mechanism is done.** Three script openings in
   thirty-eight follow-up calls, and the run carried the assembled value on
   98 of 98 dials. Nothing in G's remaining failures is about turn 1.
2. **G is not measurably different from F or E on resumption.** The framing
   change that separated F from E did not repeat here; treat F, E and G as one
   plateau at 1–2 failures of 16, and B as the only thing above it.
3. **What separates B is still PHASE 4.** B's advantage is a prompt section
   that explicitly forbids re-offering the menu. Every contender without it
   re-offers the menu on turn 2, and the only reason G looks close to B is
   that most of those re-offers fall outside the scorer's reach.
4. **The suite understates the problem and should be fixed before the next
   run.** Adding the menu needle to S23 and a `mustNotReask` to S02, S10, S11,
   S15 and S19 would have turned this run's 48/60 into roughly 42/60. Doing so
   changes what every past number means, so it is a deliberate decision, not a
   tidy-up.
5. **The timestamp is still unused and callbacks are still unacknowledged** —
   unchanged from E and F, because G inherits the same Step 1 clause.

### Recommendation

**The next run should be the PHASE 4 prohibition against G**, not another
description reword. That is the experiment the original contender-D handoff
proposed and which has never actually been run: one line at the head of
PHASE 4 telling the agent to skip the menu entirely when the CRITICAL CONTEXT
block carries instructions. The evidence for it is now direct — the menu is
six of eleven true repeats — and it is the one thing B has that G does not.

It does require editing the customer's prompt, which is what C, E, F and G
exist to avoid. If the prompt is genuinely untouchable, **G (or F) is the
answer and the menu re-offer is the residual cost**, and it should be measured
honestly by fixing the suite first.

Run: `scripts/simulation-results/h2h-G-full.md`; failed cells under
`scripts/simulation/runs/h2h-G-full/failed/`.
