# Re-extract and re-arm under H — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An operator-run tool that re-extracts every conversation of a paused campaign under the H call-note contract on YE's side (transcript from the platform's admin session dump, verdict from the simulator's model endpoint) and re-arms each contact from the new note, with a dry run that changes nothing.

**Architecture:** All logic lives under `src/lib/reextraction/` and `src/services/reextraction.service.ts` so it is typechecked and unit-tested like production code; `scripts/reextract/run.ts` is a thin CLI over it. Extraction reuses production's `CALL_NOTE_DESCRIPTIONS` and `readCallNote`; re-arming mirrors `resolveContact`'s goal branch but is allowed to touch settled contacts and resets the follow-up counter. Design: `docs/plans/2026-09-05-reextract-rearm-design.md` (copied in Task 0).

**Tech Stack:** TypeScript, Prisma, vitest (DB-backed tests via `TEST_DATABASE_URL`), `tsx` for the CLI, native `fetch`. No new dependencies.

**Branch/worktree:** `feat/reextract-rearm` off `origin/main` AFTER the contender-H PR merges, at `.worktrees/reextract/ye-voice-backend`. Test env: `TEST_DATABASE_URL=postgresql://postgres:test@localhost:5435/postgres TEST_REDIS_URL=redis://localhost:6382/10`, `npm run test:prepare` first.

**Agreed decisions** (do not re-litigate): the two named campaigns only; every contact that reached a person, settled or not; latest reached attempt only; H's verdict wins even over an old `stop`; past requested times and `immediate` arm for the next sweep; follow-up counter reset to 0; the simulator's model; the dump's prompt snapshot is the system prompt.

---

### Task 0: Design doc and scaffolding

**Files:**
- Create: `docs/plans/2026-09-05-reextract-rearm-design.md` (copy from the scratchpad path given by the controller)
- Create: `scripts/reextract/.gitignore` containing `runs/`
- Modify: `package.json` scripts: add `"reextract": "tsx scripts/reextract/run.ts"`

Step 1: copy the design doc, add the gitignore and script entry. Step 2: `npx tsc --noEmit` clean. Step 3: commit `docs: design for re-extracting a campaign under H`.

---

### Task 1: Build the extraction messages (pure)

**Files:**
- Create: `src/lib/reextraction/messages.ts`
- Test: `test/reextraction-messages.test.ts`

Contract:
```ts
export interface DumpTranscriptTurn { role: string; content: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export function extractionInstruction(): string
// Same shape the simulator used to measure H:
// 'The call has ended. Based on the conversation above and your instructions, return ONE JSON object with exactly these keys and nothing else:'
// then one line per key from CALL_NOTE_KEYS: `- ${key} (${type}[, one of: a, b]): ${description}` built from CALL_NOTE_DESCRIPTIONS in src/services/campaignExtraction.ts
// then 'Use null for anything you cannot determine.'

export function dateTimeLine(endedAt: Date, timezone: string): string
// 'DATE-TIME CONTEXT: This call ended on <formatted in zone, e.g. Thursday, 4 September 2026 at 10:00 (Asia/Kolkata, UTC+05:30)>. Resolve every relative date or time in the transcript against that moment and return absolute values; never invent a date.'

export function buildMessages(input: {
  systemPrompt: string;            // dump promptSnapshot.renderedPrompt ?? promptSnapshot.prompt
  transcript: DumpTranscriptTurn[]; // roles: 'user'/'assistant' (map 'agent'|'bot' -> assistant, 'customer'|'caller' -> user; unknown -> user)
  endedAt: Date;
  timezone: string;
}): ChatMessage[]
// [system], ...turns, { role: 'user', content: dateTimeLine + '\n\n' + extractionInstruction() }
```
Tests: instruction contains all six H keys and the pinned value lists; the date line renders in the campaign zone; role mapping; empty transcript throws `ReextractionSkip('empty_transcript')` (define `ReextractionSkip extends Error { reason: string }` in `src/lib/reextraction/skip.ts`).

TDD per step: write test → run `npx vitest run test/reextraction-messages.test.ts` (fails) → implement → passes → commit.

---

### Task 2: Parse the model reply (pure)

**Files:**
- Create: `src/lib/reextraction/parse.ts`
- Test: `test/reextraction-parse.test.ts`

