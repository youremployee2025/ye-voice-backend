# Follow-up Lane and Daily Cap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give a contact who has answered their own follow-up budget and wait, and cap how many times any contact is dialed per local day, with all three settings on the dashboard and editable mid-campaign.

**Architecture:** The outcome resolver (`dialerOutcome.ts`) decides the lane from whether the contact has ever spoken (`hasSpokenAttempt` over the goal attempt log): never-spoken → retry ladder as today; spoken → FOLLOW_UP arm spending `maxGoalFollowUps` and waiting `followUpDelayHours`. The claim query (`dialerClaim.ts`) gains two predicates beside the existing dial cap: a follow-up budget check on FOLLOW_UP rows and a per-day placed-attempt count against a `dayStart` the dialer computes from the campaign timezone. The absolute dial ceiling `totalDialsFor` becomes `retryCount + maxGoalFollowUps + 1`. The dashboard adds a "Follow-ups" card on the create form and the same three fields in the mid-campaign Pace panel.

**Tech Stack:** Node/TypeScript, Prisma + Postgres, Vitest (real DB tests), Next.js + React Testing Library on the dashboard.

**Design doc:** `docs/plans/2026-09-09-follow-up-lane-and-daily-cap-design.md` (read it first).

**Worktrees:**
- Backend: `/Users/sajaldewangan/Desktop/revenue-generator/ezo/.worktrees/follow-up-lane/ye-voice-backend` (branch `feat/follow-up-lane`, dev DB `ye_voice_follow_up_lane` on 5436, test DB `ye_test_follow_up_lane` on 5435, Redis index 13, own `node_modules`, `.env` already pointed at those).
- Dashboard: `/Users/sajaldewangan/Desktop/revenue-generator/ezo/.worktrees/follow-up-lane/ye-voice-dashboard` (branch `feat/follow-up-lane`, `node_modules` symlinked to the main clone).

**Running backend tests:** always from the backend worktree, with the shell's exported DB vars cleared so `.env` wins:

```bash
cd /Users/sajaldewangan/Desktop/revenue-generator/ezo/.worktrees/follow-up-lane/ye-voice-backend
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/<file>.test.ts
```

**Commit trailer** on every commit:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JktBnCrJKFuiQSp3f5pypx
```

**Fixture rule (from the always-on wave):** every test fixture sets a retired column to a value that would change the answer if the engine still read it: `goalEnabled: false` on a campaign that must follow up, `maxTotalDials: 99` on one that must stop, `immediateCallbackMinutes: 90` anywhere a resume gap could be confused with the follow-up wait.

**One deliberate deviation from the design doc, to keep the settle rule stable:** when a spoken contact's LAST dial went unanswered and the follow-up budget is spent, the settle stays `FAILED` with `goalAchieved = false` (the existing "FAILED settle after a conversation" rule at `dialerOutcome.ts:626-634`). A last dial that was an incomplete conversation settles `COMPLETED / false` as the doc says. Both are "reached, not achieved" for the stats page; only the status label differs, and changing it would move every stats tile. Tell the user in the final report.

---

## Phase A — Backend: schema and config

### Task A1: Add `maxDialsPerDay` to `Campaign`

**Files:**
- Modify: `prisma/schema.prisma` (Campaign model, after `followUpDelayHours` ~line 342)
- Create: `prisma/migrations/20260909100000_campaign_max_dials_per_day/migration.sql`

**Step 1: Edit the schema.** Replace the three DEPRECATED doc comments on `maxGoalFollowUps` and `followUpDelayHours` and add the new column:

```prisma
  /// How many more calls a contact may get once somebody has ANSWERED, spent
  /// by every dial after the first conversation — answered or not — and
  /// waited out at `followUpDelayHours`. Read again since 2026-09-09; 0 means
  /// an unfinished conversation settles at once. The no-answer retries in
  /// `retryCount` are a separate budget, forfeited the moment someone answers.
  maxGoalFollowUps Int @default(2)

  /// The wait before a follow-up, in hours, rolled into the dialing window.
  /// Read again since 2026-09-09; the retry ladder times no-answers only.
  followUpDelayHours Int @default(24)

  /// The most placed dials one contact may get in one calendar day of the
  /// campaign's timezone. Every arm counts except a CALLBACK the person asked
  /// for. Enforced by the claim only: a contact at the cap waits for the next
  /// local day and is never settled by it.
  maxDialsPerDay Int @default(2)
