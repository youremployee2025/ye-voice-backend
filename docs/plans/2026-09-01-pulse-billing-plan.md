# Pulse Billing — Implementation Plan

**Goal:** billing increments end to end — a tier default and a per-account override, applied on the charge path, stored on every charge, and shown on both the staff console and the customer dashboard. Design: `2026-09-01-pulse-billing-design.md`.

**Architecture:** one additive migration (four nullable columns, two `CHECK` constraints), one widened precedence function, one widened `chargeFor`, two admin route bodies, four serializers, three console surfaces, two dashboard surfaces. Nothing is created and nothing is dropped.

**Tech stack:** existing — Express, TypeScript, Prisma, Zod, Vitest + Supertest; Next.js App Router on both front ends. No new dependencies.

**Test safety (read first):** tests run only against this worktree's own `TEST_DATABASE_URL` (`ye_voice_test_pulse_billing`), under the guard in `test/setup.ts`. Run vitest with `env -u DATABASE_URL -u TEST_DATABASE_URL` or from a shell that has never exported them — `dotenv` does not override an exported variable, and a stale export silently points the suite at another branch's database.

**Branches:** `feat/pulse-billing` in all three repos. Do not commit to any other branch; do not push.

**TDD:** every task writes its failing test first. The charge-path tasks (2, 3) assert exact BigInt values, never `toBeCloseTo`.

---

### Task 1: Schema — the four columns

**Files:** `prisma/schema.prisma`, new migration, `test/setup.ts` (no change expected — no new table).

1. Add `billingIncrementSecs Int?` to `Tier` and to `AccountTier`, with the schema comments from the design.
2. Add `billedSecs Int?` and `billingIncrementSecs Int?` to `CallAttempt`. `durationSecs` already exists — do not touch it.
3. `npx prisma migrate dev --name pulse_billing_increments`. **Check the generated directory name sorts last** among `prisma/migrations/`; this repo's migrations are dated ahead of the system clock, and one that sorts early applies out of order. Rename if it does not.
4. Hand-edit the migration to add the range constraints Prisma cannot express, and note them in the schema comment:
   ```sql
   ALTER TABLE "Tier" ADD CONSTRAINT "Tier_billingIncrementSecs_range"
     CHECK ("billingIncrementSecs" IS NULL OR ("billingIncrementSecs" BETWEEN 1 AND 600));
   ALTER TABLE "AccountTier" ADD CONSTRAINT "AccountTier_billingIncrementSecs_range"
     CHECK ("billingIncrementSecs" IS NULL OR ("billingIncrementSecs" BETWEEN 1 AND 600));
   ```
   No constraint on `CallAttempt.billingIncrementSecs`: it is a snapshot of a value that was already checked, and a settled charge must never be un-writable because staff later narrowed the range.
5. Apply to the test DB with `npm run test:prepare`.
6. Commit: `feat: record a billing increment on tiers, assignments and charges`.

### Task 2: Resolution — one chain, two values

**Files:** `src/lib/tierPricing.ts`, `test/tier-pricing.test.ts`.

1. Failing tests first, in a `resolveTierPricing` describe:
   - account override `30` beats tier default `60`;
   - tier default `60` applies with no override;
   - both null → `1`;
   - **override `1` beats tier default `60`** — the `??` guard, and the commercially real case;
   - the rate and the increment come from the same row: an account with a rate override and no increment override gets its own rate and the tier's increment;
   - an unpriced tier still throws `TierRateUnavailableError`, increment or not.
2. Keep the existing `resolveTierRate` describe passing by re-pointing it at the new function's `rateCreditsPerMin`, or delete it once every caller has moved — whichever leaves no function without a test.
3. Implement `TierPricing` and `resolveTierPricing`. One query. `??` at both links. Export `BILLING_INCREMENT_MIN = 1`, `BILLING_INCREMENT_MAX = 600`, and `parseBillingIncrement(value): number` throwing on a non-integer or out-of-range value — the bounds live beside the chain, so no route invents its own pair.
4. Update `agents.routes.ts` and `phoneNumbers.routes.ts` only if they called `resolveTierRate`; they call `tiersForAccount` / `assignedTiers`, which are untouched.
5. Commit: `feat: resolve a rate and its increment from one precedence chain`.

