# Campaign Overview: dialing window and caller number — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the campaign Overview dialing window as one coherent sentence-shaped control, and add a caller phone number a campaign dials from.

**Architecture:** Backend adds one nullable `Campaign.phoneNumberId` → `PhoneNumber` (additive migration, `ON DELETE SET NULL`), a usability predicate mirroring `agentVisibility.ts`, validation on the existing PATCH, and a `{ id, did }` embedded summary. The dashboard replaces the two bare `<input type="time">` boxes with 30-minute native selects, presets, a seeded timezone and a live summary, and adds a native-select phone-number picker beside the agent picker. No Vocobase call in either repo. Start is not gated on a number — the dialer slice decides that.

**Tech Stack:** Express 4 + Prisma 6 + Postgres + Zod 4 + Vitest 4 + supertest (backend); Next 15 App Router + React 19 + Tailwind 4 + Vitest 3 + Testing Library (dashboard).

Design: `docs/plans/2026-08-28-campaign-config-design.md`.

Branch `feat/campaign-config` in both repos, worktrees under
`ye-voice-agent/.worktrees/campaign-config/`. Merge `origin/main` before the PRs.

---

## Repo A — ye-voice-backend

### Task A1: The schema and the migration (HOLD for SQL review)

**Files:**
- Modify: `prisma/schema.prisma` (`model Campaign`, `model PhoneNumber`)
- Create: `prisma/migrations/20260828100000_campaign_phone_number/migration.sql`

**Step 1: Add the relation to the schema**

In `model Campaign`, after `agentId`:

```prisma
  /// The DID this campaign dials from. Nullable, and null is a real state: a
  /// draft has not chosen one yet, and `ON DELETE SET NULL` returns a campaign
  /// to it when the number row is deleted.
  ///
  /// A set value does NOT prove the number is still usable. A DID goes back to
  /// the pool through an UPDATE the constraint cannot see, so every read that
  /// matters re-resolves it against the workspace and its status.
  phoneNumberId String?
```

In the relation block:

```prisma
  phoneNumber PhoneNumber? @relation(fields: [phoneNumberId], references: [id], onDelete: SetNull)
```

and `@@index([phoneNumberId])`.

In `model PhoneNumber`, add the back-relation beside `ledgerRows`:

```prisma
  campaigns  Campaign[]
```

**Step 2: Write the migration by hand**

Hand-written, not `migrate dev` — the generated file would carry no reasoning
and would validate the constraint under `ACCESS EXCLUSIVE`. Never edit or
re-date an existing migration.

```sql
-- Adds the DID a campaign dials from.
--
-- Additive only: one nullable column, one index, one foreign key. No existing
-- row changes, and no existing migration is touched.

-- Metadata-only in Postgres 11+: a nullable ADD COLUMN with no default does not
-- rewrite the table, so this is instant however many campaigns exist.
ALTER TABLE "Campaign" ADD COLUMN "phoneNumberId" TEXT;

-- Every row is NULL, so nothing can violate this. It is still added NOT VALID
-- and validated in the next migration, for the reason the agent FK records: a
-- plain ADD CONSTRAINT validates on creation and holds ACCESS EXCLUSIVE on
-- "Campaign" for a full scan probing "PhoneNumber"'s primary key. NOT VALID
-- takes the lock only long enough to record the constraint, and enforces on
-- every insert and update from that instant.
--
-- SET NULL, not RESTRICT, matching "Campaign_agentId_fkey": a PhoneNumber is
-- the platform's record and a campaign is the customer's. A campaign must not
-- be able to pin a DID row in place, and a campaign left without a number is an
-- accurate description of what happened.
SET lock_timeout = '3s';

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_phoneNumberId_fkey"
  FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

-- Serves the FK's own lookups and the "which campaigns use this DID" question
-- the release path will eventually ask.
CREATE INDEX "Campaign_phoneNumberId_idx" ON "Campaign"("phoneNumberId");
```

and `prisma/migrations/20260828100100_campaign_phone_number_validate/migration.sql`:

