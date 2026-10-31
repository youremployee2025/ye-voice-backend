-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "agentType" TEXT,
    "voiceId" TEXT,
    "voiceName" TEXT,
    "language" TEXT,
    "documentCount" INTEGER,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "rawConfig" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_externalId_key" ON "Agent"("externalId");

-- CreateIndex
CREATE INDEX "Agent_workspaceId_idx" ON "Agent"("workspaceId");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