### Task 3: Pricing — round up, then truncate

**Files:** `src/lib/dialerPricing.ts`, `test/dialer-pricing.test.ts`.

1. Failing tests first. At rate `10_000n` per minute:
   - `61s @ inc 60` → `billedSecs 120`, cost `20_000n`;
   - `61s @ inc 1` → `billedSecs 61`, cost `10_166n`;
   - `5s @ inc 30` → `billedSecs 30`, cost `5_000n`;
   - `60s @ inc 60` → `billedSecs 60`, cost `10_000n` (an exact multiple does not round to the next pulse);
   - `0s` → `billedSecs 0`, cost `0n`, at every increment;
   - a negative duration → `0` / `0n`, as today;
   - the truncation rule survives: `chargeFor(1n, 30, 1)` is `0n`;
   - property: for a spread of durations and increments, `billedSecs >= durationSecs` and `billedSecs % incrementSecs === 0`.
   - `resolveCallRate` returns `incrementSecs` alongside the rate, resolved through the same chain.
2. Implement. Keep the stated-rule comment about truncation and **update it** to say that rounding up happens first and why the two directions are deliberate.
3. Commit: `feat: bill a call in increments and report the seconds charged`.

### Task 4: Charge path — snapshot and persist

**Files:** `src/services/dialer.ts`, `src/services/dialerOutcome.ts`, `test/dialer-outcome.test.ts`, `test/dialer-launch.test.ts`.

1. Failing tests first:
   - a launch snapshots `billingIncrementSecs` onto the `CallAttempt` from the resolved rate;
   - a 47-second call on a 60-second increment debits the account for a full minute and writes `billedSecs = 60`;
   - the `CALL_USAGE` ledger row's amount equals the pulse-billed cost, not the pro-rata one;
   - an attempt with a **null** snapshot bills per-second — the in-flight row from before this change;
   - a zero-duration call still writes no ledger row, still stamps `chargedAt`, and stores `billedSecs = 0`;
   - a shortfall stores `billedSecs` and `costCredits` as what was **owed**, unchanged in that respect.
2. Implement: one field in the insert, `?? 1` on the read, `billedSecs` in the existing `updateMany`. Change nothing about the marker, the locks, or the guards.
3. Commit: `feat: charge a call for its billed seconds, not its raw duration`.

### Task 5: Admin API — read and write the increment

**Files:** `src/routes/admin/tiers.routes.ts`, `src/lib/serialize.ts`, `test/admin-tiers.test.ts`.

1. Failing tests first:
   - `PATCH /api/admin/tiers/:id` sets, changes and clears (`null`) a tier's increment;
   - it rejects `0`, `601`, `1.5` and `"30"` with a 400 and **writes nothing**;
   - omitting either key leaves that column alone, and an empty body is still a 400;
   - `PUT /api/admin/accounts/:id/tiers` round-trips a per-row override, treats absent and null alike as "the tier default", and rejects an out-of-range row **before writing any row** — a body with one good and one bad row leaves the account exactly as it was;
   - `GET` on both routes returns the tier default, the override, and the resolved increment.
2. Implement. Both routes call `parseBillingIncrement` from `tierPricing.ts`; neither restates the bounds.
   - **Omission means "leave alone", in a comment on the schema:** that keeps the existing guarantee (a half-written body cannot unprice a tier) and strengthens it, and it is what lets the price editor and the increment editor stay two independent one-field writes that do not clobber each other's column.
3. Serializers: `billing_increment_secs` on the staff tier row; `billing_increment_secs`, `default_billing_increment_secs` and the resolved `increment_secs` on an assignment; the same on `default_tier`.
4. Commit: `feat: set and show a tier's billing increment from the staff API`.

### Task 6: Read routes — surface duration, billed seconds and increment

**Files:** `src/lib/serialize.ts`, `src/routes/admin/accounts.routes.ts`, `src/routes/phoneNumbers.routes.ts`, `test/billing-transactions.test.ts`, `test/admin-accounts.test.ts`, `test/call-serialize.test.ts`, `test/billing-plan.test.ts`.

