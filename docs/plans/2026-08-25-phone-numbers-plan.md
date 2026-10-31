# Phone numbers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a DID inventory, workspace rental with monthly credit billing, an hourly renewal sweep, a credit ledger, and the dashboard surface for all of it — as described in `2026-08-25-phone-numbers-design.md`.

**Architecture:** Two new Prisma models (`PhoneNumber`, `CreditTransaction`) plus three enums. One pure-function library for credits, one for calendar-month arithmetic. A sync service reading a single upstream GET, a rental service holding the money-moving transactions, and a sweep worker started from `server.ts` only. Two route modules (workspace-scoped, staff). Then a dashboard settings page over the workspace routes.

**Tech Stack:** Express 4, TypeScript, Prisma, Zod, Vitest + Supertest (backend). Next.js App Router, TypeScript, Tailwind (dashboard).

**Repos and branches:** both repos, branch `feat/phone-numbers`, worktrees at `ye-voice-agent/.worktrees/phone-numbers/<repo>`.

---

## Rules that apply to every task

**Test safety.** Tests run only against `TEST_DATABASE_URL`; `test/setup.ts` asserts it is set and is not a Neon host. Never point tests at `DATABASE_URL`. Migrations reach the test DB through `npm run test:prepare`, never `prisma migrate reset`.

**Upstream safety.** The partner key is live. The only upstream call this slice may make is `GET /voicelink/dids/purchased`. Never call `dids/map`, `call-ready`, `inbound-ready`, `call-routing`, `bots`, `clients`, or anything under `/calls`. **Every test mocks the adapter with `vi.mock` — no test may make a real network call.**

**Scoping rule.** No query looks a DID up by id alone inside a workspace route. Always `findFirst({ where: { id, workspaceId } })`. The available-pool query is the one exception and returns only number, price, and release reason.

**Money rule.** Every balance change is a conditional write inside a `prisma.$transaction`, paired with a `CreditTransaction` row in the same transaction. Never read-then-write a balance.

**Sync rule.** The sync upsert never writes `workspaceId`, `status`, `monthlyPriceCredits`, `rentedAt`, or `nextRenewalAt`.

**Commit after every task.** One meaningful step per commit, imperative mood, describing the feature as built here.

---

# Part A — Backend (`ye-voice-backend`)

### Task 1: Prisma schema & migration

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Add the enums and models**

Append to `prisma/schema.prisma`:

```prisma
enum PhoneNumberStatus {
  UNASSIGNED
  ASSIGNED
  RELEASED_NONPAYMENT
}

enum CreditTransactionType {
  DID_PURCHASE
  DID_RENEWAL
  /// Zero-amount marker: the workspace gave the number back.
  DID_RELEASE
  /// Zero-amount marker: the renewal charge failed and the number was taken back.
  DID_RELEASE_NONPAYMENT
  /// Staff credit correction. Never written by this slice.
  ADJUSTMENT
}

/// Local inventory of a DID owned by the platform's telephony connection.
/// Provider facts come from sync; tenancy and billing columns are owned by
/// renting and by staff, and sync must never write them.
model PhoneNumber {
  id         String  @id @default(cuid())
  /// E.164, canonicalized on the way in. Globally unique: two rows for one
  /// real-world number is a double rental waiting to happen.
  did        String  @unique
  /// The provider's own DID id, as text. What sync matches on.
  externalId String? @unique
  provider   String?

  countryCode       String?
  numberType        String?
  providerStatus    String?
  /// When the PROVIDER's rental of this DID to us expires. Unrelated to
  /// `nextRenewalAt`, which is our rental to a workspace.
  providerExpiresAt DateTime?
  /// Last provider payload; a display cache for staff, not a source of truth.
  rawProvider       Json?
  lastSyncedAt      DateTime?

  status      PhoneNumberStatus @default(UNASSIGNED)
  workspaceId String?
  /// Null means "use the global default". Never means free.
  monthlyPriceCredits BigInt?
  rentedAt            DateTime?
  nextRenewalAt       DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Restrict, not SetNull: SetNull would leave a row that is ASSIGNED with no
  // workspace — the two fields that must agree, disagreeing, on the record
  // that says who is paying.
  workspace   Workspace?          @relation(fields: [workspaceId], references: [id], onDelete: Restrict)
  ledgerRows  CreditTransaction[]

  @@index([workspaceId])
  @@index([status])
  @@index([status, nextRenewalAt])
}

/// Append-only record of every credit movement.
model CreditTransaction {
  id        String @id @default(cuid())
  accountId String
  /// The workspace the charge was made on behalf of, captured at write time.
  /// A snapshot rather than a join, so a workspace's billing history survives
  /// the DID going back to the pool.
  workspaceId   String?
  phoneNumberId String?

  /// Signed, in internal credit units. Negative is a charge.
  amount BigInt
  type   CreditTransactionType

  createdAt DateTime @default(now())

  account     Account      @relation(fields: [accountId], references: [id], onDelete: Cascade)
  workspace   Workspace?   @relation(fields: [workspaceId], references: [id], onDelete: SetNull)
  phoneNumber PhoneNumber? @relation(fields: [phoneNumberId], references: [id], onDelete: SetNull)

  @@index([accountId, createdAt])
  @@index([workspaceId, createdAt])
  @@index([phoneNumberId])
}
```

**Step 2: Add the back-relations**

On `model Account`, add:

```prisma
  creditTransactions CreditTransaction[]
```

