# Goal Verdicts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the required-keys goal predicate with a bot-judged verdict, replace the merged key-value context with a rolling memory plus a last-call note, make the goal decision wait for the event that carries the answers, and scope do-not-call to the campaign.

**Architecture:** The design is `docs/plans/2026-09-02-goal-verdict-design.md` — read it first, every task below implements one of its sections. The engine (claim lanes, caps, retry ladder, callbacks, idempotency) is untouched. Three things change: what the campaign stores as its goal (prose), what the bot returns (a five-key verdict via one agent-level managed extraction set, with the goal reaching the bot through a prompt block YE writes into the agent), and when YE decides (on `session.completed`, after the context record is written, inside the same transaction as the charge).

**Tech Stack:** Express + Prisma + Postgres (backend), Next.js + React Testing Library (dashboard), vitest everywhere, an in-memory Vocobase mock (`ezo/ye-voice-agent/vocobase-mock`) driven by the conformance and battle harnesses.

---

## Before you start

Two worktrees already exist and have their dependencies installed:

- Backend: `/Users/sajaldewangan/Desktop/revenue-generator/.worktrees/goal-verdict/ye-voice-backend` (branch `feat/goal-verdict`)
- Dashboard: `/Users/sajaldewangan/Desktop/revenue-generator/.worktrees/goal-verdict/ye-voice-dashboard` (branch `feat/goal-verdict`)

The mock lives outside both, at `/Users/sajaldewangan/Desktop/revenue-generator/ezo/ye-voice-agent/vocobase-mock` (its own package, no git branch — it is unversioned in this workspace; edit it in place).

**The backend worktree needs its own databases.** Never point it at the main checkout's dev database: `prisma migrate dev` will demand a reset when two branches disagree on migrations. Create the pair once:

```bash
docker exec ye-dev-pg  psql -U postgres -c 'CREATE DATABASE ye_voice_goal_verdict;'
docker exec ye-test-pg psql -U postgres -c 'CREATE DATABASE ye_test_goal_verdict;'
cd /Users/sajaldewangan/Desktop/revenue-generator/.worktrees/goal-verdict/ye-voice-backend
cp ../../../ezo/ye-voice-agent/ye-voice-backend/.env .env
sed -i '' 's#localhost:5436/ye_voice#localhost:5436/ye_voice_goal_verdict#; s#localhost:5435/postgres#localhost:5435/ye_test_goal_verdict#' .env
grep -E '^(DATABASE_URL|TEST_DATABASE_URL|TEST_REDIS_URL)=' .env
npm run test:prepare
npm test -- test/goal-record.test.ts
```

Expected: the last command passes (baseline is green before any change). If `TEST_REDIS_URL` is missing from the copied `.env`, add `TEST_REDIS_URL=redis://localhost:6382/14` (a database index nobody else uses — 9 dev, 10 tests, 11–13 harnesses are taken).

Backend suite note: the suite has ~10% cross-file flake. A failing file that passes alone (`npm test -- test/<file>`) is not your bug.

Conventions every task follows:
- Tests use `vi.mock('../src/adapter/vocobase.js', …)` for the platform client, `truncateAll()` from `test/setup.js` in `beforeEach`/`afterEach`, and `makeAccount`/`makeWorkspace`/`makeAgent` from `test/helpers.js`. Copy the shape of the neighbouring test file named in each task.
- Comments in this codebase explain *why*, at length. Match that register; do not strip existing comments you are not changing.
- Commit after every task with the trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HLnmS7jiSwzcvxDYttxCZL
  ```
- Never mention the platform's source code, its repository, or any private reference repository in comments, docs, or commit messages. Describe the platform only by its observable behaviour ("the platform sends…").

---

## Part A — Backend: schema and pure modules

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (Campaign ~line 260, CampaignContactGoal ~line 469, DoNotCall ~line 509, Workspace relation line 74)
- Create: `prisma/migrations/<timestamp>_goal_verdict/migration.sql` (generated, then hand-edited)

**Step 1: Edit the schema**

In `model Campaign`, replace `goalKeys String[] @default([])` with:

```prisma
  /// The goal in the operator's own words. Null or blank is the feature off
  /// and behaviorally invisible; non-null turns the follow-up engine on. Set
  /// in DRAFT only: what the goal IS changes the meaning of every verdict
  /// already recorded, where how hard it is pursued (the three knobs below)
  /// is dispatcher policy the next claim re-reads.
  goal String?
```

Keep `maxTotalDials`, `maxGoalFollowUps`, `followUpDelayHours` exactly as they are.

Replace the body of `model CampaignContactGoal` with:

```prisma
model CampaignContactGoal {
  id                String @id @default(uuid())
  campaignContactId String @unique

  /// The rolling memory: the paragraph the bot rewrites after every
  /// conversation, and the one thing the next call is told about the person
  /// beyond the note below. Null until a conversation has happened.
  memory        String?
  /// Which attempt wrote `memory`. A redelivery of attempt N landing after
  /// attempt N+1 already wrote must not put N's paragraph back over N+1's.
  memoryAttempt Int?
  /// Derived by YE on every recorded attempt, silences included — never a
  /// model's answer, so a voicemail always has a note.
  lastCallNote  String  @default("")
  /// The bot's last non-empty "still needed" line.
  goalMissing   String?

  /// One entry per recorded attempt: `{ attemptNo, kind, disposition,
  /// answeredBy, nextAction?, reason?, callbackNote?, durationSecs? }`.
  /// Keyed by `attemptNo`, so replaying an attempt replaces its own entry.
  /// Bounded by `maxTotalDials <= 15`, so a Json log is safe.
  attemptLog Json @default("[]")

  updatedAt DateTime @updatedAt

  campaignContact CampaignContact @relation(fields: [campaignContactId], references: [id], onDelete: Cascade)
}
```

Replace `model DoNotCall` with:

```prisma
/// A campaign's do-not-call list. Per CAMPAIGN, deliberately: a person who
/// says "stop calling me about this" has opted out of this campaign, and a
/// second campaign in the workspace may still dial the number. Keyed by phone
/// rather than by contact so it survives contact deletion and re-import
/// within the campaign.
model DoNotCall {
  id         String  @id @default(uuid())
  campaignId String
  phone      String // E.164
  /// Why the number is listed, for the journey and the operator.
  reason     String?
  /// The campaign contact whose call put the number here. A plain pointer,
  /// not a foreign key: the opt-out must outlive the contact row it came from.
  sourceCampaignContactId String?

  createdAt DateTime @default(now())

  campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  @@unique([campaignId, phone])
}
```

Remove `doNotCall DoNotCall[]` from `model Workspace` (line 74) and add `doNotCall DoNotCall[]` to `model Campaign`.

**Step 2: Generate the migration**

```bash
npx prisma migrate dev --name goal_verdict --create-only
```

Open the generated `migration.sql`. Prisma will have written `ALTER TABLE "CampaignContactGoal" DROP COLUMN "mergedExtraction", DROP COLUMN "keyAttempts", DROP COLUMN "summaryNote"` and an `ALTER TABLE "DoNotCall"` that adds a NOT NULL `campaignId` — which fails on any existing row. Replace the DoNotCall statements with a replacement that **preserves the old rows**.

Do NOT simply `DROP TABLE "DoNotCall"`. "No goal campaign has run in production" does not cover this table: `recordOutcome` judges the opt-out on every resolution of every campaign, ahead of the goal gate, because the opt-out extraction set is attached to the AGENT and agents are many-to-one with campaigns. Any campaign whose agent carries the key can have written rows, and those rows are people who asked not to be called. The deploy runs `prisma migrate deploy` unattended.

Rename the old table out of the way instead — but only when it has rows, so that a clean database (dev, test, CI, and the shadow database Prisma replays the chain into) is left byte-identical to `schema.prisma`. An unconditional rename leaves a table behind that the datamodel does not declare, which is drift, and the next `prisma migrate dev` on this branch would then write `DROP TABLE "DoNotCall_workspace_legacy"` into the following migration and destroy on deploy exactly the rows the rename saved. Rename the pkey and the workspace FK with `ALTER TABLE … RENAME CONSTRAINT`, and the unique key with `ALTER INDEX` — it is a plain unique index, not a table constraint. Verify the three names against the migration that created the table; a rename of a name that does not exist fails the whole deploy.

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "DoNotCall") THEN
    ALTER TABLE "DoNotCall" RENAME TO "DoNotCall_workspace_legacy";
    ALTER TABLE "DoNotCall_workspace_legacy" RENAME CONSTRAINT "DoNotCall_pkey" TO "DoNotCall_workspace_legacy_pkey";
    ALTER TABLE "DoNotCall_workspace_legacy" RENAME CONSTRAINT "DoNotCall_workspaceId_fkey" TO "DoNotCall_workspace_legacy_workspaceId_fkey";
    ALTER INDEX "DoNotCall_workspaceId_phone_key" RENAME TO "DoNotCall_workspace_legacy_workspaceId_phone_key";
  ELSE
    DROP TABLE "DoNotCall";
  END IF;
END
$$;
CREATE TABLE "DoNotCall" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT,
    "sourceCampaignContactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DoNotCall_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DoNotCall_campaignId_phone_key" ON "DoNotCall"("campaignId", "phone");
ALTER TABLE "DoNotCall" ADD CONSTRAINT "DoNotCall_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Keep Prisma's statements for `Campaign` (`DROP COLUMN "goalKeys"`, `ADD COLUMN "goal" TEXT`) and `CampaignContactGoal`. The unique index on `(campaignId, phone)` also serves the claim's `campaignId = ? AND phone = ?` probe, so no extra index is needed.

**Step 3: Apply and regenerate**

```bash
npx prisma migrate dev
npx prisma generate
npm run test:prepare
npx tsc --noEmit 2>&1 | head -40

# The renamed COLUMNS, by name.
grep -rn 'workspaceId_phone\|goalKeys\|mergedExtraction\|keyAttempts\|summaryNote' src/ test/ scripts/

# The re-parented MODEL: every file that touches it, then every workspace
# reference in those files.
grep -rn 'workspaceId' $(grep -rl 'doNotCall\|DoNotCall' src/ test/ scripts/)
```

Expected: `tsc` now reports errors in every file that read `goalKeys`, `mergedExtraction`, `keyAttempts`, `summaryNote`, or `workspaceId_phone`. That list is your map for Parts B and C. Do not fix them yet.

**`tsc` alone is not the map — run both greps too, and treat their hits as part of the same list.** After this task `tsc` reports 32 errors across eight files (`src/lib/campaign.ts`, `src/routes/campaigns.routes.ts`, `src/services/campaignJourney.ts`, `campaignStart.ts`, `dialer.ts`, `dialerClaim.ts`, `dialerOutcome.ts`, `webhookOutcome.ts`) — and that list is not complete.

**Why two greps, and not one.** The first grep enumerates renamed FIELD names, so it finds a file only if the file spells one of them. The two known miss cases spell none:

- `src/routes/doNotCall.routes.ts` (registered at `src/app.ts` line 101 as `/api/workspaces/:workspaceId/do-not-call`, so this is a live production route) writes `workspaceId`, never `workspaceId_phone` — the compound-key name is what the first grep looks for, and a plain `where: { workspaceId }` does not contain it. `tsc` misses it too, at both of its call sites: the list handler builds `const where = { workspaceId, … }` and passes the variable, where the excess-property check that would flag it fires only on an object literal written at the call site, and Prisma's `Subset<>` inference lets the widened variable through; and the delete handler's `findFirst({ where: { id: …, workspaceId: … } })` **is** an inline literal and still compiles clean. So the file is invisible to both the first grep and `tsc`, while at runtime it queries `prisma.doNotCall` by a column that no longer exists and 500s the route with `PrismaClientValidationError`.
- `src/services/dialerClaim.ts` lines 217 and 281 write `dnc."workspaceId"` inside `$queryRaw`/`$executeRaw` template literals. SQL in a string is opaque to `tsc` by construction, and again the token is `workspaceId`, not a renamed field name.

The second grep is shaped for the model rather than the field: find every file that mentions `DoNotCall`/`doNotCall` at all, then show every workspace reference inside those files. Both misses fall out of it. It is deliberately noisy — a file that touches the model and also has ordinary `campaign.workspaceId` lines shows those too — and reading past that noise is the price of a gate that cannot miss a re-parenting.

Task 10 owns `doNotCall.routes.ts` and `dialerClaim.ts`; the point here is only that the second grep, not `tsc` and not the first grep, is what surfaces them.

**Step 3b: Exercise the `THEN` branch once, on a scratch database**

Every flow a developer runs — `migrate dev`, CI, the shadow database — starts from an empty `DoNotCall` and therefore takes the `ELSE` (plain `DROP TABLE`) branch. The four renames in the `THEN` branch are the branch production will take and the only one nothing exercises. Failure would be safe (the migration is transactional, so a bad rename rolls back and blocks the deploy) but it would be a paged on-call for a check that costs two minutes. Run it once, against a throwaway database:

```bash
ADMIN='postgresql://postgres:devpass@localhost:5436/postgres'
SCRATCH='postgresql://postgres:devpass@localhost:5436/ezo_replay_goal_verdict'
psql "$ADMIN" -c 'DROP DATABASE IF EXISTS ezo_replay_goal_verdict' \
               -c 'CREATE DATABASE ezo_replay_goal_verdict'

