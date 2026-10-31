-- The platform's own verdict on an attempt it ended before the carrier tested
-- the number: `error_code` / `error_message` off `session.completed` and
-- `call.status.updated`. Kept on the row so a journey can say why a dial
-- produced nothing, and read by the dial budget so such a dial spends none of
-- the contact's ladder.
ALTER TABLE "CallAttempt" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "CallAttempt" ADD COLUMN "errorMessage" TEXT;
