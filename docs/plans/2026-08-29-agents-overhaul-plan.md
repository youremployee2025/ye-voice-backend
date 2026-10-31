# Agents Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Revise the agent surface across `ye-voice-backend` and `ye-voice-dashboard` — full-page create, regrouped Settings, a multi-destination transfer catalog, a language-filtered voice picker, and a new Extraction tab. Design: `2026-08-29-agents-overhaul-design.md`.

**Architecture:** No schema change. `Agent.rawConfig` already mirrors the whole upstream record, so the two structured fields this slice adds are already stored and only need validating on the way in and projecting on the way out. Two files carry almost all the backend work — `src/lib/agentPayload.ts` (write validation) and `src/lib/serialize.ts` (read projection) — plus a new `src/lib/transferDestinations.ts` and `src/lib/extractionConfig.ts` for the two restated rule sets. No new route, no new dependency.

**Tech stack:** existing — Express, TypeScript, Prisma, Zod, Vitest + Supertest; Next.js App Router + Tailwind on the dashboard.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, under the guard in `test/setup.ts`. **Every test mocks the platform adapter with `vi.mock`** — no test may make a real network call, because the partner account is production and holds live customer agents. Nothing in this plan touches calls, campaigns or DIDs.

**Branch:** `feat/agents-overhaul` in both worktrees. Merge `origin/main` before opening PRs. Expected overlap on merge: `lib/types.ts` and `CLAUDE.md` on the dashboard; `CLAUDE.md` on the backend.

**TDD, strictly.** Every task below writes failing tests first, then the implementation. Commit small and often — one meaningful step per commit.

---

## Backend

### Task 1: Transfer destination rules

**Files:** create `src/lib/transferDestinations.ts`, `test/transfer-destinations.test.ts`.

1. Failing tests, one per rule from the design's table:
   - `null` is valid and means "clear";
   - `[]` is valid and must survive as `[]`, never fold into `null`;
   - more than 20 entries rejected;
   - `key` required, `^[a-z][a-z0-9_]*$`, ≤ 40 chars; a bad key names its index;
   - duplicate `key` rejected, naming the duplicate and its index;
   - `label` required, non-blank, ≤ 100;
   - `llmDescription` required, non-blank, ≤ 500 — assert the *required*, since a blank one is the failure the field exists to prevent;
   - `number` required, non-blank;
   - a literal number is canonicalized through `canonicalizeE164` (`'+91 98765 43210'` → `'+919876543210'`);
   - an invalid literal (`'+9109518550'`) rejected;
   - a `{{template}}` number passes through **untouched** and is not canonicalized;
   - unknown properties on an entry are dropped, not persisted.
2. Implement as a Zod schema plus a normalizer, mirroring the platform's own rules. Export `MAX_TRANSFER_DESTINATIONS = 20` and the per-field limits so the dashboard can restate them without a second source of truth.
3. The normalizer trims `key`, `label` and `llmDescription`, canonicalizes a literal `number`, and rebuilds each entry field-by-field — a spread would persist arbitrary extra properties into a JSON column that is then re-read on every call path.
4. Commit: `feat: restate the platform's transfer destination rules`.

### Task 2: Extraction config rules

**Files:** create `src/lib/extractionConfig.ts`, `test/extraction-config.test.ts`.

1. Failing tests:
   - `prompt` required, ≤ 50 000 chars;
   - `keys` ≤ 50; each `name` matches `^[a-zA-Z_][a-zA-Z0-9_]*$` and is unique;
   - `type` restricted to the seven the platform accepts;
   - `description` ≤ 500;
   - `analytics` boolean;
   - `values` ≤ 40 entries, each non-blank and ≤ 100 chars;
   - `values` duplicates rejected **case-insensitively** — `['Hot','hot']` is an error;
   - `values` order preserved through normalization;
   - `includeToolLogs` and `inlineEnabled` boolean;
   - `inlineEnabled` absent normalizes to `true`, so an API/UI round trip cannot silently flip it;
   - `callback_at` rejected as a new key name;
   - `callback_at` **accepted** when it is already among the agent's stored keys — the grandfather case, so re-saving an agent that has one does not lock its owner out of editing anything else.
2. Implement. The grandfather set is a parameter, defaulting to empty; create paths pass nothing.
3. Commit: `feat: restate the platform's extraction config rules`.

### Task 3: Wire both into the agent payload

**Files:** `src/lib/agentPayload.ts`, `test/agent-payload.test.ts`.

