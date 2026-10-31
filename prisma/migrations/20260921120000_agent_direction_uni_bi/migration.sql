-- An agent is uni-directional or bi-directional: one persona or two.
--
-- `OUTBOUND` and `INBOUND` were the same product fact — one configuration —
-- differing only in whether a face existed upstream, which is the platform's
-- plumbing rather than a choice a reader makes. Both collapse to `UNI`; the
-- face becomes something the backend creates lazily, the first time an
-- inbound campaign needs one. `BOTH` becomes `BI`.
--
-- Postgres cannot drop a value from an enum, so the type is replaced rather
-- than altered. `CREATE TYPE` is usable in the same transaction, unlike
-- `ALTER TYPE … ADD VALUE`, so the whole file runs as one.
CREATE TYPE "AgentDirection_new" AS ENUM ('UNI', 'BI');

-- The default has to go first: it is an expression of the OLD type, and the
-- column cannot change type underneath it.
ALTER TABLE "Agent" ALTER COLUMN "direction" DROP DEFAULT;

ALTER TABLE "Agent" ALTER COLUMN "direction" TYPE "AgentDirection_new"
  USING (CASE "direction"::text WHEN 'BOTH' THEN 'BI' ELSE 'UNI' END)::"AgentDirection_new";

ALTER TABLE "Agent" ALTER COLUMN "direction" SET DEFAULT 'UNI';

DROP TYPE "AgentDirection";
ALTER TYPE "AgentDirection_new" RENAME TO "AgentDirection";