```

Leave `goalEnabled`, `maxTotalDials`, `immediateCallbackMinutes` comments as they are (still inert).

**Step 2: Write the migration by hand** (the repo dates migrations ahead of the clock; the directory name must sort after `20260908200000_cooldown_default_2h`):

```sql
-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "maxDialsPerDay" INTEGER NOT NULL DEFAULT 2;
```

**Step 3: Apply and regenerate.**

```bash
env -u DATABASE_URL -u TEST_DATABASE_URL npx prisma migrate deploy
env -u DATABASE_URL -u TEST_DATABASE_URL npm run test:prepare
npx prisma generate
```
Expected: both report the new migration applied; generate succeeds.

**Step 4: Add the runbook row.** Open `docs/PROD-PROMOTION.md` (or the deploy doc this repo uses — `grep -rl "migration" docs/*.md | head`) and add a row for `20260909100000_campaign_max_dials_per_day`: additive column with default, no preflight SQL, safe to run in-line.

**Step 5: Commit.**
```bash
git add prisma docs
git commit -m "Add maxDialsPerDay to Campaign and revive the follow-up columns' meaning"
```

### Task A2: Bounds and validation in `campaignConfig.ts`

**Files:**
- Modify: `src/lib/campaignConfig.ts:365-376` (constants), `:406-490` (`validateGoalPolicy`)
- Test: `test/campaign-config.test.ts` (`describe('validateGoalPolicy')` ~line 586)

**Step 1: Write failing tests.** In `describe('validateGoalPolicy')` add:

```ts
  describe('maxGoalFollowUps', () => {
    it('refuses more than five', () => {
      expect(reject(() => validateGoalPolicy({ maxGoalFollowUps: 6 })).message)
        .toBe('maxGoalFollowUps must be an integer between 0 and 5 (0 stops after the first conversation).');
    });
    it('accepts the whole range', () => {
      for (const value of [0, 1, 5]) {
        expect(validateGoalPolicy({ maxGoalFollowUps: value })).toEqual({ maxGoalFollowUps: value });
      }
    });
  });

  describe('maxDialsPerDay', () => {
    it('accepts 1 through 10', () => {
      for (const value of [1, 2, 10]) {
        expect(validateGoalPolicy({ maxDialsPerDay: value })).toEqual({ maxDialsPerDay: value });
      }
    });
    it.each([0, 11, 1.5, '2', null])('refuses %p', (value) => {
      expect(reject(() => validateGoalPolicy({ maxDialsPerDay: value })).message)
        .toBe('maxDialsPerDay must be an integer between 1 and 10.');
    });
    it('is omitted when not supplied', () => {
      expect(validateGoalPolicy({})).toEqual({});
    });
  });
```

Fix the existing test at ~line 658-663 that asserts the old `0 and 50` message and `MAX_GOAL_FOLLOW_UPS_CEILING` (it becomes 5).

**Step 2: Run, expect failures.** `env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run test/campaign-config.test.ts`

**Step 3: Implement.** In the constants block:

```ts
export const MIN_MAX_TOTAL_DIALS = 1;
export const MAX_MAX_TOTAL_DIALS = 50;
/** Follow-ups after the first conversation. Small on purpose: this is the
 *  budget that irritates a person who already answered. */
export const MAX_GOAL_FOLLOW_UPS_CEILING = 5;
export const MIN_FOLLOW_UP_DELAY_HOURS = 1;
export const MAX_FOLLOW_UP_DELAY_HOURS = 168;
export const MIN_MAX_DIALS_PER_DAY = 1;
export const MAX_MAX_DIALS_PER_DAY = 10;
export const DEFAULT_MAX_DIALS_PER_DAY = 2;
```

Rewrite the comment above them: `maxTotalDials` and `immediateCallbackMinutes` stay compatibility-only; `maxGoalFollowUps` and `followUpDelayHours` are live again as of 2026-09-09; `maxDialsPerDay` is new.

Add `maxDialsPerDay?: number` to `GoalPolicyUpdate`. In `validateGoalPolicy`, change the follow-ups message to `(0 stops after the first conversation)` and add:

```ts
  if (supplied(fields, 'maxDialsPerDay')) {
    const value = fields.maxDialsPerDay;

    if (!isIntegerInRange(value, MIN_MAX_DIALS_PER_DAY, MAX_MAX_DIALS_PER_DAY)) {
      invalid(
        `maxDialsPerDay must be an integer between ${MIN_MAX_DIALS_PER_DAY} and ${MAX_MAX_DIALS_PER_DAY}.`,
      );
    }

    data.maxDialsPerDay = value;
  }
```

Rewrite the `validateGoalPolicy` docblock: two of the four are live, two are compatibility-only, plus the new one.

**Step 4: Run, expect pass. Step 5: Commit** `"Bound the follow-up budget at five and add maxDialsPerDay validation"`.

### Task A3: The dial ceiling becomes `retryCount + maxGoalFollowUps + 1`

**Files:**
- Modify: `src/lib/dialBudget.ts:89-91` (`totalDialsFor`)
- Modify: every caller that passes a narrowed object: `src/routes/campaigns.routes.ts:~912` (`totalDialsFor({ retryCount: config.retryCount })`), `src/services/reextraction.service.ts:949` (add `maxGoalFollowUps: true` to the select)
- Test: `test/dial-budget.test.ts` if it exists, else add to `test/campaign-config.test.ts`

**Step 1: Failing test.**

```ts
import { totalDialsFor } from '../src/lib/dialBudget.js';

describe('totalDialsFor', () => {
  it('is the first call, the retries, and the follow-ups', () => {
    expect(totalDialsFor({ retryCount: 2, maxGoalFollowUps: 3 })).toBe(6);
  });
  it('ignores the stored maxTotalDials column', () => {
    expect(totalDialsFor({ retryCount: 0, maxGoalFollowUps: 0, maxTotalDials: 99 } as never)).toBe(1);
  });
});
```

**Step 2: Run, expect a type error / failure.**

**Step 3: Implement.**

```ts
export function totalDialsFor(campaign: { retryCount: number; maxGoalFollowUps: number }): number {
  return campaign.retryCount + 1 + campaign.maxGoalFollowUps;
}
```

Update its docblock: two lane budgets now exist (retries for the unreached, follow-ups for the reached), and this ceiling is their sum. It still bounds callbacks, which is unchanged. Max is 20 + 5 + 1 = 26, inside the Json attempt log's fifty.

Fix callers: `tsc` will point at each. In `campaigns.routes.ts` the sweep on edit becomes:

```ts
      const outOfReach =
        config.retryCount === undefined && config.maxGoalFollowUps === undefined
          ? 0
          : await sweepContactsOverDialBudget(
              tx,
              campaign.id,
              totalDialsFor({
                retryCount: config.retryCount ?? campaign.retryCount,
                maxGoalFollowUps: config.maxGoalFollowUps ?? campaign.maxGoalFollowUps,
              }),
            );