On `model Workspace`, add:

```prisma
  phoneNumbers       PhoneNumber[]
  creditTransactions CreditTransaction[]
```

These emit no SQL of their own; Prisma requires both sides of a relation.

**Step 3: Generate the migration**

```bash
npx prisma migrate dev --name phone_numbers_and_credit_ledger
```

Expected: a new folder under `prisma/migrations/`, additive only — `CREATE TYPE` ×3, `CREATE TABLE` ×2, `CREATE INDEX`, `ALTER TABLE ... ADD CONSTRAINT` for the new foreign keys. **Read the generated SQL and confirm it contains no `ALTER TABLE ... DROP`, no `ALTER COLUMN`, and touches no existing table except to add foreign keys.**

**Step 4: Apply to the test DB and typecheck**

```bash
npm run test:prepare
npx tsc --noEmit
```

Expected: both clean.

**Step 5: Extend the test truncation list**

In `test/setup.ts`, add to `TABLES`, child-first — `CreditTransaction` before `PhoneNumber`, and `PhoneNumber` before `Workspace`:

```ts
const TABLES = [
  'CreditTransaction',
  'CampaignContact',
  'Campaign',
  'Contact',
  'PhoneNumber',
  'Agent',
  'WorkspaceInvite',
  'WorkspaceMember',
  'Workspace',
  'Account',
] as const;
```

**Step 6: Commit**

```bash
git add prisma/ test/setup.ts
git commit -m "feat: add phone number inventory and credit ledger schema"
```

---

### Task 2: Credit units

**Files:**
- Create: `src/lib/credits.ts`
- Test: `test/credits.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toInternalCredits, toDisplayCredits, CREDIT_MULTIPLIER } from '../src/lib/credits.js';

describe('credit units', () => {
  it('scales display credits by the multiplier', () => {
    expect(CREDIT_MULTIPLIER).toBe(10_000n);
    expect(toInternalCredits('1')).toBe(10_000n);
    expect(toInternalCredits('500')).toBe(5_000_000n);
  });

  it('keeps two decimal places exactly', () => {
    expect(toInternalCredits('0.01')).toBe(100n);
    expect(toInternalCredits('12.34')).toBe(123_400n);
  });

  it('rejects more precision than the multiplier can hold', () => {
    expect(() => toInternalCredits('0.001')).toThrow();
  });

  it('rejects values that are not decimal numbers', () => {
    for (const bad of ['', ' ', 'abc', '1e3', '1.2.3', 'NaN', 'Infinity']) {
      expect(() => toInternalCredits(bad)).toThrow();
    }
  });

  it('rejects negative prices', () => {
    expect(() => toInternalCredits('-1')).toThrow();
  });

  it('renders internal credits as a decimal string, never a float', () => {
    expect(toDisplayCredits(10_000n)).toBe('1');
    expect(toDisplayCredits(100n)).toBe('0.01');
    expect(toDisplayCredits(0n)).toBe('0');
    expect(toDisplayCredits(-5_000_000n)).toBe('-500');
    expect(toDisplayCredits(123_400n)).toBe('12.34');
  });

  it('round-trips a very large balance without precision loss', () => {
    const huge = 9_007_199_254_740_993n * 10_000n;
    expect(toInternalCredits(toDisplayCredits(huge))).toBe(huge);
  });
});
```

**Step 2: Run it and confirm it fails**

```bash
npx vitest run test/credits.test.ts
```
Expected: FAIL — cannot resolve `../src/lib/credits.js`.

**Step 3: Implement**

Create `src/lib/credits.ts`. Parse the decimal string by hand — **never through `Number`**: `Number('0.07') * 10000` is `699.9999999999999`, and rounding that is exactly the precision loss the multiplier exists to prevent. Split on `.`, reject more than 4 fractional digits (the multiplier is 10^4), right-pad the fraction to 4 digits, concatenate, and `BigInt` the result. `toDisplayCredits` divides with `BigInt` division, formats the remainder as a zero-padded fraction, and trims trailing zeros — handling the sign explicitly so `-1n` does not render as `-0.-0001`.

Export `CREDIT_MULTIPLIER = 10_000n`.

**Step 4: Run the test**

Expected: PASS, all seven cases.

**Step 5: Commit**

```bash
git add src/lib/credits.ts test/credits.test.ts
git commit -m "feat: add credit unit conversion with exact decimal parsing"
```

---

### Task 3: Calendar-month arithmetic

**Files:**
- Create: `src/lib/billingCycle.ts`
- Test: `test/billing-cycle.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { addOneMonth } from '../src/lib/billingCycle.js';

const iso = (d: Date) => d.toISOString();

describe('addOneMonth', () => {
  it('advances an ordinary date by one month', () => {
    expect(iso(addOneMonth(new Date('2026-03-15T10:30:00.000Z'))))
      .toBe('2026-04-15T10:30:00.000Z');
  });

  it('clamps to the last day when the target month is shorter', () => {
    // setMonth would overflow this to 3 March. A rental that skips a month
    // is a month of free service.
    expect(iso(addOneMonth(new Date('2026-01-31T00:00:00.000Z'))))
      .toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addOneMonth(new Date('2026-03-31T12:00:00.000Z'))))
      .toBe('2026-04-30T12:00:00.000Z');
  });

  it('clamps to 29 February in a leap year', () => {
    expect(iso(addOneMonth(new Date('2028-01-31T00:00:00.000Z'))))
      .toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls the year over from December', () => {
    expect(iso(addOneMonth(new Date('2026-12-31T23:59:00.000Z'))))
      .toBe('2027-01-31T23:59:00.000Z');
  });

  it('preserves the time of day', () => {
    expect(iso(addOneMonth(new Date('2026-05-10T07:08:09.010Z'))))
      .toBe('2026-06-10T07:08:09.010Z');
  });
});
```

