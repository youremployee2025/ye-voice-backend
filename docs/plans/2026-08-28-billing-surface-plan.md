# Customer Billing Surface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the customer-facing billing page — balance, upcoming renewals with a shortfall warning, and a filtered paginated transaction history — across `ye-voice-backend` and `ye-voice-dashboard`, as described in `2026-08-28-billing-surface-design.md`.

**Architecture:** One additive migration adding two nullable text columns this slice only ever reads. `GET /api/workspaces/:id/billing` keeps its existing fields and gains a 30-day renewal projection computed in BigInt beside the balance. A sibling `GET /api/workspaces/:id/billing/transactions` serves the ledger, offset-paginated and filterable by type and date range, over a widened `where` that adds the owner's `ADJUSTMENT` grants to this workspace's DID rows. The dashboard adds an ADMIN-only `/settings/billing` whose three panels each own their loading and error state.

**Tech Stack:** Express 4, TypeScript, Prisma 6, Zod 4, Vitest + Supertest (backend). Next.js 15 App Router, React 19, Tailwind 4, Vitest + Testing Library (dashboard).

**Ports:** backend worktree dev on **:3015**, dashboard worktree dev on **:3016**. Both `.env` files in this worktree are already set to these and to this worktree's own dev and test databases.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, which `test/setup.ts` asserts is set and is not a hosted host. That guard stays exactly as written — if it trips, fix the environment, never the guard. Migrations reach the test DB through `npm run test:prepare` (`prisma migrate deploy`), never `prisma migrate reset`. Nothing in this slice runs against `PROD_DATABASE_URL`.

**Safety:** This slice makes **no Vocobase call at all**. No test, no route, no service in it touches `src/adapter/vocobase.ts`. If a task seems to need one, the task is wrong.

**Rules that apply to every task:**

1. **Credit values never become JavaScript numbers.** They are BigInt internally and decimal strings on the wire, through `toDisplayCredits` / `toInternalCredits` in `src/lib/credits.ts`, which stays the only place the multiplier appears.
2. **This slice writes no credit transaction and moves no balance.** `src/services/didRental.ts` remains the only module that moves credits. Every route here is a read.
3. **Never fabricate a number.** A value that cannot be derived truthfully is absent from the payload, not zero and not null-with-a-guess. This applies especially to `balance_after`, which is deliberately not emitted.
4. Every route is `requireAuth` + `requireMembership('ADMIN')`. A MEMBER gets 403 from the middleware, and the dashboard's hidden nav entry is UX, never enforcement.
5. Small commits — one migration, one library, one route, one component group per commit.

---

## Backend

### Task 1: The two columns

**Files:**
- Modify: `prisma/schema.prisma` (`model CreditTransaction`)
- Create: `prisma/migrations/<timestamp>_credit_transaction_note/migration.sql`

**Step 1: Declare the columns**

In `model CreditTransaction`, directly after the `type` field, add:

```prisma
  /// Why this row exists, in a human's words. Written by the staff grant
  /// endpoint; this slice only reads it. Null on every DID row — a rental
  /// charge carries `phoneNumberId`, and the number itself says more than a
  /// sentence assembled around it would.
  note      String?
  /// An external identifier for the movement — an invoice or payment
  /// reference. Also staff-written, also read-only here.
  reference String?
```

**Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name credit_transaction_note --create-only`

Expected: a new `prisma/migrations/<timestamp>_credit_transaction_note/migration.sql` containing two `ALTER TABLE "CreditTransaction" ADD COLUMN` statements. Nothing is applied yet.

**Step 3: Make the migration idempotent by hand**

Replace the generated file's contents with:

```sql
-- Two nullable columns this slice only reads. The staff grant endpoint writes
-- them; a customer reading "+500 · ADJUSTMENT" otherwise learns the number and
-- nothing about why it arrived.
--
-- IF NOT EXISTS is deliberate and is not Prisma's own output. The admin-console
-- slice is in flight and adds the same two columns for its writer; whichever
-- migration lands second would fail on a duplicate column, at deploy time.
-- Two migrations that each ensure the same additive shape are safe in either
-- order.
--
-- Nullable, no default, no backfill: this rewrites no rows and takes no long
-- lock on a populated table.
ALTER TABLE "CreditTransaction" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "CreditTransaction" ADD COLUMN IF NOT EXISTS "reference" TEXT;
```

**Step 4: Apply to the worktree's dev DB and regenerate the client**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: "All migrations have been successfully applied."

**Step 5: Apply to the test DB**

Run: `npm run test:prepare`
Expected: the same, against `TEST_DATABASE_URL`.

**Step 6: Verify nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: tsc silent; 422 tests pass, as before.

**Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: record why a credit movement happened"
```

