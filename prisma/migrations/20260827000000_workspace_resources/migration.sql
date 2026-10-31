-- CreateEnum
CREATE TYPE "WorkspaceResourceKind" AS ENUM ('DOCUMENT', 'DICTIONARY', 'FUNCTION', 'CONNECTION');

-- CreateTable
CREATE TABLE "WorkspaceResource" (
    "id" TEXT NOT NULL,
    "kind" "WorkspaceResourceKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceResource_workspaceId_kind_idx" ON "WorkspaceResource"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceResource_kind_externalId_key" ON "WorkspaceResource"("kind", "externalId");

-- The FK below takes a SHARE ROW EXCLUSIVE lock on "Workspace". Validation is
-- free here (the referencing table is new and empty), but *acquiring* the lock
-- queues behind any long-running transaction, and everything wanting to write
-- "Workspace" then queues behind that. Failing after two seconds turns a stall
-- of unknown length into a migration to re-run.
SET lock_timeout = '2s';

-- AddForeignKey
ALTER TABLE "WorkspaceResource" ADD CONSTRAINT "WorkspaceResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