```sql
-- Validates the constraint added NOT VALID in the previous migration.
--
-- A separate file, and therefore a separate transaction, which is the point:
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so the scan runs while
-- reads and writes continue.
--
-- The column was created NULL on every row and the constraint has been enforced
-- on every write since it was added, so this is expected to find nothing.
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_phoneNumberId_fkey";
```

**Step 3: HOLD.** Show the SQL to the user and stop. Do not run
`prisma migrate dev`, `migrate deploy` or anything that touches production.

**Step 4: After approval, apply to the TEST database only**

Run: `npm run test:prepare`
Expected: `migrate deploy` applies both new migrations against `TEST_DATABASE_URL`.
The script refuses a Neon host; that guard stays untouched.

Then: `npx prisma generate`

**Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add the phone number a campaign dials from"
```

---

### Task A2: The usability predicate

**Files:**
- Create: `src/lib/phoneNumberVisibility.ts`
- Test: `test/campaign-phone-number.test.ts` (unit half)

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { phoneNumberIsUsable } from '../src/lib/phoneNumberVisibility.js';

describe('phoneNumberIsUsable', () => {
  const ws = 'ws_1';

  it('accepts an assigned number in this workspace', () => {
    expect(phoneNumberIsUsable({ status: 'ASSIGNED', workspaceId: ws }, ws)).toBe(true);
  });

  it('accepts a past-due number — it is still held and still rings', () => {
    expect(phoneNumberIsUsable({ status: 'PAST_DUE', workspaceId: ws }, ws)).toBe(true);
  });

  it('refuses a number in another workspace', () => {
    expect(phoneNumberIsUsable({ status: 'ASSIGNED', workspaceId: 'ws_2' }, ws)).toBe(false);
  });

  it('refuses a pool number and a released one', () => {
    expect(phoneNumberIsUsable({ status: 'UNASSIGNED', workspaceId: null }, ws)).toBe(false);
    expect(phoneNumberIsUsable({ status: 'RELEASED_NONPAYMENT', workspaceId: ws }, ws)).toBe(false);
  });

  it('refuses null', () => {
    expect(phoneNumberIsUsable(null, ws)).toBe(false);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-phone-number.test.ts`
Expected: FAIL — cannot resolve `../src/lib/phoneNumberVisibility.js`.

**Step 3: Write the implementation**

Two halves of one rule, in one file, the shape `agentVisibility.ts` uses.
Deliberately *not* a generalisation of `agentIsUsable`: same shape, different
content, and one function taking either is one that can be handed the wrong one.

```ts
import type { PhoneNumberStatus, Prisma } from '@prisma/client';

/**
 * The two statuses that mean "this workspace holds this number".
 *
 * PAST_DUE is in the list on purpose, and the enum's own comment is the
 * argument: the DID still belongs to them and still rings, and the sweep is
 * still retrying. Refusing to configure with it would punish a billing state
 * that has not yet taken the number away — and would silently unpick a
 * campaign's caller id the moment a card expired.
 *
 * UNASSIGNED and RELEASED_NONPAYMENT are both "back in the shared pool", which
 * belongs to nobody.
 */
export const HELD_STATUSES: readonly PhoneNumberStatus[] = ['ASSIGNED', 'PAST_DUE'];

/** The SQL half, for a lookup that has not happened yet. */
export const IS_HELD: Prisma.PhoneNumberWhereInput = { status: { in: [...HELD_STATUSES] } };

/**
 * The in-memory half, for a row already joined.
 *
 * Two conditions, neither implied by `phoneNumberId != null`. A release is an
 * UPDATE the foreign key cannot see, so a campaign can hold a perfectly valid
 * id for a number that is now in the pool — or in somebody else's workspace.
 */
export function phoneNumberIsUsable(
  number: { status: PhoneNumberStatus; workspaceId: string | null } | null | undefined,
  workspaceId: string,
): boolean {
  if (!number) return false;
  if (number.workspaceId !== workspaceId) return false;
  return HELD_STATUSES.includes(number.status);
}
```

