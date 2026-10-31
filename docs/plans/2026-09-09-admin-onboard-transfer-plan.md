# Onboard Customer and Transfer Account — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two staff endpoints and two console pages that create a ready-to-dial
customer in one form, and move an entire book of business between accounts in
one transaction.

**Architecture:** Design is in
`docs/plans/2026-09-09-admin-onboard-transfer-design.md`. Two services under
`src/services/`, one router under `src/routes/admin/`, three additive enum
values, and two Next.js pages that reach them through server actions.

**Tech stack:** Express + Prisma + Postgres 16 + zod + Vitest/supertest;
Next.js App Router + Tailwind + Vitest/Testing Library.

**Baseline (verified before starting):** backend 159 files / 3444 tests green,
admin 19 files / 185 tests green, `tsc --noEmit` clean in both.

**Worktrees:** `.worktrees/admin-onboard-transfer/{ye-voice-backend,ye-voice-admin}`,
branch `feat/admin-onboard-transfer` in both, own `node_modules`, dev DB
`ye_voice_onboard` (:5436) and test DB `ye_voice_onboard_test` (:5435).

---

## Task 1: Ledger types

**Files:** modify `prisma/schema.prisma`; create a migration; modify
`test/migration-data.test.ts` only if it enumerates the enum.

1. Add `ONBOARDING_TOPUP`, `ACCOUNT_TRANSFER_OUT`, `ACCOUNT_TRANSFER_IN` to
   `CreditTransactionType`, each with a doc comment saying what writes it and
   why it is not `ADJUSTMENT`.
2. `npx prisma migrate dev --name account_onboarding_and_transfer_ledger_types`
3. Read the generated SQL. It must be three `ALTER TYPE ... ADD VALUE` and
   nothing else. Postgres 16 permits these inside a transaction so long as the
   new values are not *used* in it; they are not.
4. `npm test -- test/migration-data.test.ts` → green.
5. Commit: `add ledger types for onboarding credit and account transfers`

## Task 2: `uniqueSlug` accepts a transaction client

**Files:** modify `src/lib/slug.ts`; test `test/slug.test.ts` (create).

The slug must be chosen on the same connection that writes the workspace, or
two concurrent onboards of one name both see the slug free.

1. Failing test: two `uniqueSlug` calls inside one `$transaction` against a
   workspace created in that transaction return different slugs.
2. Add an optional second parameter typed as the subset of the client it needs
   (`{ workspace: { findMany } }`), defaulting to the global `prisma`.
   `src/routes/workspaces.routes.ts` keeps calling it with one argument.
3. Green. Commit: `let uniqueSlug read through a caller's transaction`

## Task 3: Clerk provisioning adapter

**Files:** create `src/lib/clerkUsers.ts`.

```ts
export interface ProvisionedClerkUser {
  clerkUserId: string; name: string | null; imageUrl: string | null; created: boolean;
}
export async function findOrCreateClerkUser(email: string): Promise<ProvisionedClerkUser>
```

`clerkClient.users.getUserList({ emailAddress: [email] })` → take `data[0]` if
present, else `createUser({ emailAddress: [email], skipPasswordRequirement: true })`.
Wrap any thrown Clerk error in a `ClerkProvisioningError` carrying the address,
so the route answers 502 with a sentence rather than a stack trace.

No test of its own — it is a thin adapter over an SDK that cannot be exercised
without a network. Every consumer test mocks this module, which is the seam.

Commit: `add Clerk user provisioning for staff onboarding`

## Task 4: Export `addOneMonth` from the rental service

**Files:** modify `src/services/didRental.ts`.

Onboarding writes the same renewal date staff assignment does. Export the
existing helper rather than writing a second one — two functions computing a
billing date is two answers to one question.

Commit with Task 5.

## Task 5: The onboarding service

**Files:** create `src/services/onboarding.ts`; test `test/onboarding.test.ts`.

Write the tests first, all of them failing, then the service.

**Cases:**
- creates account, workspace, ADMIN membership, assigns agents and DIDs,
  credits the balance and writes one `ONBOARDING_TOPUP` row
- reuses an existing Account matched on email, case-insensitively, and never
  calls Clerk in that case
- calls Clerk exactly once for an unknown address, and adopts an existing Clerk
  user rather than creating a second
- assigns the DID with `rentedPriceCredits` = catalog price and a renewal a
  month out — the field set the renewal sweep reads
- refuses an agent already assigned to another workspace, and writes **nothing**
  (assert the workspace does not exist afterwards)
- refuses a DID already rented, and writes nothing
- refuses a retired tier
- refuses zero and negative credits
- a duplicate id in `agentIds` is a 400, not a silent count mismatch
- Clerk failing leaves no Account and no workspace

