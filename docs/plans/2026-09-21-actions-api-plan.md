# Agent actions API — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, with superpowers:test-driven-development.

**Goal:** Turn the read-only lifecycle-hooks mirror into a full editor API (create, edit, delete, reorder, preview, sheet columns, runs), mirror the face in `UNI`, and stamp campaign context onto every outbound dial.

**Architecture:** §4–§8 of `docs/plans/2026-09-21-agent-actions-google-design.md`. New `src/routes/agent-actions.routes.ts`; the serializer learns to return `input` for owned rows; four adapter functions; `src/lib/contextVariables.ts` beside `goalVariables.ts`.

**Worktree:** `.worktrees/actions-api/ye-voice-backend` on `feat/actions-api` from `origin/main`. Own Postgres + Redis index.

**Coordinate:** google-connect appends to the adapter (fenced block) and persona-uni-bi edits `agents.routes.ts` around `direction`. This stream: adapter functions in a fenced block `// ---- lifecycle hooks & runs ----`; **do not edit the direction/transition code** — read `agent.direction` through a tiny helper `isUni(agent)` in `src/lib/agentDirection.ts` that accepts both `'UNI'` and `'INBOUND'` for the merge window, and delete the alias after both PRs merge.

**Platform dependency:** the V2 inbound-face routes and `skipUnless` land in a platform release; until then the adapter functions exist and the routes answer 501 `INBOUND_ACTIONS_UNAVAILABLE` on a face write (Task 6). Everything else works against today's platform.

---

## Task 1: Adapter
`createAgentLifecycleHook(agentId, body)`, `updateAgentLifecycleHook(agentId, hookId, body)`, `deleteAgentLifecycleHook`, `reorderAgentLifecycleHooks(agentId, {stage, ids})`, `previewAgentLifecycleHook`, `getSheetColumns(agentId, {spreadsheet_id, sheet_name})`, `listIntegrationLogs(query)`, and the face variants `getInboundLifecycleHooks`, `replaceInboundLifecycleHooks(agentId, hooks)`, `createInboundLifecycleHook`…, `setInboundAgentTool`. V2 hook routes use the bare `{error}` envelope and 422 `{error:'VALIDATION_FAILED', issues}` — use `bareBody` and pass `VALIDATION_FAILED` through with its `issues`. Commit: `Speak the lifecycle-hook write routes`.

## Task 2: Ownership + the extended read
`src/lib/serialize.ts` `serializeLifecycleHooks(rows, owned: (row) => boolean)`: owned rows add `tool_slug`, `tool_fn`, `function_id`, `input`, `skip_unless`, `owned: true`; others `owned: false`, shape as today. `src/lib/hookOwnership.ts`: `hookOwned(row, agentExternalId, workspaceId)` — tool hook → the agent's binding for that slug maps here (reuse `toolOwnership()` from `agents.routes.ts`, lift it into a lib); function hook → `resourceInWorkspace('FUNCTION')` (catch the 404 → false). Update `GET …/lifecycle-hooks`. Tests in `test/agent-lifecycle-hooks.test.ts`: an owned Sheets hook returns its `input`; a staff-bound hook does not; a function hook owned elsewhere does not. Commit: `Show a workspace the actions it owns, in full`.

## Task 3: Create
`POST /:ws/agents/:id/lifecycle-hooks` per §4.1: zod body; `source.kind==='tool'` → if `requireOwnedBinding` finds none: `connection_id` required + `resourceInWorkspace('CONNECTION')` + `setAgentTool(ext, slug, {enabled:true, connection_id})`; `source.kind==='function'` → `resourceInWorkspace('FUNCTION')`; then upstream create with `{stage: STAGE_UP, name, toolSlug, toolFn, functionId, input, exposeAs, required, timeoutMs, skipUnless}`; 201 with the serialized row. 422 passthrough. Tests: binds then creates; refuses enable-without-connection; passes `issues` through untouched; cross-workspace function 404. Commit: `Create a pre- or post-call action`.

## Task 4: Update, delete, reorder, preview, sheet columns
Each first proves ownership of the hook by re-reading the list and `hookOwned` (an unowned id → 404 `RESOURCE_NOT_FOUND`). `sheet-columns` requires an owned `google_sheets` binding and proxies typed errors (`NOT_CONNECTED` → 409 `INTEGRATION_NOT_CONNECTED`, `SHEET_NOT_CONFIGURED` → 422, `TAB_NOT_FOUND` → 404 with `details.tabs`). Tests per route. Commits per route.

## Task 5: Campaign context variables
`src/lib/contextVariables.ts`: `YE_CONTEXT_VARIABLE_NAMES = ['ezo_campaign_id','ezo_campaign_name','ezo_contact_id','ezo_attempt_no']`, `contextVariables({campaign, contact, attemptNo})`. In `dialer.ts` ~496: `{ ...projected, ...contextVariables(...), ...goalVariables(...) }`. Reserve the prefix: `agents.routes.ts` variable declaration (≈317) and the CSV mapper's accepted names refuse `^ezo_` with the same 400 as a hook-supplied name. Tests: `test/dialer-launch.test.ts` asserts the four on the `/calls/start` body and that a CSV column named `ezo_campaign_id` cannot shadow it; declaration refused. Update `scripts/conformance` and `scripts/battle-test.ts` reserved-key assertions. Commit: `Stamp campaign context onto every outbound call`.

## Task 6: Sides and the `UNI` mirror
`?side=inbound`: allowed only when `!isUni(agent) && agent.inboundEnabled`, else 404 `INBOUND_NOT_ENABLED`; routes to the inbound adapter functions. In `UNI` with a face, after every successful base write: `replaceInboundLifecycleHooks(ext, baseListAsCreateBodies)` and, when a bind happened, `setInboundAgentTool`. Failure → 200 `{ …, inboundActionsSynced:false, inboundActionsError }`. Upstream 404 on the inbound routes (platform release not yet deployed) → 501 `INBOUND_ACTIONS_UNAVAILABLE`, base write still done. Tests: mirror body equals the base list; failure surfaces; `BI` writes only the named side. Commit: `Keep the face's actions equal to the base in UNI`.

## Task 7: Runs
`GET /:ws/agents/:id/action-runs?from&to&cursor` → `listIntegrationLogs({agentId: ext, from, to, cursor, limit: 50})`, rows projected to `{id, session_id, tool_slug, fn, status, upstream_code, latency_ms, error, created_at}`; default window 24h. `GET /:ws/calls/:id/actions` → attempt in workspace; `upstreamSessionId` null → `{ runs: [], reason: 'not_placed' }`; else `listIntegrationLogs({agentId, sessionId, from: startedAt-5m, to: endedAt+60m})`. Tests. Commit: `Show which actions ran, per agent and per call`.

## Task 8: Docs
`CLAUDE.md` routes table; note the `ezo_` reserved prefix beside the goal variable. Commit.

## Done when
`npm test` ≥ baseline; `tsc` clean; `git grep ezo_` covers `scripts/`; PR against `main` listing the platform release it needs for Task 6's happy path.
