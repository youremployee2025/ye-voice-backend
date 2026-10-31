-- What a finished call's post-call extraction returned, kept.
--
-- Nothing stored it before: the callback path read `callback_requested_at`
-- straight off the delivery and threw the rest away. Lead buckets are computed
-- at READ time from what a call actually returned, so that changing which key
-- a campaign buckets on re-reads history rather than only affecting calls
-- placed after the change — and that is only possible if the answers survive
-- the delivery that carried them.
--
-- Nullable with no default, so this is a catalog-only change: Postgres does not
-- rewrite the table and existing rows read NULL, which is the honest value for
-- a call whose answers nobody kept. The lock is held for the length of the
-- catalog update alone, and `lock_timeout` bounds the wait for it rather than
-- letting one long-running read on this hot table queue every writer behind us.
SET lock_timeout = '3s';

ALTER TABLE "CallAttempt" ADD COLUMN "extraction" JSONB;