**Step 2: Run it and confirm it fails.** Expected: FAIL — module not found.

**Step 3: Implement**

Build the result from UTC components: take year/month/day/time, compute the target year and month, clamp the day to `new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()`, and assemble with `Date.UTC`. UTC throughout — a server that changes timezone must not change a customer's renewal date.

**Step 4: Run the test.** Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/billingCycle.ts test/billing-cycle.test.ts
git commit -m "feat: add day-clamped calendar month arithmetic for renewals"
```

---

### Task 4: Upstream readers and the DID adapter call

**Files:**
- Modify: `src/lib/upstream.ts` (add `readDigits`)
- Modify: `src/adapter/vocobase.ts` (add `listPurchasedDids`, `readDidRows`)
- Modify: `src/lib/env.ts`
- Test: `test/upstream.test.ts` (extend), `test/vocobase-adapter.test.ts` (extend)

**Step 1: Write the failing tests**

Add to `test/upstream.test.ts`:

```ts
describe('readDigits', () => {
  it('reads a string of digits', () => {
    expect(readDigits({ did_number: '919429390403' }, ['did_number'])).toBe('919429390403');
  });

  it('reads a JSON number, which is how the provider sends a DID', () => {
    expect(readDigits({ did_number: 919429390403 }, ['did_number'])).toBe('919429390403');
  });

  it('refuses a non-integer number rather than truncating it', () => {
    expect(readDigits({ id: 1.5 }, ['id'])).toBeNull();
  });

  it('refuses anything that is not all digits', () => {
    expect(readDigits({ n: '+91 94293' }, ['n'])).toBeNull();
    expect(readDigits({ n: '' }, ['n'])).toBeNull();
    expect(readDigits({ n: true }, ['n'])).toBeNull();
    expect(readDigits({}, ['n'])).toBeNull();
  });
});
```

Add to `test/vocobase-adapter.test.ts` — mock `fetch`, never call out:

```ts
it('peels the doubly-nested purchased-DID envelope', async () => {
  mockFetchJson({
    success: true,
    data: { status: true, message: 'Success', data: { data: [{ id: 1 }], last_page: 2 } },
  });
  const page = await listPurchasedDids({ page: 1, perPage: 200 });
  expect(page.rows).toEqual([{ id: 1 }]);
  expect(page.lastPage).toBe(2);
});

it('reports an unrecognised body as no rows rather than throwing', async () => {
  mockFetchJson({ success: true, data: { status: true } });
  const page = await listPurchasedDids({ page: 1, perPage: 200 });
  expect(page.rows).toEqual([]);
});
```

**Step 2: Run them and confirm they fail.**

**Step 3: Implement**

`readDigits(source, keys)` in `src/lib/upstream.ts`: accept a `string` matching `/^\d+$/` after trim, or a `number` that is a finite **integer** (`Number.isSafeInteger`), converted with `String()`. Everything else is `null`. Document that the provider sends `did_number` as a JSON number and that a non-integer must not be truncated into a different phone number.

`listPurchasedDids({ page, perPage })` in `src/adapter/vocobase.ts`: `request('/voicelink/dids/purchased', { page, per_page: perPage })`. Add a `readDidRows(body)` that finds the array at `body.data.data`, then `body.data`, then `body.data.items`, then `body.items`, else `[]`, and reads `last_page` from the same nesting. Return `{ rows, lastPage }`.

Add to `src/lib/env.ts`:

```ts
  /** Global fallback price, in DISPLAY credits, for a DID staff have not
   *  priced individually. Parsed through toInternalCredits so a typo is a
   *  boot-time error rather than a wrong charge. */
  didDefaultMonthlyPriceCredits: process.env.DID_DEFAULT_MONTHLY_PRICE_CREDITS ?? '500',
  /** Renewal sweep period. Only `server.ts` reads this. */
  didRenewalSweepMs: count('DID_RENEWAL_SWEEP_MS', 3_600_000),
```

**Step 4: Run the tests.** Expected: PASS.

**Step 5: Document the new variables** in `.env.example` if present, and in `CLAUDE.md`'s Environment block (Task 12).

**Step 6: Commit**

```bash
git add src/lib/upstream.ts src/adapter/vocobase.ts src/lib/env.ts test/
git commit -m "feat: read the purchased DID listing from the voice platform"
```

---

### Task 5: The DID sync service

**Files:**
- Create: `src/services/didSync.ts`
- Test: `test/did-sync.test.ts`

**Step 1: Write the failing test**

`vi.mock('../src/adapter/vocobase.js')` at the top — no network. Cases:

```ts
it('imports a purchased DID as UNASSIGNED with provider metadata');
// canonicalized did '+919429390403', externalId '2027', numberType 'Mobile',
// providerStatus 'Assigned', providerExpiresAt 2026-08-31, status UNASSIGNED,
// workspaceId null, monthlyPriceCredits null.

it('walks every page until last_page');
// two pages of 200 + a short page; assert the adapter was called with
// page 1, 2, 3 and every row landed.

