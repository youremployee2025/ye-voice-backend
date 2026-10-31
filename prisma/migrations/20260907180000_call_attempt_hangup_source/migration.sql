-- Who ended the call, beside the cause that says how.
--
-- Nullable with no default and no backfill here: null means the attempt
-- settled before this column existed, or the delivery did not carry the
-- field. Defaulting it to anything would turn every historical row into an
-- attribution nobody made. The backfill script fills what upstream still
-- knows; what it cannot reach stays null and reads as unattributed.
ALTER TABLE "CallAttempt" ADD COLUMN "hangupSource" TEXT;
