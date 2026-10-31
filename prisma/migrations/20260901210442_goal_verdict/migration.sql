-- Everything below drops on the assumption that no goal campaign has run in
-- production: `goalKeys` and the three `CampaignContactGoal` context columns go
-- without being carried anywhere, because nothing can carry them. An
-- assumption a migration relies on is one it must check. `prisma migrate
-- deploy` runs unattended from `docker-entrypoint.sh`, so if the assumption is
-- wrong the choice is between a drop that silently destroys a customer's goal
-- configuration and a deploy that stops and says why — and only the second is
-- recoverable. A campaign carrying a key list, or any context row at all (only
-- a goal campaign ever writes one), is proof a goal campaign ran, and the
-- deploy fails here, before the first ALTER, with the whole file unapplied.
-- The remedy is a person's decision about those rows, then clearing them by
-- hand, then re-running the deploy; `docs/deploy.md` says how.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Campaign" WHERE cardinality("goalKeys") > 0) THEN
    RAISE EXCEPTION 'goal_verdict: refusing to drop "Campaign"."goalKeys" — a campaign still carries one, so a goal campaign has run and the assumption this migration rests on is wrong. Review them (SELECT id, name, "goalKeys" FROM "Campaign" WHERE cardinality("goalKeys") > 0), clear the column by hand once they have been dealt with, and re-run the deploy.';
  END IF;
  IF EXISTS (SELECT 1 FROM "CampaignContactGoal") THEN
    RAISE EXCEPTION 'goal_verdict: refusing to drop the "CampaignContactGoal" context columns — the table has rows, and only a goal campaign ever writes one. Review them, clear the table by hand once they have been dealt with, and re-run the deploy.';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "goalKeys",
ADD COLUMN     "goal" TEXT;

-- The three columns dropped below are dropped rather than carried forward
-- because nothing can carry them: `mergedExtraction` and `keyAttempts` are the
-- merged key/value context of the retired key-list predicate, and the goal
-- context is now a paragraph the bot writes in its own words — there is no
-- mechanical way to turn a bag of extracted values into that paragraph — while
-- `summaryNote` is superseded by `lastCallNote`, which EZO derives itself on
-- every recorded attempt. Only a goal campaign ever writes a
-- `CampaignContactGoal` row at all, and no goal campaign has run in
-- production, so on the production database this drops nothing.
-- AlterTable
ALTER TABLE "CampaignContactGoal" DROP COLUMN "keyAttempts",
DROP COLUMN "mergedExtraction",
DROP COLUMN "summaryNote",
ADD COLUMN     "goalMissing" TEXT,
ADD COLUMN     "lastCallNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "memory" TEXT,
ADD COLUMN     "memoryAttempt" INTEGER;

-- The do-not-call list is per campaign from here on, not per workspace, so the
-- table is replaced rather than altered: adding a NOT NULL `campaignId` to
-- existing rows has no right answer, because a workspace-wide opt-out belongs
-- to no one campaign.
--
-- What it must NOT do is destroy the old rows. They are not a goal-campaign
-- artefact that can be assumed empty the way the columns above can: the
-- opt-out is judged on every resolution of every campaign, ahead of the goal
-- gate, because the opt-out extraction set is attached to the AGENT and
-- nothing detaches it, while agents are many-to-one with campaigns. Any
-- campaign whose agent carries the key can therefore have written rows, goal
-- campaign or not, and every one of those rows is a person who asked not to be
-- called. The deploy runs `prisma migrate deploy` unattended, so a plain
-- `DROP TABLE` here would delete opt-outs with nobody watching.
--
-- So: if the table has any rows, it is renamed out of the way and left behind
-- as `DoNotCall_workspace_legacy` for an operator to review and drop by hand
-- once those numbers have been dealt with. If it is empty there is nothing to
-- preserve and it is simply dropped. Either way the new per-campaign list
-- starts empty.
--
-- An unconditional rename would leave a table behind on EVERY database,
-- including the shadow database Prisma replays this chain into — and a table
-- present in the migration chain but absent from `schema.prisma` is drift, so
-- the next `prisma migrate dev` on this branch would helpfully write
-- `DROP TABLE "DoNotCall_workspace_legacy"` into the following migration and
-- destroy on the next deploy exactly the rows this statement exists to save.
-- Preserving only when there is something to preserve keeps every clean
-- database (dev, test, CI, shadow) byte-identical to the datamodel, and
-- confines the deliberate, temporary drift to the one database that actually
-- holds opt-outs.
--
-- The pkey and the workspace foreign key are renamed along with the table so
-- the new table below can claim `DoNotCall_pkey` and its own constraint names;
-- the unique key is a plain unique index rather than a table constraint, so it
-- is renamed with ALTER INDEX. All three names are spelled here exactly as
-- `20260901084647_goal_followups` wrote them when it created the table, at its
-- lines 33 (`DoNotCall_pkey`), 46 (`DoNotCall_workspaceId_fkey`) and 40
-- (`DoNotCall_workspaceId_phone_key`) — one grep of that file checks all three,
-- and a rename of a name that does not exist would fail the whole deploy.
--
-- The lock is taken up front, rather than left to the one `DROP TABLE` would
-- acquire for itself, because the check and the act are two statements with a
-- gap between them. `prisma migrate deploy` runs as a pre-deploy step while the
-- PREVIOUS build is still serving, and that build writes an opt-out on call
-- resolution. Unlocked, `SELECT 1` could see an empty table, a concurrent
-- transaction could insert an opt-out and commit, and `DROP TABLE` — which
-- waits for that writer and then proceeds — would destroy the row the ELSE
-- branch had just satisfied itself was not there. Taking ACCESS EXCLUSIVE
-- before the read makes the check and the branch atomic against those writers,
-- and it also spares the ELSE path the lock upgrade it would otherwise do
-- halfway through.
DO $$
BEGIN
  LOCK TABLE "DoNotCall" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "DoNotCall") THEN
    ALTER TABLE "DoNotCall" RENAME TO "DoNotCall_workspace_legacy";
    ALTER TABLE "DoNotCall_workspace_legacy" RENAME CONSTRAINT "DoNotCall_pkey" TO "DoNotCall_workspace_legacy_pkey";
    ALTER TABLE "DoNotCall_workspace_legacy" RENAME CONSTRAINT "DoNotCall_workspaceId_fkey" TO "DoNotCall_workspace_legacy_workspaceId_fkey";
    ALTER INDEX "DoNotCall_workspaceId_phone_key" RENAME TO "DoNotCall_workspace_legacy_workspaceId_phone_key";
  ELSE
    DROP TABLE "DoNotCall";
  END IF;
END
$$;

-- CreateTable
CREATE TABLE "DoNotCall" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT,
    "sourceCampaignContactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoNotCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DoNotCall_campaignId_phone_key" ON "DoNotCall"("campaignId", "phone");

-- AddForeignKey
ALTER TABLE "DoNotCall" ADD CONSTRAINT "DoNotCall_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
