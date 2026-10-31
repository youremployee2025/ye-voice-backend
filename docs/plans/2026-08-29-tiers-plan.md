# Voice Tiers and Per-Minute Rates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Mirror the voice-platform tier catalog locally, price it, assign tiers to accounts with optional per-account overrides, resolve a per-minute rate through one function, filter the voice picker by what the workspace owner's account holds, and surface all of it — a staff catalog and assignment console, and a read-only "Your plan" card for the customer — as described in `2026-08-29-tiers-design.md`.

**Architecture:** One additive migration adds `Tier` and `AccountTier` plus a partial unique index enforcing exactly one default tier. `src/services/tierSync.ts` mirrors `GET /agent/voice-tiers`, writing catalog facts only. `src/lib/tierPricing.ts` owns rate resolution (account override → tier default → refuse) and `tiersForAccount`. A new staff router `src/routes/admin/tiers.routes.ts` composes into `src/routes/admin/index.ts`. `GET /api/workspaces/:id/voices` filters upstream's one catalog response against the owner's tiers locally. A sibling `GET /api/workspaces/:id/billing/plan` feeds the customer card. The admin console gains `/tiers`, a Tiers section on the account detail, and a `/resources` page over endpoints that already exist.

**Tech Stack:** Express 4, TypeScript, Prisma 6, Zod 4, Vitest + Supertest (backend). Next.js 15 App Router, React 19, Tailwind 4, Vitest + Testing Library (dashboard, admin).

**Worktrees:** `.worktrees/tiers-wallet/{ye-voice-backend,ye-voice-dashboard,ye-voice-admin}`, all on `feat/tiers-wallet`.

**Ports:** backend **:3017**, dashboard **:3018**, admin **:3020**. Backend `.env` here points at `ye_voice_tiers` (dev) and `ye_voice_test_tiers` (test); both dashboard and admin `.env.local` point at `:3017`.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, which `test/setup.ts` asserts is set and is not a hosted host. That guard stays exactly as written — if it trips, fix the environment, never the guard. Migrations reach the test DB through `npm run test:prepare` (`prisma migrate deploy`), never `prisma migrate reset`. Nothing here runs against `PROD_DATABASE_URL`.

**Upstream safety:** The only calls this slice may make are `GET /agent/voice-tiers` and `GET /agent/voices`. No write of any kind reaches the platform. Every test mocks `src/adapter/vocobase.ts` with `vi.mock`.

**Migration safety:** The migration is generated with `--create-only`, applied to this worktree's dev and test databases, and **not applied to production**. No existing migration file is edited; no timestamp is reordered.

**Rules that apply to every task:**

1. **Sync owns catalog facts; staff own pricing and assignment.** The tier upsert writes `slug`, `name`, `status`, `lastSyncedAt` and nothing else — never `defaultPriceCreditsPerMin`, never `isDefault`.
2. **A tier upstream stops listing is marked `REMOVED`, never deleted.**
3. **Rate resolution lives in `src/lib/tierPricing.ts` and nowhere else.** No handler reimplements the fallback chain.
4. **Unknown is not zero.** A tier with no resolvable rate is refused, never priced at 0.
5. **Money crosses the wire as decimal strings** and is parsed only through `src/lib/credits.ts`.
6. **Nothing in this slice writes a `CreditTransaction` or moves a balance.** `didRental.ts` remains the only module that moves credits.
7. Small commits — one migration, one library, one route group, one component group per commit.

---

## Backend

### Task 1: The two tables

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260829090000_voice_tiers/migration.sql`
- Modify: `test/setup.ts` (the `TABLES` reset list)

**Step 1: Declare the models**

Append to `prisma/schema.prisma`:

```prisma
/// Local mirror of a voice tier the platform sells, priced by YE.
///
/// Upstream owns exactly two facts about a tier — its slug and its label —
/// and sends neither a price nor a status. Everything else in this table is
/// YE's, which is why the sync upsert must never write below the second
/// field. A refresh that reset a price would re-rate every account holding
/// the tier, from a button labelled "Sync".
model Tier {
  id     String     @id @default(cuid())
  /// The platform's own identifier for the tier: what `voices[].tier`
  /// carries and what `?tier=` accepts. The only stable key upstream gives.
  slug   String     @unique
  /// Upstream's display label, refreshed by sync.
  name   String
  /// YE's, not upstream's. A tier the platform stops listing is marked
  /// REMOVED and keeps its assignments — deleting it would take its price,
  /// every account's override, and the referent of any later ledger row.
  status TierStatus @default(ACTIVE)

  /// The list price per minute of calling, in internal credit units (10000x).
  /// Null means unpriced, which is how a tier arrives from sync. Unpriced is
  /// NOT free: a tier with no resolvable rate cannot be used.
  defaultPriceCreditsPerMin BigInt?

  /// The tier an account with no assignment at all is treated as holding.
  /// "Exactly one" is a partial unique index in the migration — Prisma's
  /// schema language cannot express `WHERE "isDefault"`, so the constraint
  /// lives there and this column carries the comment saying so.
  isDefault Boolean @default(false)

  lastSyncedAt DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  accounts AccountTier[]
}