# Replay the chain up to the migration BEFORE this one. `migrate deploy` reads
# whatever `migrations/` sits beside the schema it is pointed at, so a copy of
# `prisma/` with the goal_verdict directory removed is the whole trick.
cp -R prisma /tmp/prisma-prev
rm -rf /tmp/prisma-prev/migrations/20260901210442_goal_verdict
DATABASE_URL="$SCRATCH" npx prisma migrate deploy --schema /tmp/prisma-prev/schema.prisma

# Seed one opt-out. Account and Workspace first — the FK is the point.
psql "$SCRATCH" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Account" (id, "clerkUserId", email, name)
  VALUES ('acc_replay', 'clerk_replay', 'replay@example.test', 'Replay');
INSERT INTO "Workspace" (id, name, slug, "ownerAccountId")
  VALUES ('ws_replay', 'Replay WS', 'replay-ws', 'acc_replay');
INSERT INTO "DoNotCall" (id, "workspaceId", phone, reason)
  VALUES ('dnc_replay', 'ws_replay', '+919812345678', 'Asked not to be called again.');
SQL

# Now the real migrations directory, which has exactly goal_verdict pending.
DATABASE_URL="$SCRATCH" npx prisma migrate deploy

psql "$SCRATCH" -c '\d "DoNotCall_workspace_legacy"' \
                -c 'SELECT * FROM "DoNotCall_workspace_legacy"' \
                -c '\d "DoNotCall"' \
                -c 'SELECT count(*) FROM "DoNotCall"'
