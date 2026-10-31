# Google connections per workspace — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, with superpowers:test-driven-development.

**Goal:** Let a workspace admin connect Google Sheets, Google Calendar and Gmail to their workspace through the platform's hosted OAuth, with the resulting connection owned by a partner customer that represents the workspace and mapped into `WorkspaceResource`.

**Architecture:** §2–§3 of `docs/plans/2026-09-21-agent-actions-google-design.md`. New `Workspace.partnerCustomerId`, a nonce in Redis for the return leg, four routes, five adapter functions.

**Worktree:** `.worktrees/google-connect/ye-voice-backend` on `feat/google-connect` from `origin/main`. Own Postgres + Redis index.

**Coordinate:** the actions-api stream also appends to `src/adapter/vocobase.ts`. Put this stream's adapter functions in a clearly fenced block at the end of the file under `// ---- partner customers & connections ----`; expect a trivial merge.

---

## Task 1: Schema
`Workspace.partnerCustomerId String? @unique`; migration `workspace_partner_customer`. Add to `test/setup.ts` nothing (no new table). Commit: `Give a workspace a partner customer upstream`.

## Task 2: Adapter
In `src/adapter/vocobase.ts`: `createPartnerCustomer({external_id, name})`, `createConnectLink(customerId, {tool_slug, redirect_uri, expires_in_seconds?})`, `listCustomerConnections(customerId)`, `deleteCustomerConnection(customerId, connectionId)`, `listConnectors()`. All through `request()`; the connect-link error codes (`ConnectLinkError`, 400 uppercased) pass through with `passUpstreamError`. Unit tests with `vi.mock` on fetch per the file's existing pattern. Commit: `Speak the partner-customer routes`.

## Task 3: `ensurePartnerCustomer(workspace)`
New `src/lib/partnerCustomer.ts`: returns the id; creates with `external_id = workspace.id`, `name = workspace.name` when null; persists; idempotent across a lost response (a second create returns the same row upstream). Tests: creates once; reuses; concurrent calls (two promises) create once — use the `@unique` as the guard and retry-read on P2002. Commit: `Create the workspace's partner customer on first use`.

## Task 4: Env
`PUBLIC_API_URL` (this backend's public origin, used for the return URL) and `DASHBOARD_URL` — check `src/lib/env.ts` for an existing dashboard origin (CORS / invite links) and reuse it if present rather than adding a second. Both required at boot only when `VOCOBASE_API_KEY` is set. Commit: `Name the two origins the connect flow redirects between`.

## Task 5: Routes — `src/routes/integrations.routes.ts`, mounted at `/api/workspaces`
- `GET /:ws/integrations` (member): connectors from `listConnectors()` filtered to the three slugs, joined with `listCustomerConnections` (empty when no customer yet) → `{ tools: [{slug, name, connections: [{id, providerEmail, status, createdAt}]}] }`. Also **reconciles**: any connection upstream for this customer that is not yet in `WorkspaceResource` is claimed here (the return leg can be lost).
- `POST /:ws/integrations/:slug/connect` (ADMIN, `writeLimiter`): slug allow-list; `ensurePartnerCustomer`; nonce = 32 random bytes base64url; Redis `ezo:oauth:${nonce}` = `{workspaceId, slug, accountId}` TTL 900s; `createConnectLink(pcid, { tool_slug: slug, redirect_uri: `${PUBLIC_API_URL}/integrations/google/return/${nonce}` })` → `{ url, expires_at }`.
- `GET /integrations/google/return/:nonce` (public, mounted before auth like `/webhooks`): `GETDEL` the nonce (single use; missing → redirect `?error=expired`); read `status`, `connection_id`, `error`; on `status !== 'ok'` → `?error=denied` (or the platform's code, lowercased, from an allow-list); on ok → `listCustomerConnections(pcid)` must contain `connection_id` else `?error=not_ours`; `claimResource('CONNECTION', connection_id, ws, providerEmail)` (409 already-mapped → treat as success); 302 `${DASHBOARD_URL}/settings/integrations?connected=${slug}`.
- `DELETE /:ws/integrations/connections/:id` (ADMIN): `resourceInWorkspace` first; `deleteCustomerConnection`; `unmapResource`; 204.

Tests (`test/integrations.test.ts`): member cannot connect (403); connect mints a nonce and the URL; return with a bad nonce redirects `expired`; return with a connection not in the customer's list redirects `not_ours` and maps nothing; happy path maps and redirects; list reconciles an unmapped upstream connection; disconnect unmaps and calls upstream; cross-workspace disconnect 404. Commit per route.

## Task 6: Docs
`CLAUDE.md` routes table, env table; `docs/deploy.md` row: **before enabling in an environment, the partner user's `allowedRedirectHosts` upstream must list `PUBLIC_API_URL`'s host** — otherwise connect-link answers 400 `REDIRECT_HOST_NOT_ALLOWED` (surface that code to the dashboard as `INTEGRATIONS_NOT_CONFIGURED`). Commit: `Document the Google connect flow`.

## Done when
`npm test` ≥ baseline, `tsc` clean, PR against `main` naming the dashboard integrations-page PR.