---

### Task 2: Offset pagination

**Files:**
- Create: `src/lib/pagination.ts`
- Test: `test/pagination.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { paginated, parsePagination } from '../src/lib/pagination.js';

describe('parsePagination', () => {
  it('defaults to the first page', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 25, skip: 0, take: 25 });
  });

  it('turns a page number into an offset', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({
      page: 3,
      limit: 10,
      skip: 20,
      take: 10,
    });
  });

  // Refusing beats falling back: page 1's rows under page 4's heading is a
  // listing that quietly shows the wrong data, which is worse than an error.
  it.each(['0', '-1', 'x', '1.5', ''])('refuses page=%s', (page) => {
    expect(() => parsePagination({ page })).toThrow(ApiError);
  });

  // Clamped, not refused: asking for more than the cap is a reasonable thing
  // to want, and the cap is ours to enforce rather than theirs to guess.
  it('clamps an oversized limit', () => {
    expect(parsePagination({ limit: '5000' }).limit).toBe(100);
  });

  it('reports the total alongside the page', () => {
    const page = paginated(['a'], 63, parsePagination({ page: '2', limit: '25' }));
    expect(page).toEqual({ items: ['a'], page: 2, limit: 25, total: 63 });
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/pagination.test.ts`
Expected: FAIL — cannot resolve `../src/lib/pagination.js`.

**Step 3: Write the implementation**

Create `src/lib/pagination.ts`:

