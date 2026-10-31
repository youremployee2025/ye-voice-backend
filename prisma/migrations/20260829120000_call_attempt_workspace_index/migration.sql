-- Analytics reads `CallAttempt` by workspace and date on every query it runs:
-- the totals groupBy, the duration aggregate, the credits ledger join, the
-- per-campaign rollup, the daily series union and the CSV export's keyset walk.
--
-- Postgres does not index a foreign key column on its own, so without this each
-- of those scans a table holding every workspace's attempts. The export is the
-- worst of them — it pages with ORDER BY "startedAt" DESC, "id" DESC LIMIT 500
-- under a bare "workspaceId" predicate, so every page is a sequential scan plus
-- a top-N sort and the walk as a whole is quadratic in the workspace's history.
CREATE INDEX "CallAttempt_workspaceId_startedAt_idx" ON "CallAttempt"("workspaceId", "startedAt");
