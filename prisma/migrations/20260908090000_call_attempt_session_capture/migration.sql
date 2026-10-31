-- What the platform sends about a finished call that this service was
-- discarding: the conversation, the variables the dial went out with, whether
-- audio exists, and the carrier's own billed duration.
--
-- Four nullable columns, no defaults and no backfill here. Null means the
-- attempt settled before these existed, or nobody has looked yet; a default
-- would turn every historical row into a claim nobody made. The backfill
-- script fills what upstream still holds.
--
-- No index on any of them. `transcript` and `variables` are read one row at a
-- time from a call already located by its own key, and an index on JSONB this
-- size would cost every dial a write to buy a lookup nobody performs.
ALTER TABLE "CallAttempt"
  ADD COLUMN "transcript" JSONB,
  ADD COLUMN "variables" JSONB,
  ADD COLUMN "recordingAvailable" BOOLEAN,
  ADD COLUMN "billDurationSeconds" INTEGER;