**Step 4: Run and watch it pass**

Run: `npx vitest run test/campaign-phone-number.test.ts`
Expected: PASS (5 tests).

**Step 5: Commit**

```bash
git add src/lib/phoneNumberVisibility.ts test/campaign-phone-number.test.ts
git commit -m "feat: define which of a workspace's numbers a campaign may dial from"
```

---

### Task A3: Serialize the number on a campaign

**Files:**
- Modify: `src/lib/campaign.ts` (`CAMPAIGN_INCLUDE`, `serializeCampaign`)
- Test: `test/campaign-phone-number.test.ts`

**Step 1: Write the failing tests** — a campaign carrying a held number
serializes `phoneNumber: { id, did }` and nothing else; one whose number has
gone back to the pool serializes `phoneNumberId` set with `phoneNumber: null`;
one with no number serializes both as null. Build rows with a `makePhoneNumber`
helper added to `test/helpers.ts`:

```ts
export async function makePhoneNumber(
  workspace: Workspace | null,
  did: string,
  status: PhoneNumberStatus = 'ASSIGNED',
): Promise<PhoneNumber> {
  return prisma.phoneNumber.create({
    data: { did, workspaceId: workspace?.id ?? null, status },
  });
}
```

**Step 2: Run and watch them fail** — `phoneNumber` is `undefined` in the payload.

**Step 3: Implement.** Extend `CAMPAIGN_INCLUDE` with
`phoneNumber: { select: { id: true, did: true, status: true, workspaceId: true } }`
— `status` and `workspaceId` are read to decide usability and are never emitted,
exactly as `agent.workspaceId` already is. In `serializeCampaign`, gate on
`phoneNumberIsUsable` and emit:

```ts
    // Emitted even when `phoneNumber` is null, for the reason `agentId` is:
    // nulling both would make "unavailable" indistinguishable from "not set" on
    // the wire, and leave the dashboard unable to say why.
    phoneNumberId: campaign.phoneNumberId,
    phoneNumber: heldNumber ? { id: heldNumber.id, did: heldNumber.did } : null,
```

**Step 4: Run** `npx vitest run test/campaign-phone-number.test.ts` — PASS.

**Step 5: Commit** — `feat: carry the caller number on a campaign payload`.

---

### Task A4: Accept and validate it on PATCH

**Files:**
- Modify: `src/lib/campaign.ts` (add `assertPhoneNumberAssignable`)
- Modify: `src/routes/campaigns.routes.ts` (`updateSchema`, the PATCH handler)
- Test: `test/campaign-phone-number.test.ts`

**Step 1: Write the failing tests**

- assigns an `ASSIGNED` number, and a `PAST_DUE` one
- 422 `CAMPAIGN_PHONE_NUMBER_NOT_FOUND` for: another workspace's number, a pool
  number, a `RELEASED_NONPAYMENT` one, and `'phone_does_not_exist'` — asserted
  **byte-identical** via `new Set(results.map(r => JSON.stringify(r.body))).size === 1`,
  sequentially, and asserting the column is still null afterwards
- the refusal never contains the foreign DID string
- `null` clears it
- 409 `CAMPAIGN_PHONE_NUMBER_LOCKED` changing it while `RUNNING`
- **200** resubmitting the *same* number while `RUNNING` (the dashboard sends the
  whole form; a locked field must not fail every other edit)
- 200 changing it while `PAUSED`
- `POST /start` succeeds on a campaign with an agent, a pending contact and no number

**Step 2: Run and watch them fail** — zod strips the unknown key, so the assign
tests come back with `phoneNumberId: null`.

**Step 3: Implement.**

`updateSchema` gains `phoneNumberId: z.string().trim().min(1).max(191).nullable()`
beside `agentId`.

`assertPhoneNumberAssignable` in `src/lib/campaign.ts`, modelled line-for-line on
`assertAgentAssignable` — same 422, same four-causes-one-answer comment, same
`select: { id: true }` so no row that could be forwarded into a response is ever
loaded.

