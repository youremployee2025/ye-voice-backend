-- AlterTable
ALTER TABLE "AccountTier" ADD COLUMN     "billingIncrementSecs" INTEGER;

-- AlterTable
ALTER TABLE "CallAttempt" ADD COLUMN     "billedSecs" INTEGER,
ADD COLUMN     "billingIncrementSecs" INTEGER;

-- AlterTable
ALTER TABLE "Tier" ADD COLUMN     "billingIncrementSecs" INTEGER;

-- The accepted range, as a constraint rather than as care.
--
-- Prisma's schema language cannot express a CHECK, so this is the only place
-- the bound is enforced by the database. Every write path already refuses an
-- out-of-range increment with a 400 — this is what makes that refusal true of
-- a hand-run UPDATE as well, and 1 is the floor because per-second billing IS
-- an increment (of one) rather than an absence of one.
--
-- 600 is ten minutes. Nothing plausible bills in a longer pulse, and an
-- increment longer than most calls turns a rate per minute into a flat fee
-- while still being labelled a rate.
--
-- NOT VALID is deliberately not used: both columns are new and every existing
-- row is NULL, so the validating scan is over a column that cannot fail it.
ALTER TABLE "Tier" ADD CONSTRAINT "Tier_billingIncrementSecs_range"
  CHECK ("billingIncrementSecs" IS NULL OR ("billingIncrementSecs" BETWEEN 1 AND 600));

ALTER TABLE "AccountTier" ADD CONSTRAINT "AccountTier_billingIncrementSecs_range"
  CHECK ("billingIncrementSecs" IS NULL OR ("billingIncrementSecs" BETWEEN 1 AND 600));

-- No constraint on "CallAttempt"."billingIncrementSecs". That column is a
-- snapshot of a value already checked when it was set, and a settled charge
-- must never become un-writable because staff later narrowed the range.
