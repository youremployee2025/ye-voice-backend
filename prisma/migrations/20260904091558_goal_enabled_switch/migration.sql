-- The goal becomes the switch it already was. See
-- `docs/plans/2026-09-04-goal-toggle-design.md`.

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "goalEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the predicate `hasGoal` used to apply to the prose: non-null
-- and not blank. `btrim` rather than `<> ''` because a goal of spaces was the
-- feature off, and a campaign carrying one must not switch on here.
--
-- One row per campaign, not per contact, so this is seconds at any size the
-- table reaches and needs no hand on it — unlike `contact_arm_kind`, whose
-- backfill walks CampaignContact.
UPDATE "Campaign"
SET "goalEnabled" = true
WHERE "goal" IS NOT NULL
  AND btrim("goal") <> '';

-- "goal" is deliberately NOT dropped. It is the operator's own statement of
-- what a campaign was for, nothing reads it from this release, and destroying
-- it in the same migration that stopped using it would leave no way back if
-- somebody does want it. A later release drops the column.
