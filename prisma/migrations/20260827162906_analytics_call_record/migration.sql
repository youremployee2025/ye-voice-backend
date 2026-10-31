-- CreateTable
CREATE TABLE "CallRecord" (
    "id" TEXT NOT NULL,
    "upstreamCallId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "agentId" TEXT,
    "direction" TEXT,
    "status" TEXT,
    "disposition" TEXT,
    "phone" TEXT,
    "startedAt" TIMESTAMP(3),
    "durationSecs" INTEGER,
    "creditsCharged" BIGINT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastStartedAt" TIMESTAMP(3),
    "lastCallId" TEXT,
    "coverageFrom" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunTruncated" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallRecord_upstreamCallId_key" ON "CallRecord"("upstreamCallId");

-- CreateIndex
CREATE INDEX "CallRecord_workspaceId_startedAt_idx" ON "CallRecord"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "CallRecord_workspaceId_disposition_idx" ON "CallRecord"("workspaceId", "disposition");

-- CreateIndex
CREATE INDEX "CallRecord_startedAt_idx" ON "CallRecord"("startedAt");