In the PATCH handler, beside the agent block:

```ts
    // Same shape as the agent above, and the same reason: `start` reads the
    // number once and nothing looks again, so leaving this open would let one
    // PATCH swap the caller id of a campaign that is mid-dial.
    const changingNumber =
      data.phoneNumberId !== undefined && data.phoneNumberId !== campaign.phoneNumberId;

    if (changingNumber && !AGENT_MUTABLE.includes(campaign.status)) {
      throw new ApiError(
        409,
        'CAMPAIGN_PHONE_NUMBER_LOCKED',
        'Pause this campaign before changing the number it dials from.',
      );
    }

    if (data.phoneNumberId) {
      await assertPhoneNumberAssignable(campaign.workspaceId, data.phoneNumberId);
    }
```

Rename `AGENT_MUTABLE` to `CONFIG_MUTABLE` in the same commit, with its comment
widened to cover both — two constants with identical contents are two rules that
eventually disagree.

**Step 4: Run** `npx vitest run test/campaign-phone-number.test.ts` — PASS.

**Step 5: Commit** — `feat: let a campaign choose which number it dials from`.

---

### Task A5: Backend gates and docs

**Step 1:** `npx tsc --noEmit` — expected: clean.
**Step 2:** `npm test` — expected: the whole suite green, including
`campaigns.test.ts`, `campaign-agent.test.ts`, `campaign-lifecycle.test.ts`,
`isolation-hardening.test.ts`.
**Step 3:** Update `CLAUDE.md`'s campaign section: the new field, the usability
rule, the two error codes, and an explicit note that **start does not require a
number and the dialer slice must decide whether it should**. No mention of any
reference repo.
**Step 4:** `git merge origin/main`, re-run both gates.
**Step 5:** Commit, push, `gh pr create --base main`. Do not merge.

---

## Repo B — ye-voice-dashboard

### Task B1: Types

**Files:** Modify `lib/types.ts`.

Add `CampaignPhoneNumber { id: string; did: string }`. On `Campaign`, add
`phoneNumberId: string | null` and `phoneNumber?: CampaignPhoneNumber | null` —
**optional**, carrying the same comment `agent` carries: absent means an API that
predates the field, and typing it non-optional would make every campaign in the
product read as "Unavailable" through a staggered deploy, with no type error to
warn of it.

Commit: `feat: type the number a campaign dials from`.

---

### Task B2: The dialing window control

**Files:**
- Create: `components/campaigns/dialing-window.tsx`
- Create: `lib/dialing-window.ts` (pure helpers)
- Test: `test/dialing-window.test.tsx`

**Step 1: Write the failing tests** against the pure helpers first —
`timeOptions(stored)` (48 slots, plus an off-step stored value in sorted
position, and no duplicate when it is on-step), `windowError({from,to,timezone})`
(null when both empty; names the empty field when one is set; refuses `to <= from`;
demands a timezone when a window is set), and `windowSummary(...)` (the sentence,
short zone name, and the no-window sentence).

**Step 2: Run** `npx vitest run test/dialing-window.test.tsx` — FAIL, module missing.

**Step 3: Implement `lib/dialing-window.ts`.** Pure, no React, so the rules are
testable without a DOM and cannot drift into the component.

```ts
export const PRESETS = [
  { label: 'Business hours 9–6', from: '09:00', to: '18:00' },
  { label: 'Extended 8–9', from: '08:00', to: '21:00' },
  { label: 'All day', from: '00:00', to: '23:30' },
] as const;
```

`windowSummary` resolves the short zone name with
`Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'short' })` inside a
try/catch — an unknown zone must degrade to the IANA id, never throw a form away.

**Step 4: Run** — PASS. **Step 5:** Commit the helpers.

**Step 6–9:** Repeat the cycle for the component: render tests for the preset
buttons writing both ends, Clear emptying both, the off-step value staying
selected, the error text appearing and being tied to the card with
`aria-describedby`, and the summary line updating. `disabled` flows from one
`canEdit` prop, never a second gate.