```

**Step 4:** `npx tsc --noEmit` clean; run `test/campaign-config.test.ts`, `test/campaign-edit-gates.test.ts`, `test/reextraction-plan.test.ts`. **Step 5: Commit** `"Derive the dial ceiling from both lane budgets"`.

### Task A4: Serializer and mid-campaign edit gate

**Files:**
- Modify: `src/lib/campaign.ts:216-220` (add `maxDialsPerDay: campaign.maxDialsPerDay`; rewrite the docblock — `maxGoalFollowUps`/`followUpDelayHours` are now real settings echoed as stored)
- Modify: `src/routes/campaigns.routes.ts:364-397` (`MID_CAMPAIGN_EDITABLE_FIELDS` add `'maxDialsPerDay'`; fix the comment), `:495` (add `'maxDialsPerDay'` to the change-detection array)
- Test: `test/campaign-edit-gates.test.ts`, `test/campaign-routes*.test.ts` (find the serializer test: `grep -ln "immediateCallbackMinutes" test/*.ts`)

**Step 1: Failing tests.** In the edit-gates file's `describe('tuning a campaign that has started')`, add:

```ts
    it(`accepts the follow-up budget, wait and daily cap while ${status}`, async () => {
      // seed a campaign in `status`, PATCH { maxGoalFollowUps: 1, followUpDelayHours: 48, maxDialsPerDay: 3 }
      // expect 200 and the three stored values echoed back
    });
```
Mirror the shape of the existing `accepts a new concurrency limit while ${status}` test at ~line 198. In the serializer test add an assertion that `maxDialsPerDay` is on the payload as stored.

**Step 2: Run, expect fail. Step 3: Implement. Step 4: Run, pass. Step 5: Commit** `"Echo maxDialsPerDay and accept the follow-up settings mid-campaign"`.

---

## Phase B — Backend: the outcome resolver

### Task B1: Lane-aware re-arm in `resolveContact`

**Files:**
- Modify: `src/services/dialerOutcome.ts:344-367` (campaign select), `:494-537` (retry gate), `:636-719` (follow-up branch)
- Test: `test/goal-resolution.test.ts` (seed helper at ~line 55-150 already supports `attemptLog`, `followUpCount`, `attempts`; add `maxGoalFollowUps`, `followUpDelayHours` to `SeedOptions` and write them on the campaign — and write `goalEnabled: false, maxTotalDials: 99` on every seeded campaign per the fixture rule)

**Step 1: Failing tests.** New `describe('the two lanes', ...)` in `test/goal-resolution.test.ts`:

```ts
describe('the two lanes', () => {
  it('a silence on a contact nobody reached spends a retry on the ladder', async () => {
    const s = await seed({ retryCount: 2, cooldownMinutes: 30, maxGoalFollowUps: 3, attemptLog: [] });
    await resolveSilence(s); // helper: resolveContact with retryable no_answer
    const row = await link(s);
    expect(row).toMatchObject({ status: 'PENDING', armKind: 'RETRY', attempts: 1, followUpCount: 0 });
    expect(row.nextEligibleAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
  });

  it('an incomplete conversation spends a follow-up and waits the follow-up hours', async () => {
    const s = await seed({ retryCount: 2, cooldownMinutes: 30, maxGoalFollowUps: 2, followUpDelayHours: 24 });
    await resolveIncomplete(s, 'flexible');
    const row = await link(s);
    expect(row).toMatchObject({ status: 'PENDING', armKind: 'FOLLOW_UP', attempts: 0, followUpCount: 1 });
    expect(row.nextEligibleAt).toEqual(new Date(NOW.getTime() + 24 * 60 * 60_000));
  });

  it('a silence on a contact already reached is a follow-up, not a retry', async () => {
    const s = await seed({
      retryCount: 5, cooldownMinutes: 30, maxGoalFollowUps: 2, followUpDelayHours: 6,
      followUpCount: 1, armKind: 'FOLLOW_UP', attemptNo: 2,
      attemptLog: [{ attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human' },
                   { attemptNo: 2, kind: 'follow_up', disposition: 'no_answer', answeredBy: null }],
    });
    await resolveSilence(s);
    const row = await link(s);
    expect(row).toMatchObject({ status: 'PENDING', armKind: 'FOLLOW_UP', attempts: 0, followUpCount: 2 });
    expect(row.nextEligibleAt).toEqual(new Date(NOW.getTime() + 6 * 60 * 60_000));
  });

  it('forfeits the retries once someone has answered: the follow-up budget alone bounds them', async () => {
    const s = await seed({ retryCount: 5, maxGoalFollowUps: 1, followUpCount: 1, armKind: 'FOLLOW_UP', attemptNo: 2,
      attemptLog: [{ attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human' },
                   { attemptNo: 2, kind: 'follow_up', disposition: 'no_answer', answeredBy: null }] });
    await resolveSilence(s);
    expect(await link(s)).toMatchObject({ status: 'FAILED', goalAchieved: false, nextEligibleAt: null });
  });

  it('zero follow-ups settles an incomplete conversation at once, not achieved', async () => {
    const s = await seed({ retryCount: 3, maxGoalFollowUps: 0 });
    await resolveIncomplete(s, 'flexible');
    expect(await link(s)).toMatchObject({ status: 'COMPLETED', goalAchieved: false, followUpCount: 0 });
  });

  it('the last follow-up that is still incomplete settles COMPLETED, not achieved', async () => {
    const s = await seed({ retryCount: 3, maxGoalFollowUps: 2, followUpCount: 2, armKind: 'FOLLOW_UP', attemptNo: 3,
      attemptLog: [/* 1 human completed-incomplete, 2 follow_up human, 3 follow_up human */] });
    await resolveIncomplete(s, 'flexible');
    expect(await link(s)).toMatchObject({ status: 'COMPLETED', goalAchieved: false });
  });

  it('reads the follow-up budget off the campaign as it is now', async () => {
    // seed maxGoalFollowUps: 3, followUpCount: 1; lower the campaign to 1 before resolving; expect settle
  });

  it('a follow-up rolls into the dialing window', async () => {
    // mirror the existing "rolls a follow-up that would land outside dialing hours" test at ~line 334 with followUpDelayHours
  });
});
```

Build `resolveSilence` / `resolveIncomplete` / `link` on the helpers the file already has (see the tests at lines 297-400 for the `resolveContact` call shape). Every seeded campaign writes `goalEnabled: false, maxTotalDials: 99, immediateCallbackMinutes: 90`.

Then fix the existing tests that encode the old rule:
- `'incomplete + flexible re-arms on the cooldown ladder and moves followUpCount only'` (297), `'a flexible follow-up walks the ladder by the retry counter, then the cooldown'` (369), `'incomplete + "null" callback type re-arms on the ladder like flexible'` (349), `'no outcome is a follow-up on the cooldown ladder, as flexible'` (510): the wait is now `followUpDelayHours` hours; keep their intent, change the expected instant, and set `followUpDelayHours` explicitly in the seed.
- `'keeps following up past the retired follow-up budget'` (555) → invert: `'stops following up once the follow-up budget is spent'`.
- `'retryCount = 2 yields exactly three dials for a repeatedly incomplete contact'` (567) → `retryCount = 2, maxGoalFollowUps = 2` yields three dials for a repeatedly incomplete contact (first + 2 follow-ups); retries are irrelevant once reached.
- `'a campaign whose stored goal switch is false'` block (703): keep; it now proves `goalEnabled` is still unread.
- In `test/dialer-outcome.test.ts` `'takes a followed-up contact back onto the ladder'` (560) → invert: a followed-up contact that goes silent stays a FOLLOW_UP.
- `test/goal-webhook.test.ts` and `test/reextraction-plan.test.ts` set `env.immediateResumeEnabled = true` at file top for resume cases; leave those, resume still lives inside the follow-up branch.

**Step 2: Run, expect failures.**

**Step 3: Implement.** In the campaign select add `maxGoalFollowUps: true, followUpDelayHours: true` and rewrite that comment. Then replace the block from `const budgetSpent` through the end of the follow-up branch with:

```ts
  const budgetSpent =
    goal !== null && (await dialBudgetSpent(db, r.campaignContactId, totalDialsFor(goal)));

  /**
   * Which lane this contact is in, decided by history and not by this call:
   * whether ANY attempt in the goal log reached a person. This call's own
   * entry is already logged, so a conversation right now reads as reached
   * too — and the follow-up branch is where a conversation goes anyway.
   */
  const reached = hasSpokenAttempt(readGoalLog(contact.goal?.attemptLog));

  const retrying =
    campaign !== null &&
    r.retryable &&
    !r.permanent &&
    // Never-reached only. Once somebody has answered, a silence is a missed
    // follow-up and spends the follow-up budget below, never a retry.
    !reached &&
    contact.attempts + 1 <= campaign.retryCount &&
    !budgetSpent &&
    !stop;

  if (retrying) { /* unchanged RETRY re-arm */ }

  const connected = !r.retryable && !r.permanent;
  const status = connected || (stop && !r.permanent) ? 'COMPLETED' : 'FAILED';

  /**
   * The follow-up lane. A reached contact whose conversation is not finished
   * — this call incomplete, or no outcome, or this call a silence after an
   * earlier conversation — gets one more call while the follow-up budget
   * lasts, `followUpDelayHours` from now, rolled into the window.
   */
  const followingUp =
    goal !== null &&
    reached &&
    !stop &&
    !r.permanent &&
    note.outcome !== 'completed' &&
    contact.followUpCount < goal.maxGoalFollowUps &&
    !budgetSpent;

  if (followingUp) {
    const bookable = parseCallbackAt(note.callbackRequestedTime, goal.timezone, r.now).ok;
    const immediate = wantsResume(note, bookable);
    const repeated = /* unchanged */;
    const gapMinutes = immediate
      ? repeated ? IMMEDIATE_REPEAT_WINDOW_MINUTES : IMMEDIATE_CALLBACK_MINUTES
      : goal.followUpDelayHours * 60;
    const at = rollIntoDialWindow(new Date(r.now.getTime() + gapMinutes * 60_000), goal);
    const followedUp = await db.campaignContact.updateMany({ where: claimed, data: { /* unchanged body */ } });
    return followedUp.count === 0 ? 'race_lost' : 'following_up';
  }

  let goalAchieved: boolean | null = null;
  if (goal !== null && status === 'FAILED' && reached) goalAchieved = note.outcome === 'completed';
  if (goal !== null && status === 'COMPLETED') {
    goalAchieved = !stop && note.outcome === 'completed';
  }
  /* settle — unchanged */
