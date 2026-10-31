-- The staff console's half of the ledger.
--
-- `CreditTransaction` already exists: the phone-numbers slice created it, with
-- the columns a machine-written DID charge needs. A staff correction needs two
-- more — the sentence explaining it, and whatever occasioned it outside this
-- system.

-- AlterTable
-- Both nullable, and deliberately: a renewal charge has its type to explain it
-- and no invoice to point at. `note` is required of a staff adjustment by the
-- route rather than by the column, for exactly that reason.
ALTER TABLE "CreditTransaction" ADD COLUMN     "note" TEXT,
ADD COLUMN     "reference" TEXT;

-- CreateIndex
-- The staff ledger listing filters by type and orders by time.
CREATE INDEX "CreditTransaction_type_createdAt_idx" ON "CreditTransaction"("type", "createdAt");

-- CreateIndex
-- What makes a retried adjustment a duplicate rather than a second correction.
--
-- Postgres treats NULLs as distinct in a unique index, so this constrains only
-- the rows that carry a reference — every machine-written row has none and is
-- untouched. Staff who genuinely mean to apply two corrections against one
-- ticket vary the reference; the point is that a resubmitted form cannot.
--
-- Plain rather than CONCURRENTLY: Prisma wraps a migration file in a
-- transaction and CONCURRENTLY cannot run inside one. The table is small and
-- new, so the SHARE lock this takes for the build is measured in milliseconds.
CREATE UNIQUE INDEX "CreditTransaction_accountId_reference_key" ON "CreditTransaction"("accountId", "reference");

-- A balance is a magnitude, and nothing may write it below zero.
--
-- The staff adjustment route refuses an overdraw itself, and now does so in the
-- same statement that applies it. This is the floor under that: a future writer
-- that forgets — a renewal sweep, a migration, a hand-run UPDATE — fails loudly
-- instead of leaving an account owing the platform money in a column that has
-- no way to express it.
--
-- NOT VALID, validated in the next migration, following the convention set by
-- `20260827090000_campaign_agent_fk`. It takes the lock only long enough to
-- record the constraint, and enforces on every insert and update from that
-- moment; the scan proving the pre-existing rows runs separately, without
-- holding ACCESS EXCLUSIVE across it.
SET lock_timeout = '3s';

ALTER TABLE "Account" ADD CONSTRAINT "Account_credits_nonnegative"
  CHECK ("credits" >= 0)
  NOT VALID;