it('never overwrites tenancy or billing state on re-sync');
// seed an ASSIGNED DID with a workspace, a price, rentedAt and nextRenewalAt;
// re-sync; assert all five columns are byte-identical and providerStatus DID
// change. THIS IS THE CENTRAL INVARIANT — a refresh that un-rents a paid
// number is the failure this whole guard exists to prevent.

it('skips a DID whose number will not canonicalize, and counts it');
// did_number '12345' → { imported: 0, skipped: 1 }, no row written. Assert
// prisma.phoneNumber.count() is 0 — a fabricated '+12345' must not be stored.

it('accepts did_number sent as a JSON number');

it('counts a number re-issued under a new provider id as a conflict');
// existing row did '+91...' externalId '1'; upstream sends the same number as
// externalId '2'. Result reports conflicts: 1, the run completes, and the
// existing row is untouched.

it('leaves a DID the provider stopped listing alone');
// seed two, upstream lists one; both rows survive, nothing is unassigned.
```

**Step 2: Run and confirm every case fails.**

**Step 3: Implement**

```ts
export interface DidSyncResult {
  imported: number;   // rows created
  updated: number;    // rows refreshed
  skipped: number;    // rows whose number would not canonicalize
  conflicts: number;  // rows whose number is already held under another id
}
```

Page with `PER_PAGE = 200` and a `MAX_PAGES = 50` backstop; stop on a short page or on reaching `lastPage`. Per row: `readDigits(row, ['did_number','didNumber','number','did'])` → `canonicalizeE164` → skip + count if null. Build **only** the provider fields:

```ts
const providerFields = {
  did, provider: 'voicelink',
  countryCode: readDigits(row, ['country_code']),
  numberType: readString(row, ['type_label', 'did_type_label']),
  providerStatus: readString(row, ['status_label', 'status']),
  providerExpiresAt: parseDate(readString(row, ['expiry_date', 'user_expiry_date'])),
  rawProvider: row as Prisma.InputJsonValue,
  lastSyncedAt: new Date(),
};
await prisma.phoneNumber.upsert({
  where: { externalId },
  update: providerFields,                       // no tenancy, no billing
  create: { externalId, ...providerFields },    // status defaults to UNASSIGNED
});
```

Wrap the upsert in the same `P2002` handling `agentSync` uses, but branch on the failing target: a collision on `externalId` is the benign concurrent-create race and retries as an update; a collision on **`did`** is a re-issued number and increments `conflicts` without writing.

Removal detection is deliberately absent — see the design doc's "Stitch points".

**Step 4: Run the tests.** Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/didSync.ts test/did-sync.test.ts
git commit -m "feat: mirror purchased DIDs into the local inventory"
```

---

### Task 6: The rental service

**Files:**
- Create: `src/services/didRental.ts`
- Test: `test/did-rental.test.ts`

This module owns every write that moves credits. Nothing else in the codebase may decrement a balance.

**Step 1: Write the failing test**

```ts
it('charges the workspace owner the full price and assigns the DID');
// owner credits 10_000_000n (1000 display), price default 500 → 5_000_000n.
// After: credits 5_000_000n; DID status ASSIGNED, workspaceId set,
// rentedAt set, nextRenewalAt one month out; exactly one ledger row,
// amount -5_000_000n, type DID_PURCHASE, workspaceId and phoneNumberId set.

it('charges the OWNER, not the admin who clicked');
// a non-owner ADMIN rents; the owner's balance moves, the admin's does not,
// and the ledger row names the owner's accountId.

it('uses a per-DID price when staff set one, ignoring the global default');

it('refuses a rental the owner cannot afford, and changes nothing');
// credits one unit short → InsufficientCreditsError; balance unchanged, DID
// still UNASSIGNED with a null workspaceId, zero ledger rows. The rollback is
// the assertion: a claimed DID with no charge is a free rental.

it('refuses a DID that is already assigned');
// PhoneNumberTakenError; no balance change, no ledger row.

it('rents a DID released for non-payment and clears the marker');
// status RELEASED_NONPAYMENT, workspaceId null → rents, status ASSIGNED.

it('lets only one of two concurrent rentals win');
// await Promise.allSettled([rent(wsA), rent(wsB)]) on one DID.
// Exactly one fulfils; exactly one ledger row exists; the DID has exactly one
// workspaceId; the loser rejected with PhoneNumberTakenError.

it('never lets a balance go negative under concurrent rentals');
// owner can afford exactly one; two rentals of two different DIDs at once.
// Exactly one succeeds, credits land at 0n, never below.

it('releases a DID back to the pool with a zero-amount marker and no refund');
// status UNASSIGNED, workspaceId null, rentedAt null, nextRenewalAt null;
// owner's credits UNCHANGED; a DID_RELEASE row with amount 0n whose
// workspaceId still names the workspace that held it.
```

**Step 2: Run and confirm every case fails.**

**Step 3: Implement**

```ts
export class InsufficientCreditsError extends Error {}
export class PhoneNumberTakenError extends Error {}

export function priceOf(number: Pick<PhoneNumber, 'monthlyPriceCredits'>): bigint {
  return number.monthlyPriceCredits ?? toInternalCredits(env.didDefaultMonthlyPriceCredits);
}
```

`rentPhoneNumber({ phoneNumberId, workspace })` — one `prisma.$transaction(async (tx) => ...)`:

