-- The immediate-resume throttle's anchor. See `CampaignContact.lastImmediateAt`
-- in schema.prisma. Nullable with no default and no backfill: a contact that
-- has never been resumed reads as "no throttle", which is what every existing
-- row is.

-- AlterTable
ALTER TABLE "CampaignContact" ADD COLUMN     "lastImmediateAt" TIMESTAMP(3);