**Shape:** resolve the account (Clerk outside the transaction), then one
`prisma.$transaction(async (tx) => …)` doing workspace → membership → agents →
DIDs → credits+ledger → tier. Conditional `updateMany` with a `count`
assertion for agents and each DID. Typed errors (`AgentNotAvailableError`,
`PhoneNumberNotAvailableError`, `TierNotAssignableError`, `SlugTakenError`) so
the route owns the HTTP codes and the service owns the rules.

Commit: `add customer onboarding service`

## Task 6: The transfer service

**Files:** create `src/services/accountTransfer.ts`; test
`test/account-transfer.test.ts`.

`describeTransfer(sourceId, destId)` returns the preview; `transferAccount`
calls it inside its own transaction and then writes. Same function, so the
confirm step cannot promise something the write does not do.

**Cases:**
- moves every owned workspace, and with it campaigns, contacts, agents, DIDs
  (assert by re-reading through the destination, not by counting writes)
- source loses its membership rows on transferred workspaces; destination gains
  ADMIN on each
- a destination that was already a `MEMBER` is promoted to `ADMIN`, not
  duplicated
- non-owner members of a transferred workspace keep their rows and roles
- the whole balance moves and two ledger rows are written, each naming the
  other address
- a zero balance writes no ledger rows
- the source's existing ledger history stays on the source
- `AccountTier` rows move, except where the destination already holds that
  tier — those stay on the source and are reported
- `concurrencyLimit` is not touched on either account
- refuses source == destination
- refuses a source with no workspaces
- refuses a missing account on either side
- workspaces the source is only a *member* of are not transferred

Commit: `add account transfer service`

## Task 7: The routes

**Files:** create `src/routes/admin/customers.routes.ts`; modify
`src/routes/admin/index.ts`; test `test/admin-customers.test.ts`.

| Method | Path |
|---|---|
| POST | `/api/admin/customers/onboard` |
| GET | `/api/admin/account-transfers/preview` |
| POST | `/api/admin/account-transfers` |

zod schemas at the top. Codes: `VALIDATION_ERROR` 400, `NOT_FOUND` 404,
`AGENT_NOT_AVAILABLE` / `PHONE_NUMBER_NOT_AVAILABLE` / `WORKSPACE_SLUG_TAKEN` /
`CONCURRENT_MODIFICATION` 409, `TIER_NOT_ASSIGNABLE` 409, `SAME_ACCOUNT` /
`NO_WORKSPACES` 422, `CLERK_ERROR` 502.

Tests must include the staff-auth block every admin test file carries — each
route rejected without a token, and a customer identity rejected in its place.

Commit: `add staff onboarding and account transfer routes`

## Task 8: Console — onboard page

**Files (admin repo):** create `app/(console)/accounts/onboard/{page.tsx,onboard-form.tsx,actions.ts,loading.tsx}`;
modify `components/shell/sidebar.tsx`; test `test/onboard-form.test.tsx`.

Server component fetches unassigned agents, unassigned numbers and active
tiers in parallel and passes them down. Client form: email, workspace name,
multi-select agents and numbers, credits, tier. Says how many of how many each
picker shows. Validates in the browser as well as at the API — an operator
should learn that `1.5.2` is not an amount before the round trip, the rule the
tier price field already follows.

On success, render what was created with a link to the new workspace.

Commit: `add the onboard customer page`

## Task 9: Console — transfer page

**Files (admin repo):** create `app/(console)/accounts/transfer/{page.tsx,transfer-form.tsx,actions.ts,loading.tsx}`;
test `test/transfer-form.test.tsx`.

Two account pickers, a **Preview** button, then the preview sentence naming
both addresses and every count, the checkbox, and `ConfirmDialog` with
`confirmWord` set to the source's email address. The confirm button stays inert
until the preview has been fetched for the pair currently selected — changing a
picker clears it, so the sentence on screen always describes the pair the button
will act on.

Commit: `add the transfer account page`

## Task 10: Ledger filter correction

**Files (admin repo):** modify `app/(console)/billing/filters.tsx`.

Add the three new types and the four call/test-session types that have been
missing since call billing landed. Commit separately — it is a fix, not part of
either feature.

Commit: `list every ledger type in the billing filter`

## Task 11: Documentation

**Files:** modify `ye-voice-backend/CLAUDE.md` (admin routes table) and
`ye-voice-admin/CLAUDE.md` (pages table, and what each page claims).

Commit: `document the onboarding and transfer surfaces`

## Task 12: Verification

- backend: `npm test` — 3444 + new, zero failures. Re-run the two new files
  several times; the suite has a known cross-file flake rate, so a single green
  run of a new file proves less than it looks like.
- backend: `npx tsc --noEmit`
- admin: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`
- Manual: run the backend against the dev DB and drive both pages in a browser.
