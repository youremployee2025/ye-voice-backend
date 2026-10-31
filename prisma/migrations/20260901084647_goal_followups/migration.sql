-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "followUpDelayHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "goalKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "maxGoalFollowUps" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "maxTotalDials" INTEGER NOT NULL DEFAULT 6;

-- AlterTable
ALTER TABLE "CampaignContact" ADD COLUMN     "followUpCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "goalAchieved" BOOLEAN;

-- CreateTable
CREATE TABLE "CampaignContactGoal" (
    "id" TEXT NOT NULL,
    "campaignContactId" TEXT NOT NULL,
    "mergedExtraction" JSONB NOT NULL DEFAULT '{}',
    "attemptLog" JSONB NOT NULL DEFAULT '[]',
    "summaryNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignContactGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoNotCall" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT,
    "sourceCampaignContactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoNotCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContactGoal_campaignContactId_key" ON "CampaignContactGoal"("campaignContactId");

-- CreateIndex
CREATE UNIQUE INDEX "DoNotCall_workspaceId_phone_key" ON "DoNotCall"("workspaceId", "phone");

-- AddForeignKey
ALTER TABLE "CampaignContactGoal" ADD CONSTRAINT "CampaignContactGoal_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoNotCall" ADD CONSTRAINT "DoNotCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
