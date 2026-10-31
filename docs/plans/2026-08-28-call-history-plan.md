# Call History — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A read-only call-history surface — list, detail, transcript, recording — scoped to a workspace, across `ye-voice-backend` and `ye-voice-dashboard`. Design: `2026-08-28-call-history-design.md`.

**Architecture:** No schema change and no mirror table. Three routes hang off the existing membership middleware. A service walks Vocobase's `GET /calls` listing, filters each row against the workspace's agent set and the request's filters, and pages over the *filtered* stream under a bounded page budget. The recording is streamed through the backend, never redirected to.

**Tech stack:** existing — Express, TypeScript, Prisma, Zod, Vitest + Supertest; Next.js App Router + Tailwind on the dashboard. No new dependencies.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, under the guard in `test/setup.ts`. **Every test mocks the Vocobase client with `vi.mock`** — no test may make a real network call. The partner account is production and this slice's whole job is reading it. Nothing in this plan calls anything but `GET` upstream, and nothing touches `calls/start`, campaigns, or DIDs.

**Ports:** backend dev on `:3013`, dashboard dev on `:3014` (both set in the gitignored env files; `package.json` is not edited).

**Branch:** `feat/call-history` in both worktrees. Merge `origin/main` before opening PRs and keep both sides' additions — expected overlap is `src/app.ts`, `lib/api.ts`, `lib/types.ts`, `CLAUDE.md`.

---

## Backend

### Task 1: Vocobase call client

**Files:** extend `src/adapter/vocobase.ts`, `test/vocobase-adapter.test.ts`.

1. Failing tests, `fetch` stubbed via `vi.stubGlobal`:
   - `listCalls({ limit, offset })` requests `/calls` with both params and unwraps `{ calls, total, limit, offset }`;
   - `getCall(id)` requests `/calls/:id` and URL-encodes the id;
   - `getCallRecordingUrl(id)` requests `/calls/:id/recording-url`;
   - each maps an upstream failure envelope, a non-2xx, and a network throw to `ApiError(502, 'UPSTREAM_ERROR')`;
   - `fetchRecording(url, range?)` sends **no `Authorization` header** and forwards a `Range` header when given one.
2. Implement on the existing private `request<T>()`. Types mirror only fields verified in the design doc (§ What the Vocobase API actually returns); every field optional, unknown keys preserved.
3. `fetchRecording` is deliberately *not* built on `request()`: the presigned URL points at the supplier's object storage, not the API, and sending the partner key to a third-party host would be a credential leak. It returns the raw `Response` for streaming and throws `UPSTREAM_ERROR` on a network failure.
4. Commit: `feat: add Vocobase call-history client`.

### Task 2: Error codes

**Files:** `src/lib/errors.ts`.

1. Add `'RECORDING_NOT_AVAILABLE'` and `'CALL_HISTORY_UNAVAILABLE'` to `ErrorCode`.
2. Commit with Task 3 (a union member alone is not a commit).

### Task 3: Query parsing

**Files:** create `src/lib/callQuery.ts`, `test/call-query.test.ts`.

1. Failing tests:
   - `page`/`limit` follow the repo rule — a whole number ≥ 1, absent means the default (25), malformed is a `400` rather than a fallback, `limit` clamps at 100;
   - `from`/`to` accept a full ISO 8601 timestamp;
   - a date-only `from` (`2026-08-01`) becomes that day at `00:00:00.000Z`; a date-only `to` becomes `23:59:59.999Z`, so a single-day range includes the whole day;
   - `from` after `to` is a `400`;
   - an unparseable date is a `400`;
   - `status` and `disposition` are free text, trimmed, and case-folded for comparison — **no enum validation**, since the values are provider-controlled and a new carrier disposition must filter, not fail.
2. Implement `parseCallQuery(query)` returning `{ page, limit, skip, take, from, to, status, disposition, agentId, campaignId }`.
3. Do **not** add or reuse a shared `src/lib/pagination.ts`. That module arrives on the staff-admin branch with a different envelope (`total`, no `truncated`), and two modules with one name is a merge conflict that resolves into a wrong shape. Keep this local.
4. Commit: `feat: add call-history query parsing`.

### Task 4: Campaign correlation

**Files:** create `src/lib/callCorrelation.ts`, `test/call-correlation.test.ts`.

1. Failing tests:
   - `formatCorrelationId(campaignId, campaignContactId)` yields `ezo:<campaignId>:<campaignContactId>`;
   - `parseCorrelationId` returns `{ campaignId, campaignContactId }` for that shape;
   - returns `null` for another integrator's key (`crm:a:b`), for a bare string, for an empty string, for `null`, and for a non-string;
   - a value with extra segments is rejected rather than partially parsed.
2. Implement both. The prefix is `ezo:` and the separator is `:`, matching the shape already seen in live partner traffic.
3. Document in the module why this exists: a call carries no campaign id, so the dialer stamps one into `client_reference_id`, which is the only correlation field present on a **list** row (`variables` are detail-only). Nothing writes it yet; the dispatcher slice will.
4. Commit: `feat: add campaign correlation keys for calls`.

### Task 5: Call serializers

