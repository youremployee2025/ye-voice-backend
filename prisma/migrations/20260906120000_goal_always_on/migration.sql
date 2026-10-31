-- Goal follow-ups are always on now, and they no longer have a budget of
-- their own. The switch and the four knobs beside it have been taken off
-- every screen; the columns stay so nothing already written is lost, but the
-- engine reads none of them any more.
--
-- What the engine does instead, for every campaign:
--   * a contact's total dials are `retryCount + 1` — the first call plus the
--     retries the Retry Calls section already sets;
--   * an incomplete conversation is followed up until that budget runs out,
--     at the retry cooldown ladder's own wait;
--   * a dropped call is resumed after a fixed three minutes, at most once an
--     hour, unchanged in every other respect;
--   * a callback time the person actually asked for stays exempt from the
--     retry reservation, exactly as before.
--
-- Two writes, both one row per campaign: the defaults are moved so a row
-- created from now on says what the code does, and the existing rows are
-- brought to the same truth. `maxTotalDials`, `maxGoalFollowUps` and
-- `followUpDelayHours` are deliberately left alone — they are inert, and
-- rewriting them would destroy the settings an operator chose without buying
-- a single behavioral change.
--
-- No schema change and no index build, so this is safe to run unattended on
-- the first container start. Not reversible by re-running anything: the
-- previous `goalEnabled` values are not recorded anywhere.
ALTER TABLE "Campaign" ALTER COLUMN "goalEnabled" SET DEFAULT true;
ALTER TABLE "Campaign" ALTER COLUMN "immediateCallbackMinutes" SET DEFAULT 3;

UPDATE "Campaign" SET "goalEnabled" = true WHERE "goalEnabled" = false;
