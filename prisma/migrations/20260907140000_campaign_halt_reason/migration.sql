-- Why a campaign is not dialing, in the words a customer reads. Written by
-- every writer of PAUSED, CREDIT_EXHAUSTED and STOPPED; cleared by start and
-- resume. Nullable, no default, no backfill: a campaign halted before this
-- column existed keeps its notification as the only record.
ALTER TABLE "Campaign" ADD COLUMN "haltReason" TEXT;