**Files:** extend `src/lib/serialize.ts`, create `test/call-serialize.test.ts`.

1. Failing tests:
   - `serializeCallSummary` projects only list-row fields and never emits `client_reference_id` raw or any upstream URL;
   - `normalizeTranscript` returns `{ kind: 'turns', turns }` for the documented array, mapping `role`/`content`/`timestamp` through the tolerant readers;
   - it returns `{ kind: 'unavailable', reason }` when the field is the **error object** seen in real payloads (`{ error, provider, terminal_reason }`) — this is the case that must never render as a conversation;
   - it returns `{ kind: 'unavailable', reason: null }` for `null`, `undefined`, `[]`, and a malformed value;
   - `serializeCallDetail` carries `recordingAvailable` as a boolean and **no recording URL**.
2. Implement, reading every upstream field through `src/lib/upstream.ts`. Add `readRecord`/`readArray` there if a reader is missing, with tests in `test/upstream.test.ts`.
3. Agent and campaign are attached by the service as `{ id, name } | null` from the local mirrors — never a bare upstream id, so the dashboard renders a name or `Not set`.
4. Commit: `feat: add call serializers with transcript normalization`.

### Task 6: The walk

**Files:** create `src/services/callHistory.ts`, `test/call-history-service.test.ts`.

1. Failing tests, `vi.mock('../src/adapter/vocobase.js')`:
   - **isolation:** a call whose `agent_id` maps to another workspace's agent is absent; one mapping to an unassigned agent is absent; one mapping to nothing is absent;
   - **history outlives usability:** a call whose agent has `status = "removed"` **is** listed — visibility uses workspace ownership only, never `agentIsUsable`/`NOT_REMOVED`;
   - **campaign leg:** a call whose `client_reference_id` is `ezo:<campaignId>:<ccId>` for a campaign in this workspace is visible even when its agent is not this workspace's; one naming another workspace's campaign is not; one carrying another integrator's key falls through to the agent leg;
   - **pagination over the filtered stream:** with matches scattered across upstream pages, page 2 returns the 26th–50th match, not upstream's second page;
   - `hasMore` is true when one further match exists and false on the last page;
   - **budget:** a stream that never fills the page stops after `MAX_UPSTREAM_PAGES` and returns `truncated: true` with `scanned` set;
   - **early exit:** when a whole batch predates `from`, the walk stops and does not request the next page (assert the mock's call count);
   - upstream exhaustion (a short batch) ends the walk with `truncated: false`;
   - filters compose: agent + date + status narrow together;
   - `status`/`disposition` match case-insensitively and match an **undocumented** value, proving no enum gate;
   - an upstream failure mid-walk propagates as `UPSTREAM_ERROR`.
2. Implement `listWorkspaceCalls(workspaceId, query)` per the design's pseudocode. Resolve the agent set once (`SELECT externalId, id, name WHERE workspaceId = ?`) into a `Map`, and the workspace's campaigns once, so per-row tests are in-memory.
3. Implement `getWorkspaceCall(workspaceId, callId)`: fetch upstream, derive visibility from the same two legs, throw `404 NOT_FOUND` when neither resolves. A call in another workspace and a nonexistent id must be indistinguishable.
4. `MAX_UPSTREAM_PAGES = 20` and `UPSTREAM_PAGE_SIZE = 100` are module constants with a comment stating the ceiling in calls (2,000) and that the budget is per request.
5. Commit: `feat: add workspace-scoped call history service`.

### Task 7: Routes

**Files:** create `src/routes/calls.routes.ts`, `test/calls.test.ts`. Extend `src/app.ts`.

1. Failing tests over HTTP:
   - all three routes 401 unauthenticated and 403 for a non-member;
   - a `MEMBER` may read all three — there is no ADMIN gate on this surface;
   - the list returns `{ items, page, limit, hasMore, truncated, scanned }`;
   - `?agentId=` naming another workspace's agent is a **404**, not an empty list — resolved through a workspace-scoped `findFirst` first, so the parameter cannot be used as an existence oracle;
   - `?campaignId=` likewise;
   - a malformed `?page=`/`?from=` is a 400;
   - detail 404s for a call the workspace cannot see;
   - the recording route streams bytes, sets `Accept-Ranges`, mirrors a `Range` request to `206` with `Content-Range`, and **its response body and headers contain no upstream URL** (assert on the full serialized response);
   - a call with no recording is `404 RECORDING_NOT_AVAILABLE`, distinct from `NOT_FOUND`;
   - the list is rate-limited per **workspace** and answers `429 RATE_LIMITED` past the cap.
2. Implement. Register `/:workspaceId/calls` behind `requireAuth, requireMembership()`. Order matters: `/calls/:callId/recording` before `/calls/:callId` is not required (distinct depths), but `/calls` must precede nothing that could shadow it.
3. The list limiter uses `createRateLimiter({ keyOf: (req) => workspaceOf(req).id })`, mounted **after** membership so an unauthenticated caller cannot spend a workspace's budget — the same construction and the same reason as the agents sync limiter. One list request costs up to 20 upstream requests against a rate limit every workspace shares.
4. Stream the recording with `Readable.fromWeb(response.body)` piped to `res`; never buffer. Mirror `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`. Destroy the upstream stream if the client disconnects.
5. Register in `src/app.ts` next to the other workspace routers.
6. Commit: `feat: add read-only call history routes`.

### Task 8: Backend docs

**Files:** `CLAUDE.md`.

1. Add a **Call history** section: the two-leg visibility rule and why history ignores `NOT_REMOVED`; the bounded walk, its budget, and why there is no `total`; the free-text status/disposition rule; the proxied recording and why not a redirect; the correlation key the dispatcher will stamp; and the telephony-only limitation.
2. Add the route rows to the route table.
3. Describe the surface as built here — the route table and the rules above are the whole record.
4. Commit: `docs: document the call history surface`.

### Gate

`npx tsc --noEmit` and `npm test` both green before opening the PR.

---

## Dashboard

### Task 9: Types and API surface

**Files:** `lib/types.ts`, `lib/api.ts`.

1. Add `CallSummary`, `CallDetail`, `Transcript` (the discriminated union from Task 5), `CallsPage`.
2. Add `RECORDING_NOT_AVAILABLE` and `CALL_HISTORY_UNAVAILABLE` to `ApiErrorCode`, and curated copy for them in `lib/errors.ts`. Backend wording is never rendered raw — the existing rule.
3. Commit: `feat: add call history API types`.

### Task 10: List page

**Files:** create `app/(dash)/calls/page.tsx`, `components/calls/calls-table.tsx`, `components/calls/call-filters.tsx`.

1. Filter bar: agent picker (over the workspace's agents), campaign picker, date range, free-text status and disposition. Filter state lives in the query string so a filtered view is a link.
2. Table columns: when, to/from, agent, campaign, direction, status, disposition, duration. Dense and scannable per the repo's design language; status never encoded by colour alone.
3. Four distinct states, never conflated: loading; empty ("No calls yet" — a fact about the workspace); failed ("The voice platform is temporarily unavailable" plus a retry — a fact about the request); and empty-after-filtering ("No calls match these filters", offering to clear them).
4. When `truncated`, a footer states what was searched — "Searched the 2,000 most recent calls; older calls are not included" — and points at the date range as the way to look further back.
5. Pagination is Previous/Next driven by `hasMore` and `page`. No page-count and no jump-to-last: the backend deliberately does not measure the set.
6. Every fetch carries the workspace-currency check used by the agents and notification surfaces — a response arriving after a workspace switch is discarded, never painted.
7. Commit: `feat: add the calls list with filters`.

### Task 11: Detail slide-over

**Files:** create `components/calls/call-detail.tsx`, `components/calls/transcript.tsx`, `components/calls/recording-player.tsx`.

1. A slide-over from the list, so the reader keeps their place in a filtered result. Addressable via `?call=<id>` so it survives a reload and can be linked.
2. Header: to/from, when, duration, status, disposition. Agent and campaign as names from the payload, `Not set` when unlinked — never a bare id.
3. Variables and extraction rendered when present; absent means the row says so, per the surface-wide rule that absent values are shown and never hidden.
4. `transcript.tsx` switches on the union: `turns` renders the conversation with speaker and timestamp; `unavailable` renders the reason when upstream gave one ("This call did not connect") and a plain "No transcript available" when it did not. **It never renders a blank pane and never fabricates a turn.**
5. `recording-player.tsx` renders a native `<audio controls>` pointed at the backend's `/recording` route when `recordingAvailable`, and an explicit "No recording for this call" when not. A `RECORDING_NOT_AVAILABLE` at play time is reported, not swallowed.
6. Commit: `feat: add the call detail slide-over with transcript and recording`.

### Task 12: Navigation

**Files:** `components/shell/sidebar.tsx`, delete `app/(dash)/sessions/page.tsx`.

1. Replace the `Sessions` nav entry with **Calls** → `/calls`, keeping the `PhoneCall` icon.
2. Delete the `Sessions` placeholder page — the surface it promised now exists under a name that matches what it holds.
3. Commit: `feat: replace the Sessions placeholder with the Calls surface`.

### Task 13: Tests and docs

**Files:** `test/calls-*.test.tsx`, `CLAUDE.md`.

1. Component tests: the four list states are distinguishable; a truncated response prints the footer; a workspace switch discards an in-flight response; the transcript union renders each arm correctly and an error object never renders as conversation; a call with no recording renders the explicit line rather than an empty player.
2. `CLAUDE.md`: a **Calls surface** section describing the pages, the four states, the truncation copy, the `Not set` rule, and the telephony-only limitation.
3. Commit: `docs: document the calls surface`.

### Gate

`npx tsc --noEmit`, `npm test`, and `npm run build` all green before opening the PR.

---

## Finishing

1. In each worktree: `git fetch origin && git merge origin/main`, keeping both sides' additions in `src/app.ts`, `lib/api.ts`, `lib/types.ts`, and `CLAUDE.md`.
2. Re-run every gate after the merge — a clean merge is not a passing build.
3. `gh pr create --base main` in each repo, explicitly. **Do not merge.** Report and stop.
