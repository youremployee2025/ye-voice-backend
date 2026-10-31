-- The conversation and the recording flag on an inbound call, the two session
-- facts the completion webhook already carries and the inbound settle dropped.
-- Both nullable with no default: null is "nothing has looked yet", which the
-- backfill keys on, and a default would erase that distinction on every row.
ALTER TABLE "CampaignInboundCall"
  ADD COLUMN "transcript" JSONB,
  ADD COLUMN "recordingAvailable" BOOLEAN;
