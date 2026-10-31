# Campaign simulator — design

**Status: built on `feat/campaign-sim` (rebased onto `feat/goal-verdict` @ 63c31cb); first full run recorded in `2026-09-02-campaign-simulator-run-1.md` — BLOCKED on S04 (follow-up calls restart the script).**

A text-only, end-to-end rehearsal of a goal campaign: synthetic customers
played by a model talk to the real agent prompt on the real production model,
the real extraction shape judges each call, and the real engine schedules
every follow-up. No telephony, no audio, no real call is ever placed.

Base: `feat/goal-verdict` @ 6e57da1. Depends on that branch's
`goalPromptBlock.ts`, `goalVariables.ts`, `GOAL_VERDICT_DESCRIPTIONS` and the
mock's real event order (its Tasks 4–6 and 13, all landed).

## Why

The engine is proven by the conformance and battle harnesses, but every
verdict they see is scripted. Nothing exercises the model's judgement, and
the questions the next production run hangs on are exactly judgement
questions:

- when a customer says "call me Tuesday after five" or "kal subah", does the
  verdict come back `call_back_at` with a time the engine books in the right
  slot;
- when a customer hangs up partway, does the next call carry a faithful
  memory and resume at the right phase of the prompt instead of re-asking;
- when a customer says "don't call me again" or "mujhe call mat karo", does
  `stop` come back and the do-not-call list fill;
- when the goal is never achieved, do the caps end the journey cleanly, with
  memory faithful on every attempt.

The prompt is not under redesign. The suite exists to prove that the prompt
as it stands, wrapped the way the platform wraps it and fed the variables the
dispatcher sends, produces the verdicts the engine needs in these situations,
every time.

## Decisions

Recorded from the brainstorm of 2026-09-02.

| Question | Decision |
|---|---|
| Scale | A curated scenario suite, not a scale run. Ten scenarios × three languages. Engine scale stays the battle harness's job. |
| Provider | One OpenAI-compatible endpoint; `SIM_BASE_URL`, `SIM_API_KEY`, `SIM_MODEL` from `scripts/simulation/.env`. One model plays agent, extraction and persona. Reached with plain `fetch`; no SDK dependency. |
| Judge | No judge model in the harness (no second provider available). The harness records everything; a Claude Code review grades memory and re-asks. Deterministic checks block; judge findings advise. |
| Wrapper | The platform's base wrapper is reproduced verbatim from a bot log, as fixtures, so the agent runs under the same rules as production. |
| Prompt | The customer's exact agent prompt, with its `{{tb…}}` variables intact, as a fixture. Greeting: `um hello?`, spoken outside the LLM context, as the log shows. |
| Agent keys | None of its own. Extraction lists exactly YE's five verdict keys plus `callback_requested_at`. |
| Contacts | One synthetic contact per scenario, generated once with a seed and committed. No real CSV row enters a fixture. |
| Language | Every scenario runs in Hinglish, Hindi (Devanagari) and English. |
| Campaign | `maxTotalDials` 15, `maxGoalFollowUps` 5, `followUpDelayHours` 24, window 10:00–19:00 Asia/Kolkata, retry ladder as the campaign defaults, concurrency 5. Production wants 20 dials and follow-ups until achieved; the engine's ceilings are 15 and 5 (`campaignConfig.ts`), so the suite runs at the ceilings and this gap is recorded, not fixed here. |
| Budget | No hard ceiling. The run prints its token estimate and waits for confirmation. |
| Determinism | Temperature 0. Every prompt and completion recorded to disk; a run can be re-scored without the model. |

## Architecture

```
scripts/simulation/run.ts  ── boots ──► backend (real workers, ezo_harness_campaign_sim, Redis /15)
        │                                  ▲ webhooks
        │ seeds, starts, ticks             │
        ▼                                  │
  conformance Driver ── advance ──► vocobase-mock (SIM_MANUAL_CLOCK=1,
                                            SIM_OUTCOME_ENGINE=llm)
                                             │ onAccept(call, variables)
                                             ▼
                                    conversation engine
                                    agent ⇄ persona, then extraction
                                             │ transcript, duration, values
                                             ▼
                                    timeline: status event, then
                                    session.completed a few virtual seconds later
```

