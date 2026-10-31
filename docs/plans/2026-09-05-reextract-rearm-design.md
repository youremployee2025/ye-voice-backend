# Re-extract and re-arm a campaign's conversations under the H call-note contract

## Why

Two September Touchbase campaigns (500 contacts each, paused) ran under the
G call-note contract. Its `callback_type` definition marked dropped
conversations `flexible` where H's definition says `immediate`, and its
`call_outcome` was judged against a paraphrase rather than the agent prompt.
Every contact that reached a person therefore carries a verdict the campaign
no longer trusts, and the queue is armed from those verdicts.

The fix is to re-run extraction for those conversations under H and re-arm
each contact from the new note — on YE's side, from the transcript the
platform kept, so the result does not depend on the platform's own
extraction configuration or on re-firing any webhook.

## Decisions (agreed 2026-09-05)

| Question | Answer |
|---|---|
| Which campaigns | The two named campaigns only, by id |
| Which contacts | Every contact that reached a person, settled or not |
| Which call | The contact's latest attempt that reached a person |
| Old `stop` verdicts | H's verdict wins; a `stop` can be reopened |
| Past requested times, `immediate` | Arm for the next dispatcher sweep inside the window |
| Follow-up counter | Reset to zero on re-arm |
| Model | The simulator's configured model, through the same OpenAI-compatible endpoint |
| Prompt | The agent's prompt snapshot from the session dump as the system message, exactly as the simulator measured H |

## Shape

A script, `scripts/reextract/run.ts`, run by an operator with three inputs:
a campaign id, the platform admin debug token (`VOCOBASE_ADMIN_DEBUG_TOKEN`
in the environment, never a file in the repo), and the model endpoint
configuration (`SIM_BASE_URL`, `SIM_API_KEY`, `SIM_MODEL`, read from the
environment the same way the simulator reads them). `--dry-run` is the
default; `--apply` writes.

Per campaign:

1. **Select.** Contacts of the campaign whose latest attempt with a
   disposition in the reached tier (`completed`, `transferred`) has an
   `upstreamSessionId`. Contacts with no such attempt are listed as skipped.
2. **Fetch.** `GET $API/api/admin/sessions/:upstreamSessionId/dump?format=json`
   with `X-Debug-Token`. Read `session.transcript`, `session.promptSnapshot`
   (the exact field name is confirmed in the plan), `session.startedAt`,
   `session.endedAt`. A dump with no transcript is a skip with a reason.
3. **Extract.** One chat completion: system = the prompt snapshot; then the
   transcript as user/assistant turns; then a date-time line stating when the
   call ended in the campaign's timezone; then the H extraction instruction
   built from production's `CALL_NOTE_DESCRIPTIONS` (the same object the
   platform is given, so the wording cannot drift). `temperature: 0`, JSON
   mode, strict parse: a non-object reply is a skip, never a guess.
4. **Store.** Write the parsed values onto that attempt's `extraction`
   column (whole-column replace, which is what the live path does), and keep
   the previous value in the run report.
5. **Re-arm** from `readCallNote(values)`, in one transaction per contact
   under the campaign lock the dispatcher uses:
   - `stop` → status `COMPLETED`, `goalAchieved=false`, `nextEligibleAt=null`,
     `callbackAt=null`, `armKind=FRESH`, and the do-not-call row upserted
     (first writer wins, as the live path does).
   - `completed` → status `COMPLETED`, `goalAchieved=true`, clocks cleared.
   - `incomplete` → status `PENDING`, `followUpCount=0`, `goalAchieved=null`:
     - `requested` with a parseable future time → `armKind=CALLBACK`,
       `callbackAt` and `nextEligibleAt` at that time rolled into the window;
     - `requested` with a past or unparseable time, `immediate`, `flexible`,
       or `null` → `armKind=RESUME` for `immediate`, `FOLLOW_UP` otherwise,
       `nextEligibleAt=now` rolled into the dial window, `callbackAt=null`.
   - A contact whose old status was `COMPLETED`/`FAILED` and is now
     `PENDING` decrements the campaign's `completedCount`/`failedCount`; the
     reverse increments. Counters stay consistent with what the list shows.
   - The goal record's attempt log gets a new entry marking the re-run, so
     the journey shows the verdict changed and when.
6. **Report.** One line per contact: contact id, phone tail, old verdict →
   new verdict, old arm → new arm, and the reason for any skip; then totals
   per transition. Written to stdout and to `scripts/reextract/runs/<campaign>-<ts>.md`
   (gitignored).

Idempotent: a second `--apply` on the same campaign re-extracts again and
lands on the same state; nothing accumulates. Resumable: contacts already
carrying an extraction stamped with this run's marker are skipped unless
`--force`.

## What it does not do

- It does not touch the platform's extraction config or its stored session
  extraction. The platform's own analysis stays whatever it was.
- It does not dial. The campaign stays paused until the operator unpauses it
  after reviewing the report.
- It does not re-extract earlier conversations of a contact that had several.
- It does not run on any campaign that is `RUNNING`; it refuses unless the
  campaign is `PAUSED`, `COMPLETED`, or `STOPPED`, so a live dispatcher never
  races it.

## Risks

- **Rate limits.** ~1,000 contacts across both campaigns, one model call
  each, with the simulator's concurrency setting. Minutes, not seconds.
- **Prompt snapshot age.** The snapshot in the dump is the prompt the call
  ran with, which carried the G-era call-note block. That is correct for
  re-extraction: the model is being asked what happened on that call.
- **Reopened stops.** Agreed: H's verdict wins. The report lists every
  reopened `stop` separately so they can be reviewed before unpausing.