enum TierStatus {
  ACTIVE
  REMOVED
}

/// One account's entitlement to one tier, and optionally its own price for it.
///
/// An account may hold several tiers. `priceCreditsPerMin` overrides the
/// tier's default for THIS account only; null means "use the list price".
model AccountTier {
  id        String @id @default(cuid())
  accountId String
  tierId    String

  /// This account's own rate per minute, in internal credit units. Null means
  /// the tier's default applies. Never labelled as a discount to the
  /// customer — it is simply their rate.
  priceCreditsPerMin BigInt?

  createdAt DateTime @default(now())

  // Cascade on the account, matching WorkspaceMember: an entitlement is a
  // live permission, not financial history, and has no meaning once the
  // account is gone. Restrict on the tier, matching the never-delete rule
  // above: nothing may remove a tier row out from under an override.
  account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  tier    Tier    @relation(fields: [tierId], references: [id], onDelete: Restrict)

  @@unique([accountId, tierId])
  @@index([tierId])
}
```

Add the back-relation to `model Account`, beside `notificationReads`:

```prisma
  tiers              AccountTier[]
```

**Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name voice_tiers --create-only`
Expected: a new `prisma/migrations/<timestamp>_voice_tiers/migration.sql` with `CreateEnum`, two `CreateTable`s and their indexes. Nothing applied.

**Step 3: Add the partial unique index by hand**

Append to the generated `migration.sql`:

```sql
-- Exactly one default tier, enforced by the database rather than by care.
-- Prisma's schema language has no partial index, so this cannot live in
-- schema.prisma and is written here deliberately. Postgres treats every
-- `false` row as distinct under this predicate, so any number of tiers may be
-- non-default and at most one may be default. Two concurrent attempts to move
-- the default cannot both land.
CREATE UNIQUE INDEX "Tier_isDefault_key" ON "Tier" ("isDefault") WHERE "isDefault";
```

**Step 4: Apply to this worktree's dev DB and regenerate the client**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: "All migrations have been successfully applied."

**Step 5: Apply to the test DB**

Run: `npm run test:prepare`

**Step 6: Add both tables to the test reset**

In `test/setup.ts`, in `TABLES`, add `'AccountTier'` and `'Tier'` immediately before `'Account'` — children before parents, as the comment there requires. `AccountTier` before `Tier` for the same reason.

**Step 7: Verify nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: tsc silent; the existing 946 tests pass.

**Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/setup.ts
git commit -m "feat: add the voice tier catalog and per-account entitlement"
```

---

### Task 2: The upstream reader

**Files:**
- Modify: `src/adapter/vocobase.ts`
- Test: `test/vocobase-adapter.test.ts`

**Step 1: Write the failing test**

Add to `test/vocobase-adapter.test.ts` a case asserting `listVoiceTiers()` calls `GET {base}/agent/voice-tiers` and unwraps `{ tiers }`, and one asserting `listVoices({ tier: 'va-1' })` sets `?tier=va-1` while `listVoices()` sets no query.

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/vocobase-adapter.test.ts`
Expected: FAIL — `listVoiceTiers is not a function`.

**Step 3: Implement**

In `src/adapter/vocobase.ts`, beside `VoicesResponse`:

```ts
export interface VoiceTiersResponse {
  tiers?: UpstreamRecord[];
}

/** The tiers YE is entitled to sell. A read; the catalog is the platform's. */
export function listVoiceTiers(): Promise<VoiceTiersResponse> {
  return request<VoiceTiersResponse>('/agent/voice-tiers');
}
```

and widen `listVoices` to take an optional tier:

```ts
export function listVoices(query: { tier?: string } = {}): Promise<VoicesResponse> {
  return request<VoicesResponse>('/agent/voices', {
    query: query.tier ? { tier: query.tier } : undefined,
  });
}
```

**Step 4: Run the test**

Run: `npx vitest run test/vocobase-adapter.test.ts` → PASS.

**Step 5: Commit**

```bash
git commit -am "feat: read the voice tier catalog from the platform"
```

---

### Task 3: Rate resolution

