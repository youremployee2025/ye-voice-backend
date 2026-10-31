-- Of the slots that reach the non-fresh side, the percent held for plain
-- retries. Defaulted to 0, which reproduces the ordering that predates the
-- split, so this migration re-paces no running campaign.
ALTER TABLE "Campaign" ADD COLUMN "retrySharePercent" INTEGER NOT NULL DEFAULT 0;
