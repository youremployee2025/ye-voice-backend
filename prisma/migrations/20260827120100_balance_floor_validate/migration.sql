-- Validates the CHECK added NOT VALID in the previous migration.
--
-- Separate file, and therefore a separate transaction, which is the point:
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so the scan runs while
-- reads and writes continue.
--
-- The constraint has been enforced on every new row since it was added; this
-- only proves the rows that predate it. If it fails, an account is already
-- carrying a negative balance and that is a fact worth stopping a deploy over.
ALTER TABLE "Account" VALIDATE CONSTRAINT "Account_credits_nonnegative";