1. Failing tests first:
   - a `CALL_USAGE` ledger row carries a `call` object with `duration_secs`, `billed_secs` and `billing_increment_secs`;
   - a row with no call (a grant, a DID rental) carries `call: null`, not an object of nulls;
   - a charge written before this change carries the object with `billed_secs: null` — **never `0`, never the duration**;
   - `serializeCallAttempt` emits `billed_secs` and `billing_increment_secs`;
   - `GET /:workspaceId/billing/plan` emits `billing_increment_secs` per tier, and `metered: true`.
2. Implement: `serializeLedgerRow` gains an optional `callAttempt` include and the `call` block; the four call sites add the include. `metered` becomes `true` and its comment is rewritten to say minutes *are* billed.
3. Commit: `feat: report actual and billed seconds on every charge`.

### Task 7: Staff console — tier editor

**Repo:** `ye-voice-admin`. **Files:** `lib/types.ts`, `app/(console)/tiers/actions.ts`, `app/(console)/tiers/increment-cell.tsx` (new), `app/(console)/tiers/page.tsx`.

1. `TierRow` gains `billing_increment_secs: number | null`.
2. `setTierIncrement(tierId, secs | null)` in `actions.ts`, through the same `report` funnel.
3. `IncrementCell`, modelled on `PriceCell`: an integer field, client-side bounds check before the round trip, and the **same moves-everyone warning naming the account count before the click**. A null value renders the field empty with the placeholder `Per second`, and the cell's read state says *per second* in words.
4. A column beside **List price**, header `Billing increment`. Update the explanatory paragraph under the table and drop the stale "nothing is charged per minute yet" sentence.
5. Commit: `feat: edit a tier's billing increment beside its list price`.

### Task 8: Staff console — account override and ledger

**Repo:** `ye-voice-admin`. **Files:** `lib/types.ts`, `lib/format.ts`, `app/(console)/accounts/[id]/tiers-form.tsx`, `app/(console)/accounts/[id]/actions.ts`, `app/(console)/billing/page.tsx`.

1. `AccountTierRow` and `LedgerRow` gain their new fields.
2. `TiersForm`: an increment input beside the rate input on each row, placeholder `Tier default: 30s` (or `Tier default: per second`), blank submitting as `null`. Same single Save, same whole-set replace. Update the paragraph's empty-means-default sentence to cover both fields.
3. `duration(secs)` in `lib/format.ts` — `m:ss`, and `—` for null.
4. Billing table: a **Call** column showing `0:47 billed as 1:00` when the two differ, one figure when they agree, `—` when the row is not a call, and *Not recorded* when it is a call from before this change.
5. Commit: `feat: override a billing increment per account and show it on the ledger`.

### Task 9: Customer dashboard

**Repo:** `ye-voice-dashboard`. **Files:** `lib/types.ts`, `lib/format.ts`, `app/(dash)/settings/billing/transactions-table.tsx`, `app/(dash)/settings/billing/plan-card.tsx`, plus their tests.

Additive only. The polish and campaign waves are in flight in this repo — touch nothing outside these files.

1. Failing tests first: a transaction row renders `0:47 billed as 1:00`; an equal pair renders once; a null `billed_secs` renders as not recorded, never `0:00`; the plan card renders *"Calls are billed in 30-second steps."* for 30, *"Calls are billed per second."* for 1 or null, and says nothing at all when the plan failed to load.
2. Implement. The plan card's `metered` branch keeps its two-state shape and gains the increment sentence; the "not billed yet" copy goes, because it is no longer true.
3. Commit: `feat: show what a call was billed for and the increment it was billed in`.

### Task 10: Verify

1. Backend: full `npx vitest run`. Per the repo's known cross-file bleed, **re-run any failing file in isolation** before treating it as a regression.
2. `npm run build` in all three repos; `npm run lint` where it exists.
3. Screenshots: the tier editor showing an increment mid-edit with its warning, and a ledger row reading actual against billed.
4. Commit any doc updates to the repos' `CLAUDE.md` route/schema tables.