```

Rewrite the big decision-table docblock (lines 553-598) to describe the two lanes; delete the "One budget, and it is the retry panel's" paragraph. Remove `retryWaitMinutes` from the follow-up path (the retry branch still uses it). Confirm `hasSpokenAttempt` and `readGoalLog` are imported (they are, line ~626 uses them).

**Step 4: Run** `test/goal-resolution.test.ts`, `test/dialer-outcome.test.ts`, `test/goal-webhook.test.ts`, `test/attempt-reason.test.ts`, `test/campaign-callback.test.ts`. Expect pass.

**Step 5: Commit** `"Put a reached contact in its own follow-up lane with its own budget and wait"`.

---

## Phase C — Backend: claim, sweeps, dialer pass

### Task C1: `localDayStart` in `dialingWindow.ts`

**Files:**
- Modify: `src/lib/dialingWindow.ts` (append after `instantOf`)
- Test: `test/dialing-window.test.ts` (find the right file: `ls test | grep window`)

**Step 1: Failing test.**

```ts
describe('localDayStart', () => {
  it('is local midnight in the campaign zone', () => {
    // 2026-09-09T20:30Z is 2026-09-10 02:00 IST
    expect(localDayStart(new Date('2026-09-09T20:30:00Z'), 'Asia/Kolkata'))
      .toEqual(new Date('2026-09-09T18:30:00Z'));
  });
  it('handles a zone west of UTC', () => {
    // 2026-09-10T02:00Z is 2026-09-09 22:00 in New York (EDT, -4)
    expect(localDayStart(new Date('2026-09-10T02:00:00Z'), 'America/New_York'))
      .toEqual(new Date('2026-09-09T04:00:00Z'));
  });
  it('falls back to UTC midnight with no zone', () => {
    expect(localDayStart(new Date('2026-09-09T20:30:00Z'), null)).toEqual(new Date('2026-09-09T00:00:00Z'));
  });
});
```

**Step 3: Implement.**

```ts
/**
 * Midnight of `now`'s calendar day in the campaign's zone — the instant the
 * per-contact daily dial count starts from. A campaign with no zone counts
 * UTC days: it has no hours either, so there is no local day to prefer.
 */