`parseCallNoteReply(text: string): ParsedReply` where `ParsedReply = { ok: true; values: Record<string, unknown> } | { ok: false; reason: 'not_json' | 'not_an_object' | 'no_managed_keys' | 'partial_reply' }` (`partial_reply`: names an outcome and fewer than four of the six keys — the write is a whole-column replace, so two keys stored blanks the four the attempt has held since the call; a reply that names no outcome is `no_verdict` a moment later and is not judged this way) — strip ``` fences, JSON.parse, must be a non-array object, keep only `CALL_NOTE_KEYS`, map the literal string `"null"` (any case) to `null`. Three refusals rather than one `unparseable`, because they are three different things to tell an operator: `not_json` is prose or a truncated reply and is worth retrying, `not_an_object` is well-formed JSON of the wrong shape and will answer identically on every retry, `no_managed_keys` is a reply about something else. Tests: fenced JSON, extra keys dropped, `"null"` word, the omitted keys pinned absent with `toStrictEqual`, and one case per refusal reason.

---

### Task 3: Plan the re-arm (pure)

**Files:**
- Create: `src/lib/reextraction/plan.ts`
- Test: `test/reextraction-plan.test.ts`

```ts
export type RearmPlan =
  | { kind: 'stop'; reason: string | null }
  | { kind: 'completed' }
  | { kind: 'callback'; at: Date }                       // requested with a parseable future time
  | { kind: 'resume'; at: Date }                         // immediate
  | { kind: 'follow_up'; at: Date }                      // flexible / null / requested-but-unusable / no callbackType
  | { kind: 'no_verdict' };                              // outcome null -> skip, contact untouched

