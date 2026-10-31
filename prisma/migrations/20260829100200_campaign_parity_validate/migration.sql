-- Validates the two foreign keys re-added NOT VALID in the previous migration.
--
-- A separate file, and therefore a separate transaction, which is the whole
-- point: VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so the scan runs
-- while the sweep, the webhook pipeline and the call listings keep reading.
-- Folding it into the previous migration would reinstate exactly the ACCESS
-- EXCLUSIVE hold that splitting it bought us out of.
--
-- Both constraints have been enforced on every write since the instant they
-- were added, and the rows they cover satisfied the identical constraint
-- before it was dropped, so this is expected to find nothing. It runs anyway,
-- so the constraints are marked valid and the planner may rely on them.
ALTER TABLE "CallAttempt" VALIDATE CONSTRAINT "CallAttempt_campaignId_fkey";

ALTER TABLE "CallAttempt" VALIDATE CONSTRAINT "CallAttempt_campaignContactId_fkey";