export function localDayStart(now: Date, timeZone: string | null): Date {
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (timeZone === null) return utcMidnight;
  const local = zonedParts(now, timeZone);
  return local === null ? utcMidnight : instantOf(local.ymd, 0, timeZone);
}
```

**Step 5: Commit** `"Compute the campaign-local start of day"`.

### Task C2: Follow-up budget and daily cap in the claim

**Files:**
- Modify: `src/services/dialerClaim.ts:72-110` (`ClaimOptions`: add `maxGoalFollowUps: number; maxDialsPerDay: number; dayStart: Date`), `:346-381` (predicates)
- Test: `test/dialer-claim.query.test.ts` (extend `addContact` with `followUpCount` — already there — and add an `addAttempt(linkId, { attemptNo, startedAt, kind, status })` helper; the campaign seed needs `maxGoalFollowUps`, `maxDialsPerDay`, `timezone: 'Asia/Kolkata'`)

Every existing `claimContacts` call in tests must pass the three new options; default them in a local `claim()` helper: `maxGoalFollowUps: 2, maxDialsPerDay: 10, dayStart: new Date(0)` so existing cases are unaffected.

**Step 1: Failing tests.**

```ts
describe('the follow-up budget', () => {
  it('claims a FOLLOW_UP row inside the budget', async () => {
    const id = await addContact({ armKind: 'FOLLOW_UP', followUpCount: 2 });
    expect((await claim({ lane: 'retry', maxGoalFollowUps: 2 })).map((c) => c.id)).toEqual([id]);
  });
  it('refuses a FOLLOW_UP row the budget no longer covers', async () => {
    await addContact({ armKind: 'FOLLOW_UP', followUpCount: 3 });
    expect(await claim({ lane: 'retry', maxGoalFollowUps: 2 })).toEqual([]);
  });
  it('does not apply the retry budget to a reached contact', async () => {
    const id = await addContact({ armKind: 'FOLLOW_UP', attempts: 5, followUpCount: 0 });
    expect((await claim({ lane: 'retry', retryCount: 1 })).map((c) => c.id)).toEqual([id]);
  });
});

