-- The arming discriminator. See `ContactArmKind` in schema.prisma for why the
-- counters could not answer the question this column answers.

-- CreateEnum
CREATE TYPE "ContactArmKind" AS ENUM ('FRESH', 'RETRY', 'FOLLOW_UP', 'RESUME', 'CALLBACK');

-- AlterTable
ALTER TABLE "CampaignContact" ADD COLUMN     "armKind" "ContactArmKind" NOT NULL DEFAULT 'FRESH';

-- Backfill, scoped to PENDING rows. A settled contact is armed for nothing, and
-- every reader of this column pairs it with `status = 'PENDING'`, so the value
-- on a settled row is never read. Scoping the write keeps it off the large
-- majority of a campaign's rows.
--
-- Ordered most-specific first, and each step excludes what the previous one
-- claimed, so a contact that is both followed up and armed for a callback keeps
-- the arming that is actually in force.
--
-- There is no RESUME arm: the immediate-resume path ships in this same release,
-- so no existing row can have been armed by it.
--
-- One shape the counters cannot resolve: a contact that was followed up and
-- then re-armed by the retry ladder carries `followUpCount > 0` AND
-- `attempts > 0`, and nothing recorded which of the two set the clock that is
-- currently in force. It is backfilled FOLLOW_UP. That is the reading the
-- release being replaced already gave it — its ordering keyed on
-- `followUpCount > 0` alone — so the backfill is no worse than the behaviour
-- it inherits, and the row corrects itself the first time it is re-armed,
-- because from here every re-arm path writes this column outright.

UPDATE "CampaignContact"
SET "armKind" = 'CALLBACK'
WHERE "status" = 'PENDING'
  AND "callbackAt" IS NOT NULL
  AND "nextEligibleAt" = "callbackAt";

UPDATE "CampaignContact"
SET "armKind" = 'FOLLOW_UP'
WHERE "status" = 'PENDING'
  AND "armKind" = 'FRESH'
  AND "followUpCount" > 0;

UPDATE "CampaignContact"
SET "armKind" = 'RETRY'
WHERE "status" = 'PENDING'
  AND "armKind" = 'FRESH'
  AND "attempts" > 0;

-- The lanes claim on (campaign, status, armKind) and then order within the
-- lane, so the discriminator belongs beside the two columns already leading
-- every claim predicate.
CREATE INDEX "campaign_contacts_arm_lane_idx" ON "CampaignContact"("campaignId", "status", "armKind");