**Files:**
- Create: `src/lib/tierPricing.ts`
- Test: `test/tier-pricing.test.ts`

**Step 1: Write the failing test**

`test/tier-pricing.test.ts` covers, against the test database:

- `resolveTierRate` returns the account's `AccountTier.priceCreditsPerMin` when set.
- It falls back to `Tier.defaultPriceCreditsPerMin` when the assignment has no price.
- It falls back to the default when the account has no assignment for the tier at all.
- It throws `TierRateUnavailableError` when neither is set — **and does not return 0n**.
- A `defaultPriceCreditsPerMin` of `0n` is returned as `0n`: zero is a price somebody set, and only *absence* is a refusal.
- `tiersForAccount` returns the account's ACTIVE assigned tiers.
- `tiersForAccount` returns **the default tier** when the account has no assignments at all.
- `tiersForAccount` returns **an empty list** when the account has no assignments and no tier is marked default — fail closed, never "the first tier".
- An account whose only assignment is to a REMOVED tier does **not** fall back to the default: it has an assignment, so the default does not apply; `tiersForAccount` omits the removed tier from the entitlement set but `assignedTiers` (below) still lists it for display.

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/tier-pricing.test.ts` → FAIL, module not found.

**Step 3: Implement `src/lib/tierPricing.ts`**

Exports:

- `class TierRateUnavailableError extends Error` — carries the tier slug.
- `resolveTierRate(accountId: string, tierId: string): Promise<bigint>` — the one place the precedence chain exists. One query joining the assignment to the tier; the fallback is decided in code, not in SQL, so it is readable and testable.
- `tiersForAccount(accountId: string): Promise<Tier[]>` — the **entitlement** set: ACTIVE assigned tiers, or the default tier when there are no assignments at all.
- `assignedTiers(accountId): Promise<Array<{ tier: Tier; priceCreditsPerMin: bigint | null }>>` — everything the account holds, removed tiers included, for display.

Each carries a doc comment stating why it is the only copy of its rule.

**Step 4: Run the test** → PASS.

**Step 5: Commit**

```bash
git add src/lib/tierPricing.ts test/tier-pricing.test.ts
git commit -m "feat: resolve a tier's rate in one place, and refuse when there is none"
```

---

### Task 4: The catalog sync

**Files:**
- Create: `src/services/tierSync.ts`
- Test: `test/tier-sync.test.ts`

**Step 1: Write the failing test** (adapter mocked with `vi.mock`):

- Imports the tiers upstream lists, reading `tier`/`slug` and `label`/`name` through `src/lib/upstream.ts` so both spellings work.
- A row with no readable slug is **skipped and counted**, never stored with a fabricated one.
- A second sync updates `name` and `lastSyncedAt` and **leaves `defaultPriceCreditsPerMin` and `isDefault` untouched** — the load-bearing assertion of this task.
- A tier no longer listed is marked `REMOVED`; its `AccountTier` rows survive.
- A tier that reappears after removal is set back to `ACTIVE`, keeping its price.
- An empty or unreadable upstream list marks **nothing** removed, and reports `truncated: true` — an empty response is far more likely to be an outage than a platform that stopped selling every tier.

**Step 2: Run it and watch it fail.**

**Step 3: Implement** `syncVoiceTiers(): Promise<TierSyncResult>` with `{ synced, skipped, removed, truncated }`.

**Step 4: Run the test** → PASS.

**Step 5: Commit**

```bash
git add src/services/tierSync.ts test/tier-sync.test.ts
git commit -m "feat: mirror the tier catalog without touching what staff priced"
```

---

### Task 5: Staff tier routes

**Files:**
- Create: `src/routes/admin/tiers.routes.ts`
- Modify: `src/routes/admin/index.ts`
- Test: `test/admin-tiers.test.ts`

**Routes** (all `X-Admin-Token`, all through `requireStaffToken` on the sub-router as well as the composed one):

| Route | Notes |
|---|---|
| `POST /api/admin/tiers/sync` | Registered **before** `/tiers/:tierId`, or Express matches "sync" as an id. |
| `GET /api/admin/tiers` | Catalog: name, slug, status, default price, `is_default`, `account_count` (from `_count`), `last_synced_at`. |
| `PATCH /api/admin/tiers/default` | `{ tierId }` — registered **before** `/tiers/:tierId`. |
| `PATCH /api/admin/tiers/:tierId` | `{ defaultPriceCreditsPerMin: string \| null }`. |
| `GET /api/admin/accounts/:accountId/tiers` | The account's assignments with each resolved rate, plus the catalog to pick from. |
| `PUT /api/admin/accounts/:accountId/tiers` | `{ tiers: [{ tierId, priceCreditsPerMin? }] }` — full replace. |

**Step 1: Write the failing tests.** The cases that carry the design:

- `PATCH /tiers/:id` parses the price through `toInternalCredits`; a malformed or out-of-range value is **400 `VALIDATION_ERROR`**, never a 500. `null` clears it.
- `PATCH /tiers/default` moves the flag in one transaction — the previous default is cleared — and a second read shows exactly one default.
- `PATCH /tiers/default` on a tier with **no default price** is **409 `TIER_NOT_PRICEABLE`**, and nothing is written.
- `PATCH /tiers/default` on a `REMOVED` tier is **409**.
- `PUT /accounts/:id/tiers` replaces: a tier present before and absent from the body is gone afterwards.
- `PUT` validates **every** tier id before writing **any** — a body naming one good and one unknown tier writes nothing and answers **404**.
- `PUT` refuses a `REMOVED` tier with **409 `TIER_NOT_ASSIGNABLE`**.
- `PUT` with `tiers: []` clears every assignment and succeeds; an omitted `tiers` key is a **400**.
- A duplicate `tierId` in the body is a **400** rather than a last-one-wins write.
- Every route answers **401** without the staff token (covered by the shared admin-auth test's pattern).

**Step 2: Run and watch them fail.**

**Step 3: Implement the router**, then add one line to `src/routes/admin/index.ts`:

```ts
adminRoutes.use(adminTierRoutes);
```

Add `'TIER_NOT_PRICEABLE'` and `'TIER_NOT_ASSIGNABLE'` to `ErrorCode` in `src/lib/errors.ts`.

**Step 4: Run the tests** → PASS.

**Step 5: Commit**

```bash
git add src/routes/admin/tiers.routes.ts src/routes/admin/index.ts src/lib/errors.ts test/admin-tiers.test.ts
git commit -m "feat: let staff price tiers and assign them to accounts"
```

---

### Task 6: The voice picker learns about entitlement

**Files:**
- Modify: `src/routes/agents.routes.ts` (the `/:workspaceId/voices` handler)
- Modify: `src/lib/serialize.ts` (`VOICE_FIELDS`, `serializeVoices`)
- Test: `test/voices-entitlement.test.ts`

**Step 1: Write the failing test:**

- A voice whose `tier` slug the **owner's** account holds is offered.
- A voice whose tier it does not hold is withheld.
- A voice with **no** `tier` field is offered to everybody.
- The filter reads the **owner's** tiers, not the caller's: an ADMIN member with their own tiers sees the owner's list.
- An account with no assignments is offered the **default** tier's voices.
- With no default tier and no assignments, only untiered voices are offered.
- Each row carries `tier` and `tier_name`; `tier_name` is `null` for a slug not in the mirror.
- Exactly **one** upstream call is made regardless of how many tiers the account holds.
- An unreachable catalog is still a **502**, not an empty list.

**Step 2: Run and watch it fail.**

**Step 3: Implement.** In the handler: resolve the workspace's `ownerAccountId`, call `tiersForAccount`, fetch the catalog once, filter, serialize. `serializeVoices` takes an optional `Map<slug, name>` and emits `tier` and `tier_name`.

**Step 4: Run the tests, then the whole suite** → PASS.

**Step 5: Commit**

```bash
git commit -am "feat: offer only the voices a workspace's plan entitles it to"
```

---

### Task 7: The customer's plan

**Files:**
- Modify: `src/routes/phoneNumbers.routes.ts` (add `GET /:workspaceId/billing/plan`)
- Test: `test/billing-plan.test.ts`

**Step 1: Write the failing test:**

- ADMIN gets the **owner's** tiers with `rate_credits_per_min` as a decimal string.
- A MEMBER gets **403** from the membership middleware.
- An account with no assignments is shown the default tier — with **nothing in the payload marking it a default**.
- A per-account override is emitted as the rate, with **no field distinguishing it from a list price**.
- A `REMOVED` tier the account still holds is listed with `status: "removed"`, not dropped.
- A tier with no resolvable rate emits `rate_credits_per_min: null` — never `"0"`.

**Step 2: Run and watch it fail.**

**Step 3: Implement**, registered beside `/billing/transactions` and after `/billing`, `requireAuth` + `requireMembership('ADMIN')`.

**Step 4: Run the tests** → PASS.

**Step 5: Commit**

```bash
git commit -am "feat: tell a workspace what its calling rate is"
```

---

### Task 8: Backend gate and docs

**Step 1:** Run `npx tsc --noEmit && npm test`. Expected: silent; all tests pass.

**Step 2:** Update `ye-voice-backend/CLAUDE.md`: a **Voice tiers** section (the mirror invariant, the one-default index, the resolution chain, the refusal), the new rows in the staff-routes table, the new customer route, and the note that nothing charges per minute yet.

**Step 3:** Commit `docs: record the tier model and where its rate is resolved`.

---

## Dashboard

### Task 9: The plan card

**Files:**
- Create: `app/(dash)/settings/billing/plan-card.tsx`
- Modify: `app/(dash)/settings/billing/page.tsx`, `lib/types.ts`
- Test: `test/plan-card.test.tsx`

**Step 1: Write the failing test:**

- Renders each tier's name and rate.
- Loading, empty and error are three distinct renderings; the error offers a retry and never reads as "you have no plan".
- A rate of `null` renders "Not set" and never `0`.
- A `removed` tier is labelled as no longer offered.
- **No wording anywhere calls a rate custom, special or discounted** — asserted directly, because that is the rule most easily lost in a copy edit.
- The card states that call minutes are not billed yet.

**Step 2: Run and watch it fail.**

**Step 3: Implement.** A third panel on `/settings/billing`, loaded on its **own** request — not folded into `loadSummary`, so a plan failure cannot blank the balance. It carries the same workspace-currency guard every other fetch on this page carries.

**Step 4: Run the tests** → PASS.

**Step 5: Commit** `feat: show a workspace the rate it is on`.

### Task 10: Dashboard gate and docs

**Step 1:** `npx tsc --noEmit && npm run build && npm test`.
**Step 2:** Update `ye-voice-dashboard/CLAUDE.md`'s Billing section with the plan card and its three copy rules.
**Step 3:** Commit.

---

## Admin console

### Task 11: `/tiers`

**Files:**
- Create: `app/(console)/tiers/page.tsx`, `actions.ts`, `price-cell.tsx`, `default-cell.tsx`, `sync-button.tsx`
- Modify: `components/shell/sidebar.tsx`, `lib/types.ts`
- Test: `test/tier-price-cell.test.tsx`

Server component reading `GET /api/admin/tiers`; server actions for the price edit, the default move and the sync. Fail-closed rules from the console's CLAUDE.md apply: an unpriced tier renders **Not set**, never `0`; a table with no default tier says so **above** the table, because that is the state in which accounts with no assignment get nothing; `RouteNotServedError` is handled the way `/phone-numbers` handles it.

Tests: the price field refuses a malformed amount before submitting, and an unpriced tier's default radio is disabled with the reason stated beside it rather than in a tooltip.

**Commit** `feat: price the tier catalog from the console`.

### Task 12: Tiers on the account detail

**Files:**
- Create: `app/(console)/accounts/[id]/tiers-form.tsx`, extend `actions.ts`
- Modify: `app/(console)/accounts/[id]/page.tsx`
- Test: `test/tiers-form.test.tsx`

One form, one Save, whole-set replace — matching the `PUT`. Add and remove rows locally; Save sends the set. The form states plainly that an account with no assignments is on the default tier, and names it.

**Commit** `feat: assign tiers and per-account rates from the account page`.

### Task 13: `/resources`

**Files:**
- Create: `app/(console)/resources/page.tsx`, `actions.ts`, `assignment-cell.tsx`, `map-form.tsx`
- Modify: `components/shell/sidebar.tsx`, `lib/types.ts`

Lists `GET /api/admin/resources` (cursor paged via `meta.next_cursor`), with a kind filter and in-place reassignment through the existing `POST /api/admin/resources/:kind/:externalId/assignment`. A **map form** takes kind + external id + workspace, because a `CONNECTION` has no mapping row until staff make one and so cannot appear in the listing first — which is the whole reason customers currently see "No integrations available yet".

**Commit** `feat: map pooled resources and tool connections to workspaces`.

### Task 14: Admin gate and docs

**Step 1:** `npx tsc --noEmit && npm run build && npm test`.
**Step 2:** Update `ye-voice-admin/CLAUDE.md` — the two new pages in the routes table, and the note that mapping a connection is the only way one becomes visible to a workspace.
**Step 3:** Commit.

---

## Finishing

1. Re-run all three gates from a clean state.
2. Print the migration SQL and **hold** — it is not applied to production. One `prisma migrate deploy` from `main` happens later.
3. `gh pr create --base main` for `ye-voice-backend` and `ye-voice-dashboard`. **Do not merge.**
4. `ye-voice-admin`: fast-forward its local `main` to `feat/tiers-wallet`. No PR.
5. Report what landed, what is held, and what the next slice inherits (the dialer, which calls `resolveTierRate`).