describe('the daily cap', () => {
  const IST_MIDNIGHT = new Date('2026-08-29T18:30:00Z'); // 2026-08-30 00:00 IST; NOW is 10:00Z = 15:30 IST
  it('skips a contact already dialed the cap today', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-300) });
    await addAttempt(id, { attemptNo: 2, startedAt: minutes(-60) });
    expect(await claim({ lane: 'any', maxDialsPerDay: 2, dayStart: IST_MIDNIGHT })).toEqual([]);
  });
  it('claims it again once the day has turned', async () => {
    // same rows; dayStart = tomorrow's IST midnight → claimed
  });
  it('does not count yesterday', async () => {
    // attempts at minutes(-1000) and minutes(-60) with cap 2 → claimed
  });
  it('does not count a callback the person asked for', async () => {
    // attempt kind 'callback' today + one 'retry' today, cap 2 → claimed
  });
  it('does not count an attempt that was never placed', async () => {
    // attempt with status FAILED, upstreamCallId null, launchError 'x' → not counted
  });
  it('claims an armed CALLBACK whatever the count', async () => {
    // CALLBACK arm with 3 placed attempts today, cap 2 → claimed
  });
});
```

**Step 3: Implement.** Add to `ClaimOptions` with docblocks (the day start is injected exactly like `now`, computed once per pass from the campaign zone). In `claimContacts`:

```ts
  /**
   * The follow-up budget, on the rows that spend it. Lowering
   * `maxGoalFollowUps` mid-campaign must stop a follow-up already waiting,
   * as lowering `retryCount` stops a retry. A reached contact is exempt from
   * the retry clause below: its retries were forfeited when somebody answered.
   */
  const followUpBudget = Prisma.sql`AND (cc."armKind" <> 'FOLLOW_UP' OR cc."followUpCount" <= ${maxGoalFollowUps})`;

  /**
   * The daily cap. Placed dials since the campaign-local midnight, excluding a
   * callback the person asked for; an armed CALLBACK is exempt outright, and
   * a contact at the cap simply waits — nothing settles on this.
   */
  const dailyCap = Prisma.sql`AND (${ARMED_FOR_CALLBACK} OR (
          SELECT COUNT(*) FROM "CallAttempt" ca
          WHERE ca."campaignContactId" = cc.id
            AND ca."startedAt" >= ${dayStart}
            AND COALESCE(ca.kind, '') <> 'callback'
            AND NOT ${neverPlacedSql('ca')}) < ${maxDialsPerDay})`;
```

Change the retry clause to `AND (cc.attempts <= ${retryCount} OR ${ARMED_FOR_CALLBACK} OR cc."armKind" = 'FOLLOW_UP')` and place `${followUpBudget} ${dailyCap}` after `${dialCap}`.

**Step 4: Run** `test/dialer-claim.query.test.ts`, `test/goal-claim.test.ts`, `test/lane-budgets.test.ts`, `test/dialer-sweep.test.ts`, `test/do-not-call.test.ts`. Fix call sites in `src/services/dialer.ts:1514-1525` (Task C4 does the real wiring; for now pass placeholders so `tsc` compiles, then finish in C4).

**Step 5: Commit** `"Refuse a follow-up past its budget and a contact at its daily cap in the claim"`.

### Task C3: Sweep for a lowered follow-up budget

**Files:**
- Modify: `src/lib/campaignLifecycle.ts:159-170` (`sweepContactsOverRetryBudget` exempts FOLLOW_UP); add `sweepContactsOverFollowUpBudget`
- Modify: `src/routes/campaigns.routes.ts:~890-915` (call the new sweep when `config.maxGoalFollowUps !== undefined`)
- Test: `test/campaign-edit-gates.test.ts` or the file that tests `sweepContactsOverRetryBudget` (`grep -ln "sweepContactsOverRetryBudget" test/*.ts`)

**Step 1: Failing tests.**
- Lowering `retryCount` to 0 leaves a PENDING FOLLOW_UP row with `attempts: 3` alone.
- Lowering `maxGoalFollowUps` to 1 SKIPs a PENDING FOLLOW_UP row with `followUpCount: 2` and increments `skippedCount`; leaves `followUpCount: 1` alone; leaves a CALLBACK row alone.

**Step 3: Implement.**

```ts
export async function sweepContactsOverRetryBudget(tx, campaignId, retryCount) {
  return tx.$executeRaw`
    UPDATE "CampaignContact"
    SET status = 'SKIPPED', "updatedAt" = NOW()
    WHERE "campaignId" = ${campaignId}
      AND status = 'PENDING'
      AND attempts > ${retryCount}
      AND "armKind" NOT IN ('CALLBACK', 'FOLLOW_UP')`;
}

/** The follow-up budget's analogue of the retry sweep: a reached contact
 *  waiting on a follow-up the lowered budget no longer covers. */