Commit: `feat: rebuild the dialing window as one control`.

---

### Task B3: The timezone seed

**Files:** Modify `app/(dash)/campaigns/[id]/overview-tab.tsx`; test in
`test/dialing-window.test.tsx`.

**Step 1: Write the failing tests** — with `campaign.timezone` null and a
campaigns list whose most recently updated timezone-bearing campaign says
`Asia/Dubai`, the select shows `Asia/Dubai`; with no such campaign, `Asia/Kolkata`;
with the list request failing, `Asia/Kolkata` and no visible error; with
`campaign.timezone` set, the stored value regardless of the list.

**Step 2–4:** Implement `seedTimezone(campaigns)` in `lib/dialing-window.ts` and
call it from a second `useEffect` in the overview tab, behind the same
`isCurrent()` workspace guard the agents load already uses — a request spanning a
workspace switch must not paint another workspace's answer. The seed applies
**only** when `campaign.timezone` is null, and is a form default, not a write.

**Step 5:** Commit — `feat: seed a campaign's timezone from the workspace's last choice`.

---

### Task B4: The phone number picker

**Files:**
- Create: `components/campaigns/phone-number-picker.tsx`
- Modify: `app/(dash)/campaigns/[id]/overview-tab.tsx`
- Test: `test/campaign-phone-picker.test.tsx`

**Step 1: Write the failing tests** — the four states (options / none rented with
a link to `/settings/phone-numbers` / load failed with a Retry / unavailable in
the danger colour showing the raw id); `PAST_DUE` offered and labelled, pool and
released numbers not offered; `Not set` first; a `StatusPill` beside the control
for a `PAST_DUE` selection; disabled under `canEdit === false`.

**Step 2–4:** Implement. A native `<select>` styled with the existing
`selectClass`. Options filtered with the same held-status rule the backend holds,
stated once in this file. Load from
`GET /api/workspaces/:id/phone-numbers` in the overview tab with the same
`loadAgents`-shaped guarded callback, and a failure reported **inside the field**
only.

**Step 5:** Commit — `feat: choose the number a campaign dials from`.

---

### Task B5: List column and detail header

**Files:**
- Create: `components/campaigns/phone-cell.tsx`
- Modify: `app/(dash)/campaigns/page.tsx`, `app/(dash)/campaigns/[id]/page.tsx`
- Test: `test/campaign-phone-cell.test.tsx`

Mirror `agent-cell.tsx` exactly, including the four-state `phoneState()` with its
`unknown` case for an API that omits the field. Tests cover all four. Add a
**Number** column to the campaigns table and the DID to the detail header's meta
line.

Commit: `feat: show the caller number on the campaign list and header`.

---

### Task B6: Dashboard gates

**Step 1:** `npx tsc --noEmit` — clean.
**Step 2:** `npm test` — whole suite green.
**Step 3:** `npm run build` — Next build succeeds.
**Step 4:** Update `CLAUDE.md`: the rebuilt dialing window (why native selects
here and a listbox for agents), the timezone seed and where it comes from, the
phone-number field and its four states, and the new list column.
**Step 5:** `git merge origin/main`, re-run all three gates.
**Step 6:** Commit, push, `gh pr create --base main`. Do not merge.

---

## Verification checklist

- [ ] Migration SQL shown and approved before anything ran
- [ ] No existing migration edited or re-dated
- [ ] `TEST_DATABASE_URL` only; the Neon guard in `test/setup.ts` and
      `scripts/test-prepare.mjs` untouched
- [ ] No Vocobase call added in either repo — `grep -ri vocobase` on the diff
      returns nothing but prose
- [ ] Backend: `tsc --noEmit` + `npm test`
- [ ] Dashboard: `tsc --noEmit` + `npm test` + `npm run build`
- [ ] Both PRs open against `main`, neither merged
- [ ] No reference-repo mention in any committed file