1. Failing tests:
   - `transfer_destinations` accepted by **both** create and update schemas;
   - `extraction_config` accepted by the update schema and **rejected — stripped — by the create schema**, because the platform's create route does not read it;
   - `kb_threshold`, `kb_include_summaries` and `kb_result_format` are stripped from both, so they are no longer forwarded;
   - `transfer_number` is canonicalized on the way in, and an invalid one is rejected rather than stored;
   - `WRITABLE_AGENT_FIELDS` contains both new fields and neither of the removed ones.
2. Implement: add `transfer_destinations` to `optionalFields`; add `extraction_config` to the update schema *only*; remove the three `kb_*` entries; extend `stripUnknown`'s `declared` set and `WRITABLE_AGENT_FIELDS` to match. `extraction_config` must be listed in `WRITABLE_AGENT_FIELDS` even though it is not in `optionalFields` — the agreement test in Task 4 is what keeps it readable.
3. Commit: `feat: accept transfer destinations and extraction config on an agent`.

### Task 4: Read projection

**Files:** `src/lib/serialize.ts`, `test/agents.test.ts`.

1. Failing tests:
   - `transfer_destinations` and `extraction_config` are readable on the detail;
   - both are **rebuilt, not passed through**: a snapshot entry carrying an extra key does not reach the response;
   - a malformed snapshot value (a string where an array belongs) projects to `null` rather than throwing or leaking;
   - an absent catalog reads `null` and an emptied one reads `[]` — the two stay distinguishable;
   - the three `kb_*` keys are no longer readable;
   - the existing "every writable field is readable" agreement test still passes.
2. Implement `serializeTransferDestinations` and `serializeExtractionConfig`, and add both keys to `VISIBLE_CONFIG_KEYS`. Both must **always emit their key** — as `null` when unreadable — or the agreement test's synthetic row (which sets every visible key to the string `'set'`) reports them missing.
3. Remove the three `kb_*` entries from `VISIBLE_CONFIG_KEYS`.
4. Commit: `feat: project the agent's structured config fields`.

### Task 5: Voice catalogue widens

**Files:** `src/lib/serialize.ts`, `test/agents.test.ts`.

1. Failing test: a voice row emits `tier` and `description` alongside `id`, `name`, `language`, `gender`, and still emits nothing else.
2. Add both to `VOICE_FIELDS`.
3. Commit: `feat: carry voice tier and description to the picker`.

### Task 6: Backend gates and docs

1. `npx tsc --noEmit`, then `npm test`. Both clean.
2. Update `CLAUDE.md` if the routes table or field notes are now stale.
3. Commit: `docs: record the agent surface's new fields`.

---

## Dashboard

### Task 7: Types

**Files:** `lib/types.ts`.

1. Add `TransferDestination` and `ExtractionConfig` (with `ExtractionKey`), matching the backend's projected shapes exactly.
2. Extend `AgentDetail['config']` consumers, `CreateAgentInput` (unchanged fields, but confirm), and `UpdateAgentInput` with `transfer_destinations` and `extraction_config`; remove the three `kb_*` entries.
3. Add `tier` and `description` to `Voice`.
4. Commit with Task 8 — a type change alone is not a commit.

### Task 8: The voice picker

**Files:** create `components/agents/voice-picker.tsx`, `test/voice-picker.test.tsx`.

1. Failing tests:
   - renders a card per voice, with name, language and tier;
   - the language filter is derived from the catalogue, not hardcoded;
   - filtering to a language shows only that language's voices;
   - **the selected voice stays visible under a filter that excludes it**, and the filter opens on the selected voice's language;
   - selecting a card calls `onChange` with the voice id;
   - a load failure renders the reason, not an empty grid;
   - a genuinely empty catalogue renders an explanation, not a silent blank.
2. Implement. Voices are fetched by the caller and passed in, so the create page and Settings share one fetch each rather than the component owning a request it would repeat.
3. Commit: `feat: pick a voice by language, from cards`.

### Task 9: The create page

**Files:** create `app/(dash)/agents/new/page.tsx`; delete `components/agents/new-agent-modal.tsx`; edit `app/(dash)/agents/page.tsx`; `test/create-agent-page.test.tsx`.

1. Failing tests:
   - submits exactly `{ agent_name, prompt, voice_id, agent_type, intro_message }` — an empty greeting sent as `null`, not `''`;
   - Create is disabled until name, instructions and voice are all present;
   - a `NAME_TAKEN` error reports on the name field, not as a whole-form failure;
   - success routes to `/agents/:id?tab=instructions`;
   - **does not** send `extraction_config` — the platform's create route would ignore it.