### The engine lives in the mock

`vocobase-mock` gains an outcome engine selected by `SIM_OUTCOME_ENGINE`
(`script`, the default and today's behaviour, or `llm`). The mock already
holds everything the engine needs at the moment a dial is accepted: the
`variables` block the dispatcher sent, the script rule for that number, the
virtual clock and the timeline that emits the platform's real event order.
A separate service would have had to be told all of that over HTTP.

Under `llm`, a script rule keeps deciding whether the dial is answered.
`status: busy` or `no_answer` walks the existing silent lifecycle. A rule
with `persona: <id>` is an answered call: the engine plays it and produces
what the platform would have produced. Rules without `persona` under `llm`
are an error, so a scenario can never fall through to a scripted verdict by
mistake.

The conversation starts at accept time and runs on the wall clock while the
virtual clock stands still. The call's terminal timeline entry and its
completion entry await the conversation's promise, so `POST /_sim/advance`
still returns only when every webhook it released has been delivered, and
the driver's tick/advance/drain loop is unchanged. `duration_seconds` is
derived from the transcript (a fixed seconds-per-turn) so the engine's
billing path sees plausible numbers.

### Composing the agent's context

The system instruction is assembled the way the bot log shows the platform
assembling it, section by section, with the agent prompt first:

1. `<role_and_mission>`: the agent prompt fixture with every `{{tb…}}`
   replaced from the scenario's contact, and every YE goal variable
   replaced from the dial's `variables`. YE's managed block is present
   because the real backend wrote it into the mock's agent prompt on
   campaign start; the engine reads the prompt from the mock's agent store,
   not from the fixture, so a missing or hand-edited block is exercised too.
2. `<runtime_state>`: the "greeting already spoken" instruction with the
   greeting text.
3. `<call_screening>`, `<formatting_and_behavior_rules>`,
   `<custom_function_instructions>`: verbatim fixtures.
4. `<date_time_context>`: regenerated from the virtual clock in the
   campaign's timezone, in the fixture's exact layout (time, time of day,
   date, weekday, recent days, an eight-day calendar).
5. `<final_reminder>`: verbatim.
6. The turn-completion block, appended last, verbatim.

The `end_call` function is advertised with the schema the log shows, so the
agent ends calls the way it does in production.

### Playing the call

The first user message is the platform's "greeting already spoken"
instruction, followed by the persona's first words. Then:

- **Agent turn**: one completion. The leading `✓`, `○` or `◐` is stripped
  before the text reaches the persona. `○` or `◐` alone means the agent is
  waiting; the persona speaks again. A tool call to `end_call` ends the call
  after the agent's parting line.
- **Persona turn**: one completion against the persona's own system prompt
  (character sheet, language, the intent script for this call number, and
  its transcript history from earlier calls to this contact) plus the
  conversation so far from its side. The persona may hang up by emitting
  `[hangs up]`, which ends the call without `end_call`.
- The turn cap is 20 agent turns; a call that hits it ends as a hang-up.

Everything the agent said and heard is the transcript that
`session.completed` carries.

### Extraction

Same system instruction, same message history, then one trailing user
message: the call has ended; return a single JSON object with exactly these
keys. The keys are the five in `GOAL_VERDICT_DESCRIPTIONS` and
`callback_requested_at` with `CALLBACK_KEY_DESCRIPTION`, each listed with
its type, its description and, for `next_action`, its pinned values, in the
words production uses. The reply is parsed strictly; anything unparseable
becomes an absent extraction, which the engine reads as a null verdict. The
parsed values become `session.completed.extraction.values`.

This is the design's one assumption about the platform: that its in-bot
extraction is a trailing instruction over the live context, as the
goal-verdict design describes. Where the platform's own extraction turns out
to differ, the trailing message is the single place to change.

## Personas and scenarios

A scenario is one typed TypeScript module under
`scripts/simulation/scenarios/`, the way the conformance scenarios are
(no YAML parser, no new dependency):

```ts
export const S02: Scenario = {
  id: 'S02-callback-weekday-time',
  blocking: true,
  persona: {
    sheet: 'You are Rekha Sharma, 44, owner of a tailoring shop in Kothrud, Pune…',
    calls: [
      { intents: 'Confirm you are the owner. You are busy with a customer. When the report is offered, say you can talk properly on Tuesday after 5 in the evening and ask to be called then. Give no other detail.', hangsUpAfterTurns: 6 },
      { intents: 'You remember she said she would call Tuesday. Listen to the report, pick reviews, agree to send review requests to five customers today.' },
    ],
  },
  dials: [{ kind: 'persona', call: 1 }, { kind: 'persona', call: 2 }],
  expected: {
    calls: [
      { nextAction: 'call_back_at', goalAchieved: false, callbackSlot: { weekday: 'tuesday', time: '17:00', toleranceMinutes: 60 } },
      { nextAction: 'done', goalAchieved: true },
    ],
    terminal: { status: 'COMPLETED', goalAchieved: true, dials: 2, dnc: false },
  },
};
```

The contact's `{{tb…}}` values come from a seeded generator keyed by the
scenario id, so they are synthetic, deterministic and cover every variable
the prompt names.

Each scenario runs once per language; the language is injected into the
persona's system prompt and is a matrix axis in the report.

The persona holds its own history: on call two it is told what it said on
call one, so it can notice a re-ask and complain about it, which is what a
real customer does.

The first suite:

| id | situation | what must hold |
|---|---|---|
| S01 achieved-first-call | forthcoming owner, completes one action | `done`, `goal_achieved` true, no further dial |
| S02 callback-weekday-time | "Tuesday after 5" | `call_back_at`, callback booked in that slot |
| S03 callback-relative | "kal subah", "Diwali ke baad" | relative and festival dates resolve to a slot in the window |
| S04 drop-midway-resume | hangs up after picking an item | call 2 opens at the next phase; no re-ask of what call 1 covered |
| S05 dnc-english | "don't call me again" | `stop`, do-not-call row, no dial after |
| S06 dnc-hindi | "mujhe call mat karo" | same |
| S07 never-achieved | polite, never commits, five conversations | five follow-ups then COMPLETED/false; memory faithful each time |
| S08 silence-then-achieved | busy, no-answer, then a conversation | retry ladder honoured; `call_number` 3 on the conversation |
| S09 wrong-person | a relative answers, owner not available, no better number | `stop` or `call_again` with a reason; never `done` |
| S10 not-interested-soft | "abhi nahi, baad mein" with no time | `call_again`, follow-up at the delay, not a callback |

## The campaign under test

Seeded by the driver from `scripts/simulation/fixtures/campaign.json`:

- goal (derived from the prompt's END GOAL section; to be corrected in
  review): *Deliver last month's report to the customer, get them to pick
  and complete or firmly commit to one pending action, ask them to collect
  reviews, and if their auto-payment mandate is broken get it fixed. The
  goal is met when the report has been delivered and one action was done on
  the call or committed to for a specific later time.*
- `maxTotalDials` 15, `maxGoalFollowUps` 5, `followUpDelayHours` 24,
  window 10:00–19:00 `Asia/Kolkata`, `retryCount` 2, `cooldownMinutes` 30,
  `retryDelaysMinutes` default, `concurrencyLimit` 5, callbacks enabled.
- One contact per scenario × language, with the phone number encoding the
  scenario so the mock's script rules and the report can address it.

## Scoring

**Deterministic checks**, computed by the driver from the database, the
mock's dial log and the recorded extraction, per call and per contact:

- `next_action` equals the expected value; `goal_achieved` agrees.
- For a callback: `callback_requested_at` parsed to a time inside the
  expected slot ± tolerance, and the contact's next eligible time equals the
  engine's booking of it (rolled into the window).
- For a stop: a `DoNotCall` row for this campaign and phone; no later dial
  in the dial log.
- Terminal contact state: status, `goalAchieved`, dial count.
- Dial variables: `call_number`, `previous_attempts`, `memory` and
  `last_call_note` on each dial match what the previous call's record
  should have produced.
- Resumption phase (S04 and every follow-up call): the agent's first
  substantive turn does not ask for anything the memory already holds. This
  is checked with exact strings the scenario names (the item picked, the
  business name) and left to the review for the rest.
- Engine invariants, unchanged from battle: no double dials, caps honoured,
  delays honoured, do-not-call honoured, a replayed completion changes
  nothing.

**Review** (advisory), done by a Claude Code session over
`runs/<runId>/review/`, one packet per call holding the persona's truth,
the transcript, the memory returned and the verdict:

- facts the persona revealed that the memory dropped;
- facts in the memory that were never said;
- questions the agent asked that the memory or the same call had already
  answered;
- on follow-up calls, whether the agent resumed at the right phase.

The harness may also drive this review headlessly through `claude -p` with
the rubric, one packet per call, when a session is not at hand; the packets
and the rubric are the same either way.

**Blocking rule.** A failed deterministic check on S02, S04, S05 or S06 in
any language blocks the production run. Every other failure and every
review finding is reported for a decision.

## Budget and determinism

Before starting, the run prints: scenarios × languages, expected calls per
scenario, expected turns per call, the system-instruction size in tokens
(about 24k, from the log), and the resulting input and output token
estimate. It starts only on confirmation (`--yes` skips the prompt for CI).

Temperature 0 on every call. Every request is recorded under
`runs/<runId>/calls/<callId>/<n>-<role>.json` with the prompt, the
completion, token usage and wall time. The driver also persists the
scorer's inputs per scenario under `runs/<runId>/inputs/`. `--replay
<runId>` re-scores those persisted inputs and re-renders the report — no
driver re-run, no server, no model call — so a failing case is read for
free, and the scorer can be changed without spending tokens.

## Report

One markdown file per run under `scripts/simulation-results/`, in the
conformance report's style:

1. Headline: scenario × language grid, pass/fail per check; the blocking
   verdict.
2. Verdict accuracy by scenario class; callback parsing outcomes with the
   slot booked; do-not-call outcomes.
3. Follow-up economy: dials used against the dials the scenario expects,
   per contact.
4. Engine invariants.
5. Cost: tokens in and out and completions per run, wall time (per-call
   tokens are in each call's recordings).
6. Review packets pending, or the review's findings once it has run.
7. What this run does not prove (below), verbatim.

## What this does not prove

Nothing about the platform itself: the exact order and timing of its
webhooks, telephony behaviour, speech recognition errors, barge-in, latency,
or its fallback extraction when the in-bot one does not run. The extraction
shape here is the design doc's description of the platform, not the
platform. The only thing that proves those is a live rehearsal: a 10–20
contact campaign to the team's own handsets, on production, under
`DIALER_TEST_ALLOWLIST`. This simulator replaces the mock's scripted verdicts
with real model output; it does not replace that rehearsal.

Also outside its reach: the engine at thousands of contacts (the battle
harness's job), and the production caps of 20 dials and unbounded follow-ups
until the engine's ceilings are raised.

## Safety rules

- The API key lives in `scripts/simulation/.env`, gitignored, read only by
  the model client, never logged.
- No real call: the harness talks only to the mock, and the mock refuses a
  non-loopback webhook URL.
- No real customer data in fixtures: contacts are synthetic; the wrapper
  fixtures were checked for customer values before commit; the recorded runs
  directory is gitignored.
- Every URL is preflighted as the conformance harness does: local Postgres
  and Redis only, never neon.tech.
- The harness has a database of its own, `ezo_harness_campaign_sim`, and
  Redis index 15; the boot accepts only allowlisted names and indexes, so it
  can never be pointed at the worktree's dev database (which it would
  truncate) or a dev server's queue (whose dials its worker would place).

## Sequencing

Built on `feat/campaign-sim`, branched from `feat/goal-verdict`, rebased
when that merges. Before the first run: `ezo_harness_campaign_sim` exists on
localhost:5436 with migrations deployed. The first full run is part of the goal-verdict
verification before its PR merges. The prompt fixture currently in the
worktree is unformatted (pasted without line breaks) and must be replaced by
the exported prompt file before the first run.

## Open

- The goal text above is a draft from the prompt's END GOAL section.
- Whether the platform's in-bot extraction is a trailing instruction, or the
  keys ride in the system instruction; the trailing message is the only
  thing to change.
- Raising `MAX_MAX_TOTAL_DIALS` and `MAX_GOAL_FOLLOW_UPS_CEILING` for the
  production run, as a separate change.
