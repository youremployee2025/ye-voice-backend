-- What an agent is FOR, and therefore whether it is edited as one persona or
-- two. EZO's own column: the platform has no equivalent, so sync never writes
-- it. `inboundEnabled` stays the platform's fact about whether a face exists.
CREATE TYPE "AgentDirection" AS ENUM ('OUTBOUND', 'INBOUND', 'BOTH');

ALTER TABLE "Agent"
  ADD COLUMN "direction" "AgentDirection" NOT NULL DEFAULT 'OUTBOUND';

-- An agent that already has a face is read as BOTH, which is the conservative
-- direction rather than the likeliest one: BOTH overwrites neither
-- configuration, where reading a face that merely happens to match its parent
-- as INBOUND would start syncing over it. Moving to a uni mode is a deliberate
-- act behind a confirm, so nothing here decides one for anybody.
UPDATE "Agent" SET "direction" = 'BOTH' WHERE "inboundEnabled" = true;
