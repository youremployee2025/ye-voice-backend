# Campaign simulator — run 1 (`sim-full-1`)

First full run of the simulator described in
`2026-09-02-campaign-simulator-design.md`, against `feat/goal-verdict` at its
final state (no engine code changed between the branch point and 63c31cb, so
the engine under test is the one in PR #25). Ten scenarios × three languages,
60 conversations, one synthetic contact per cell.

**Caveat that governs every prompt finding below:** the agent prompt fixture
used was the copy pasted into chat with its line breaks lost
(`agent-prompt.UNFORMATTED.md`). Phase order, rules and wording survive; layout
does not. Re-run with the exported prompt file before treating any prompt
finding as final. Engine findings are unaffected: the engine never sees the
prompt.

## Verdict: BLOCKED

| Scenario | hinglish | hindi | english |
|---|---|---|---|
| S01 achieved-first-call | ✅ | ✅ | ✅ |
| S02 callback-weekday-time (blocking) | ✅ | ✅ | ✅ |
| S03 callback-relative | ✅ | ✅ | ✅ |
| S04 drop-midway-resume (blocking) | ⛔ | ⛔ | ⛔ |
| S05 dnc-english (blocking) | ✅ | ✅ | ✅ |
| S06 dnc-hindi (blocking) | ✅ | ✅ | ✅ |
| S07 never-achieved | ✅ | ✅ | ✅ |
| S08 silence-then-achieved | ✅ | ✅ | ✅ |
| S09 wrong-person (advisory) | ✅ | ✅ | ✅ |
| S10 not-interested-soft | ✅ | ✅ | ✅ |

The block is `resume.no_reask` on S04 in all three languages: on the second
call the agent re-offered the full three-item menu although the memory it was
given said the report had been heard and the customer cared about reviews.

## What the engine did (all held)

- Verdict agreement 54/54 on `next_action` and 54/54 on `goal_achieved`
  across every persona call.
- Callbacks: S02 parsed "Tuesday, after five in the evening" to
  `2026-09-08T17:00:00+05:30` and S03 "kal subah gyarah baje" to
  `2026-09-03T11:00:00+05:30` in every language; the engine booked each at
  exactly that instant and the follow-up dial left on it.
- Do-not-call: every S05/S06 cell produced `stop`, a `DoNotCall` row for the
  campaign, and no dial after it (Task 10's claim-time check is on this
  branch).
- Memory continuity: every follow-up dial carried the previous call's
  returned `memory` verbatim, `call_number`/`previous_attempts` correct,
  `last_call_note` derived on every attempt including silences (S08's
  conversation ran as call 3 after busy and no-answer).
- Caps: S07's six conversations ended COMPLETED/false after five follow-ups;
  no contact exceeded its budget.
- Invariants: 78 dials, zero duplicate references, every contact terminal,
  zero mock concurrency breaches, zero webhook or conversation failures.
- Cost: 16.5M input tokens, 61k output, 1,164 completions, 8.1 minutes wall.

## What the prompt did (review of all 60 packets)

Graded by three Claude Code passes against `scripts/simulation/review/RUBRIC.md`;
the per-packet tables are `runs/sim-full-1/review/FINDINGS-*.md` (gitignored,
on disk). Consistent across every scenario and language:

1. **Follow-up calls restart the cold script.** All 18 follow-up conversations
   opened with the owner check, the "two-minute call" ask and the three-item
   menu, verbatim, whatever `memory` and `last_call_note` said. Customers
   noticed in most of them ("kal aapne call kiya tha", "I told you to call
   after five, right?", "teesri baar call kar rahi hain"). The memory is
   consulted only once the customer forces a redirect. YE's block ("Never ask
   again for anything you already know") is one line at the end of a
   74k-character prompt whose own phase script wins. This is the block that
   S04 fires on; it is the same behaviour in S02, S03, S07 and S10 where no
   deterministic check happens to catch it.
2. **The extractor launders the agent's claims into memory.** With
   `tbautopaystatus: ACTIVE`, the agent told S07 customers their automatic
   payment had failed; memory, `goal_missing` and `next_action_reason` then
   carried "autopay mandate failed" as a customer fact for the rest of the
   sequence. Similar: "aware of the Growth Action button", "not active in the
   app" (against `tbdayssinceappopen: 1`). Only customer turns should count as
   evidence about the customer.
3. **Memory keeps what was committed, loses when.** "Tonight after nine",
   "today" dropped in several S08/S10 memories; the callback time survived
   only in `callback_requested_at`. Memory also never records who was spoken
   to (owner vs staff), which is what causes the owner re-ask on every
   follow-up, and on S07 it went byte-identical from call 3 onward, so the
   customer's rising weariness never reached the next call.
4. **Same-call double asks come from the script order.** The Photo Upload
   block re-asks a commitment the customer just made; the reviews ask fires
   again right after the customer committed to reviews ("wahi toh maine abhi
   kaha"). Closing recaps demote "tonight" to "this week".
5. **Template facts spoken against the data.** "App hasn't been opened in a
   while" with `tbdayssinceappopen` 0–2; "your zero reviews got AI replies"
   with `tbm4repliedcount: 0`; Photo Upload pitched as the top pending action
   with `tbmissingfeatures: All Done`. No zero guards in the prompt's template
   fills. (One grader row claiming S02 quoted S03's numbers was checked and is
   wrong: both contexts carried their own contact's values.)
6. **One DNC near miss.** S06/english: to "Don't call me again and take my
   number off your list" the agent answered with a report line and "kal subah
   ya shaam?". The verdict and memory still said `stop`, so the engine did the
   right thing; the spoken turn did not.
7. **Language.** The agent spoke Devanagari Hindi on all 60 calls, including
   the 20 where the persona spoke only English, following the wrapper's
   "continue in the language of your most recent marker" rule. The `english`
   axis therefore tests the persona's language, not the agent's.
8. **S09 policy.** "Owner abroad, no return date" gave `call_again` with an
   honest reason in every language; the engine will re-dial a relative daily
   until the cap. A stop-or-long-defer rule for this case is a product
   decision.

## Harness notes from the run

- Model quirks handled: the platform wrapper's `[Turn Number: N | Responded
  in: X]` prefix is stripped from spoken text and kept in context; a literal
  spoken "end_call()" appeared in a few calls where the model wrote the tool
  name instead of calling it, and the persona hung up instead.
- S09's follow-up dials after the persona call had no scripted rule and ran
  through the mock's random lifecycle; harmless for S09's advisory checks,
  but a scenario with `call_again` should script its later dials.
- Actual cost was 1.5× the pre-run estimate; defaults now 11 turns and 25k
  system tokens.

## Recommendations

- Do not run the production campaign on this prompt with follow-ups on until
  finding 1 is addressed: either the prompt gains an explicit
  `call_number > 1` branch (skip the owner check and the menu for delivered
  items, open by referencing the last call), or YE's managed block is
  strengthened and moved where the prompt's phase script cannot override it.
  Re-run S04 (and S02/S10 with the re-ask needles widened) to confirm.
- Ask the extraction, in the `memory` description, to record who was spoken
  to, every commitment with its time in the customer's words, every decline,
  and to trust contact values over the agent's own statements.
- Decide S09's policy and the memory-length open question from the design.
- Then the live rehearsal: 10–20 handsets on production under
  `DIALER_TEST_ALLOWLIST`. Nothing here proves webhook order, telephony,
  speech recognition, barge-in or the platform's fallback extraction.

## Iterations after run 1 (formatted prompt, S04 in three languages each)

| Run | Change | S04 result | What the transcripts showed |
|---|---|---|---|
| `sim-phase0-1` | Prompt: a Phase 0 follow-up rule before Phase 1; `T_ATTEMPT2` scoped to memory-less redials | 1/3 pass | Hindi used the new opening line then still ran the menu; Hinglish and English ran the cold opener until the customer pushed back |
| `sim-crit10-1` | Prompt: the rule promoted to CRITICAL-10 plus skip lines at the head of Phases 2 and 4 | 3/3 "pass" | Every language still ran the cold opener as turn one; the pass was the scorer's leniency (opening turn exempt, only the three-item phrase as a needle). Scorer tightened: every turn counts and S04 lists the opener's phrases. Re-scored: 0/3 |
| `sim-prepend-1` | Engine: `withGoalBlock` writes the block at the TOP of the prompt | 0/3 | Block confirmed first in the system instruction; cold opener unchanged. Position is not the cause |
| `sim-followup-var-1` | Engine: a seventh goal variable, `follow_up_instruction`, rendered by YE ("this is a follow-up call, do not run your opening…" when a memory exists, a first-call line otherwise) as the block's first line | 3/3 | Turn one refers to the last call and goes straight to what is still needed, in every language, without the customer having to object |

Conclusion: this model does not act on a conditional written into the prompt
("if call number is 2 or more…"), wherever it sits and however it is
emphasised. It does act on an unconditional imperative that is simply present
or absent. YE knows whether anyone has been spoken to, so YE makes the
decision and the model receives the result. The two engine commits (block at
top, `follow_up_instruction`) live on `feat/campaign-sim` and belong in the
goal-verdict PR; the prompt-side Phase 0 / CRITICAL-10 edits are in the
simulator's fixture only and are the prompt owner's to adopt or drop.

Still open after the S04 fix: whether the other follow-up scenarios (S02,
S07, S10) and the first-call scenarios are unchanged under the new block, and
the review findings 2–8 above, which the fix does not address.

## Run 2 (`sim-full-2`) and the A/B on the prompt

Run 2: the untouched exported prompt with the engine's `follow_up_instruction`
and block-at-top. 26/30 passed. S04 failed in all three languages with the
cold opener as turn one; S02/hinglish failed because the persona never said
its callback line (model variance on the persona side; the `call_again`
verdict was right for what was said). Every other cell, including every
first-call scenario and S07's six-call memory chain, was unchanged by the new
block.

Immediately after, S04 alone on the CRITICAL prompt (Phase 0, CRITICAL-10,
the Phase 2/4 skip lines, `T_ATTEMPT2` scoped) with the same engine
(`sim-critical-var-1`): 3/3, turn one is the follow-up line in every
language. This reproduces `sim-followup-var-1`.

So the fix is the pair, and neither half works alone:

- **YE renders the decision** (`follow_up_instruction`, present only when a
  memory exists) — without it the CRITICAL prompt alone passed 1/3 and 0/3 on
  the strict scorer.
- **The prompt acknowledges the YE block in its own top-precedence list**
  (CRITICAL-10 and the phase hooks) — without it the engine's instruction was
  read and ignored, 0/3.

Which of the five prompt additions are load-bearing is not yet isolated; the
diff between the two prompts is `git diff 08a5b60 0960ce6 --
scripts/simulation/fixtures/agent-prompt.md`. Bisecting it costs one S04 run
(~2M tokens) per candidate.

## Bisecting the prompt hook (S04 × 3 languages, engine fix in place)

| Prompt | S04 |
|---|---|
| untouched | 0/3 |
| + CRITICAL-10 only | 0/3 (Hinglish mentioned the last call, then ran the two-minute line) |
| + Phase 0 only | 3/3, turn one is the follow-up line in every language |
| + all five (Phase 0, CRITICAL-10, phase hooks, T_ATTEMPT2) | 3/3 |

Phase 0 is the load-bearing addition, and its example opening sentence is
what the model says: this model follows a concrete line to speak, not a
rule about precedence. The recommended prompt change is therefore Phase 0
alone (29 lines, one section before Phase 1, no other edit), committed as the
fixture; the untouched export remains at commit 08a5b60. Together with
YE's `follow_up_instruction`, S04 passes; either alone fails.