```ts
import { ApiError } from './errors.js';

/**
 * Offset pagination for listings with filters.
 *
 * Offsets rather than cursors, deliberately. A cursor is the better tool for
 * an append-only feed walked forwards, but this serves a filterable table: a
 * reader changing the type filter expects page 1 of the new result set, and a
 * cursor names a row that may not be in that set at all. So a cursor API makes
 * the client reset on every filter change anyway, while still not knowing how
 * many pages there are.
 *
 * The cost is drift under concurrent inserts. Here the inserts are a
 * customer's own rentals and an hourly sweep, so the worst case is one row
 * appearing twice across a page step, on a history that is read and not acted
 * upon.
 */

const DEFAULT_LIMIT = 25;

/** One page must not be able to ask for the whole ledger. */
const MAX_LIMIT = 100;

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

/**
 * A whole number >= 1, or the fallback when the parameter is absent.
 *
 * Bad input throws rather than falling back. Ignoring `?page=x` would answer
 * page 1's rows under page x's heading, and a listing that quietly shows the
 * wrong rows is worse than one that refuses.
 */
function positive(name: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;

  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a whole number of at least 1.`);
  }

  const value = Number(raw.trim());

  if (value < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a whole number of at least 1.`);
  }

  return value;
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = positive('page', query.page, 1);
  const limit = Math.min(positive('limit', query.limit, DEFAULT_LIMIT), MAX_LIMIT);

  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function paginated<T>(items: T[], total: number, { page, limit }: Pagination): Page<T> {
  return { items, page, limit, total };
}
```

**Step 4: Run the test**

Run: `npx vitest run test/pagination.test.ts`
Expected: PASS, 5 tests.

**Step 5: Commit**

```bash
git add src/lib/pagination.ts test/pagination.test.ts
git commit -m "feat: add offset pagination for filtered listings"
```

> **Merge note:** the in-flight admin-console slice adds this same file for its staff listings. The contract here — `{ page, limit, skip, take }` and `paginated()` — is chosen to match it, so a merge that keeps either copy leaves both callers working. Do not rename these fields.

---

### Task 3: The 30-day renewal projection

**Files:**
- Create: `src/services/billingProjection.ts`
- Test: `test/billing-projection.test.ts`

This is the arithmetic behind the shortfall warning. It is a pure-ish read: it queries DIDs and sums prices, and writes nothing.

**Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { projectUpcomingRenewals } from '../src/services/billingProjection.js';
import { toInternalCredits } from '../src/lib/credits.js';
import { createAccount, createWorkspace, truncateAll } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('projectUpcomingRenewals', () => {
  beforeEach(truncateAll);

  async function did(workspaceId: string | null, over: Record<string, unknown> = {}) {
    return prisma.phoneNumber.create({
      data: {
        did: `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`,
        status: workspaceId ? 'ASSIGNED' : 'UNASSIGNED',
        workspaceId,
        rentedPriceCredits: toInternalCredits('500'),
        nextRenewalAt: new Date(Date.now() + 10 * DAY),
        ...over,
      },
    });
  }

  it('sums the numbers renewing inside the window', async () => {
    const owner = await createAccount();
    const workspace = await createWorkspace(owner.id);
    await did(workspace.id);
    await did(workspace.id);

    const result = await projectUpcomingRenewals(workspace.id, toInternalCredits('2000'));

    expect(result.renewalCount).toBe(2);
    expect(result.totalCredits).toBe(toInternalCredits('1000'));
    expect(result.covers).toBe(true);
    expect(result.shortfallCredits).toBeNull();
  });

  it('reports the shortfall when the balance will not cover it', async () => {
    const owner = await createAccount();
    const workspace = await createWorkspace(owner.id);
    await did(workspace.id);
    await did(workspace.id);

    const result = await projectUpcomingRenewals(workspace.id, toInternalCredits('800'));

    expect(result.covers).toBe(false);
    expect(result.shortfallCredits).toBe(toInternalCredits('200'));
  });

  it('ignores a renewal beyond the window', async () => {
    const owner = await createAccount();
    const workspace = await createWorkspace(owner.id);
    await did(workspace.id, { nextRenewalAt: new Date(Date.now() + 45 * DAY) });

    const result = await projectUpcomingRenewals(workspace.id, toInternalCredits('0'));

    expect(result.renewalCount).toBe(0);
    expect(result.totalCredits).toBe(0n);
    expect(result.covers).toBe(true);
  });

  // A declined charge does not move `nextRenewalAt` — that is what makes the
  // sweep retry the same month — so a PAST_DUE number is already in the window
  // by date. It is also the strongest evidence the balance is short, so
  // excluding it would drop the one case this warning exists for.
  it('includes a past-due number', async () => {
    const owner = await createAccount();
    const workspace = await createWorkspace(owner.id);
    await did(workspace.id, { status: 'PAST_DUE', pastDueSince: new Date() });

    const result = await projectUpcomingRenewals(workspace.id, toInternalCredits('0'));

    expect(result.renewalCount).toBe(1);
    expect(result.covers).toBe(false);
  });

  // Folding an unknown date into a total would present a guess as a sum.
  it('counts a number with no renewal date separately instead of guessing', async () => {
    const owner = await createAccount();
    const workspace = await createWorkspace(owner.id);
    await did(workspace.id, { nextRenewalAt: null });

    const result = await projectUpcomingRenewals(workspace.id, toInternalCredits('0'));

    expect(result.renewalCount).toBe(0);
    expect(result.unscheduledCount).toBe(1);
    expect(result.totalCredits).toBe(0n);
  });

  it('charges the agreed price, not the catalog price', async () => {
    const owner = await createAccount();
    const workspace = await createWorkspace(owner.id);
    await did(workspace.id, {
      rentedPriceCredits: toInternalCredits('300'),
      monthlyPriceCredits: toInternalCredits('900'),
    });

    const result = await projectUpcomingRenewals(workspace.id, toInternalCredits('0'));

    expect(result.totalCredits).toBe(toInternalCredits('300'));
  });

  it('does not count another workspace\'s numbers', async () => {
    const owner = await createAccount();
    const mine = await createWorkspace(owner.id);
    const theirs = await createWorkspace(owner.id);
    await did(theirs.id);

    const result = await projectUpcomingRenewals(mine.id, toInternalCredits('0'));

    expect(result.renewalCount).toBe(0);
  });
});
```

Check `test/helpers.ts` for the real names of the account/workspace factories and the truncate helper before writing this — use whatever it already exports rather than adding new ones.

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/billing-projection.test.ts`
Expected: FAIL — cannot resolve `../src/services/billingProjection.js`.

**Step 3: Write the implementation**

Create `src/services/billingProjection.ts`:

```ts
import { prisma } from '../lib/prisma.js';
import { chargePriceOf } from './didRental.js';

/**
 * What this workspace's DIDs will cost over the next 30 days, against the
 * balance that has to cover it.
 *
 * Computed here rather than in the browser for three reasons, in order of
 * weight: it is a money claim, and both "you are short" to somebody who is not
 * and silence for somebody who is are damaging, so it belongs where it can be
 * tested against a database; it is the same sum the renewal sweep will actually
 * perform, so it should not exist twice; and doing it client-side means adding
 * credit strings in JavaScript, which this codebase does not do.
 *
 * Reads only. Nothing here moves a balance or writes a ledger row.
 */

/** Fixed in this slice, and reported in the payload so the dashboard never has
 *  to assume it. Widening it later must not silently relabel the number. */
export const PROJECTION_WINDOW_DAYS = 30;

export interface UpcomingRenewals {
  windowDays: number;
  /** Numbers with a renewal date inside the window. */
  renewalCount: number;
  /** Held numbers with no `nextRenewalAt` at all — staff assigned one without
   *  starting a cycle, or the row predates the column. Reported rather than
   *  folded into the total, because we do not know when they will be billed. */
  unscheduledCount: number;
  totalCredits: bigint;
  covers: boolean;
  /** Only when `covers` is false. */
  shortfallCredits: bigint | null;
}

export async function projectUpcomingRenewals(
  workspaceId: string,
  balance: bigint,
  now: Date = new Date(),
): Promise<UpcomingRenewals> {
  const horizon = new Date(now.getTime() + PROJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Both prices are selected because `chargePriceOf` needs the snapshot with
  // the catalog price behind it; the whole row is cheaper to reason about than
  // a partial select that drifts from that helper's signature.
  const held = await prisma.phoneNumber.findMany({ where: { workspaceId } });

  let total = 0n;
  let renewalCount = 0;
  let unscheduledCount = 0;

  for (const number of held) {
    if (number.nextRenewalAt === null) {
      unscheduledCount += 1;
      continue;
    }

    // A renewal already past due is inside every window: its date did not move
    // when the charge was declined, which is what makes the sweep retry it.
    if (number.nextRenewalAt > horizon) continue;

    renewalCount += 1;
    total += chargePriceOf(number);
  }

  const covers = balance >= total;

  return {
    windowDays: PROJECTION_WINDOW_DAYS,
    renewalCount,
    unscheduledCount,
    totalCredits: total,
    covers,
    shortfallCredits: covers ? null : total - balance,
  };
}
```

**Step 4: Run the test**

Run: `npx vitest run test/billing-projection.test.ts`
Expected: PASS, 7 tests.

**Step 5: Commit**

```bash
git add src/services/billingProjection.ts test/billing-projection.test.ts
git commit -m "feat: project the next thirty days of rental renewals"
```

---

### Task 4: The billing summary gains the projection

**Files:**
- Modify: `src/routes/phoneNumbers.routes.ts` (the `/:workspaceId/billing` handler)
- Test: `test/billing.test.ts` (create)

**Step 1: Write the failing test**

Create `test/billing.test.ts` — model the request setup on `test/phone-numbers.test.ts`, which already builds an authenticated ADMIN and MEMBER against `createApp()`.

```ts
describe('GET /api/workspaces/:id/billing', () => {
  it('answers the owner balance, not the caller\'s', async () => {
    // owner has 1000, the ADMIN calling has 5
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing`);
    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe('1000');
    expect(res.body.data.owner_account_id).toBe(owner.id);
  });

  it('reports the upcoming window and whether the balance covers it', async () => {
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing`);
    expect(res.body.data.upcoming).toEqual({
      window_days: 30,
      renewal_count: 2,
      unscheduled_count: 0,
      total_credits: '1000',
      covers: true,
      shortfall_credits: null,
    });
  });

  it('names the shortfall when the balance will not cover the window', async () => {
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing`);
    expect(res.body.data.upcoming.covers).toBe(false);
    expect(res.body.data.upcoming.shortfall_credits).toBe('200');
  });

  // The phone-numbers page calls this with ?limit=1 for the balance alone.
  it('keeps answering the existing ledger fields', async () => {
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing?limit=1`);
    expect(res.body.data.ledger).toHaveLength(1);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('refuses a MEMBER', async () => {
    const res = await asMember.get(`/api/workspaces/${workspace.id}/billing`);
    expect(res.status).toBe(403);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/billing.test.ts`
Expected: FAIL — `upcoming` is undefined, `owner_account_id` is undefined.

**Step 3: Add the projection to the handler**

In the `/:workspaceId/billing` handler, after the existing `Promise.all` resolves `owner` and `rows`, call `projectUpcomingRenewals(workspace.id, owner.credits)` and add to `data`:

```ts
        /** Whose balance this is. An ADMIN who is not the owner is being shown
         *  somebody else's number and the payload should say so rather than
         *  leaving the dashboard to infer it. */
        owner_account_id: workspace.ownerAccountId,
        upcoming: {
          window_days: upcoming.windowDays,
          renewal_count: upcoming.renewalCount,
          unscheduled_count: upcoming.unscheduledCount,
          total_credits: toDisplayCredits(upcoming.totalCredits),
          covers: upcoming.covers,
          shortfall_credits:
            upcoming.shortfallCredits === null
              ? null
              : toDisplayCredits(upcoming.shortfallCredits),
        },
```

Leave `balance`, `ledger` and `nextCursor` exactly as they are, and add a comment above them recording that `ledger`/`nextCursor` are superseded by `/billing/transactions` and stay only until nothing reads them.

**Step 4: Run the test**

Run: `npx vitest run test/billing.test.ts`
Expected: PASS.

**Step 5: Verify the phone-numbers page's call is untouched**

Run: `npx vitest run test/phone-numbers.test.ts`
Expected: PASS, unchanged.

**Step 6: Commit**

```bash
git add src/routes/phoneNumbers.routes.ts test/billing.test.ts
git commit -m "feat: report the coming month's renewals beside the balance"
```

---

### Task 5: The transactions route

**Files:**
- Modify: `src/routes/phoneNumbers.routes.ts` (add the sibling route)
- Modify: `src/lib/serialize.ts` (`serializeLedgerRow` gains `note` and `reference`)
- Test: `test/billing-transactions.test.ts`

**Step 1: Write the failing test**

```ts
describe('GET /api/workspaces/:id/billing/transactions', () => {
  it('returns this workspace\'s DID rows newest first', async () => { /* ... */ });

  // The second arm of the disjunction. Without it a customer sees every charge
  // and never the top-up that paid for them.
  it('includes ADJUSTMENT grants on the owner\'s account', async () => {
    // grant written with accountId = owner.id and NO workspaceId
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing/transactions`);
    expect(res.body.data.items.map((r) => r.type)).toContain('ADJUSTMENT');
  });

  it('does not include another workspace\'s DID charges', async () => { /* ... */ });

  // The whitelist. A future Account-scoped row of another type must not become
  // customer-visible without somebody deciding it should.
  it('does not include a non-ADJUSTMENT row that carries no workspace', async () => { /* ... */ });

  it('carries the note and reference a grant was written with', async () => {
    expect(row).toMatchObject({ note: 'Q3 top-up', reference: 'INV-2026-114' });
  });

  it('leaves note null on a DID charge and names the number instead', async () => {
    expect(row.note).toBeNull();
    expect(row.phone_number.did).toBe('+14155550100');
  });

  // Never fabricated. See the design doc.
  it('emits no balance_after', async () => {
    expect(row).not.toHaveProperty('balance_after');
  });

  it('paginates with a total', async () => {
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing/transactions?page=2&limit=2`);
    expect(res.body.data).toMatchObject({ page: 2, limit: 2, total: 5 });
    expect(res.body.data.items).toHaveLength(2);
  });

  it('filters by type', async () => { /* ?type=DID_RENEWAL */ });

  // An unknown type must not answer an empty page: that is indistinguishable
  // from a workspace with no history.
  it('refuses an unknown type', async () => {
    const res = await asAdmin.get(`/api/workspaces/${workspace.id}/billing/transactions?type=NONSENSE`);
    expect(res.status).toBe(400);
  });

  it('filters by date range', async () => { /* ?from=&to= */ });

  // A naive `lte` on midnight drops the named day's rows entirely.
  it('includes the whole of the day named by `to`', async () => {
    // a row at 23:30 UTC on the `to` date is present
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await asAdmin.get(`.../transactions?from=2026-05-01&to=2026-04-01`);
    expect(res.status).toBe(400);
  });

  it('refuses a MEMBER', async () => { /* 403 */ });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/billing-transactions.test.ts`
Expected: FAIL — 404 on the route.

**Step 3: Widen the serializer**

In `serializeLedgerRow`, add after `created_at`:

```ts
    /** Why this movement happened, in a human's words — staff-written on a
     *  grant, and null on every DID row, where the number below says more. */
    note: row.note,
    /** An external identifier for the movement: an invoice or payment ref. */
    reference: row.reference,
```

Deliberately no `balance_after`: see `docs/plans/2026-08-28-billing-surface-design.md`. Record that in a comment on the function so the next person does not add one.

**Step 4: Write the route**

Register it in `src/routes/phoneNumbers.routes.ts` **before** nothing in particular — `/billing/transactions` cannot collide with `/billing`, since Express matches the full path — but keep it directly beneath `/billing` so the pair reads together.

```ts
const transactionFilterSchema = z.object({
  type: z.enum([
    'DID_PURCHASE',
    'DID_RENEWAL',
    'DID_RELEASE',
    'DID_RELEASE_NONPAYMENT',
    'ADJUSTMENT',
  ]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
```

Handler shape:

```ts
phoneNumberRoutes.get(
  '/:workspaceId/billing/transactions',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { type, from, to } = parseBody(transactionFilterSchema, {
      type: req.query.type,
      from: req.query.from,
      to: req.query.to,
    });

    // Always a mistake, and an empty table would read as "no history in this
    // period", which is a different claim from "that range is backwards".
    if (from && to && from > to) {
      throw new ApiError(400, 'VALIDATION_ERROR', '`from` must not be after `to`.');
    }

    // `to` names a whole day. A bare `lte` on its midnight silently drops
    // every row from the day the reader asked for.
    const until = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;

    const where = {
      // This workspace's own charges, plus the grants that funded them. A
      // grant credits an Account and carries no workspaceId, so the first arm
      // alone shows a customer every charge and never the top-up that paid for
      // it — a history that cannot add up to the balance printed above it.
      //
      // `type: 'ADJUSTMENT'` is a whitelist, not a shorthand: a future
      // Account-scoped row of some other type does not become customer-visible
      // by default.
      OR: [
        { workspaceId: workspace.id },
        { accountId: workspace.ownerAccountId, type: 'ADJUSTMENT' as const },
      ],
      ...(type ? { type } : {}),
      ...(from || until
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(until ? { lte: until } : {}) } }
        : {}),
    };

    // One round trip each, in parallel: the page and the count it is a page of.
    const [rows, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        include: { phoneNumber: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.creditTransaction.count({ where }),
    ]);

    res.json({ success: true, data: paginated(rows.map(serializeLedgerRow), total, pagination) });
  }),
);
```

Note the secondary sort on `id`. Rows written in the same transaction share a `createdAt` to the millisecond, and an unstable sort under offset pagination shows the same row on two pages.

**Step 5: Run the test**

Run: `npx vitest run test/billing-transactions.test.ts`
Expected: PASS.

**Step 6: Full suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc silent; everything green.

**Step 7: Commit**

```bash
git add src/routes/phoneNumbers.routes.ts src/lib/serialize.ts test/billing-transactions.test.ts
git commit -m "feat: add the workspace transaction history with filters"
```

---

### Task 6: Document it

**Files:**
- Modify: `CLAUDE.md` (the "Phone numbers & credits" route table and a new billing paragraph)

Add the two routes to the table, and a short section stating: the ledger's disjunction and why; that `balance_after` is deliberately absent; that `note`/`reference` are read here and written by the staff endpoint; and that the projection includes `PAST_DUE` and reports unscheduled numbers separately.

**Commit:**

```bash
git add CLAUDE.md
git commit -m "docs: describe the customer billing surface"
```

---

## Dashboard

Work in `.worktrees/billing-surface/ye-voice-dashboard`, branch `feat/billing-surface`. Dev server on **:3016** (`npx next dev -p 3016` — do not change the `dev` script, which other worktrees share).

### Task 7: Types and credit arithmetic

**Files:**
- Modify: `lib/types.ts`
- Create: `lib/credits.ts`
- Test: `test/credits.test.ts`

**Step 1: The types**

Extend `LedgerRow` with `note: string | null` and `reference: string | null`. Add:

```ts
/** What the next 30 days of rentals will cost, and whether the balance covers
 *  it. Computed by the backend: this is a money claim, and summing credit
 *  strings in the browser is the thing this app does not do. */
export interface UpcomingRenewals {
  window_days: number;
  renewal_count: number;
  /** Held numbers with no renewal date. Counted, never folded into the total —
   *  we do not know when they will be billed. */
  unscheduled_count: number;
  total_credits: string;
  covers: boolean;
  /** Only when `covers` is false. */
  shortfall_credits: string | null;
}

export interface TransactionPage {
  items: LedgerRow[];
  page: number;
  limit: number;
  total: number;
}
```

Extend `WorkspaceBilling` with `owner_account_id: string` and `upcoming: UpcomingRenewals`, and mark `ledger` / `nextCursor` as superseded by `/billing/transactions`.

**Step 2: The credit helpers, test first**

`app/(dash)/settings/phone-numbers/available-tab.tsx` already compares credits in integer units by hand. This slice needs to format and sign them in two more places, so the rule moves to one file rather than a third copy.

```ts
// test/credits.test.ts
describe('formatCredits', () => {
  it('keeps the string the backend sent', () => {
    expect(formatCredits('1234.5')).toBe('1,234.5');
  });
  it('never parses through Number', () => {
    // 20 digits: a float would round this and print a different balance
    expect(formatCredits('12345678901234567890')).toBe('12,345,678,901,234,567,890');
  });
  it('renders a signed charge with its sign', () => {
    expect(signedCredits('-500')).toBe('−500');
  });
});

describe('compareCredits', () => {
  it('orders by value, not lexically', () => {
    expect(compareCredits('9', '10')).toBeLessThan(0);
  });
  it('handles fractions of differing length', () => {
    expect(compareCredits('1.5', '1.50')).toBe(0);
  });
});
```

Implement in `lib/credits.ts` by grouping the integer part with a regex and comparing padded fraction strings — never `Number()`, never `parseFloat`. Then change `available-tab.tsx` to use `compareCredits` instead of its inline comparison, and delete the inline version.

**Step 3: Run**

Run: `npx vitest run test/credits.test.ts`
Expected: PASS.

**Step 4: Commit**

```bash
git add lib/types.ts lib/credits.ts test/credits.test.ts "app/(dash)/settings/phone-numbers/available-tab.tsx"
git commit -m "feat: add billing types and one place to compare credit amounts"
```

---

### Task 8: The nav entry, ADMIN only

**Files:**
- Modify: `components/shell/sidebar.tsx`
- Test: `test/sidebar-billing-gate.test.tsx`

**Step 1: Write the failing test**

```tsx
it('shows Billing to an ADMIN', () => { /* role: 'ADMIN' → link present */ });
it('hides Billing from a MEMBER', () => { /* role: 'MEMBER' → link absent */ });
it('still shows Members and Phone numbers to a MEMBER', () => { /* both present */ });
```

The third assertion is the point of the test: this is the first entry in `SETTINGS_NAV` that is hidden, and the existing comment says both are shown to everyone. Changing that comment without a test guarding the other two invites somebody to gate them next.

**Step 2: Implement**

Give `SETTINGS_NAV` entries an optional `adminOnly` flag, set it on Billing, and filter on `activeWorkspace?.role === 'ADMIN'`. Rewrite the comment above the array to say which entries are gated and why — the page is entirely ADMIN, so the link would lead only to a 403, unlike phone numbers where a MEMBER can read the page.

**Step 3: Run, then commit**

```bash
git add components/shell/sidebar.tsx test/sidebar-billing-gate.test.tsx
git commit -m "feat: gate the billing nav entry to admins"
```

---

### Task 9: The billing page

**Files:**
- Create: `app/(dash)/settings/billing/page.tsx`
- Create: `app/(dash)/settings/billing/balance-card.tsx`
- Create: `app/(dash)/settings/billing/upcoming-charges.tsx`
- Create: `app/(dash)/settings/billing/transactions-table.tsx`
- Create: `app/(dash)/settings/billing/type-badge.tsx`
- Test: `test/billing-page.test.tsx`

Model the page's structure on `app/(dash)/settings/phone-numbers/page.tsx`: `'use client'`, `useWorkspace`, `useApi`, the `activeWorkspaceRef` currency guard read at every await boundary, and loading / empty / error as three separate renderings.

**The three panels load independently.** The balance summary, the owned numbers (for upcoming charges) and the transactions page are three requests, and a failure in one must not blank the others — this is the lesson the phone-numbers page already learned when billing shared a `Promise.all` with the number lists. The transactions request re-runs on a filter or page change; the other two do not.

**Step 1: Write the failing tests**

```tsx
it('shows the balance labelled as the owner\'s', () => { /* copy names the owner */ });
it('warns above the table when the balance will not cover the window', () => { /* ... */ });
it('says nothing about a shortfall when covers is true', () => { /* ... */ });
it('names the numbers with no scheduled renewal rather than hiding them', () => { /* ... */ });
it('renders a charge with its sign and a word, not colour alone', () => { /* ... */ });
it('shows an empty history as empty, not as an error', () => { /* ... */ });
it('offers a retry when the transactions request fails, and keeps the balance card', () => { /* ... */ });
it('refetches when the type filter changes and resets to page 1', () => { /* ... */ });
it('renders a refusal, not a spinner, for a MEMBER who types the URL', () => { /* ... */ });
```

**Step 2: Run and watch them fail**, then build the components:

- **`balance-card.tsx`** — the balance in display credits through `formatCredits`, the words "workspace owner's balance", and a `mailto:` support link reading "Contact us to add credits". Text and a link. **No button, not even a disabled one** — a greyed-out purchase control promises something that is not coming this wave, the rule the agents surface set. The support address comes from `NEXT_PUBLIC_SUPPORT_EMAIL` with a documented fallback; if it is unset the card says who to contact in words rather than rendering a `mailto:` to nowhere.
- **`upcoming-charges.tsx`** — the DIDs renewing in the window from `GET /phone-numbers` (rows with a `next_renewal_at`, soonest first), each with its date and its agreed price, and the total from `upcoming.total_credits`. When `covers` is false, a `role="alert"` panel **above** the table naming `shortfall_credits` and what happens if it is not resolved (the number stays and keeps ringing through the grace window, then is released) — a reader who scrolls past has missed the only thing on the page that needs an action. When `unscheduled_count > 0`, one line saying how many numbers have no scheduled renewal and that their cost is not in the total.
- **`transactions-table.tsx`** — date, type badge, signed amount, and a reference column showing `note` when present, else the DID when present, else `—`. Below it: page controls reading "Showing 1–25 of 63", and the one-line note that this history covers this workspace's charges against an account-wide balance, so the balance can move for reasons not listed here. **No running-balance column** — add a comment in the file saying it is absent because it cannot be derived from a filtered subset without inventing a number.
- **`type-badge.tsx`** — following `components/ui/status-pill.tsx` exactly: the label is always text, colour only reinforces, and an unrecognised type renders humanised in neutral styling rather than being forced into a known bucket.

Filters are `?type=` and `?from=`/`?to=` in the URL via `useSearchParams`, so a filtered view is addressable and the back button behaves — the pattern the tabs on the other settings pages use. A filter change resets to page 1.

**Step 3: Run the tests**

Run: `npx vitest run test/billing-page.test.tsx`
Expected: PASS.

**Step 4: Commit**

```bash
git add "app/(dash)/settings/billing" test/billing-page.test.tsx
git commit -m "feat: add the workspace billing page"
```

---

### Task 10: Error copy

**Files:**
- Modify: `lib/errors.ts`

`CURATED.NOT_FOUND` currently reads "That number is no longer held by this workspace" — written for the phone-numbers dialog and wrong anywhere else. This page can produce a 404 (a workspace that vanished mid-session). Either scope that copy to where it belongs or leave `NOT_FOUND` to the caller's fallback; do not let the billing page tell somebody their number was reclaimed.

**Commit:**

```bash
git add lib/errors.ts
git commit -m "fix: stop the phone-number wording answering for every 404"
```

---

### Task 11: Document it

**Files:**
- Modify: `CLAUDE.md` (the Pages table, and a Billing section)

Record: the page is ADMIN-only and the nav entry is hidden for MEMBERs, unlike phone numbers; there is no checkout in this wave and deliberately no disabled buy button; the balance is the owner's; the history does not reconcile to the balance and the page says so; there is no running-balance column and why.

**Commit:**

```bash
git add CLAUDE.md
git commit -m "docs: document the billing page"
```

---

## Gates before opening PRs

Both must be green, and must be **run**, not assumed:

```bash
# backend worktree
npx tsc --noEmit && npm test

# dashboard worktree
npx tsc --noEmit && npm run build && npx vitest run
```

Then, in each worktree, merge `origin/main` and keep **both** sides' additions — expected overlap is `src/app.ts`, `lib/api.ts`, `lib/types.ts`, `CLAUDE.md`, and possibly `src/lib/pagination.ts` and the `note`/`reference` migration if the admin-console slice landed first. If it did, drop this slice's duplicate migration rather than keeping two, and re-run the gates after the merge.

Open one PR per repo with `gh pr create --base main`. **Do not merge.**

## Prod database

The migration in Task 1 is the only schema change, it is additive, and it is **not to be applied to production** in this slice. The SQL is in the design doc and in the migration file; it is for review, and it holds until somebody says otherwise.