export function planRearm(note: CallNote, input: { now: Date; window: DialingWindow; timezone: string | null }): RearmPlan
```
`planRearm` also asks the dispatcher's two budgets, from a `budget` on `RearmContext` (campaign `retryCount`/`maxTotalDials` read once, the contact's `attempts` and highest PLACED `attemptNo` off the selection): an arm the claim would never take becomes `{ kind: 'over_budget'; reason: 'retry_budget' | 'dial_budget' }`, which writes nothing. The dial ceiling first and with no exemption; then the retry budget, which a `callback` is exempt from (`ARMED_FOR_CALLBACK`). Otherwise the contact sits PENDING for ever, unclaimed and unsettled, and `completeIfDone` can never finish the campaign.

Rules: `stop` → stop; `completed` → completed; `incomplete`/null-outcome-with-callbackType? No: outcome null → `no_verdict`. For `incomplete`: `requested` → `parseCallbackAt(note.callbackRequestedTime, timezone, now)`; ok → `callback` at `rollIntoDialWindow(at, window)`; not ok (absent/unparseable/too_soon/too_far_ahead, i.e. past or bad) → `follow_up` at `rollIntoDialWindow(now, window)`. `immediate` → `resume` at `rollIntoDialWindow(now, window)`. `flexible`/`null`/null → `follow_up` at `rollIntoDialWindow(now, window)`.
Tests cover every branch, including a requested time in the past becoming follow_up-now and a Saturday `now` rolling to Monday for a weekday window.

---

### Task 4: Select the conversations to re-extract (DB)

**Files:**
- Create: `src/services/reextraction.service.ts` (start with `selectConversations`)
- Test: `test/reextraction-select.test.ts` (DB-backed; follow the fixture helpers used in `test/campaign-stats.test.ts`)

```ts
export interface Conversation { campaignContactId: string; attemptId: string; attemptNo: number; upstreamSessionId: string; phone: string; oldStatus: CampaignContactStatus; oldArmKind: ContactArmKind; oldExtraction: unknown }
export interface SelectionSkip { campaignContactId: string; reason: 'never_reached' | 'no_session_id' | 'excluded' }
export async function selectConversations(campaignId: string, db = prisma): Promise<{ conversations: Conversation[]; skipped: SelectionSkip[] }>
```
Per contact of the campaign: the latest `CallAttempt` (highest `attemptNo`) with `disposition IN ('completed','transferred')` — there is no `DISPOSITION_TIERS` in this repo (it is the dashboard's, in `lib/campaigns/presentation.ts`), so the tier ships as `REACHED_DISPOSITIONS` exported from `src/lib/campaignOutcomes.ts` beside `CANONICAL_DISPOSITIONS`, mirroring that module's `DISPOSITION_TIERS.reached`, rather than as two literals here. No such attempt → `never_reached`; attempt without `upstreamSessionId` → `no_session_id`. An `EXCLUDED` contact → `excluded`, never a conversation. Two writers reach that status, not one: an operator's remove, and the dispatcher's do-not-call sweep (`excludeDoNotCallContacts`, `src/services/dialerClaim.ts`), which settles every PENDING contact whose phone is on the campaign's list — so a G-era `stop` can have EXCLUDED a **second** contact sharing that phone, which is a contact this run would otherwise want back. It is skipped for the reason that holds for both writers: `EXCLUDED` is the one status `totalContacts` was decremented for, so re-arming would queue a contact the campaign's own denominator says is not there. The report names it and the operator puts it back deliberately — `PENDING` plus a `totalContacts` top-up — once the do-not-call row that swept it is gone. `SKIPPED` is NOT excluded — that is the campaign sweeping its own queue on a stop, which is the state this run exists to revisit. Also refuse (throw `ReextractionRefused`) when the campaign status is `RUNNING`, `SCHEDULED`, or `DRAFT`.
Tests: a contact with two conversations picks the later; a later voicemail does not displace the earlier conversation; a voicemail-only contact is skipped; an `EXCLUDED` contact is skipped; a RUNNING campaign refuses.

---

### Task 5: Apply the re-arm (DB, transactional)

**Files:**
- Modify: `src/services/reextraction.service.ts` (add `applyRearm`)
- Test: `test/reextraction-apply.test.ts`

```ts
export async function applyRearm(input: { conversation: Conversation; values: Record<string, unknown>; plan: RearmPlan; runId: string; now: Date }, db = prisma): Promise<void>
```
In ONE `db.$transaction` per contact:
1. `callAttempt.update({ where: { id: attemptId }, data: { extraction: { ...values, _reextractedBy: runId, _reextractedAt: now.toISOString() } } })` — the marker keys are prefixed with `_` and are what makes a re-run resumable; `readCallNote` ignores unknown keys (verify; if it does not, store the marker on a sibling column instead — do not break `readCallNote`).
2. Contact update by plan:
   - `stop`: `{ status: 'COMPLETED', goalAchieved: false, nextEligibleAt: null, callbackAt: null, armKind: 'FRESH', followUpCount: 0 }` and `doNotCall.upsert` exactly as `resolveContact` does (`create` with reason, `update: {}`).
   - `completed`: `{ status: 'COMPLETED', goalAchieved: true, nextEligibleAt: null, callbackAt: null, armKind: 'FRESH', followUpCount: 0 }`.
   - `callback`: `{ status: 'PENDING', goalAchieved: null, nextEligibleAt: at, callbackAt: at, armKind: 'CALLBACK', followUpCount: 0 }`.
   - `resume`: `{ status: 'PENDING', goalAchieved: null, nextEligibleAt: at, callbackAt: null, armKind: 'RESUME', followUpCount: 0 }`.
   - `follow_up`: same as resume with `armKind: 'FOLLOW_UP'`.
   - `no_verdict`: **nothing at all is written** — not the contact, and not the extraction either. The attempt write is a whole-column replace, so storing a reply that named no outcome would blank the other five values the attempt has held since the call. The contact keeps its arm, the attempt keeps its answers, and the row is reported with `newPlan: 'no_verdict'` under its own totals key (`no_verdict:<old outcome>`) — not as a skip, and above all not as a `stop→none` transition, which forty rows deep reads as forty contacts the run disarmed.
   - For every non-stop plan: `doNotCall.deleteMany({ where: { campaignId, phone, sourceCampaignContactId: campaignContactId } })` — a DNC row this contact's OLD wrong `stop` created must not keep the dispatcher from dialing it. Rows with a different source are left alone.
3. Campaign counters, decided on the counter each status owns — `COMPLETED`→`completedCount`, `FAILED`→`failedCount`, `SKIPPED`→`skippedCount` (a stopped campaign swept its own queue to `SKIPPED` with that counter, and those contacts are exactly the ones a re-arm brings back), `PENDING`→none. Where the two differ, decrement the old one and increment the new; where they agree, nothing moves. Guard every decrement at 0 with `updateMany where <counter> > 0`. The **old** status is read live inside the transaction rather than taken from `conversation.oldStatus`: that is what makes a second `applyRearm` a no-op instead of a second decrement, and it is the only reading that is right if anything touched the row since the selection.
4. Goal record: call `recordAttempt` from `src/services/goalContext.ts` for this attemptNo with the new note fields so the journey and the next dial's memory read H's note (read its `RecordAttemptInput` and pass what the live path passes; if it needs fields the dump does not carry, pass the attempt row's values). Its `callbackNote` reads the promised time through `callbackRawFrom(values, hasGoal(campaign))`, with `goalEnabled` read on the campaign row **inside the transaction** rather than passed as a literal `true`: a campaign without a goal never carried the call-note set, its promise is in `callback_requested_at`, and the goal rule would drop it.
Tests, one per plan kind, asserting the contact row, the DNC row presence/absence, the counters, and that a second `applyRearm` with the same input is a no-op state-wise (idempotent).

---

### Task 6: Platform dump client and model client (thin I/O)

**Files:**
- Create: `src/lib/reextraction/dump.ts` — `fetchDump(sessionId, { apiUrl, token, fetchImpl = fetch })` → `{ transcript: DumpTranscriptTurn[]; systemPrompt: string; endedAt: Date }` from `GET ${apiUrl}/api/admin/sessions/${id}/dump?format=json` with header `X-Debug-Token`. Read `session.transcript` (each turn: `role ?? speaker ?? type`, `content ?? text ?? message`), `session.promptSnapshot.renderedPrompt ?? session.promptSnapshot.prompt`, `session.endedAt ?? session.startedAt`. 404 → `ReextractionSkip('session_not_found')`; missing prompt → `ReextractionSkip('no_prompt_snapshot')`; missing or non-array transcript → `ReextractionSkip('no_transcript')`; neither `endedAt` nor `startedAt` parseable → `ReextractionSkip('no_ended_at')` (without that anchor the date-time line would resolve "next Tuesday" against nothing). Every other non-2xx throws rather than skipping, so one wrong token is not reported as a thousand calls that could not be judged.
- Create: `src/lib/reextraction/model.ts` — `createCompleter({ baseUrl, apiKey, model, fetchImpl = fetch })` returning `(messages) => Promise<string>`: POST `${baseUrl}/chat/completions`, `{ model, messages, temperature: 0, response_format: { type: 'json_object' } }`, Bearer auth, retry on 429/5xx with `retry-after` or exponential backoff up to 5 tries, and if a 400 mentions `response_format`, retry once without it (the simulator's client does exactly this). Return `choices[0].message.content`.
- Tests: `test/reextraction-io.test.ts` with an injected `fetchImpl` stub for both — no network.

---

### Task 7: The run orchestrator and report

**Files:**
- Modify: `src/services/reextraction.service.ts` (add `runReextraction`)
- Test: `test/reextraction-run.test.ts`

```ts
export interface RunOptions { campaignId: string; apply: boolean; force: boolean; concurrency: number; now?: Date; runId?: string;
  fetchDump: (sessionId: string) => Promise<DumpResult>; complete: (messages: ChatMessage[]) => Promise<string>; log?: (line: string) => void }