2. Implement the two-column layout from the design. "New agent" on the list page becomes a link to `/agents/new`; the `creating` state and the modal render go.
3. Wire `useUnsavedGuard` to a dirty check over the form.
4. Delete `new-agent-modal.tsx`.
5. Commit: `feat: create an agent on a page, not in a dialog`.

### Task 10: Form values for the structured fields

**Files:** `components/agents/agent-form.ts`, `test/agent-form.test.ts`.

1. Failing tests:
   - `toFormValues` reads a destination catalog and an extraction config out of `config`, and a missing one yields the empty/`null` form value;
   - both are held as **serialized JSON strings** in the form, so `useDirtyForm`'s shallow array comparison stays correct — a round trip with no edit is not dirty;
   - `toUpdate` emits `transfer_destinations: []` when the catalog is emptied, never `null` and never omission;
   - `toUpdate` omits an untouched structured field entirely;
   - the three `kb_*` fields are gone from both directions.
2. Implement, with parse/serialize helpers beside the form so no component parses JSON inline.
3. Commit: `feat: carry the structured agent fields through the form`.

### Task 11: The transfer destinations editor

**Files:** create `components/agents/transfer-destinations.tsx`, `test/transfer-destinations-editor.test.tsx`.

1. Failing tests:
   - with an empty catalog the single-number field renders; with a non-empty one it does not;
   - **hiding the number does not clear it** — emptying the catalog brings the stored value back;
   - adding a destination derives `key` from the label by slugification;
   - editing `key` directly stops it tracking the label;
   - a pristine new row shows no field errors; a touched-then-emptied field does, and blocks Save;
   - remove and reorder mutate the array in place, order preserved;
   - the add control disables at 20 and says so.
2. Implement, restating the backend's exported limits rather than re-declaring numbers.
3. Commit: `feat: edit a catalog of named transfer destinations`.

### Task 12: Settings regrouped

**Files:** `components/agents/tab-settings.tsx`, `test/tab-settings.test.tsx`.

1. Failing tests:
   - Status, Knowledge sources and Language rows are **absent**;
   - no `kb_*` control renders;
   - the voice picker renders in place of the old `<select>`;
   - the transfer card renders the destinations editor;
   - Post-call extraction no longer renders here.
2. Implement the four-card regroup from the design. Keep `Row`, `SwitchRow` and the `aria-describedby` wiring — the accessibility work there is not what the feedback objected to.
3. Commit: `feat: regroup agent settings into purposeful cards`.

### Task 13: The Extraction tab

**Files:** create `components/agents/tab-extraction.tsx`, edit `app/(dash)/agents/[agentId]/page.tsx`, `test/tab-extraction.test.tsx`.

1. Failing tests:
   - **round-trips a config unchanged** — load, render, save with no edit, and the payload equals what came in. This is the strongest guard against a form silently dropping a field it does not render;
   - the enable toggle and the run-after-each-call toggle are independent controls mapping to `extraction_enabled` and `extraction_config.inlineEnabled`;
   - the prompt's 50 000-character limit is shown as a live counter;
   - adding a key, setting its type, and marking it for lead buckets;
   - the answers list only renders on a key marked for lead buckets;
   - a duplicate answer differing only in case is reported;
   - `callback_at` is refused as a new key name;
   - key and answer caps disable their add controls and say so.
2. Add `extraction` to `TABS` and to `FORM_TABS`, so it shares the header's Save.
3. Commit: `feat: configure post-call extraction on its own tab`.

### Task 14: Dashboard gates

1. `npx tsc --noEmit`, `npm test`, `npm run build`. All clean.
2. Update `CLAUDE.md`.
3. Commit: `docs: record the revised agent surface`.

---

## Manual verification

Once both suites are green. One throwaway agent named `zz-ezo-dev-scratch`, hard-deleted through the staff route afterwards.

1. Create it from `/agents/new`, choosing a voice through the language filter.
2. On Settings, confirm the removed rows are gone and the voice picker holds the selection.
3. Add two transfer destinations; confirm the single-number field hides; save; reload; confirm both round-trip.
4. Empty the catalog; confirm the single number returns with its stored value.
5. On Extraction, enable, write a prompt, add a key with pinned answers; save; reload; confirm unchanged.
6. Hard-delete the agent through the staff route. Verify it is gone.

**No calls endpoint is touched at any point.**

## Then

`git merge origin/main` in both worktrees, re-run every gate, then `gh pr create --base main` — one PR per repo. **Do not merge.** Report and stop.