1. `tx.phoneNumber.findFirst({ where: { id, workspaceId: null } })`; null → `PhoneNumberTakenError`.
2. `price = priceOf(row)`; `renewAt = addOneMonth(now)`.
3. **Claim (compare-and-set):** `tx.phoneNumber.updateMany({ where: { id, workspaceId: null }, data: { workspaceId, status: 'ASSIGNED', rentedAt: now, nextRenewalAt: renewAt } })`. `count === 0` → `PhoneNumberTakenError`. The row lock this takes is what serializes two simultaneous rentals; the `findFirst` above is for the price, not for safety.
4. **Debit (compare-and-set):** `tx.account.updateMany({ where: { id: workspace.ownerAccountId, credits: { gte: price } }, data: { credits: { decrement: price } } })`. `count === 0` → `InsufficientCreditsError`, which rolls back the claim. There is no window between checking the balance and spending it, so a negative balance is unreachable.
5. `tx.creditTransaction.create({ data: { accountId: owner, workspaceId, phoneNumberId, amount: -price, type: 'DID_PURCHASE' } })`.

`releasePhoneNumber({ phoneNumberId, workspace })` — one transaction: scoped `updateMany({ where: { id, workspaceId } , data: { workspaceId: null, status: 'UNASSIGNED', rentedAt: null, nextRenewalAt: null } })`, `count === 0` → throw a not-found the route maps to 404; then the zero-amount `DID_RELEASE` row carrying the workspace it left. **No credit write at all** — the no-refund rule is enforced by the absence of the statement, and the test asserts the balance is untouched.

**Step 4: Run the tests.** Expected: PASS. If the two concurrency cases are flaky, that is the implementation being wrong, not the test — do not add retries or serialize the test.

**Step 5: Commit**

```bash
git add src/services/didRental.ts test/did-rental.test.ts
git commit -m "feat: rent and release DIDs with atomic credit charges"
```

---

### Task 7: The renewal sweep

**Files:**
- Create: `src/services/didRenewal.ts`
- Test: `test/did-renewal.test.ts`

**Step 1: Write the failing test**

Call `runRenewalSweep({ now })` directly — never `setInterval` — so the tests are deterministic.

```ts
it('charges a DID whose renewal date has arrived and advances it a month');
// nextRenewalAt yesterday → credits down by the price, one DID_RENEWAL row,
// nextRenewalAt one month past the OLD date.

it('leaves a DID whose renewal is still in the future alone');
// no charge, no ledger row, nextRenewalAt unmoved.

it('is idempotent: a second sweep at the same instant charges nothing more');
// THE central property. Run the sweep twice; exactly one ledger row.

it('charges once per sweep for a DID overdue by three months');
// three sequential sweeps produce three DID_RENEWAL rows and land
// nextRenewalAt one month past the third. Advancing from `now` would forgive
// the gap; charging the backlog in one pass would empty the account at once.

it('releases a DID the owner can no longer pay for, and charges nothing');
// credits one unit short → DID workspaceId null, status RELEASED_NONPAYMENT,
// rentedAt null, nextRenewalAt null; balance UNCHANGED; exactly one ledger
// row, amount 0n, type DID_RELEASE_NONPAYMENT, workspaceId still naming the
// workspace it left. Assert no DID_RENEWAL row exists — a failed charge that
// left a debit behind is the worst outcome available.

it('keeps sweeping after one DID fails');
// two due DIDs in different workspaces, the first unaffordable: the second is
// still charged, and the result reports { renewed: 1, released: 1 }.

it('ignores a DID that is not ASSIGNED even if nextRenewalAt is past');
```

**Step 2: Run and confirm every case fails.**

**Step 3: Implement**

```ts
export interface RenewalSweepResult { renewed: number; released: number; failed: number; }
export async function runRenewalSweep({ now = new Date() } = {}): Promise<RenewalSweepResult>;
```

Select `{ status: 'ASSIGNED', nextRenewalAt: { lte: now }, workspaceId: { not: null } }` with the workspace included, ordered by `nextRenewalAt`. Per DID, in its own `prisma.$transaction`:

1. **Claim:** `updateMany({ where: { id, status: 'ASSIGNED', nextRenewalAt: dueAt }, data: { nextRenewalAt: addOneMonth(dueAt) } })`. `count === 0` → another runner or a concurrent release took it; skip silently. This compare-and-set on `nextRenewalAt` is the whole of the idempotency guarantee.
2. **Debit:** the same `gte` conditional write as renting. `count === 0` → throw a sentinel so the transaction rolls back with `nextRenewalAt` unmoved and nothing charged.
3. Ledger `DID_RENEWAL`, `amount: -price`.

Catch the sentinel outside the transaction and run the release in a second transaction: null the workspace, set `RELEASED_NONPAYMENT`, clear `rentedAt`/`nextRenewalAt`, write the zero-amount `DID_RELEASE_NONPAYMENT` row carrying the workspace it left. Any other error increments `failed`, is logged, and the loop continues — one bad row must not stop the platform's billing.

Then the lifecycle, exported but **not started here**:

```ts
export function startRenewalSweep(periodMs: number): NodeJS.Timeout {
  void runRenewalSweep().catch((err) => console.error('Renewal sweep failed:', err));
  const timer = setInterval(() => {
    void runRenewalSweep().catch((err) => console.error('Renewal sweep failed:', err));
  }, periodMs);
  // Nothing bills anybody just because a test built the app: this is started
  // from server.ts only. unref'd so it cannot hold the process open.
  timer.unref();
  return timer;
}
```