export interface RunRow { campaignContactId: string; phoneTail: string; attemptNo: number; oldOutcome: string | null; oldCallbackType: string | null; newOutcome: string | null; newCallbackType: string | null; oldStatus: string; newPlan: RearmPlan['kind'] | 'skipped'; skipReason?: string; reopenedStop: boolean }
// `skipReason` carries the specific reason, never a single `unparseable`: the `ReextractionSkip.reason` for a skip, and for an unreadable reply the `ParsedReply` refusal itself — `not_json` | `not_an_object` | `no_managed_keys`. The totals group on it, and a model that quietly started answering in prose must not read like a contract whose keys were renamed.
export interface RunReport { runId: string; campaignId: string; apply: boolean; rows: RunRow[]; totals: Record<string, number>; markdown: string }
export async function runReextraction(opts: RunOptions, db = prisma): Promise<RunReport>
```
Add to `RunOptions`: `batchSize: number` (default 20) and `confirmBatch?: (summary: { batchNo: number; rows: RunRow[]; totalsSoFar: Record<string, number> }) => Promise<boolean>`.

Flow: `selectConversations` → skip rows whose stored extraction already carries `_reextractedBy` unless `force` → process the remaining conversations **in batches of `batchSize`**, in a stable order (campaignContactId ascending) so a resumed run continues where it stopped. Within a batch use a small concurrency pool (`concurrency`, default 4). After each batch, print that batch's rows and the running totals, then call `confirmBatch` if provided; `false` stops the run cleanly with the report so far (rows already applied stay applied, which is why every row is marked resumable). In `apply` mode a batch is applied only after the whole batch has been extracted, so a model outage mid-batch leaves the batch untouched. Test: a `confirmBatch` stub that returns `false` after batch 1 with `batchSize: 2` and 5 conversations yields exactly 2 processed rows and a report saying it stopped after batch 1.

Per conversation: fetchDump → buildMessages (timezone = campaign.timezone ?? 'Asia/Kolkata') → complete → parseCallNoteReply → `readCallNote` → `planRearm` → if `apply`, `applyRearm`. Every `ReextractionSkip` and parse failure becomes a row with `newPlan: 'skipped'` and its reason; other errors are recorded per row and do not abort the run. `reopenedStop = oldOutcome === 'stop' && newPlan !== 'stop'`, less `no_verdict` (nothing is written for one, so its `stop` still stands). Markdown report: header with campaign, runId, mode, batching and the zone the calls were anchored in — saying so explicitly when it is the fallback rather than the campaign's; a table of rows; totals per `old→new` outcome transition; a separate "Reopened stops" list.

Six things settled in the Task 7 review, all of them about not claiming more than was done:

- **A row that was judged and not written says so.** In `apply` mode every row of a batch whose `applyRearm` did not run — everything after the refusal that aborted it, and any row whose own write failed — is marked `skipped` / `not_applied` with `reopenedStop` cleared, exactly as an abandoned batch's rows are. Otherwise a reopened `stop` nothing wrote sits in the report under "Dialable again".
- **The abandon rule needs a batch worth reading.** `failed * 2 > batch.length` only applies from four conversations up; below that a single dump the platform no longer has would stop a `--batch 1` run outright.
- **`confirmBatch` may throw.** A prompt on a closed stdin or an interrupted one is not a `no` — but it ends the run all the same, under its own reason, so the report survives with the record of every row already applied.
- **The report carries the reason it ended, not just the kind.** `RunReport.outcome` is the `RunOutcome` union; `status` stays the bare kind for callers that only branch on `aborted`. An operator's `no`, a model outage and a prompt that could not be asked are three different pieces of news and a caller choosing an exit code must not have to scan the rows to tell them apart.
- **The zone is validated after the selection**, so a live campaign with an odd timezone is refused for being live rather than for its zone.
- **`stillListed` is only asked of rows something was written for**, since a row nothing touched has no "after" to ask about.

And six more from the whole-branch review:

- **The dispatcher's budgets are asked before arming** (Task 3 above), reported as `over_budget:<reason>` and never as dialable.
- **A 401/403 from the dump is `ReextractionRefused('dump_unauthorized')`** and ends the run on the first one, whatever the batch size — the majority rule needs a batch of four and `--batch 2` would otherwise walk a thousand contacts and exit 0.
- **The abandon rule needs four conversations**, so `--batch 1` is not stopped by one bad dump.
- **`onBatch`** hands each batch's markdown over as it lands (header ahead of the first), so a killed run still leaves the record of what it wrote; `newRunId` is exported so the caller can name the file first. `applyRearm` returns the do-not-call row it deleted, and the report prints it.
- **`maxReopenedStops`** stops before applying a batch that would take the run past a ceiling the operator named.
- **One run per campaign**, on a session advisory lock held for the life of the run (`run_in_progress`); it guards two processes, which is the case that happens.
Tests use stub `fetchDump`/`complete`: dry run writes nothing (assert DB unchanged); apply writes; a resumable second run skips marked rows; a stub throwing for one contact leaves the others processed.

Two things the report must be honest about, both discovered in the Task 4–5 review:
- **`reopenedStop` may over-claim.** `applyRearm` deletes only the do-not-call row whose `sourceCampaignContactId` is this contact's own; a row first written by another source — an uploaded opt-out list, or another contact on the same phone whose `stop` got there first — survives, and the dispatcher's `excludeDoNotCallContacts` will settle this contact `EXCLUDED` again on the next sweep. So the row must say per contact whether the number is still listed after the re-arm (`doNotCall` still present for `campaignId + phone`), and the "Reopened stops" section must separate the ones that are actually dialable again from the ones that need the operator to clear a row somebody else wrote.
- **Strip the markers when printing `oldExtraction`.** A conversation re-judged by an earlier run carries `_reextractedBy` / `_reextractedAt` in its stored extraction; printed verbatim in a before-and-after column they are noise in every row of a re-run, and they are this tool's bookkeeping rather than anything the model said. Drop `_`-prefixed keys from what the report renders (never from what is stored).

---

### Task 8: CLI

**Files:**
- Create: `scripts/reextract/run.ts`
- Create: `src/lib/reextraction/cli.ts` (arg and env parsing, the name-refusal message, the header)
- Test: `test/reextraction-cli.test.ts`

Args: `--campaign <id>` or `--campaign-name "<exact name>"` (one required; a name resolves through Prisma to exactly one campaign, refusing with the candidate ids if 0 or >1 match), `--apply` (default dry run), `--force`, `--concurrency <n>`, `--batch <n>` (default 20), `--max-reopened-stops <n>` (default none), `--yes` (do not pause between batches). In `--apply` without `--yes` it asks once on the header — `Re-arm contacts of "<name>" (<id>)? [y/N]` — BEFORE batch 1 is judged, since the mistake no batch table catches is a valid campaign that is not the one the operator meant. An unknown argument is echoed four characters deep and no further: what sits on that command line is sometimes a token pasted one line too low. Each batch is appended to the run file as it lands. Without `--yes`, after each batch the CLI prints the batch table and asks `Continue with batch N+1? [y/N]` on stdin; anything but `y` stops the run and still writes the report. The report header prints the campaign name beside its id so the operator can confirm the target before the first batch runs. Env (process.env only, never a file): `VOCOBASE_API_URL` (default `https://api.vocobase.com`), `VOCOBASE_ADMIN_DEBUG_TOKEN`, `SIM_BASE_URL`, `SIM_API_KEY`, `SIM_MODEL`; exit 2 with a one-line message naming the missing variable. Uses `DATABASE_URL` through the normal Prisma client — refuse to start if `DATABASE_URL` is unset. Prints the markdown report to stdout and writes it to `scripts/reextract/runs/<campaignId>-<runId>.md`. Never prints the token or key, and never echoes an environment value.

