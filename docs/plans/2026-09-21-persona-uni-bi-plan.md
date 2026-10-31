# Uni/bi-directional agents (backend) — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, with superpowers:test-driven-development for every task.

**Goal:** Replace the three-value `AgentDirection` with `UNI | BI`, create the inbound face lazily when an inbound campaign first needs it, and shrink the direction transition table to two moves.

**Architecture:** Same column, new enum, one migration. The mirror predicate in `PATCH /agents/:id` is renamed, `PATCH …/direction` loses four of its six moves, and `inboundStart.ts` enables a face instead of refusing. Design: `../ye-voice-dashboard/docs/plans/2026-09-21-agent-persona-uni-bi-design.md` (copy it into this repo's `docs/plans/` as the first commit so the branch is self-describing).

**Tech Stack:** Express, Prisma 6, Vitest + supertest; Vocobase client mocked with `vi.mock`.

**Worktree:** `.worktrees/persona-mode/ye-voice-backend` on `feat/persona-uni-bi`, branched from `origin/main` (`bd4fd33` or later). Own Postgres + Redis index.

**Baseline:** record `npm test` count before Task 1. Suite is flaky at ~10%; rerun a red file before reading it.

**Do not touch:** anything under `src/services/dialer*`, `src/routes/campaigns.routes.ts` beyond what Task 4 names — the actions-api and google-connect streams edit those files in parallel.

---

## Task 1: Enum and migration

**Files:** `prisma/schema.prisma` (enum `AgentDirection`, the `direction` doc comment), new `prisma/migrations/<ts>_agent_direction_uni_bi/migration.sql`, `docs/deploy.md` (row).

Migration SQL — Postgres cannot drop enum values, so:
```sql
CREATE TYPE "AgentDirection_new" AS ENUM ('UNI', 'BI');
ALTER TABLE "Agent" ALTER COLUMN "direction" DROP DEFAULT;
ALTER TABLE "Agent" ALTER COLUMN "direction" TYPE "AgentDirection_new"
  USING (CASE "direction"::text WHEN 'BOTH' THEN 'BI' ELSE 'UNI' END)::"AgentDirection_new";
ALTER TABLE "Agent" ALTER COLUMN "direction" SET DEFAULT 'UNI';
DROP TYPE "AgentDirection";
ALTER TYPE "AgentDirection_new" RENAME TO "AgentDirection";
```
Test (`test/agent-direction.test.ts`, new `describe('enum')`): an agent created with no direction reads `UNI`; Prisma refuses `'BOTH'` at the type level (a `// @ts-expect-error` line is the test). Run `npm run test:prepare` before the suite. Commit: `Collapse an agent's direction to uni- or bi-directional`.

## Task 2: Serializer, error codes, and the read path

**Files:** `src/lib/serialize.ts` (`direction` passes through — no change needed unless a label map exists; verify), `src/lib/errors.ts` (keep `DIRECTION_CHANGED`), `src/routes/agents.routes.ts` `setDirectionSchema` → `z.enum(['UNI','BI'])`.

Tests: `PATCH …/direction { direction: 'BOTH' }` → 400 `VALIDATION_ERROR`; `GET` emits `direction: 'UNI'`. Commit: `Accept only UNI and BI on the direction route`.

## Task 3: The transition table

**File:** `src/routes/agents.routes.ts` lines ~689–760.

| From → To | Do |
| --- | --- |
| `UNI → BI` | if `!agent.inboundEnabled`: `setAgentInbound(externalId, true)` (no `confirm`); else nothing |
| `BI → UNI` | if `agent.inboundEnabled`: `updateAgentInbound(externalId, await baseConfigForFace(externalId))`; else nothing. **Requires `confirm: true`** — without it 409 `CONFIRM_REQUIRED` with `details: { overwrites: 'inbound' }` (YE's own code path; the platform's passthrough is no longer reachable and its branch is removed) |
| same | no-op, current detail |

Column moves only after the upstream act, via the existing conditional `updateMany`; `count === 0` → 409 `DIRECTION_CHANGED`. Rewrite the tests in `test/agent-direction.test.ts` §"PATCH …/direction" to the four cases above plus: `BI → UNI` without `confirm` writes nothing upstream; racing moves still 409. Delete tests for `→ OUTBOUND`, `CONFIRM_REQUIRED` passthrough, and disable. Commit: `Two direction moves, and never a disable`.

## Task 4: Lazy face for inbound campaigns

**Files:** `src/lib/inboundStart.ts` (both `AGENT_INBOUND_NOT_ENABLED` throw sites, lines ~60 and ~153), new `src/lib/ensureInboundFace.ts`.

`ensureInboundFace(agent)`: if `inboundEnabled` return; else `setAgentInbound(externalId, true)`, then `prisma.agent.update({ inboundEnabled: true })` (sync would also do it; do not wait for sync), return the refreshed row. Errors map to `AGENT_INBOUND_NOT_ENABLED` with the upstream message — the code stays, its meaning becomes "could not create the face", and `campaignConfig.ts:143`'s message is reworded to match. `inboundStart.ts` calls it instead of throwing. `direction === 'BI'` agents already have a face by construction; the helper is direction-agnostic.

Tests in `test/inbound-start.test.ts` (or wherever the two throws are covered): an inbound campaign on a `UNI` agent without a face **enables it** (assert `setAgentInbound` called with `true`) and starts; enable failure → 422 `AGENT_INBOUND_NOT_ENABLED`, nothing else written. Commit: `Create the inbound face the first time an inbound campaign needs it`.

## Task 5: The mirror predicate and the `include=inbound` gate

**File:** `src/routes/agents.routes.ts` line ~506: `agent.inboundEnabled && agent.direction === 'UNI' ? parsed : null`. Tests in `test/agent-direction.test.ts` §"save by direction": `UNI` + face → both sides; `UNI` no face → base only; `BI` → base only, extraction included. Commit: `Mirror the one editor onto the face in UNI`.

## Task 6: Rollout report script

**File:** `scripts/report-agent-direction.ts` — per workspace: `UNI` without face, `UNI` with face, `BI`. Add a row to `docs/deploy.md` (migration is additive-safe; the report is the post-deploy check). Commit: `Report agent directions after the enum move`.

## Task 7: Docs and CLAUDE.md

Update the routes table and the agent notes in `CLAUDE.md` (`direction` values; "a face is created lazily"). Copy the design doc in. Commit: `Document uni/bi agents`.

## Done when

- `npm test` green at ≥ baseline; `npx tsc --noEmit` clean.
- `git grep -nE "'(OUTBOUND|INBOUND|BOTH)'" src test scripts` returns nothing.
- PR opened against `main`, description names the dashboard PR it pairs with and says **merge backend first** (the dashboard tolerates both vocabularies; the backend does not).