**Step 4: Run the tests.** Expected: PASS.

**Step 5: Start it from the server, not the app**

In `src/server.ts` only, after `app.listen`:

```ts
startRenewalSweep(env.didRenewalSweepMs);
```

`createApp()` must not reference it. A test that builds the app must never start a timer that charges people.

**Step 6: Commit**

```bash
git add src/services/didRenewal.ts src/server.ts test/did-renewal.test.ts
git commit -m "feat: add the hourly DID renewal sweep with non-payment release"
```

---

### Task 8: Serializers and error codes

**Files:**
- Modify: `src/lib/serialize.ts`, `src/lib/errors.ts`

**Step 1:** Add to `ErrorCode` in `src/lib/errors.ts`:

```ts
  | 'INSUFFICIENT_CREDITS'
  | 'PHONE_NUMBER_TAKEN'
```

**Step 2:** Add to `src/lib/serialize.ts`. Every credit value is a decimal string via `toDisplayCredits`; `BigInt` is not JSON-serializable and a float would lose the precision the multiplier protects.

```ts
serializePhoneNumber(n)          // id, did, country_code, number_type, status,
                                 // monthly_price_credits, rented_at, next_renewal_at
serializeAvailablePhoneNumber(n) // id, did, country_code, number_type,
                                 // monthly_price_credits, released_for_nonpayment
serializeLedgerRow(t)            // id, amount, type, created_at, phone_number: { id, did } | null
serializePhoneNumberForStaff(n)  // the above plus external_id, provider,
                                 // provider_status, provider_expires_at,
                                 // last_synced_at, workspace: {id,name,slug} | null
```

`serializeAvailablePhoneNumber` is deliberately narrow: the pool is the one cross-workspace read in this slice, so it carries the number, its price, and why it is free — never `workspaceId`, never `rawProvider`, never the provider's own id.

**Step 3: Commit**

```bash
git add src/lib/serialize.ts src/lib/errors.ts
git commit -m "feat: serialize phone numbers and ledger rows"
```

---

### Task 9: Workspace phone-number routes

**Files:**
- Create: `src/routes/phoneNumbers.routes.ts`
- Modify: `src/app.ts`
- Test: `test/phone-numbers.test.ts`

**Step 1: Write the failing test** — Supertest, `vi.mock` the adapter.

```ts
it('lists only this workspace\'s numbers');
it('returns 404 for a number belonging to another workspace');
// Not 403: a 403 would confirm the id names something real.
it('answers 403 to a caller who is not a member at all');
it('lists the available pool to any member, including released-for-nonpayment');
it('excludes an assigned number from the available pool');
it('never exposes another workspace\'s id through the pool');
// assert the response body has no `workspace` key and no `workspaceId`.

it('rents a number as ADMIN and returns the updated row');
it('refuses a rental from a MEMBER with 403');
// and asserts the balance and the DID are both untouched.
it('returns 409 PHONE_NUMBER_TAKEN when the number is already rented');
it('returns 402 INSUFFICIENT_CREDITS when the owner is short');
// assert the envelope: { success:false, error:{ code:'INSUFFICIENT_CREDITS' } }.

it('releases a number as ADMIN');
it('refuses a release from a MEMBER with 403');
it('returns 404 releasing a number this workspace does not hold');

it('returns the owner balance and this workspace\'s ledger to an ADMIN');
it('refuses billing to a MEMBER with 403');
it('paginates the ledger by cursor');
it('keeps a released number\'s ledger rows on the workspace\'s billing');
// rent, release, then read billing: both rows are still there. This is why
// CreditTransaction carries its own workspaceId.
```

**Step 2: Run and confirm every case fails.**

**Step 3: Implement**

Mirror `agents.routes.ts` in shape. A `phoneNumberInWorkspace(req)` helper does `findFirst({ where: { id: req.params.didId, workspaceId: workspaceOf(req).id } })` and throws 404 — ownership is part of the lookup, not a check after it.

- `GET /:workspaceId/phone-numbers` — `requireMembership()`, ordered by `did`.
- `GET /:workspaceId/phone-numbers/available` — `requireMembership()`, `where: { workspaceId: null }`, `serializeAvailablePhoneNumber`. **Register before `/:didId`.**
- `POST /:workspaceId/phone-numbers/:didId/rent` — `requireMembership('ADMIN')`. Map `PhoneNumberTakenError` → 409 `PHONE_NUMBER_TAKEN`, `InsufficientCreditsError` → **402** `INSUFFICIENT_CREDITS`.
- `POST /:workspaceId/phone-numbers/:didId/release` — `requireMembership('ADMIN')`.
- `GET /:workspaceId/billing` — `requireMembership('ADMIN')`. Returns `{ balance, ledger, nextCursor }` where `balance` is the **owner's** `toDisplayCredits(credits)`. Ledger is `where: { workspaceId }`, `orderBy: { createdAt: 'desc' }, take: limit + 1` with the same cursor pattern the campaign contacts route uses (`limit` 1–200, default 50).

Register in `src/app.ts` alongside the other workspace routers:

```ts
app.use('/api/workspaces', phoneNumberRoutes);
```

**Merge note:** `src/app.ts` and `prisma/schema.prisma` are the two files a parallel stitch session also touches. When merging `origin/main`, keep **both** sides' additions — a resolution that drops a router line or a model is a silently missing feature, not a conflict resolved.

