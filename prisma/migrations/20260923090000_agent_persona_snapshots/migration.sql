-- One side of an agent's persona, saved immediately before something writes
-- over it: a BI -> UNI move, a UNI -> BI revive, an inbound start reviving a
-- UNI agent's face, and a restore. A new, empty table: no backfill, and no
-- existing table is rewritten or scanned.
CREATE TYPE "PersonaSide" AS ENUM ('OUTBOUND', 'INBOUND');

CREATE TYPE "PersonaSnapshotReason" AS ENUM (
  'DIRECTION_UNI_KEEP_OUTBOUND',
  'DIRECTION_UNI_KEEP_INBOUND',
  'DIRECTION_BI_REVIVE',
  'INBOUND_START_REVIVE',
  'RESTORE'
);

CREATE TABLE "AgentPersonaSnapshot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "side" "PersonaSide" NOT NULL,
    "reason" "PersonaSnapshotReason" NOT NULL,
    "config" JSONB NOT NULL,
    "hooks" JSONB NOT NULL,
    "takenByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPersonaSnapshot_pkey" PRIMARY KEY ("id")
);

-- Leads with the foreign key, so it doubles as the FK index.
CREATE INDEX "AgentPersonaSnapshot_agentId_createdAt_idx" ON "AgentPersonaSnapshot"("agentId", "createdAt");

-- The prune: newest 20 per agent and side.
CREATE INDEX "AgentPersonaSnapshot_agentId_side_createdAt_idx" ON "AgentPersonaSnapshot"("agentId", "side", "createdAt");

ALTER TABLE "AgentPersonaSnapshot" ADD CONSTRAINT "AgentPersonaSnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
