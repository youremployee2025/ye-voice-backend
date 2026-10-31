-- The workspace agent-refresh cooldown moves off the agent rows and onto the
-- workspace. Deriving it from `Agent.lastSyncedAt` made it a record of the last
-- *success*, so a workspace holding one unreachable agent never satisfied the
-- check and lost its throttle entirely.
ALTER TABLE "Workspace" ADD COLUMN "lastAgentSyncAt" TIMESTAMP(3);