**Step 4: Run the tests.** Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/phoneNumbers.routes.ts src/app.ts test/phone-numbers.test.ts
git commit -m "feat: add workspace phone number rental and billing routes"
```

---

### Task 10: Staff phone-number routes

**Files:**
- Create: `src/routes/admin/phoneNumbers.routes.ts`
- Modify: `src/app.ts`
- Test: `test/admin-phone-numbers.test.ts`

**Step 1: Write the failing test**

```ts
it('refuses every request without the staff token');   // all four routes, 401
it('lists every number with its workspace and renewal state');
it('filters by ?status= and by ?assigned=');
it('rejects a malformed ?status= rather than ignoring it');
// silently ignoring it would return the wrong list.

it('syncs the purchased list');                        // adapter mocked
it('assigns a number to a workspace with NO charge');
// balance unchanged, ZERO ledger rows, status ASSIGNED, nextRenewalAt one
// month out. An operational override is not a sale.
it('unassigns with an explicit null and clears the renewal date');
it('rejects an omitted workspaceId with 400');
// an omitted field must never silently take a number away from a customer.
it('404s assigning to a workspace that does not exist');
it('sets a per-DID monthly price');
it('restores the global default with a null price');
it('rejects a negative or non-decimal price with 400');
```

**Step 2: Run and confirm every case fails.**

**Step 3: Implement**

Mirror `src/routes/admin/agents.routes.ts`: `adminPhoneNumberRoutes.use(requireStaffToken)`, Zod through `parseBody`.

- `GET /phone-numbers` — `?status=UNASSIGNED|ASSIGNED|RELEASED_NONPAYMENT`, `?assigned=true|false`, both `z.enum(...).optional()` so a typo is a 400.
- `POST /phone-numbers/sync` — `runDidSync()`. **Register before `/phone-numbers/:didId/...`.**
- `POST /phone-numbers/:didId/assign` — `z.object({ workspaceId: z.string().min(1).nullable() })`, nullable but **required**. Verify the workspace exists first so a typo is a clean 404 rather than a foreign-key 500. Sets `status`, `workspaceId`, and `rentedAt`/`nextRenewalAt` (one month out when assigning, null when unassigning). Writes no ledger row.
- `PATCH /phone-numbers/:didId` — `z.object({ monthlyPriceCredits: z.string().nullable() })`; convert with `toInternalCredits`, mapping its throw to a 400 `VALIDATION_ERROR`.

Mount it under the existing rate limiter in `src/app.ts`, after `adminAgentRoutes`.

**Step 4: Run the tests.** Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/admin/phoneNumbers.routes.ts src/app.ts test/admin-phone-numbers.test.ts
git commit -m "feat: add staff phone number pool, sync, assignment and pricing"
```

---

### Task 11: Full backend gate

**Step 1:**

```bash
npx tsc --noEmit
npm test
```

Expected: tsc silent; every test file green, including the pre-existing ones. **A pre-existing test that now fails is this slice's bug** — most likely the `test/setup.ts` truncation order.

**Step 2:** Confirm no test hit the network: `grep -rn "vi.mock('../src/adapter/vocobase.js')" test/` covers every file that touches sync.

**Step 3: Commit** anything outstanding.

---

### Task 12: Backend docs

**Files:** `ye-voice-backend/CLAUDE.md`

Add a **Phone numbers & credits** section: the model and the sync-owns-provider-facts invariant, the routes table, the atomic-charge rule, the sweep's idempotency and its from-`dueAt` advance, the no-refund rule, the staff-assignment-is-free rule, and the new env vars in the Environment block. Say **Vocobase** in the docs and **"the voice platform"** in customer-facing strings — the split the repo already keeps.

```bash
git add CLAUDE.md
git commit -m "docs: document phone number rental, billing and the renewal sweep"
```

---

# Part B — Dashboard (`ye-voice-dashboard`)

### Task 13: Types and error copy

**Files:** `lib/types.ts`, `lib/api.ts`, `lib/errors.ts`

**Step 1:** Add to `lib/types.ts`:

```ts
export type PhoneNumberStatus = 'UNASSIGNED' | 'ASSIGNED' | 'RELEASED_NONPAYMENT';

export type CreditTransactionType =
  | 'DID_PURCHASE' | 'DID_RENEWAL' | 'DID_RELEASE'
  | 'DID_RELEASE_NONPAYMENT' | 'ADJUSTMENT';

/** Credits are decimal strings, never numbers: the backend holds them as
 *  BigInt with a 10000x multiplier and a float would lose that precision. */
export interface PhoneNumber {
  id: string;
  did: string;
  country_code: string | null;
  number_type: string | null;
  status: PhoneNumberStatus;
  monthly_price_credits: string;
  rented_at: string | null;
  next_renewal_at: string | null;
}

export interface AvailablePhoneNumber {
  id: string;
  did: string;
  country_code: string | null;
  number_type: string | null;
  monthly_price_credits: string;
  released_for_nonpayment: boolean;
}

export interface LedgerRow {
  id: string;
  amount: string;
  type: CreditTransactionType;
  created_at: string;
  phone_number: { id: string; did: string } | null;
}

/** `balance` is the workspace OWNER's, not the signed-in account's. */
export interface WorkspaceBilling {
  balance: string;
  ledger: LedgerRow[];
  nextCursor: string | null;
}
```