psql "$ADMIN" -c 'DROP DATABASE ezo_replay_goal_verdict'
rm -rf /tmp/prisma-prev
```

Expected: `DoNotCall_workspace_legacy` still holds the seeded row and owns all three renamed names — `DoNotCall_workspace_legacy_pkey`, `DoNotCall_workspace_legacy_workspaceId_fkey`, `DoNotCall_workspace_legacy_workspaceId_phone_key` — while the new `DoNotCall` is empty and owns the originals: `DoNotCall_pkey`, `DoNotCall_campaignId_phone_key` and `DoNotCall_campaignId_fkey` to `Campaign`.

One local consequence to know about: if your own dev database happened to hold `DoNotCall` rows, your `npx prisma migrate dev` above took the `THEN` branch too and left `DoNotCall_workspace_legacy` behind on it. That table is drift against `schema.prisma`, so once you have confirmed the rename, drop it locally (`psql "$DATABASE_URL" -c 'DROP TABLE "DoNotCall_workspace_legacy"'`) — otherwise the next `prisma migrate dev` reports drift and asks to reset. Production is where the table is meant to survive; a dev box is not.

**Step 4: Add the migration to the promotion runbook**

Open `docs/deploy.md`, find the migrations table, and add a row. It must state plainly that the workspace-scoped list is left behind as `DoNotCall_workspace_legacy` for review and a manual drop, that the new per-campaign list starts empty, and that the migration is not code-rollback-safe (the previous build selects `Campaign.goalKeys` and `DoNotCall.workspaceId`). An operator reading that row must not come away thinking the old opt-out rows are simply gone. Be precise about the "no manual SQL" claim the section preamble defines: no manual SQL is needed for the deploy itself to succeed, but the row is not one that can be left alone — if `DoNotCall_workspace_legacy` appears it needs a decision and a manual drop afterwards.

**Step 5: Commit**

```bash
git add prisma docs/deploy.md
git commit -m "Store the goal as prose, the context as a memory, and do-not-call per campaign"
```

---

### Task 2: Reserved extraction keys

**Files:**
- Modify: `src/lib/extractionConfig.ts:38-107`
- Test: `test/extraction-config.test.ts` (exists; extend)

**Step 1: Write the failing test**

Append to `test/extraction-config.test.ts`:

```ts
describe('reserved goal keys', () => {
  it('names the five verdict keys and the callback key as reserved', async () => {
    const { RESERVED_EXTRACTION_KEYS, GOAL_MANAGED_EXTRACTION_KEYS, GOAL_VERDICT_KEYS } = await import(
      '../src/lib/extractionConfig.js'
    );
    expect([...GOAL_VERDICT_KEYS]).toEqual([
      'goal_achieved',
      'goal_missing',
      'next_action',
      'next_action_reason',
      'memory',
    ]);
    for (const key of GOAL_VERDICT_KEYS) expect(RESERVED_EXTRACTION_KEYS.has(key)).toBe(true);
    expect(RESERVED_EXTRACTION_KEYS.has('callback_requested_at')).toBe(true);
    expect(RESERVED_EXTRACTION_KEYS.has('callback_at')).toBe(true);
    expect(RESERVED_EXTRACTION_KEYS.has('do_not_call')).toBe(false);
    expect(RESERVED_EXTRACTION_KEYS.has('call_summary')).toBe(false);
    expect([...GOAL_MANAGED_EXTRACTION_KEYS]).toEqual([...GOAL_VERDICT_KEYS]);
  });

  it('refuses a user-defined verdict key by name', async () => {
    const { extractionConfigSchema } = await import('../src/lib/extractionConfig.js');
    const result = extractionConfigSchema().safeParse({
      prompt: 'x',
      keys: [{ name: 'memory', type: 'string' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reserved by campaign goals');
  });
});
```

**Step 2: Run it**

```bash
npm test -- test/extraction-config.test.ts
```
Expected: FAIL — `GOAL_VERDICT_KEYS` is not exported.

**Step 3: Implement**

In `src/lib/extractionConfig.ts`, delete the `DO_NOT_CALL_KEY` and `CALL_SUMMARY_KEY` constants and their comments. Keep `CALLBACK_AT_KEY` and `CALLBACK_REQUESTED_AT_KEY`. Add, after `CALLBACK_REQUESTED_AT_KEY`:

```ts
/**
 * The verdict a goal campaign's agent returns at the end of every call,
 * attached as one managed set the way the callback key is. Reserved because
 * each one is read as a decision: a user-defined `next_action` would decide
 * who gets called again, and a user-defined `memory` would become what the
 * next call is told about the person.
 */
export const GOAL_ACHIEVED_KEY = 'goal_achieved';
export const GOAL_MISSING_KEY = 'goal_missing';
export const NEXT_ACTION_KEY = 'next_action';
export const NEXT_ACTION_REASON_KEY = 'next_action_reason';
export const MEMORY_KEY = 'memory';

export const GOAL_VERDICT_KEYS = [
  GOAL_ACHIEVED_KEY,
  GOAL_MISSING_KEY,
  NEXT_ACTION_KEY,
  NEXT_ACTION_REASON_KEY,
  MEMORY_KEY,
] as const;

/** What `next_action` may say. A prompt instruction, not a schema enum — the
 *  model may answer null, and null is "no verdict". */
export const NEXT_ACTIONS = ['done', 'call_again', 'call_back_at', 'stop'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];
```

Rewrite `RESERVED_KEY_NAMES` as:

```ts
const RESERVED_KEY_NAMES: ReadonlyMap<string, string> = new Map([
  [CALLBACK_AT_KEY, 'the voice platform'],
  [CALLBACK_REQUESTED_AT_KEY, 'campaign callbacks'],
  ...GOAL_VERDICT_KEYS.map((key) => [key, 'campaign goals'] as const),
]);
```

Rewrite `GOAL_MANAGED_EXTRACTION_KEYS` as `new Set(GOAL_VERDICT_KEYS)` and shorten its comment to: the subset campaign goals manage, and the only names `leadBucketKey` refuses (the two callback keys stay pickable for the grandfathering reason already documented there — keep that paragraph).

**Step 4: Run**

```bash
npm test -- test/extraction-config.test.ts
```
Expected: PASS. `tsc` will now also complain wherever `DO_NOT_CALL_KEY`/`CALL_SUMMARY_KEY` were imported — those files are rewritten in later tasks.

**Step 5: Commit**

```bash
git add src/lib/extractionConfig.ts test/extraction-config.test.ts
git commit -m "Reserve the five verdict keys, and retire the opt-out and summary keys"
```

---

### Task 3: The verdict reader and the record shape (`goalRecord.ts`)

**Files:**
- Rewrite: `src/lib/goalRecord.ts`
- Rewrite: `test/goal-record.test.ts`

This module stays pure: no queries, no clock. It keeps `EMPTY_VALUE_FILLERS`, `isEmptyValue`, `readGoalLog`, `hasSpokenAttempt` (unchanged in behaviour) and gains the verdict reader and the note derivation. `readMerged`, `previewMerge`, `goalProgress`, `isOptOutValue` are deleted.

**Step 1: Write the failing tests** — replace `test/goal-record.test.ts` wholesale:

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveLastCallNote,
  hasGoal,
  hasSpokenAttempt,
  isEmptyValue,
  readGoalLog,
  readVerdict,
} from '../src/lib/goalRecord.js';

describe('hasGoal', () => {
  it('is on for prose and off for null or blank', () => {
    expect(hasGoal({ goal: 'Collect a budget' })).toBe(true);
    expect(hasGoal({ goal: null })).toBe(false);
    expect(hasGoal({ goal: '   ' })).toBe(false);
  });
});

describe('readVerdict', () => {
  it('reads a full verdict', () => {
    expect(
      readVerdict({
        goal_achieved: true,
        goal_missing: '',
        next_action: 'done',
        next_action_reason: 'gave a budget',
        memory: 'Priya, moving in November, budget 50L.',
      }),
    ).toEqual({
      goalAchieved: true,
      goalMissing: null,
      nextAction: 'done',
      reason: 'gave a budget',
      memory: 'Priya, moving in November, budget 50L.',
    });
  });

  it('reads model-shaped booleans loosely and everything else strictly', () => {
    expect(readVerdict({ goal_achieved: 'yes' }).goalAchieved).toBe(true);
    expect(readVerdict({ goal_achieved: 'false' }).goalAchieved).toBe(false);
    expect(readVerdict({ goal_achieved: 'maybe' }).goalAchieved).toBeNull();
    expect(readVerdict({ next_action: 'CALL_AGAIN' }).nextAction).toBe('call_again');
    expect(readVerdict({ next_action: 'ring later' }).nextAction).toBeNull();
    expect(readVerdict({ memory: 'n/a' }).memory).toBeNull();
    expect(readVerdict({ memory: 'x'.repeat(2000) }).memory).toHaveLength(600);
  });

  it('is all-null for no extraction at all', () => {
    expect(readVerdict(null)).toEqual({
      goalAchieved: null, goalMissing: null, nextAction: null, reason: null, memory: null,
    });
    expect(readVerdict(undefined).nextAction).toBeNull();
    expect(readVerdict('garbage').nextAction).toBeNull();
  });
});

describe('deriveLastCallNote', () => {
  const silent = { disposition: null, answeredBy: null, callbackNote: null, verdict: readVerdict(null) };

  it('names the silence', () => {
    expect(deriveLastCallNote({ ...silent, disposition: 'voicemail' })).toBe('reached voicemail');
    expect(deriveLastCallNote({ ...silent, disposition: 'busy' })).toBe('the line was busy');
    expect(deriveLastCallNote({ ...silent, answeredBy: 'machine' })).toBe('reached voicemail');
    expect(deriveLastCallNote({ ...silent, disposition: 'user_hangup_no_speech' })).toBe(
      'call dropped with no conversation',
    );
  });

  it('leads with a promise', () => {
    expect(deriveLastCallNote({ ...silent, disposition: 'completed', callbackNote: 'tomorrow 5pm' })).toBe(
      'spoke, asked to be called back: tomorrow 5pm',
    );
  });

  it('says what the bot decided about a conversation', () => {
    const spoke = { ...silent, disposition: 'completed', answeredBy: 'human' };
    expect(deriveLastCallNote({ ...spoke, verdict: readVerdict({ next_action: 'stop', next_action_reason: 'not interested' }) }))
      .toBe('spoke, asked not to be called again: not interested');
    expect(deriveLastCallNote({ ...spoke, verdict: readVerdict({ next_action: 'done' }) }))
      .toBe('spoke, and the goal was met');
    expect(deriveLastCallNote({ ...spoke, verdict: readVerdict({ next_action: 'call_again', next_action_reason: 'busy at work' }) }))
      .toBe('spoke, worth calling again: busy at work');
    expect(deriveLastCallNote({ ...spoke, verdict: readVerdict({ goal_achieved: false }) }))
      .toBe('spoke, but the goal is not met yet');
    expect(deriveLastCallNote({ ...spoke, verdict: readVerdict(null) }))
      .toBe('spoke, but no verdict was recorded');
  });
});

describe('readGoalLog', () => {
  it('keeps the verdict fields and drops malformed entries', () => {
    const log = readGoalLog([
      { attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human', nextAction: 'call_again', reason: 'busy' },
      { attemptNo: 2, kind: 'follow_up', disposition: 'voicemail', answeredBy: 'machine' },
      { kind: 'retry' },
      'junk',
    ]);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ attemptNo: 1, nextAction: 'call_again', reason: 'busy' });
    expect(log[1]).toMatchObject({ attemptNo: 2, nextAction: null, reason: null });
  });
});

describe('hasSpokenAttempt', () => {
  it('needs a conversation, not merely an entry', () => {
    expect(hasSpokenAttempt(readGoalLog([{ attemptNo: 1, kind: 'fresh', disposition: 'busy', answeredBy: null }]))).toBe(false);
    expect(hasSpokenAttempt(readGoalLog([{ attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human' }]))).toBe(true);
  });
});

describe('isEmptyValue', () => {
  it('reads filler words as empty and real answers as answers', () => {
    expect(isEmptyValue('N/A')).toBe(true);
    expect(isEmptyValue('0')).toBe(false);
    expect(isEmptyValue([])).toBe(true);
  });
});
```

**Step 2: Run** — `npm test -- test/goal-record.test.ts` — Expected: FAIL (missing exports).

**Step 3: Implement** — rewrite `src/lib/goalRecord.ts`. Keep the module comment's spirit (this is the pure shape every read surface consumes). Keep `EMPTY_VALUE_FILLERS`, `FILLER_SET`, `isEmptyValue` verbatim. Then:

```ts
import { isAttemptKind, type AttemptKind } from './attemptKind.js';
import { classifyOutcome } from './callOutcome.js';
import {
  GOAL_ACHIEVED_KEY, GOAL_MISSING_KEY, MEMORY_KEY, NEXT_ACTIONS, NEXT_ACTION_KEY,
  NEXT_ACTION_REASON_KEY, type NextAction,
} from './extractionConfig.js';

/** The feature switch, in one place: a campaign has a goal exactly when it
 *  says one in words. Null and blank are the behaviorally-invisible state. */
export function hasGoal(campaign: { goal: string | null }): boolean {
  return campaign.goal !== null && campaign.goal.trim() !== '';
}

/** The memory paragraph's ceiling, matching the key description the agent
 *  is given. Cut here as well, so a model that ignores the instruction cannot
 *  grow the record — or the next call's prompt — without bound. */
export const MAX_MEMORY_CHARS = 600;
export const MAX_NOTE_CHARS = 300;

export interface GoalVerdict {
  goalAchieved: boolean | null;
  goalMissing: string | null;
  nextAction: NextAction | null;
  reason: string | null;
  memory: string | null;
}

const NO_VERDICT: GoalVerdict = {
  goalAchieved: null, goalMissing: null, nextAction: null, reason: null, memory: null,
};

/**
 * A model's boolean, read the way `isOptOutValue` used to read it: `true`,
 * `"true"`, `"yes"`, `"1"` and `1` are true; `false`, `"false"`, `"no"`,
 * `"0"` and `0` are false; anything else is no answer. Loose in both
 * directions because the value is model output, and strict on the rest
 * because a verdict that is guessed is worse than one that is missing.
 */
function readBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

function readText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || isEmptyValue(value)) return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function readNextAction(value: unknown): NextAction | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return (NEXT_ACTIONS as readonly string[]).includes(s) ? (s as NextAction) : null;
}

/**
 * The verdict out of a call's extraction values. Total: anything that is not
 * an object, or any field that is not readable, is the null arm — and null
 * everywhere is "no verdict", which the resolution treats as "call again at
 * the default delay" rather than as any judgement about the person.
 */
export function readVerdict(extraction: unknown): GoalVerdict {
  if (typeof extraction !== 'object' || extraction === null || Array.isArray(extraction)) {
    return { ...NO_VERDICT };
  }
  const values = extraction as Record<string, unknown>;
  return {
    goalAchieved: readBoolean(values[GOAL_ACHIEVED_KEY]),
    goalMissing: readText(values[GOAL_MISSING_KEY], MAX_NOTE_CHARS),
    nextAction: readNextAction(values[NEXT_ACTION_KEY]),
    reason: readText(values[NEXT_ACTION_REASON_KEY], MAX_NOTE_CHARS),
    memory: readText(values[MEMORY_KEY], MAX_MEMORY_CHARS),
  };
}

export interface LastCallNoteInput {
  disposition: string | null;
  answeredBy: string | null;
  callbackNote: string | null;
  verdict: GoalVerdict;
}

/**
 * The one-liner the next call is told about the last one. YE's own render,
 * never the model's: a silence has no extraction, and the note must exist
 * for every attempt or the variable would say "first call" on the fourth.
 *
 * The silence vocabulary mirrors `dialerOutcome.ts`'s decision sets plus the
 * two terminal statuses a carrier may report through the disposition field.
 */
export function deriveLastCallNote(input: LastCallNoteInput): string {
  switch (input.disposition) {
    case 'voicemail': return 'reached voicemail';
    case 'user_hangup_no_speech': return 'call dropped with no conversation';
    case 'blocked': return 'the call was blocked';
    case 'failed': return 'the call could not be connected';
    case 'no_answer': return 'the call was not answered';
    case 'busy': return 'the line was busy';
    default: break;
  }
  if (input.answeredBy === 'machine') return 'reached voicemail';
  if (input.answeredBy === 'not_answered') return 'the call was not answered';

  // A promise beats a verdict: whatever else was said, they said when to call.
  if (input.callbackNote !== null && input.callbackNote.trim() !== '') {
    return `spoke, asked to be called back: ${input.callbackNote.trim()}`;
  }

  const { nextAction, reason, goalAchieved } = input.verdict;
  const why = reason ? `: ${reason}` : '';
  if (nextAction === 'stop') return `spoke, asked not to be called again${why}`;
  if (nextAction === 'done' || goalAchieved === true) return 'spoke, and the goal was met';
  if (nextAction === 'call_again' || nextAction === 'call_back_at') return `spoke, worth calling again${why}`;
  if (goalAchieved === false) return 'spoke, but the goal is not met yet';
  return 'spoke, but no verdict was recorded';
}

export interface LoggedAttempt {
  attemptNo: number;
  kind: AttemptKind | null;
  disposition: string | null;
  answeredBy: string | null;
  nextAction: NextAction | null;
  reason: string | null;
  callbackNote?: string;
  durationSecs?: number;
}

export function readGoalLog(stored: unknown): LoggedAttempt[] {
  // Same defensive shape as before; add `nextAction: readNextAction(entry.nextAction)`
  // and `reason: typeof entry.reason === 'string' ? entry.reason : null`, and
  // drop `collectedKeys`.
}

export function hasSpokenAttempt(log: readonly LoggedAttempt[]): boolean {
  // unchanged
}
```

Fill in `readGoalLog` and `hasSpokenAttempt` from the current file, adjusted as the comments say.

**Step 4: Run** — `npm test -- test/goal-record.test.ts` — Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/goalRecord.ts test/goal-record.test.ts
git commit -m "Read the bot's verdict, and derive the last-call note from it"
```

---

### Task 4: The dial variables (`goalVariables.ts`)

**Files:**
- Rewrite: `src/lib/goalVariables.ts`
- Rewrite: `test/goal-variables.test.ts`

**Step 1: Failing tests** — replace the file:

```ts
import { describe, expect, it } from 'vitest';
import { GOAL_VARIABLE_NAMES, goalVariables } from '../src/lib/goalVariables.js';

const GOAL = 'Collect a budget and a move-in month.';

describe('goalVariables', () => {
  it('renders the first call', () => {
    expect(goalVariables({ goal: GOAL, attemptNo: 1 }, null)).toEqual({
      campaign_goal: GOAL,
      call_number: '1',
      previous_attempts: '0',
      memory: 'nothing yet',
      last_call_note: 'first call',
      goal_missing: 'everything in the goal',
    });
  });

  it('renders the record on a later call', () => {
    expect(
      goalVariables(
        { goal: GOAL, attemptNo: 4 },
        { memory: 'Priya, moving in November.', lastCallNote: 'reached voicemail', goalMissing: 'a budget' },
      ),
    ).toEqual({
      campaign_goal: GOAL,
      call_number: '4',
      previous_attempts: '3',
      memory: 'Priya, moving in November.',
      last_call_note: 'reached voicemail',
      goal_missing: 'a budget',
    });
  });

  it('never says first call when a record exists without a note', () => {
    const v = goalVariables({ goal: GOAL, attemptNo: 2 }, { memory: null, lastCallNote: '', goalMissing: null });
    expect(v.last_call_note).toBe('no note from the previous call');
    expect(v.memory).toBe('nothing yet');
  });

  it('names exactly the six reserved variables', () => {
    expect([...GOAL_VARIABLE_NAMES]).toEqual([
      'campaign_goal', 'call_number', 'previous_attempts', 'memory', 'last_call_note', 'goal_missing',
    ]);
  });
});
```

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement** — rewrite `src/lib/goalVariables.ts`:

```ts
/**
 * The variable contract: the six reserved variables every dial of a goal
 * campaign carries, rendered from the context record. Pure and total — see
 * the previous version's reasoning, which still holds: a render failure here
 * would be a dial that never leaves, and `previous_attempts` derives from the
 * ordinal frozen at claim time so a replayed placement renders identically.
 *
 * These are the values the YE-managed prompt block interpolates; the block
 * itself lives in `goalPromptBlock.ts` and must name exactly these.
 */
export const GOAL_VARIABLE_NAMES = [
  'campaign_goal', 'call_number', 'previous_attempts', 'memory', 'last_call_note', 'goal_missing',
] as const;
export type GoalVariableName = (typeof GOAL_VARIABLE_NAMES)[number];

export interface GoalRecordSnapshot {
  memory: string | null;
  lastCallNote: string;
  goalMissing: string | null;
}

export interface GoalVariablesInput {
  goal: string;
  attemptNo: number;
}

export function goalVariables(
  input: GoalVariablesInput,
  record: GoalRecordSnapshot | null,
): Record<GoalVariableName, string> {
  const previous = Math.max(0, input.attemptNo - 1);
  const memory = record?.memory?.trim();
  const note = record?.lastCallNote?.trim();
  const missing = record?.goalMissing?.trim();
  return {
    campaign_goal: input.goal,
    call_number: String(previous + 1),
    previous_attempts: String(previous),
    memory: memory ? memory : 'nothing yet',
    last_call_note: previous === 0 ? 'first call' : note ? note : 'no note from the previous call',
    goal_missing: missing ? missing : 'everything in the goal',
  };
}
```

**Step 4: Run** — Expected: PASS.

**Step 5: Commit** — `git commit -m "Render the six goal variables from the memory record"`

---

### Task 5: The prompt block (`goalPromptBlock.ts`)

**Files:**
- Create: `src/lib/goalPromptBlock.ts`
- Create: `test/goal-prompt-block.test.ts`

**Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  GOAL_BLOCK_END, GOAL_BLOCK_START, GOAL_PROMPT_BLOCK, hasIntactGoalBlock, withGoalBlock, withoutGoalBlock,
} from '../src/lib/goalPromptBlock.js';
import { GOAL_VARIABLE_NAMES } from '../src/lib/goalVariables.js';

describe('the goal prompt block', () => {
  it('names every goal variable and nothing else', () => {
    const used = [...GOAL_PROMPT_BLOCK.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(GOAL_VARIABLE_NAMES));
  });

  it('appends once and is idempotent', () => {
    const once = withGoalBlock('You are Asha.');
    expect(once.startsWith('You are Asha.\n\n' + GOAL_BLOCK_START)).toBe(true);
    expect(once.endsWith(GOAL_BLOCK_END)).toBe(true);
    expect(withGoalBlock(once)).toBe(once);
  });

  it('replaces a stale or hand-edited block', () => {
    const edited = `Intro.\n\n${GOAL_BLOCK_START}\nsomething the operator typed\n${GOAL_BLOCK_END}\nOutro.`;
    expect(hasIntactGoalBlock(edited)).toBe(false);
    const fixed = withGoalBlock(edited);
    expect(hasIntactGoalBlock(fixed)).toBe(true);
    expect(fixed).toContain('Outro.');
    expect(fixed.match(new RegExp(GOAL_BLOCK_START, 'g'))).toHaveLength(1);
  });

  it('removes the block and the whitespace it brought', () => {
    expect(withoutGoalBlock(withGoalBlock('You are Asha.'))).toBe('You are Asha.');
    expect(withoutGoalBlock('No block here.')).toBe('No block here.');
  });

  it('reports absence as not intact', () => {
    expect(hasIntactGoalBlock('plain')).toBe(false);
  });
});
```

**Step 2: Run** — Expected: FAIL (module missing).

**Step 3: Implement**

```ts
/**
 * The block YE writes into a goal campaign's agent prompt, so the goal, the
 * memory and the last-call note reach the model whether or not the operator
 * ever heard of dial variables. The platform substitutes `{{name}}` in the
 * prompt from the variables a dial carries and silently drops any it never
 * mentions — so a variable YE sends but the prompt does not name reaches
 * nobody. This block is how the six are guaranteed to be named.
 *
 * The text is identical for every campaign and every contact: everything
 * that varies is a variable, which is what lets one agent serve several goal
 * campaigns at once. The marker lines are what make the write idempotent and
 * the removal exact.
 */
export const GOAL_BLOCK_START = '[EZO campaign context — managed by EZO, do not edit]';
export const GOAL_BLOCK_END = '[end EZO campaign context]';

export const GOAL_PROMPT_BLOCK = [
  GOAL_BLOCK_START,
  'Campaign goal: {{campaign_goal}}',
  'This is call number {{call_number}} to this person. Calls before this one: {{previous_attempts}}.',
  'What you already know about them: {{memory}}',
  'Last call: {{last_call_note}}',
  'Still needed for the goal: {{goal_missing}}',
  'Never ask again for anything you already know. If they ask not to be called again, acknowledge it and wind the call up.',
  'When the call ends you will be asked to judge whether the goal was met and to recommend a next step.',
  GOAL_BLOCK_END,
].join('\n');

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any span between the markers, edited or not, greedy on the last end marker. */
const BLOCK_SPAN = new RegExp(`\\n*${escape(GOAL_BLOCK_START)}[\\s\\S]*?${escape(GOAL_BLOCK_END)}\\n*`, 'g');

export function hasIntactGoalBlock(prompt: string): boolean {
  return prompt.includes(GOAL_PROMPT_BLOCK);
}

export function withoutGoalBlock(prompt: string): string {
  return prompt.replace(BLOCK_SPAN, '\n\n').replace(/^\n+|\n+$/g, '');
}

export function withGoalBlock(prompt: string): string {
  if (hasIntactGoalBlock(prompt)) return prompt;
  const bare = withoutGoalBlock(prompt);
  return bare === '' ? GOAL_PROMPT_BLOCK : `${bare}\n\n${GOAL_PROMPT_BLOCK}`;
}
```

Run the tests; if the whitespace assertions fail, adjust the regex rather than the tests — the contract is "append with one blank line, remove leaving the original".

**Step 4: Run** — Expected: PASS.

**Step 5: Commit** — `git commit -m "The prompt block YE manages on a goal campaign's agent"`

---

## Part B — Backend: the platform side (keys and prompt)

### Task 6: The managed extraction set and the prompt writer

**Files:**
- Modify: `src/services/campaignExtraction.ts` (replace `ensureGoalExtractionKeys`, constants ~lines 55-70 and 214-268)
- Create: `src/services/campaignPrompt.ts`
- Modify: `src/lib/env.ts:345-350` (delete `goalSummaryLlmEnabled`), `.env.example` (delete the `GOAL_SUMMARY_LLM` lines)
- Modify: `test/campaign-extraction.test.ts` (goal cases)
- Create: `test/campaign-prompt.test.ts`

**Step 1: Failing tests.** In `test/campaign-extraction.test.ts`, delete every `describe`/`it` that references `OPT_OUT_EXTRACTION_SET_NAME`, `CALL_SUMMARY_EXTRACTION_SET_NAME`, `DO_NOT_CALL_KEY`, `CALL_SUMMARY_KEY` or `GOAL_SUMMARY_LLM`, and add:

```ts
describe('ensureGoalExtractionKeys', () => {
  it('creates the verdict set once and attaches it', async () => {
    listSets.mockResolvedValue({ extraction_sets: [theSet] });
    listAgentSets.mockResolvedValue({ extraction_sets: [theSet] });
    createSet.mockResolvedValue({ id: 'set_goal' });
    const ok = await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');
    expect(ok).toBe(true);
    const body = createSet.mock.calls[0]![0] as { name: string; keys: { name: string }[] };
    expect(body.name).toBe(GOAL_EXTRACTION_SET_NAME);
    expect(body.keys.map((k) => k.name)).toEqual([...GOAL_VERDICT_KEYS]);
    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_goal');
    // The callback set rides along whatever callbackEnabled says.
    expect(attachSet).toHaveBeenCalledWith(AGENT, theSet.id);
  });

  it('detaches the retired opt-out and summary sets', async () => {
    const legacy = [{ id: 'set_old1', name: 'EZO campaign opt-outs' }, { id: 'set_old2', name: 'EZO call summaries' }];
    listSets.mockResolvedValue({ extraction_sets: [theSet, ...legacy, { id: 'set_goal', name: GOAL_EXTRACTION_SET_NAME }] });
    listAgentSets.mockResolvedValue({ extraction_sets: [theSet, ...legacy, { id: 'set_goal', name: GOAL_EXTRACTION_SET_NAME }] });
    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');
    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_old1');
    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_old2');
    expect(createSet).not.toHaveBeenCalled();
  });

  it('notifies and returns false on failure, never throws', async () => {
    listSets.mockRejectedValue(new Error('upstream down'));
    expect(await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals')).toBe(false);
    await flushNotifications();
    const n = await prisma.notification.findFirst({ where: { workspaceId, type: 'campaign.goal_keys_unavailable' } });
    expect(n).not.toBeNull();
  });
});
```

Update the destructured import at the top to `GOAL_EXTRACTION_SET_NAME` and import `GOAL_VERDICT_KEYS` from `extractionConfig.js`.

Create `test/campaign-prompt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({ getAgent: vi.fn(), updateAgent: vi.fn() }));

const adapter = await import('../src/adapter/vocobase.js');
const { ensureGoalPromptBlock, releaseGoalPromptBlock } = await import('../src/services/campaignPrompt.js');
const { GOAL_PROMPT_BLOCK, withGoalBlock } = await import('../src/lib/goalPromptBlock.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const getAgent = vi.mocked(adapter.getAgent);
const updateAgent = vi.mocked(adapter.updateAgent);

let workspaceId: string;
let agentId: string;
let externalId: string;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const account = await makeAccount(`pr${Math.random().toString(36).slice(2, 7)}`);
  const workspace = await makeWorkspace(account, 'Prompts');
  workspaceId = workspace.id;
  const agent = await makeAgent(workspace, 'caller');
  agentId = agent.id;
  externalId = agent.externalId;
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

describe('ensureGoalPromptBlock', () => {
  it('appends the block to a prompt without one', async () => {
    getAgent.mockResolvedValue({ prompt: 'You are Asha.' });
    updateAgent.mockResolvedValue({});
    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(true);
    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: withGoalBlock('You are Asha.') });
  });

  it('writes nothing when the block is already intact', async () => {
    getAgent.mockResolvedValue({ prompt: withGoalBlock('You are Asha.') });
    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('rewrites a hand-edited block and tells an admin', async () => {
    getAgent.mockResolvedValue({ prompt: `Intro\n\n${GOAL_PROMPT_BLOCK.replace('Last call', 'LAST CALL')}` });
    updateAgent.mockResolvedValue({});
    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');
    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: withGoalBlock('Intro') });
    await flushNotifications();
    expect(await prisma.notification.findFirst({ where: { workspaceId, type: 'campaign.goal_prompt_rewritten' } })).not.toBeNull();
  });

  it('notifies and returns false on failure', async () => {
    getAgent.mockRejectedValue(new Error('down'));
    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(false);
    await flushNotifications();
    expect(await prisma.notification.findFirst({ where: { workspaceId, type: 'campaign.goal_prompt_unavailable' } })).not.toBeNull();
  });
});

describe('releaseGoalPromptBlock', () => {
  it('removes the block when no live goal campaign shares the agent', async () => {
    await prisma.campaign.create({ data: { workspaceId, name: 'done', agentId, status: 'STOPPED', goal: 'x' } });
    getAgent.mockResolvedValue({ prompt: withGoalBlock('You are Asha.') });
    updateAgent.mockResolvedValue({});
    await releaseGoalPromptBlock(agentId, workspaceId);
    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: 'You are Asha.' });
  });

  it('keeps the block while another goal campaign is running or paused', async () => {
    await prisma.campaign.create({ data: { workspaceId, name: 'live', agentId, status: 'PAUSED', goal: 'x' } });
    await releaseGoalPromptBlock(agentId, workspaceId);
    expect(getAgent).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run both** — Expected: FAIL.

**Step 3: Implement.**

In `src/services/campaignExtraction.ts`:
- Delete `OPT_OUT_EXTRACTION_SET_NAME`, `DO_NOT_CALL_KEY_DESCRIPTION`, `CALL_SUMMARY_EXTRACTION_SET_NAME`, `CALL_SUMMARY_KEY_DESCRIPTION`, and the `env` import.
- Add:

```ts
export const GOAL_EXTRACTION_SET_NAME = 'EZO campaign goals';

/** Sets earlier releases attached that this one no longer reads. Detached on
 *  every goal start so an agent stops paying for extraction nothing consumes. */
export const RETIRED_EXTRACTION_SET_NAMES = ['EZO campaign opt-outs', 'EZO call summaries'] as const;

/**
 * The verdict keys' descriptions. None names a campaign: the goal reaches
 * the model through the prompt block, and the in-bot extraction runs on the
 * live context, so "the campaign goal in your instructions" is a reference
 * the model can resolve. The platform's transcript-only fallback cannot, and
 * answers null — which the resolution reads as no verdict, never as a guess.
 */
export const GOAL_VERDICT_DESCRIPTIONS: Record<(typeof GOAL_VERDICT_KEYS)[number], { type: string; description: string; values?: string[] }> = {
  goal_achieved: { type: 'boolean', description: 'Was the campaign goal stated in your instructions fully met by the end of this conversation? Null if nobody was spoken to.' },
  goal_missing: { type: 'string', description: 'What the campaign goal still needs from this person, in one short line. Empty if the goal was met. Null if nobody was spoken to.' },
  next_action: { type: 'string', values: ['done', 'call_again', 'call_back_at', 'stop'], description: 'What should happen next with this person. "done" if the goal is met or there is nothing more to collect; "call_again" if another call is worthwhile; "call_back_at" if they asked to be called at a particular time; "stop" if they asked not to be called again, are the wrong person, or made clear there is no point calling.' },
  next_action_reason: { type: 'string', description: 'Why you chose that next step, in a few words — for example "asked to call next week", "not interested", "wrong number". Null if nobody was spoken to.' },
  memory: { type: 'string', description: 'The paragraph under "What you already know about them" in your instructions, rewritten to include what this call taught you about this person and their needs, in under 600 characters. Keep only what helps the next call pursue the campaign goal. Null if nobody was spoken to.' },
};
```

- Replace `ensureGoalExtractionKeys` with one that: attaches the callback set (reuse the same `ensureManagedSetAttached` call `ensureCallbackExtractionKey` makes — extract that set literal into a `const CALLBACK_SET: ManagedSet` so both use it), attaches `GOAL_EXTRACTION_SET_NAME` with keys built from `GOAL_VERDICT_DESCRIPTIONS`, detaches each of `RETIRED_EXTRACTION_SET_NAMES` via `ensureManagedSetDetached`, calls `ensureExtractionEnabled`, and on any throw notifies `campaign.goal_keys_unavailable` with title `` `${campaignName} may not record goal verdicts` `` and returns false. `ManagedSet.keys` gains `values?: string[]`.

Create `src/services/campaignPrompt.ts`:

```ts
import { getAgent, updateAgent } from '../adapter/vocobase.js';
import { readString } from '../lib/upstream.js';
import { notify } from '../lib/notify.js';
import { prisma } from '../lib/prisma.js';
import { hasIntactGoalBlock, withGoalBlock, withoutGoalBlock } from '../lib/goalPromptBlock.js';

/**
 * Writing and removing the goal block on an agent's prompt upstream.
 *
 * The same promise as the managed extraction keys: idempotent on every start
 * and resume, and never able to fail one — a campaign whose agent could not
 * be told its goal still dials, and the notification is what tells an ADMIN.
 */
export async function ensureGoalPromptBlock(
  agentExternalId: string, workspaceId: string, campaignName: string,
): Promise<boolean> {
  try {
    const prompt = readString(await getAgent(agentExternalId), ['prompt']) ?? '';
    if (hasIntactGoalBlock(prompt)) return true;

    // A block is there but not ours any more: somebody edited inside the
    // markers. Rewritten, because a block that drifted from the variables the
    // dial carries is a prompt that quietly stops seeing the goal — but said,
    // because it was somebody's edit.
    const edited = prompt.includes('[EZO campaign context') ;
    await updateAgent(agentExternalId, { prompt: withGoalBlock(prompt) });

    if (edited) {
      void notify(workspaceId, 'ADMINS_ONLY', 'campaign.goal_prompt_rewritten',
        `${campaignName} restored its agent's goal block`,
        'The managed campaign-context block in this campaign\'s agent prompt had been edited. It was rewritten on start; put your own instructions outside the marked block.',
        '/campaigns');
    }
    return true;
  } catch (err) {
    console.error(`[campaign] could not write the goal block onto ${agentExternalId}:`, err);
    void notify(workspaceId, 'ADMINS_ONLY', 'campaign.goal_prompt_unavailable',
      `${campaignName} may not know its goal`,
      'This campaign started, but its agent prompt could not be updated with the campaign goal. Calls will be placed as normal; the agent will not be told the goal or what earlier calls learned.',
      '/campaigns');
    return false;
  }
}

/**
 * Takes the block off the agent once no RUNNING, PAUSED or CREDIT_EXHAUSTED
 * goal campaign in the workspace still uses it. Agents are many-to-one with
 * campaigns, so stopping one campaign must not silence another's.
 */
export async function releaseGoalPromptBlock(agentId: string, workspaceId: string): Promise<void> {
  try {
    const live = await prisma.campaign.count({
      where: { agentId, workspaceId, goal: { not: null }, status: { in: ['RUNNING', 'PAUSED', 'CREDIT_EXHAUSTED'] } },
    });
    if (live > 0) return;
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { externalId: true } });
    if (!agent) return;
    const prompt = readString(await getAgent(agent.externalId), ['prompt']) ?? '';
    const bare = withoutGoalBlock(prompt);
    if (bare !== prompt) await updateAgent(agent.externalId, { prompt: bare });
  } catch (err) {
    console.error(`[campaign] could not remove the goal block from agent ${agentId}:`, err);
  }
}
```

(`goal: { not: null }` matches blank strings too; the write path normalises blank to null in Task 10, so this is exact.)

Delete `goalSummaryLlmEnabled` from `src/lib/env.ts` (and the `onOffSwitch` helper if nothing else uses it — check with grep), and the `GOAL_SUMMARY_LLM` lines from `.env.example` and `README.md`.

**Step 4: Run** — `npm test -- test/campaign-extraction.test.ts test/campaign-prompt.test.ts` — Expected: PASS.

**Step 5: Commit** — `git commit -m "Attach the verdict set and write the goal block on the agent"`

---

### Task 7: Hook the prompt block and keys into start, resume, stop and complete

**Files:**
- Modify: `src/services/campaignStart.ts:120-144`
- Modify: `src/routes/campaigns.routes.ts` (transition loop ~2030-2055; complete route ~1672-1730)
- Modify: `src/lib/campaignLifecycle.ts` (no change needed; `stopCampaign` stays)
- Test: `test/campaign-start-gates.test.ts`, `test/campaign-lifecycle.test.ts` (extend)

**Step 1: Failing tests.** In `test/campaign-start-gates.test.ts`, add to the adapter mock `getAgent: vi.fn(), updateAgent: vi.fn(), listExtractionSets: vi.fn(), createExtractionSet: vi.fn(), listAgentExtractionSets: vi.fn(), attachAgentExtractionSet: vi.fn(), detachAgentExtractionSet: vi.fn()` if absent, and add:

```ts
it('a goal campaign start attaches the verdict set and writes the prompt block', async () => {
  // seed a startable campaign with goal: 'Collect a budget' (copy the file's own seed helper)
  // mock: listExtractionSets → [], createExtractionSet → { id: 'set_goal' }, listAgentExtractionSets → [],
  //       getAgent → { prompt: 'You are Asha.', extraction_enabled: true }, updateAgent → {}
  // POST /api/workspaces/:ws/campaigns/:id/start
  // expect 200; expect createExtractionSet called with name 'EZO campaign goals';
  // expect updateAgent called with { prompt: expect.stringContaining('[EZO campaign context') }
});

it('a plain campaign start touches neither the goal set nor the prompt', async () => {
  // same seed with goal: null, callbackEnabled false → updateAgent never called with a prompt
});
```

In `test/campaign-lifecycle.test.ts` add:

```ts
it('stopping the last live goal campaign on an agent removes the block; pausing does not', async () => {
  // seed RUNNING goal campaign; getAgent → { prompt: withGoalBlock('You are Asha.') }
  // POST /pause → updateAgent not called
  // POST /resume → updateAgent not called (block intact)
  // POST /stop → updateAgent called with { prompt: 'You are Asha.' }
});
```

Write these out fully using the seed helpers already in each file.

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement.**

`src/services/campaignStart.ts`: replace the block at lines 130-144 with:

```ts
    if (campaign.agent && (updated.callbackEnabled || hasGoal(updated))) {
      const agent = await prisma.agent.findUnique({ where: { id: campaign.agent.id }, select: { externalId: true } });
      if (agent) await prepareCampaignAgent(agent.externalId, workspaceId, updated);
    }
```

and add to `src/services/campaignExtraction.ts`:

```ts
/**
 * Everything a campaign needs on its agent upstream, in one call shared by
 * start and resume: the callback key when callbacks are on, and for a goal
 * campaign the verdict set plus the prompt block. Each half is idempotent
 * and none may fail the transition.
 */
export async function prepareCampaignAgent(
  agentExternalId: string, workspaceId: string,
  campaign: { name: string; callbackEnabled: boolean; goal: string | null },
): Promise<void> {
  if (hasGoal(campaign)) {
    await ensureGoalExtractionKeys(agentExternalId, workspaceId, campaign.name);
    await ensureGoalPromptBlock(agentExternalId, workspaceId, campaign.name);
  } else if (campaign.callbackEnabled) {
    await ensureCallbackExtractionKey(agentExternalId, workspaceId, campaign.name);
  }
}
```

(`ensureGoalExtractionKeys` already attaches the callback set, so the goal branch covers both.)

`src/routes/campaigns.routes.ts` transition loop: replace the `if (transition.startsDialing && updated.callbackEnabled && campaign.agent)` block with the same `prepareCampaignAgent` call gated on `transition.startsDialing && campaign.agent && (updated.callbackEnabled || hasGoal(updated))`. After the `write`/update for `stop` (`transition.to === 'STOPPED'`), when `campaign.agentId && hasGoal(campaign)`, call `await releaseGoalPromptBlock(campaign.agentId, workspaceOf(req).id)`. In the `complete` route, after `moved.count > 0`, do the same. Import `hasGoal` from `../lib/goalRecord.js`.

**Step 4: Run** — the two test files — Expected: PASS.

**Step 5: Commit** — `git commit -m "Prepare the agent on start and resume, and release the block on stop"`

---

## Part C — Backend: the decision and the record

### Task 8: The context record writer (`goalContext.ts`)

**Files:**
- Rewrite: `src/services/goalContext.ts`
- Test: `test/goal-context.test.ts` (new; the old record tests lived in `goal-webhook.test.ts` and are rewritten in Task 10)

**Step 1: Failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { recordAttempt } from '../src/services/goalContext.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

let contactId: string;

beforeEach(async () => {
  await truncateAll();
  const account = await makeAccount(`gc${Math.random().toString(36).slice(2, 7)}`);
  const ws = await makeWorkspace(account, 'Ctx');
  const agent = await makeAgent(ws, 'caller');
  const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'G', agentId: agent.id, status: 'RUNNING', goal: 'Collect a budget' } });
  const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone: '+919000000001' } });
  contactId = (await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: contact.id, status: 'QUEUED' } })).id;
});
afterEach(truncateAll);

const record = () => prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: contactId } });

const conversation = (attemptNo: number, values: Record<string, unknown>, kind: 'fresh' | 'follow_up' = 'follow_up') => ({
  campaignContactId: contactId, attemptNo, kind, disposition: 'completed', answeredBy: 'human',
  extraction: values, callbackNote: null, durationSecs: 30,
});

describe('recordAttempt', () => {
  it('writes memory, the note, the missing line and a log entry', async () => {
    await recordAttempt(conversation(1, { memory: 'Priya, wants a 2BHK.', goal_missing: 'a budget', next_action: 'call_again', next_action_reason: 'busy at work' }, 'fresh'));
    const r = await record();
    expect(r.memory).toBe('Priya, wants a 2BHK.');
    expect(r.memoryAttempt).toBe(1);
    expect(r.goalMissing).toBe('a budget');
    expect(r.lastCallNote).toBe('spoke, worth calling again: busy at work');
    expect(r.attemptLog).toEqual([expect.objectContaining({ attemptNo: 1, kind: 'fresh', nextAction: 'call_again', reason: 'busy at work' })]);
  });

  it('a voicemail keeps the memory and replaces only the note', async () => {
    await recordAttempt(conversation(1, { memory: 'Priya.' }, 'fresh'));
    await recordAttempt({ ...conversation(2, {}), disposition: 'voicemail', answeredBy: 'machine', extraction: null });
    const r = await record();
    expect(r.memory).toBe('Priya.');
    expect(r.memoryAttempt).toBe(1);
    expect(r.lastCallNote).toBe('reached voicemail');
    expect((r.attemptLog as unknown[]).length).toBe(2);
  });

  it('a stale redelivery cannot put an older memory over a newer one', async () => {
    await recordAttempt(conversation(1, { memory: 'first' }, 'fresh'));
    await recordAttempt(conversation(2, { memory: 'second' }));
    await recordAttempt(conversation(1, { memory: 'first again' }, 'fresh'));
    const r = await record();
    expect(r.memory).toBe('second');
    expect(r.memoryAttempt).toBe(2);
    expect((r.attemptLog as { attemptNo: number }[]).map((e) => e.attemptNo)).toEqual([1, 2]);
  });

  it('replaying an attempt is byte-identical', async () => {
    await recordAttempt(conversation(1, { memory: 'x', next_action: 'done' }, 'fresh'));
    const a = await record();
    await recordAttempt(conversation(1, { memory: 'x', next_action: 'done' }, 'fresh'));
    const b = await record();
    expect({ ...b, updatedAt: null }).toEqual({ ...a, updatedAt: null });
  });

  it('the callback note wins the last-call line', async () => {
    await recordAttempt({ ...conversation(1, { next_action: 'call_back_at' }, 'fresh'), callbackNote: 'Tuesday 4pm' });
    expect((await record()).lastCallNote).toBe('spoke, asked to be called back: Tuesday 4pm');
  });
});
```

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement** — rewrite `recordAttempt`. Keep the upsert-then-`FOR UPDATE` shape and the transaction wrapper. Body after the lock:

```ts
    const row = await tx.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: input.campaignContactId },
      select: { memory: true, memoryAttempt: true, goalMissing: true, attemptLog: true },
    });
    const extraction = boundExtractionValues(input.extraction);
    const verdict = readVerdict(extraction);
    const log = readLog(row.attemptLog);

    // A later ATTEMPT's memory wins; an empty one never erases; a stale
    // redelivery (an older ordinal than the writer on record) is ignored.
    const memoryMoves =
      verdict.memory !== null && (row.memoryAttempt === null || input.attemptNo >= row.memoryAttempt);
    const missingMoves =
      verdict.goalMissing !== null && (row.memoryAttempt === null || input.attemptNo >= row.memoryAttempt);

    // The note follows the LATEST attempt by ordinal, whatever the delivery
    // order: a replay of attempt 1 after attempt 2 recorded must not turn
    // "reached voicemail" back into "spoke, worth calling again".
    const latest = Math.max(input.attemptNo, ...log.map((e) => e.attemptNo));
    const noteMoves = input.attemptNo === latest;

    const entry: AttemptLogEntry = {
      attemptNo: input.attemptNo, kind: input.kind, disposition: input.disposition, answeredBy: input.answeredBy,
      nextAction: verdict.nextAction, reason: verdict.reason,
      ...(input.callbackNote ? { callbackNote: input.callbackNote } : {}),
      ...(input.durationSecs == null ? {} : { durationSecs: input.durationSecs }),
    };
    const nextLog = [...log.filter((e) => e.attemptNo !== input.attemptNo), entry].sort((a, b) => a.attemptNo - b.attemptNo);

    await tx.campaignContactGoal.update({
      where: { campaignContactId: input.campaignContactId },
      data: {
        attemptLog: nextLog as unknown as Prisma.InputJsonValue,
        ...(memoryMoves ? { memory: verdict.memory, memoryAttempt: input.attemptNo } : {}),
        ...(missingMoves ? { goalMissing: verdict.goalMissing } : {}),
        ...(noteMoves ? { lastCallNote: deriveLastCallNote({ disposition: input.disposition, answeredBy: input.answeredBy, callbackNote: input.callbackNote ?? null, verdict }) } : {}),
      },
    });
```

Keep the re-exports block, replacing the deleted names: export `hasGoal, hasSpokenAttempt, readGoalLog, readVerdict, deriveLastCallNote, type GoalVerdict, type LoggedAttempt`. Also export `recordAttempt`'s input type.

**Step 4: Run** — Expected: PASS.

**Step 5: Commit** — `git commit -m "Record the memory, the note and the verdict per attempt"`

---

### Task 9: The decision table (`dialerOutcome.ts`) and the completion-only rule (`webhookOutcome.ts`)

**Files:**
- Modify: `src/services/dialerOutcome.ts:163-540` (resolveContact) and `:560-760` (applyTerminalOutcome)
- Modify: `src/services/webhookOutcome.ts:82-103, 168-289, 378-503`
- Rewrite: `test/goal-resolution.test.ts`
- Rewrite: `test/goal-webhook.test.ts`

**Step 1: Failing tests.**

`test/goal-resolution.test.ts` — keep the seed helper, changing `goalKeys` to `goal: options.goal ?? 'Collect a budget'` and the record seed to `{ memory, lastCallNote, goalMissing, attemptLog }`. Replace the `conversation()` helper so `extraction` is the verdict object, and rewrite the cases as the decision table:

```ts
describe('the goal decision table', () => {
  it('stop settles COMPLETED, lists the number for this campaign only, and records the verdict', async () => {
    const s = await seed();
    const other = await seed(); // a second campaign in the same workspace, same phone
    expect(await conversation(s, { next_action: 'stop', goal_achieved: false })).toBe('completed');
    const c = await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(c.status).toBe('COMPLETED'); expect(c.goalAchieved).toBe(false);
    expect(await prisma.doNotCall.findUnique({ where: { campaignId_phone: { campaignId: s.campaignId, phone: s.phone } } })).not.toBeNull();
    expect(await prisma.doNotCall.findUnique({ where: { campaignId_phone: { campaignId: other.campaignId, phone: s.phone } } })).toBeNull();
  });

  it('done, or goal_achieved true, settles achieved', async () => {
    for (const v of [{ next_action: 'done' }, { goal_achieved: 'yes', next_action: 'call_again' }]) {
      const s = await seed();
      expect(await conversation(s, v)).toBe('completed');
      expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } })).goalAchieved).toBe(true);
    }
  });

  it('call_again re-arms at the delay rolled into the window and moves followUpCount only', async () => {
    const s = await seed({ followUpDelayHours: 24, window: { fromTime: '09:00', toTime: '18:00', timezone: 'Asia/Kolkata' } });
    expect(await conversation(s, { next_action: 'call_again', next_action_reason: 'busy' })).toBe('following_up');
    const c = await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(c.status).toBe('PENDING'); expect(c.followUpCount).toBe(1); expect(c.attempts).toBe(0);
    expect(c.nextEligibleAt!.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 24 * HOUR);
  });

  it('call_back_at re-arms the same way; the booking moves it afterwards', async () => {
    const s = await seed();
    expect(await conversation(s, { next_action: 'call_back_at' })).toBe('following_up');
  });

  it('a null verdict is a follow-up at the default delay', async () => {
    const s = await seed();
    expect(await conversation(s, null)).toBe('following_up');
    expect(await conversation(await seed(), { next_action: 'ring me' })).toBe('following_up');
  });

  it('call_again past the follow-up budget or the dial cap settles not achieved', async () => {
    const a = await seed({ maxGoalFollowUps: 1, followUpCount: 1 });
    expect(await conversation(a, { next_action: 'call_again' })).toBe('completed');
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: a.contactId } })).goalAchieved).toBe(false);
    const b = await seed({ maxTotalDials: 2, attemptNo: 2 });
    expect(await conversation(b, { next_action: 'call_again' })).toBe('completed');
  });

  it('a silence keeps the retry ladder, whatever the stored verdict says', async () => {
    const s = await seed({ memory: 'Priya' });
    expect(await resolveContact(prisma, { ...base(s), disposition: 'voicemail', answeredBy: 'machine', retryable: true, permanent: false, extraction: null, now: NOW })).toBe('retrying');
  });

  it('a campaign with no goal is untouched by any verdict', async () => {
    const s = await seed({ goal: null });
    expect(await conversation(s, { next_action: 'stop' })).toBe('completed');
    const c = await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(c.goalAchieved).toBeNull();
    expect(await prisma.doNotCall.count()).toBe(0);
  });

  it('a lost race writes nothing', async () => {
    const s = await seed({ attemptNo: 1 });
    await prisma.callAttempt.create({ data: { campaignId: s.campaignId, campaignContactId: s.contactId, workspaceId: s.workspaceId, accountId: (await prisma.campaign.findUniqueOrThrow({ where: { id: s.campaignId }, select: { workspace: { select: { ownerId: true } } } })).workspace.ownerId, attemptNo: 2, status: 'QUEUED' } });
    expect(await conversation(s, { next_action: 'done' })).toBe('race_lost');
  });
});
```

Write `base(s)` and `conversation(s, values)` so `conversation` passes `disposition: 'completed', answeredBy: 'human', retryable: false, permanent: false, extraction: values`.

Note on `stop` on a non-goal campaign: the design keeps the opt-out inside the goal gate now (the verdict set is only attached to goal campaigns' agents), so the last test's `doNotCall.count() === 0` is correct.

`test/goal-webhook.test.ts` — keep `seedGoalAttempt` (with `goal: 'Collect a budget'`) and rewrite:

```ts
describe('goal decisions wait for the completion event', () => {
  it('a classified status event on a connected goal call frees the line and resolves nothing', async () => {
    const s = await seedGoalAttempt();
    await processWebhookEvent({ kind: 'webhook', event: 'call.status.updated', data: { call_id: `c_g${seq}`, session_id: s.sessionId, status: 'completed', disposition: 'completed', answered_by: 'human' }, receivedAtIso: new Date().toISOString() });
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: s.attemptId } });
    expect(attempt.status).toBe('COMPLETED'); expect(attempt.resolvedAt).toBeNull();
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } })).status).toBe('QUEUED');
  });

  it('the completion event then records the memory BEFORE deciding, and decides on the verdict', async () => {
    const s = await seedGoalAttempt();
    await processWebhookEvent(statusEvent(s));
    await processWebhookEvent(completion(s.sessionId, `c_g${seq}`, { memory: 'Priya.', next_action: 'done' }));
    const c = await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(c.status).toBe('COMPLETED'); expect(c.goalAchieved).toBe(true);
    const r = await prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: s.contactId } });
    expect(r.memory).toBe('Priya.');
    expect(r.lastCallNote).toBe('spoke, and the goal was met');
  });

  it('a silence still resolves on the status event', async () => {
    const s = await seedGoalAttempt();
    await processWebhookEvent({ ...statusEvent(s), data: { ...statusEvent(s).data, status: 'no_answer', disposition: null, answered_by: null } });
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } })).status).toBe('PENDING');
  });

  it('a replayed completion changes nothing', async () => {
    const s = await seedGoalAttempt();
    await processWebhookEvent(completion(s.sessionId, `c_g${seq}`, { memory: 'A', next_action: 'call_again' }));
    const before = await prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: s.contactId } });
    await processWebhookEvent(completion(s.sessionId, `c_g${seq}`, { memory: 'A', next_action: 'call_again' }));
    const after = await prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: s.contactId } });
    expect(after.attemptLog).toEqual(before.attemptLog);
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } })).followUpCount).toBe(1);
  });

  it('call_back_at with a readable time books the callback after the re-arm', async () => {
    const s = await seedGoalAttempt();
    const at = new Date(Date.now() + 26 * 3_600_000).toISOString();
    await processWebhookEvent(completion(s.sessionId, `c_g${seq}`, { next_action: 'call_back_at', callback_requested_at: at }));
    const c = await prisma.campaignContact.findUniqueOrThrow({ where: { id: s.contactId } });
    expect(c.callbackAt).not.toBeNull();
    expect(c.nextEligibleAt?.getTime()).toBe(c.callbackAt?.getTime());
  });
});
```

(`seedGoalAttempt` must set `callbackEnabled: true` on the campaign for the last case, and the campaign's window must allow the time — copy the window used in `campaign-callback.test.ts`.)

**Step 2: Run both** — Expected: FAIL.

**Step 3: Implement.**

`src/services/webhookOutcome.ts`:
- `ATTEMPT_FIELDS.campaign` → `{ select: { goal: true } }`; `MatchedAttempt.campaign: { goal: string | null } | null`.
- In `handleStatusUpdated`, after `normalised` and `carriesClassification`, compute:

```ts
  /**
   * A goal campaign's connected call is decided on `session.completed`, and
   * only there. The platform sends this status event for a completed call
   * WITH its disposition and answered-by but BEFORE it has run extraction, so
   * a resolution here would judge the goal with no verdict at all — which is
   * exactly the bug that scheduled a follow-up for every person who answered
   * everything on the first call. The attempt is still closed, so the line
   * is freed on time; `resolvedAt` stays null, the mark the completion (and,
   * failing that, the reaper) reads to know the decision is still theirs.
   */
  const { retryable, permanent } = classifyOutcome(normalised);
  const goalConversation = attempt.campaign !== null && hasGoal(attempt.campaign) && !retryable && !permanent;
  const resolvesHere = carriesClassification && !goalConversation;
```

and use `resolvesHere` in place of `carriesClassification` for both the `resolvedAt` stamp and the `if (...) return;` guard.
- Delete the `recordAttempt` call at the end of `handleSessionCompleted` and its comment (the record now moves into `applyTerminalOutcome`). Delete the `recordAttempt`/`deriveKind` imports if unused — `deriveKind` moves too.

`src/services/dialerOutcome.ts`:
- `applyTerminalOutcome`: widen the attempt read to include `attemptNo, kind, campaign: { select: { id, name, workspaceId, goal } }`. Inside the transaction, after `closed.count > 0` and before the `resolveContact` call, add:

```ts
      /**
       * The context record, BEFORE the resolution and in its transaction: the
       * decision reads the record, and a follow-up re-armed here must never
       * be dialled ahead of its own memory. Written on every terminal outcome
       * of a goal campaign, silences included — the note has to exist for
       * every attempt. Keyed by attempt number, so a replay is a no-op.
       */
      if (attempt.campaignContactId !== null && attempt.campaign !== null && hasGoal(attempt.campaign)) {
        await recordAttempt({
          campaignContactId: attempt.campaignContactId,
          attemptNo: attempt.attemptNo,
          kind: deriveKind(attempt),
          disposition, answeredBy,
          extraction,
          callbackNote: callbackNoteFrom(extraction),
          durationSecs: outcome.durationSecs,
        }, tx);
      }
```

Move `deriveKind` from `webhookOutcome.ts` into `src/lib/attemptKind.ts` (export it; keep its comment), and add there `callbackNoteFrom(extraction: Prisma.JsonObject | null): string | null` returning `callback_requested_at ?? callback_at` when a non-blank string. Update `webhookOutcome.ts`'s `callbackNoteFrom`/`extractedCallback` to use it.

- `resolveContact`: change the contact read's `goal` select to `{ memory: true, attemptLog: true }`; the campaign select `goalKeys` → `goal`; `const goal = campaign !== null && hasGoal(campaign) ? campaign : null`. Delete `merged`, `optOut`, `progressComplete` and the workspace-keyed DNC upsert. Replace with:

```ts
  const verdict = goal === null ? null : readVerdict(r.extraction);
  const stop = verdict?.nextAction === 'stop';

  /**
   * The opt-out, written for a goal campaign's `stop` before any branching
   * and outside the `claimed` guard: even a resolution that loses its race
   * heard the person ask to be left alone. Per campaign — the design's
   * decision — so the row is keyed by this campaign and this phone.
   */
  if (stop && r.campaignId !== null) {
    await db.doNotCall.upsert({
      where: { campaignId_phone: { campaignId: r.campaignId, phone: contact.contact.phone } },
      create: { campaignId: r.campaignId, phone: contact.contact.phone,
        reason: verdict?.reason ?? 'Asked not to be called again during a campaign call.',
        sourceCampaignContactId: r.campaignContactId },
      update: {},
    });
  }
```

`retrying` gets `!stop` where it had `!optOut`. `status` becomes `connected || (stop && !r.permanent) ? 'COMPLETED' : 'FAILED'`. The FAILED-with-a-conversation branch sets `goalAchieved = verdict?.goalAchieved ?? false`. The COMPLETED table becomes:

```ts
  if (goal !== null && status === 'COMPLETED') {
    const achieved = verdict!.nextAction === 'done' || verdict!.goalAchieved === true;
    if (stop) {
      goalAchieved = verdict!.goalAchieved ?? false;
    } else if (achieved) {
      goalAchieved = true;
    } else if (contact.followUpCount < goal.maxGoalFollowUps && !budgetSpent) {
      // call_again, call_back_at, and no verdict alike: re-arm at the delay.
      // A promised time is booked by the caller after this returns and moves
      // the contact off the delay; no verdict is a follow-up, never a guess.
      … existing follow-up updateMany, unchanged …
      return followedUp.count === 0 ? 'race_lost' : 'following_up';
    } else {
      goalAchieved = false;
    }
  }
```

Update the decision-table comment above it to the new five rows. Remove `DO_NOT_CALL_KEY`, `previewMerge`, `goalProgress`, `isOptOutValue` imports; import `readVerdict`, `hasGoal`, `recordAttempt`, `deriveKind`, `callbackNoteFrom`.

`ContactResolution.extraction` comment: now "read for the verdict; the record has already been written by the caller".

**Step 4: Run** — `npm test -- test/goal-resolution.test.ts test/goal-webhook.test.ts test/dialer-outcome.test.ts test/webhook-queue.test.ts test/dialer-reaper.test.ts` — Expected: PASS (fix any reaper test that asserted the old record write timing).

**Step 5: Commit** — `git commit -m "Decide a goal contact on the verdict, on the event that carries it"`

---

### Task 10: Per-campaign do-not-call in the claim, the sweep, the journey and the routes

**Files:**
- Modify: `src/services/dialerClaim.ts:41-48, 173-235, 256-297`
- Modify: `src/services/dialer.ts:1155-1160, 1408-1412` (drop `workspaceId` from both calls)
- Modify: `src/services/campaignJourney.ts:64-102, 256-262`
- Modify: `src/routes/doNotCall.routes.ts` (paths and scoping)
- Modify: `test/goal-claim.test.ts`, `test/do-not-call.test.ts`, `test/dialer-claim.query.test.ts`, `test/campaign-journey.test.ts`

**Step 1: Failing tests.** In `test/goal-claim.test.ts`, change the DNC cases: a row `{ campaignId, phone }` refuses the claim in every lane for *that* campaign and settles it EXCLUDED via `excludeDoNotCallContacts(prisma, { campaignId, now })`; the same phone on a second campaign in the workspace is claimed normally. In `test/do-not-call.test.ts`, change the routes to `GET /api/workspaces/:ws/campaigns/:cid/do-not-call` and `DELETE …/do-not-call/:id`, and add: a row from another campaign in the same workspace 404s on delete and does not appear in the list. Update the `makeCampaign` seeds to `goal: 'x'` instead of `goalKeys`.

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement.**
- `dialerClaim.ts`: delete `workspaceId` from `ClaimOptions` and the `excludeDoNotCallContacts` options; the `NOT EXISTS` becomes `WHERE dnc."campaignId" = ${campaignId} AND dnc.phone = c.phone`; the sweep's `findFirst` and `EXISTS` likewise. Rewrite the two doc comments to say per campaign.
- `dialer.ts`: remove the two `workspaceId:` lines at 1157 and 1410.
- `campaignJourney.ts`: `JourneyCampaign.goalKeys` → `goal: string | null`; the record select → `{ memory: true, lastCallNote: true, goalMissing: true, attemptLog: true }` gated on `hasGoal(campaign)`; the DNC read → `where: { campaignId_phone: { campaignId: campaign.id, phone: link.contact.phone } }`. Per-attempt annotation becomes `goal: { kind, nextAction, reason, callbackNote? }`. The `goal` block becomes `{ goal: campaign.goal, achieved, followUpCount, memory, lastCallNote, goalMissing }`. `optOut` comment: this campaign's list.
- `doNotCall.routes.ts`: paths `'/:workspaceId/campaigns/:campaignId/do-not-call'` and `'/:workspaceId/campaigns/:campaignId/do-not-call/:id'`; resolve the campaign with `campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!)` first (import from `../lib/campaign.js`), then `where: { campaignId: campaign.id, … }`. Rewrite the module comment: the list is a campaign's, permanent for that campaign, and a second campaign may still dial the number.

**Step 4: Run** — the four test files plus `test/dialer-sweep.test.ts` — Expected: PASS.

**Step 5: Commit** — `git commit -m "Scope the do-not-call list to the campaign"`

---

### Task 11: Campaign config, routes, serialisation, stats, dial variables

**Files:**
- Modify: `src/lib/campaignConfig.ts:485-550` (replace `validateGoalKeys`)
- Modify: `src/routes/campaigns.routes.ts` (`goalKeysFrom` 228-252, `changedBy` 385-407, create 553-563, PATCH 675-683 and 719-723 and 761-766 and 793, contacts list 1264-1299, stats 1490-1570)
- Modify: `src/lib/campaign.ts:184-191`
- Modify: `src/services/dialer.ts:575-591, 1184`
- Modify: `test/campaign-config.test.ts`, `test/campaigns.test.ts`, `test/campaign-edit-gates.test.ts`, `test/campaign-stats.test.ts`, `test/campaign-contacts.test.ts`, `test/dialer-placement.test.ts`

**Step 1: Failing tests.**
- `campaign-config.test.ts`: `validateGoal({ goal: '  Collect a budget  ' })` → `{ goal: 'Collect a budget' }`; `{ goal: '' }` and `{ goal: null }` → `{ goal: null }`; `{ goal: 'x'.repeat(2001) }` throws `VALIDATION_ERROR` naming `goal`; `{ goal: 42 }` throws; absent → `{}`.
- `campaign-edit-gates.test.ts`: `goal` is DRAFT-only (PATCH on PAUSED with a changed `goal` → 409 naming `goal`; the three knobs still allowed).
- `campaigns.test.ts`: create with `goal` round-trips on the response; `goalKeys` in a body is ignored.
- `campaign-stats.test.ts`: `stats.goal` is `{ goal: '<text>', achieved: {…} }`, and `null` without a goal; no `collectedFields`.
- `campaign-contacts.test.ts`: on a goal campaign each row carries `goal: { memory, lastCallNote, goalMissing }` (nulls and `''` when no record), `null` otherwise.
- `dialer-placement.test.ts`: a goal campaign's `startCall` body carries the six variables (`campaign_goal` equal to the goal text; `call_number: '1'`), and the reserved names win over a `variableMap` collision.

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement.**
- `campaignConfig.ts`: `export const MAX_GOAL_CHARS = 2000;` and

```ts
export function validateGoal(body: unknown): { goal?: string | null } {
  const fields = fieldsOf(body);
  if (!supplied(fields, 'goal')) return {};
  const value = fields.goal;
  if (value === null) return { goal: null };
  if (typeof value !== 'string') invalid('goal must be text, or null to turn the goal off.');
  const trimmed = value.trim();
  if (trimmed.length > MAX_GOAL_CHARS) invalid(`goal must be at most ${MAX_GOAL_CHARS} characters.`);
  return { goal: trimmed === '' ? null : trimmed };
}
```

Delete `validateGoalKeys`, `GoalKeysContext`, and the `RESERVED_EXTRACTION_KEYS` import if now unused.
- Routes: delete `goalKeysFrom` and `agentExtractionKeys` uses for goals (keep for lead buckets). `changedBy` takes `changingGoal: boolean` and pushes `'goal'`. In create: `const goal = validateGoal(req.body)` spread into `data`. In PATCH: `const goalUpdate = validateGoal(req.body); const changingGoal = goalUpdate.goal !== undefined && goalUpdate.goal !== campaign.goal;` and spread `goalUpdate`; the dial-budget sweep gate becomes `hasGoal({ goal: goalUpdate.goal ?? campaign.goal })`. Contacts list: fetch `{ campaignContactId, memory, lastCallNote, goalMissing }` and emit that per row. Stats: delete the distribution query; `goal = { goal: campaign.goal, achieved }`.
- `campaign.ts`: `goal: campaign.goal` replaces `goalKeys`.
- `dialer.ts`: `goalVariables({ goal: campaign.goal!, attemptNo }, await prisma.campaignContactGoal.findUnique({ …, select: { memory: true, lastCallNote: true, goalMissing: true } }))`; line 1184's gate uses `hasGoal(campaign)`.

**Step 4: Run** — `npx tsc --noEmit` must be clean now; then `npm test` (full). Re-run any failing file alone before treating it as real.

**Step 5: Commit** — `git commit -m "The campaign goal is prose: config, routes, stats and dial variables"`

---

### Task 12: Backend docs

**Files:**
- Rewrite: `docs/goal-campaigns-agent-guide.md`
- Modify: `README.md` (env table), `docs/deploy.md` (env list — remove `GOAL_SUMMARY_LLM`)

Rewrite the guide for the customer: a goal campaign needs one thing from you, a goal written in plain words. YE adds a managed block to your agent's prompt (show it, say not to edit inside the markers, say your own instructions go outside). Explain the verdict the agent gives at the end of each call in one table, what each `next_action` does, that "stop" lists the number for this campaign only, and that a promised time is honoured. Keep the register of the current guide ("the voice platform", no internals). Delete the old variables table and the `call_summary`/`do_not_call` sections.

Commit: `git commit -m "Rewrite the goal campaign guide for a prose goal"`

---

## Part D — The mock and the harnesses

### Task 13: Give the mock the platform's real event order

**Files (mock package):**
- Modify: `src/webhooks.ts:18-30` (classify default)
- Modify: `src/lifecycle.ts:70-80` and `src/manual.ts:49-57, 88-95` (completion after a gap)
- Modify: `src/routes/platform.ts` (agent prompt read/write; set detach)
- Modify: `test/webhooks.test.ts`, `test/lifecycle.test.ts`

**Step 1: Failing tests.** In `test/webhooks.test.ts`: a `completed` call with `answered_by: 'human'` and no `classify_on_status` carries `disposition` and `answered_by` on its terminal `call.status.updated`; a call with `classify_on_status: false` does not. In `test/lifecycle.test.ts`: for an answered call the emitted sequence is `…, status:completed, session.completed` with `session.completed` at a strictly later virtual instant (manual engine: two timeline entries).

**Step 2: Run** — `npm test` in the mock — Expected: FAIL.

**Step 3: Implement.**
- `webhooks.ts`: the default becomes `terminal && (call.disposition !== null || call.answeredBy !== null)` — the platform computes both before its terminal status event goes out, for completed calls too. Update the comment: a `completed` status carries classification whenever the call has one; extraction arrives only on `session.completed`, seconds later.
- `lifecycle.ts`: emit `session.completed` from a separate timer `POST_CALL_SECS` (draw 1–3 s) after the terminal transition.
- `manual.ts`: `push` gains a `completion` flag; `onAccept` pushes the terminal transition with `final: false` and a second entry `{ atMs: terminalAt + postCallMs, completion: true }`; `advance` emits `session.completed` for a completion entry without changing status. Scripted `delays_secs.post_call` overrides the gap (add to `ScriptRule`).
- `platform.ts`: keep a `Map<agentId, { prompt: string }>`; `GET /agent/:id` returns `{ id, extraction_enabled: true, prompt }`; add `PUT /agent/:id` merging `prompt` from the body; add `DELETE /agent/:id/extraction-sets/:setId`. Expose the prompts on `/_sim/state` as `agents: { [id]: { prompt } }` so a scenario can assert the block was written.

**Step 4: Run** — mock `npm test` — Expected: PASS.

No commit (the mock is unversioned here); note the change in the backend commit of Task 14.

---

### Task 14: Conformance scenarios

**Files:**
- Modify: `scripts/conformance/lib.ts` (`CampaignSpec.goalKeys` → `goal?: string`; seed writes `goal`)
- Rewrite: `scripts/conformance/scenarios/14-goal-followups.ts`, `15-goal-timing.ts`, `16-goal-optout-replay.ts`
- Modify: `scripts/conformance/report.ts` (row descriptions G1–G6)

Rewrite the scenarios against verdicts. Rows to keep or add:
- **G1** convergence: three conversations with `memory` growing ("Priya" → "Priya, 2BHK" → "Priya, 2BHK, 50L") and `next_action: call_again` twice then `done`; assert the third dial's variables carry the second call's memory and note; assert `goalAchieved === true`.
- **G2** follow-up budget: `call_again` past `maxGoalFollowUps` settles COMPLETED/false.
- **G3** dial cap: unchanged shape, with a verdict instead of keys.
- **G4** "not interested" on the first call: `next_action: stop` → COMPLETED, DoNotCall row for this campaign; a second campaign on the same phone still dials it (this replaces the workspace-wide assertion in 16).
- **G5** null verdict: a conversation whose script carries no extraction → follow-up at the default delay; journey note "no verdict".
- **G6** ordering: a completed call whose `session.completed` arrives 3 virtual seconds after the classified status event — with the first call's verdict `done` — settles achieved after ONE dial. This is the regression gate for the bug; it must fail against the pre-change engine.
- Replay (from 16): a duplicated completion changes no counter and no record.

The existing 46 non-goal rows must show zero verdict changes:

```bash
npm run conformance
```
Expected: every row MATCHES; the report in `scripts/conformance-results/` shows G1–G6 green.

Commit: `git commit -m "Conformance: verdict-driven goal rows, and the platform's real event order"` (include the mock change description in the body).

---

### Task 15: Battle scenarios

**Files:**
- Modify: `scripts/battle-lib.ts` (seed field), `scripts/battle-test.ts:706-1220` (scenarios 4–8)

Port scenarios 4–8 to verdict scripts (`goalHuman({ memory, next_action, … })`), add "two goal campaigns on one agent" (both start; the mock's agent prompt holds exactly one block; both settle correctly), and "hand-edited block" (script the mock agent's prompt with an edited block before start; after start it is intact). Run:

```bash
npm run battle
```
Expected: `scripts/battle-report.md` shows every goal scenario passing 3/3 with zero double-dials.

Commit: `git commit -m "Battle: verdict scenarios, shared-agent and edited-block cases"`

---

## Part E — Dashboard

Run the dashboard worktree's suite first for a green baseline: `npm test` in `/Users/sajaldewangan/Desktop/revenue-generator/.worktrees/goal-verdict/ye-voice-dashboard`.

### Task 16: Types and the goal rules

**Files:**
- Modify: `lib/types.ts` (Campaign 222-237, CampaignContact 361-374, CampaignGoalStats 440-446, JourneyGoal 489-500, JourneyContact goal annotation 557-565, `optOut` comment 480-486)
- Modify: `lib/campaigns/goal.ts`, `lib/campaigns/payload.ts:35-44, 100-113`
- Modify: `test/campaign-goal.test.ts`, `test/campaign-payload.test.ts`

**Step 1: Failing tests.** In `campaign-goal.test.ts`: `goalDraftFrom({ goal: 'Collect a budget' }).goal === 'Collect a budget'`; `hasGoal({ goal: '  ' }) === false`; `validateGoalDraft` reports `{ field: 'goal', message }` past 2000 characters; `goalPayload` sends `goal: null` for blank; `dialBudget` reads `goal`. In `campaign-payload.test.ts`: the create payload carries `goal: string | null`, never `goalKeys`.

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement.**
- `types.ts`: `goal?: string | null` replaces `goalKeys`; `CampaignContact.goal?: { memory: string | null; lastCallNote: string; goalMissing: string | null } | null`; `CampaignGoalStats = { goal: string; achieved: {…} }`; `JourneyGoal = { goal: string; achieved; followUpCount; memory; lastCallNote; goalMissing }`; attempt annotation `goal?: { kind; nextAction: NextAction | null; reason: string | null; callbackNote? }` with `export type NextAction = 'done' | 'call_again' | 'call_back_at' | 'stop'`; `optOut` comment → this campaign's list.
- `goal.ts`: `GoalDraft.goal: string` replaces `goalKeys`; `MAX_GOAL_CHARS = 2000`; `hasGoal` trims; `goalDraftFrom` reads `goal ?? ''`; `validateGoalDraft` adds the length issue; `goalPayload` emits `goal: draft.goal.trim() || null`; `goalDialCeiling` gates on `hasGoal`; `dialBudget` gates on `hasGoal`. `GOAL_FIELDS` gains `'goal'`, loses `'goalKeys'`.
- `payload.ts`: `goal: string | null` replaces `goalKeys`.

**Step 4: Run** — Expected: PASS.

**Step 5: Commit** — `git commit -m "The goal is prose on the wire and in the form"`

---

### Task 17: The goal editor

**Files:**
- Modify: `components/campaigns/goal-editor.tsx`
- Modify: `app/(dash)/campaigns/[id]/settings-tab.tsx:680-695, 802`, `app/(dash)/campaigns/new/page.tsx:559-577`
- Rewrite: `test/campaign-goal-editor.test.tsx`

**Step 1: Failing tests.** Replace the file: the editor renders a `textarea` labelled "Campaign goal"; typing turns the three knobs on; clearing it hides them and restores defaults (keep that existing case); `keysLocked` (rename the prop to `goalLocked`) renders the goal as read-only text with the Locked chip; a server issue with `field: 'goal'` lands under the textarea; no fetch is made (`api` never called).

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement.** Delete `KeyPicker`, `LockedKeys`, the `useApi`/`extractionKeyNames`/`AgentDetail` imports and the `workspaceId`/`agentId` props. Add a `textarea` (`rows={4}`, `maxLength={MAX_GOAL_CHARS}`, `aria-describedby` hint "Say in plain words what a call should achieve — for example: 'Confirm they are still looking, and collect their budget and move-in month.'"), and a `LockedGoal` read-only rendering. The intro paragraph becomes: "The agent judges at the end of every call whether the goal was met and what should happen next. A conversation that does not meet it schedules a follow-up, and the next call is told what earlier calls learned. Someone who asks not to be called again is not dialled again by this campaign." `on = value.goal.trim() !== ''`. Update the two call sites: drop `workspaceId`/`agentId`, rename `keysLocked` → `goalLocked`.

**Step 4: Run** — `npm test -- test/campaign-goal-editor.test.tsx test/campaign-settings-tab.test.tsx test/create-campaign-page.test.tsx` — Expected: PASS (fix the two page tests' fixtures from `goalKeys` to `goal`).

**Step 5: Commit** — `git commit -m "Goal editor: a text area, no key picker"`

---

### Task 18: Contacts row, journey, overview

**Files:**
- Modify: `app/(dash)/campaigns/[id]/contacts-tab.tsx:167-200`
- Modify: `components/campaigns/contact-journey.tsx:370-434, 605-660`
- Modify: `app/(dash)/campaigns/[id]/overview-tab.tsx:429-520`
- Modify: `test/campaign-contacts-tab.test.tsx`, `test/campaign-contact-journey.test.tsx`, `test/campaign-overview-tab.test.tsx`, `test/campaign-queue-tab.test.tsx` (fixtures)

**Step 1: Failing tests.**
- Contacts: a goal row shows the verdict line ("Achieved" / "Settled without the goal") and, beneath it, the last-call note; a row with a memory shows it truncated with a `title` carrying the full text; a non-goal campaign has no Goal column.
- Journey: `GoalStanding` shows the goal text, "What the agent knows: …" (or "Nothing learned yet"), the last-call note, and "Still needed: …"; the opt-out banner says "for this campaign" and never "workspace-wide"; an attempt row with `nextAction` shows "Next step: call again — busy at work" (and the four wordings).
- Overview: the goal card shows the goal text and the achieved rate; no field bars.

**Step 2: Run** — Expected: FAIL.

**Step 3: Implement** the three components as the tests describe. Keep the existing tones and classes; only the content changes. `kindWord`/`nextActionWord` map `done → 'goal met'`, `call_again → 'call again'`, `call_back_at → 'call back at the promised time'`, `stop → 'stop calling'`.

**Step 4: Run** — full dashboard suite and `npm run lint` and `npm run build` — Expected: green.

**Step 5: Commit** — `git commit -m "Show the verdict, the memory and the note on every contact surface"`

---

## Part F — Finish

### Task 19: Full verification

Backend:

```bash
npx tsc --noEmit

# The renamed COLUMNS, by name.
grep -rn 'workspaceId_phone\|goalKeys\|mergedExtraction\|keyAttempts\|summaryNote' src/ test/ scripts/

# The re-parented MODEL: every file that touches it, then every workspace
# reference in those files.
grep -rn 'workspaceId' $(grep -rl 'doNotCall\|DoNotCall' src/ test/ scripts/)

npm test
npm run conformance
npm run battle
```

**Both greps are required checks, not niceties.** `tsc` provably misses references to the dropped fields when the Prisma argument is built as a variable — the excess-property check fires only on an object literal at the call site, and `Subset<>` inference accepts the widened variable — so a `where = { workspaceId, … }` compiles clean and throws `PrismaClientValidationError` at runtime. It misses SQL inside `$queryRaw`/`$executeRaw` for the plainer reason that a string is a string. A green `tsc` is therefore not evidence that the rename is finished.

**The first grep must come back empty.** Every one of those five tokens is a name that no longer exists.

**The second grep will NOT come back empty, and must not be read as though it should.** It lists every workspace reference in every file that mentions the model, so it legitimately shows unrelated lines — `campaign.workspaceId`, `agent.workspaceId`, workspace ids in test fixtures, the `/:workspaceId/do-not-call` route path itself. What must be empty is the `DoNotCall` half: no line in that output may pair a `workspaceId` with the model. Read it looking for `prisma.doNotCall`/`db.doNotCall` arguments carrying `workspaceId`, `workspaceId_phone` compound keys on this model, `data: { workspaceId, phone }` on it, and `dnc."workspaceId"` inside raw SQL. Every one of those is a runtime 500 that both `tsc` and the first grep pass.

Dashboard:

```bash
npm run lint && npm test && npm run build
```

Any backend file that fails in the full run must pass alone (`npm test -- test/<file>`) before you conclude anything; the suite bleeds across files about one run in ten.

### Task 20: Update the design doc's status, push, open PRs

Add at the top of `docs/plans/2026-09-02-goal-verdict-design.md`: `Status: built on feat/goal-verdict, <date>.` Then:

```bash
git push -u origin feat/goal-verdict   # in both worktrees
gh pr create --title "Goal verdicts: the bot judges the goal, YE keeps a memory, decisions wait for the completion event" --body "<summary of the design's Why section; link the design doc; list the conformance and battle results>"
```

End the PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01HLnmS7jiSwzcvxDYttxCZL
```

Then use superpowers:finishing-a-development-branch.