Two things shifted while building it, both from the Task 7 review. The parsing is NOT in the script: `tsconfig.json` compiles `src/**` only, so a parser under `scripts/` is a parser nothing typechecks, and these are the decisions with the shortest path to the wrong campaign — so args, env, the ambiguous-name message and the header live in `src/lib/reextraction/cli.ts` with a test each, and `run.ts` is wiring. And the environment is validated BEFORE the service is imported: importing it pulls in `src/lib/env.ts`, which throws on the first thing the whole backend is missing, so an operator who forgot `SIM_API_KEY` would otherwise be told about `CLERK_SECRET_KEY`. The backend's own load failure is caught and re-stated as needing a full backend `.env`.

Exit 0 on a run that completed or that the operator stopped at a batch boundary; 1 on an abort or a batch abandoned to a model outage; 2 on every refusal to start. Verify by `npx tsx scripts/reextract/run.ts --help`, then against the local test DB with a campaign id that does not exist, and confirm no secret is echoed.

---

### Task 9: Docs and PR

- Modify: `CLAUDE.md` — a short "Re-extracting a campaign under a revised call-note contract" section: when to use it, the command, the env vars, dry-run first, that it refuses RUNNING campaigns (at selection AND again under the lock at every write, so unpausing mid-run stops the rest of it), and that a reopened `stop` deletes only the DNC row that contact's own old verdict created.
- The same section must carry the `EXCLUDED` follow-up, because it is manual work the run cannot do: contacts the report lists as `excluded` were removed by an operator **or swept out by the dispatcher's do-not-call pass**, and re-arming them is a deliberate two-part edit — set the contact `PENDING` and increment the campaign's `totalContacts` — to be done only after checking that no do-not-call row still covers the number, otherwise the next sweep excludes it again.
- Full suite green (`npx vitest run`, 16 known env failures aside), `npx tsc --noEmit` clean.
- Open PR `feat/reextract-rearm` → `main` with the design's Why, the decisions table, and the runbook. Do not run it against production from the PR.