**Step 2:** Add `'INSUFFICIENT_CREDITS'` and `'PHONE_NUMBER_TAKEN'` to `ApiErrorCode` in `lib/api.ts`.

**Step 3:** Add to `CURATED` in `lib/errors.ts` — copy written here, never the backend's own wording:

```ts
  INSUFFICIENT_CREDITS:
    'Not enough credits to rent this number. Top up the workspace owner’s balance and try again.',
  PHONE_NUMBER_TAKEN:
    'Somebody rented that number first. Refresh the list and pick another.',
```

**Step 4: Commit**

```bash
git add lib/
git commit -m "feat: add phone number and billing types with curated error copy"
```

---

### Task 14: The phone numbers page

**Files:**
- Create: `app/(dash)/settings/phone-numbers/page.tsx`
- Create: `app/(dash)/settings/phone-numbers/owned-tab.tsx`
- Create: `app/(dash)/settings/phone-numbers/available-tab.tsx`
- Create: `app/(dash)/settings/phone-numbers/confirm-dialog.tsx`
- Modify: `components/shell/sidebar.tsx`

**Step 1:** Add a **Phone numbers** link beside Members in the settings block of `components/shell/sidebar.tsx`, `Phone` from `lucide-react`.

**Step 2:** Build the page. Follow the conventions the agents and campaigns surfaces already set — read them first (`app/(dash)/agents/page.tsx`, `app/(dash)/campaigns/[id]/page.tsx`):

- Tabs are links driven by `?tab=owned|available`, so each is addressable and the back button behaves.
- **Every fetch carries a currency check** so a response arriving after a workspace switch is discarded rather than painted under the new workspace. Copy the guard from the agents page.
- `isAdmin = activeWorkspace?.role === 'ADMIN'`.
- Loading, empty and error are **three different renderings**. An error renders the error and offers a retry; it must never look like an empty list, or the reader concludes they own no numbers when the request simply failed.
- Absent values render `Not set`, never blank.
- Colour comes only from the tokens in `app/globals.css`; light theme only, no `dark:` variants.

**Owned tab** — a dense table: number, type, price/mo, next renewal (`relativeTime` with `absoluteTime` in the `title`), and for ADMIN a **Release** action. `Not set` for a null renewal date.

**Available tab** — number, type, price/mo, and a badge on any row with `released_for_nonpayment`. For ADMIN, a **Rent** action. For MEMBER, no action control at all — not a disabled one.

**Confirm dialog** — the one required piece of the brief, used by both actions:

- *Rent*: names the number, the **monthly price**, and the **workspace owner's current balance** side by side, from `GET /api/workspaces/:id/billing`. If the balance is short, say so before the click rather than after. On failure render `userMessage(err, ...)`, which resolves `INSUFFICIENT_CREDITS` and `PHONE_NUMBER_TAKEN` to the curated copy — **never a silent failure**.
- *Release*: names the number and states plainly that **the current month is not refunded**.
- Focus moves into the dialog on open, `Escape` closes it, and the trigger regains focus on close.

**Step 3: Verify**

```bash
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all three clean.

**Step 4: Commit**

```bash
git add app/ components/
git commit -m "feat: add the workspace phone numbers settings page"
```

---

### Task 15: Dashboard docs

**Files:** `ye-voice-dashboard/CLAUDE.md`

Add the two rows to the Pages table and a short **Phone numbers** section: the two tabs, the confirm dialog showing price against the owner's balance, the no-refund line, and that MEMBERs get no action controls at all. Add `Billing` to the product-surfaces list as partially landed.

```bash
git add CLAUDE.md
git commit -m "docs: document the phone numbers page"
```

---

# Part C — Landing

### Task 16: Merge, gate, and open the PRs

**Step 1: Merge `origin/main` into the branch, both repos**

```bash
git fetch origin
git merge origin/main
```

The expected conflicts are `prisma/schema.prisma` and `src/app.ts`. **Keep both sides' additions.** A resolution that drops the other session's model or router line is a silently missing feature that no test here will catch — read the conflict, do not take a side wholesale.

**Step 2: Re-run every gate after the merge**

Backend:
```bash
npm install && npx prisma generate && npm run test:prepare
npx tsc --noEmit && npm test
```

Dashboard:
```bash
npm install
npx tsc --noEmit && npm run build
```

All must be green. **Do not open a PR on unverified output** — run the commands and read them.

**Step 3: If the merge brought in a new migration**, confirm the two migrations are independent (they touch disjoint tables) and that `npm run test:prepare` applies both cleanly in timestamp order.

**Step 4: Push and open one PR per repo**

```bash
git push -u origin feat/phone-numbers
gh pr create --base main --title "..." --body "..."
```

The PR body describes the slice as built here: the inventory, the rental and its atomic charge, the sweep, the ledger, the permissions, and what is deliberately out of scope. State plainly that the migration has not been applied to production.

**Do not merge.** Report and stop.

---

## Production migration — gated

`DATABASE_URL` in `.env` is a **local** Postgres (`localhost:5436`). Production Neon is `PROD_DATABASE_URL` and is inactive by design. Applying this migration to production is therefore a separate, deliberate act:

1. Print the generated SQL from `prisma/migrations/<timestamp>_phone_numbers_and_credit_ledger/migration.sql`.
2. Confirm it is additive only — `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT`; no `DROP`, no `ALTER COLUMN`, no data statement.
3. **Show it to the user and wait for an explicit go-ahead.** Nothing is applied to production without it.