export async function sweepContactsOverFollowUpBudget(tx, campaignId, maxGoalFollowUps): Promise<number> {
  return tx.$executeRaw`
    UPDATE "CampaignContact"
    SET status = 'SKIPPED', "updatedAt" = NOW()
    WHERE "campaignId" = ${campaignId}
      AND status = 'PENDING'
      AND "armKind" = 'FOLLOW_UP'
      AND "followUpCount" > ${maxGoalFollowUps}`;
}
```

In the route, add beside the retry sweep and include its count in the `skippedCount` increment (see how `swept` and `outOfReach` are summed further down).

**Step 5: Commit** `"Sweep follow-ups a lowered budget stranded, and stop the retry sweep touching them"`.

### Task C4: Wire the dialer pass

**Files:**
- Modify: `src/services/dialer.ts:1117` area (compute `const dayStart = localDayStart(now, campaign.timezone)` next to `evaluateWindow`), `:1514-1525` (pass `maxGoalFollowUps: campaign.maxGoalFollowUps, maxDialsPerDay: campaign.maxDialsPerDay, dayStart`)
- Modify: `src/services/dialer.ts:~1228` — `settleContactsOverDialBudget` keeps `totalDialsFor(campaign)` (now includes follow-ups; no code change, but re-read the comment)
- Test: `test/dialer-sweep.test.ts` — one end-to-end case: a RUNNING campaign with `maxDialsPerDay: 1`, one contact with a placed attempt today, a sweep pass claims nothing and settles nothing; advance `now` past local midnight and the same pass claims it.

`CAMPAIGN_INCLUDE` (dialer.ts:~100) is an `include`, so the two columns arrive on `SweepCampaign` after `prisma generate`.

**Step 5: Commit** `"Hand the claim the follow-up budget, the daily cap and the local day start"`.

### Task C5: Re-extraction planner

**Files:**
- Modify: `src/lib/reextraction/plan.ts:71-80` (`RearmBudget` add `maxGoalFollowUps: number; followUpCount: number`), `:106-117` (`refusedBy` returns `'follow_up_budget'` when `kind !== 'callback' && followUpCount >= maxGoalFollowUps` — placed after the dial-budget clause and before the retry clause; the retry clause applies only when `followUpCount === 0 && !spoken`... keep it simple: a re-extraction only ever re-arms conversations (`selectConversations` skips `never_reached`), so every re-arm here is a reached contact: **replace** the `retry_budget` clause with the follow-up one)
- Modify: `src/services/reextraction.service.ts:225` (carry `followUpCount` on the conversation — note `contactWrite` resets it to 0 on apply, which is the agreed rule; the budget check uses the value BEFORE the reset), `:1038-1041` (pass `maxGoalFollowUps`, `followUpCount`)
- Modify: the `RearmPlan` `over_budget` reason union and any report/CSV that prints it (`grep -rn "retry_budget" src scripts`)
- Test: `test/reextraction-plan.test.ts`, `test/reextraction-apply.test.ts`

**Step 1: Failing tests.** In `test/reextraction-plan.test.ts`: `follow_up` with `followUpCount: 2, maxGoalFollowUps: 2` → `{ kind: 'over_budget', reason: 'follow_up_budget' }`; with `followUpCount: 1` → armed; a `callback` at `followUpCount: 2` → still armed; `attempts: 9, retryCount: 1` no longer refuses a follow-up. Daily cap is deliberately not a refusal (add a one-line test that `RearmBudget` has no such field — or just a comment).

**Step 5: Commit** `"Refuse a re-extraction re-arm on the follow-up budget, not the retry budget"`.

### Task C6: Conformance scenario and battle greps

**Files:**
- Modify: `scripts/conformance/lib.ts:444-475` (`CampaignSpec`: add `maxGoalFollowUps?`, `followUpDelayHours?`, `maxDialsPerDay?`; rewrite the "no goal knobs" comment; spread them onto the row in `seedCampaign`)
- Modify: `scripts/conformance/scenarios/15-goal-timing.ts`: the flexible/unread/promised campaigns now re-arm at `followUpDelayHours` (set it explicitly, e.g. 4 h on `windowed` so it still rolls; 6 h on `unread`); the header comment.
- Create: `scripts/conformance/scenarios/17-follow-up-lane.ts` with rows: (a) silence → retry ladder; (b) conversation-incomplete → FOLLOW_UP at +`followUpDelayHours`; (c) silence after (b) → FOLLOW_UP again, `attempts` unmoved; (d) `maxGoalFollowUps: 0` settles; (e) `maxDialsPerDay: 1` with `retryDelaysMinutes: [5]`: second dial refused until the next IST midnight, then placed. Register in `scenarios/index.ts`.
- Grep: `grep -rn "retryCount + 1\|totalDialsFor\|maxGoalFollowUps" scripts/ docs/*.md CLAUDE.md` and fix every sentence that says the budget is `retryCount + 1` or that follow-ups wait the ladder.

Run the conformance suite only if a free DB is available (`scripts/conformance/README` or CLAUDE.md says which); otherwise note "updated, not run" in the final report.

**Step 5: Commit** `"Conformance rows for the follow-up lane and the daily cap"`.

### Task C7: Full backend gate

```bash
npx tsc --noEmit
env -u DATABASE_URL -u TEST_DATABASE_URL npx vitest run
```
Expected: clean tsc; all files pass. The suite is ~10% flaky on cross-file bleed: re-run any failing file alone before reading it as a bug. Then `npm run lint` if present.

Update `CLAUDE.md` in the backend (the campaign section describing budgets) and commit `"Describe the two lanes and the daily cap in CLAUDE.md"`.

---

## Phase D — Dashboard

Work in the dashboard worktree. Tests: `npx vitest run test/<file>`; gates: `npx tsc --noEmit && npm run lint`.

### Task D1: Types and payloads

**Files:**
- Modify: `lib/types.ts:275-298` (`maxGoalFollowUps: number; followUpDelayHours: number; maxDialsPerDay: number` — required now; rewrite the docblock; keep `goalEnabled`, `maxTotalDials?`, `immediateCallbackMinutes?` as-is)
- Modify: `lib/campaigns/payload.ts` (`DraftSettingsDraft` and `MidCampaignDraft` gain the three; both builders emit them)
- Modify: `lib/campaigns/goal.ts` (`dialBudget` takes `{ retryCount, maxGoalFollowUps }` = `retryCount + 1 + maxGoalFollowUps`; `followUpPolicyLine(retryCount, maxGoalFollowUps, followUpDelayHours, maxDialsPerDay)` drops the 3-minute sentence and says: "Once somebody answers, they may get up to N more calls, M hours apart. No contact is called more than K times a day, callbacks they asked for aside.")
- Test: `test/campaign-payload.test.ts` (the pinned key lists: draft + 3, mid-campaign "exactly the seven" → ten), `test/campaign-goal.test.ts`, fixtures in `test/campaign-settings-tab.test.tsx` `campaign()` and `components/labs/surfaces/ops-fixtures.ts` gain the three fields.

**Step 1: Failing tests** (extend the pinned-keys tests; add `dialBudget` and `followUpPolicyLine` cases). **Step 3: Implement.** Fix every `tsc` error from the now-required fields. **Step 5: Commit** `"Carry the follow-up settings on the campaign type and both payloads"`.

### Task D2: Follow-ups card on the create form

**Files:**
- Create: `components/campaigns/follow-up-policy-card.tsx` — a `Panel` with three `Field`s (`Follow-ups after a partial conversation` 0–5, `Wait before a follow-up` 1–168 hours, `Max calls per contact per day` 1–10), props `{ value: { maxGoalFollowUps: string; followUpDelayHours: string; maxDialsPerDay: string }, onChange, idPrefix, disabled }`, hints as in the design doc. Reuse `numberClass` (export it from where the retry editor gets it, or duplicate the string — check `components/campaigns/retry-policy-editor.tsx` first).
- Modify: `app/(dash)/campaigns/new/page.tsx:79-92` (form state: `maxGoalFollowUps: '0', followUpDelayHours: '24', maxDialsPerDay: '2'`), `:220-245` (clamp with `wholeInRange`), `:268-290` (send the three; delete the "goal fields are deliberately absent" comment), `:550-575` (render the card under `RetryPolicyEditor` inside section 3).
- Test: `test/create-campaign-page.test.tsx` — the create payload carries `maxGoalFollowUps: 0, followUpDelayHours: 24, maxDialsPerDay: 2` by default; editing the follow-ups box to 3 sends 3; a value outside range is refused with the field named (mirror how the retry editor's `showErrors={submitted}` case is tested). New `test/campaign-follow-up-policy-card.test.tsx` for the card alone.

**Step 5: Commit** `"Follow-ups card on the create form"`.

### Task D3: Same fields in the Pace panel and the draft settings form

**Files:**
- Modify: `app/(dash)/campaigns/[id]/settings-tab.tsx`: `DraftSettingsForm` state (~282), payload (~527), render under its `RetryPolicyEditor` (~763); `MidCampaignSettingsForm` `pace` state (~841), clamp (~897-903), payload (~955), render inside the Pace `Panel` after the retry-share `Field` (~1080) — reuse `FollowUpPolicyCard` with `bare` rendering or render the three `Field`s inline with `idPrefix="mid-"`; `LockedConfigCard` `Row label="Follow-ups"` (~1263) reads the stored values.
- Modify: `retryLoweringWarning` caller so lowering `maxGoalFollowUps` shows an analogous warning ("contacts already waiting on follow-up #N are marked skipped").
- Test: `test/campaign-settings-tab.test.tsx`: the `describe.each` RUNNING/PAUSED/CREDIT_EXHAUSTED block gets `'edits the follow-up budget inside the Pace panel and sends it'`, `'sends exactly the ten fields the API accepts'` (update the pinned list), and the locked shape shows "Follow-ups" read-only; the draft block sends the three with the draft payload.

**Step 5: Commit** `"Follow-up settings editable mid-campaign in the Pace panel"`.

### Task D4: Copy cleanup

**Files:**
- `app/(dash)/campaigns/new/page.tsx:496` and `settings-tab.tsx:707,1066` retries'-share hint: "the rest goes to callbacks someone asked for" (drop "and to conversations picked back up after they dropped mid-call"; "callbacks and resumes go first" → "callbacks go first").
- `app/(dash)/campaigns/[id]/queue-tab.tsx:123-136`: render the "Dropped calls being resumed" `QueueGroup` only when its list is non-empty (check how `QueueGroup` fetches; add a `hideWhenEmpty` prop if needed); reword blurb to past tense ("was queued to be picked back up") and drop "three minutes".
- `app/(dash)/campaigns/[id]/overview-tab.tsx:231-235, 283`: same wording pass.
- `lib/campaigns/contact-state.ts:172`: label stays (old RESUME rows exist).
- Test: `test/campaign-queue-tab.test.tsx` — the resume group is absent with no rows, present with one.

**Step 5: Commit** `"Stop describing the three-minute resume as live"`.

### Task D5: Dashboard gate

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```
Expected: all green.

---

## Phase E — Rollout checks and handoff

### Task E1: Prod audit query (read-only)

Against the prod DB (see memory `ezo-prod-db-is-on-render`; PascalCase quoted tables), run read-only:

```sql
SELECT id, name, status, "retryCount", "maxGoalFollowUps", "followUpDelayHours"
FROM "Campaign"
WHERE status IN ('RUNNING','PAUSED','CREDIT_EXHAUSTED')
   OR "maxGoalFollowUps" <> 2 OR "followUpDelayHours" <> 24;
```
Report the rows to the user: on deploy every live campaign starts following up reached contacts with its stored budget, and each gets `maxDialsPerDay = 2`.

### Task E2: Finish

Use `superpowers:finishing-a-development-branch`. Push both branches, open PRs (backend first; the dashboard PR body notes it needs the backend deployed first because `maxDialsPerDay` becomes required on the type). Do not merge: merging backend `main` is a Render prod deploy and the user does that.
