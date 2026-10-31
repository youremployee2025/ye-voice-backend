import { Worker } from 'bullmq';
import { createWorkerConnection } from '../connection.js';
import { QUEUE_NAMES, type CampaignCleanupJobData } from '../types.js';
import { closeStaleAttempts, releaseStaleClaims } from '../../../services/dialerReaper.js';
import { closeStaleTestSessions } from '../../../services/testSessionReaper.js';

/**
 * The reaper, given a second caller.
 *
 * `closeStaleAttempts` already runs inside every dispatch tick, and **it keeps
 * running there** — the tick's first act, on the tick's cadence, observed by
 * the conformance suite on that cadence. This queue does not take it over.
 * What it adds is a caller that is not the dispatch tick, for the one failure
 * the dispatch tick cannot cover: the instance that was going to run it is
 * gone.
 *
 * That case is new to this wave. A single-process deployment either had a
 * dialer or did not; with two instances, one can be SIGKILLed mid-batch,
 * holding claimed contacts and attempt rows it opened, and its ticks stop with
 * it. Five minutes is how long those sit before another instance frees them.
 *
 * Calling it twice is free by construction, which is what makes this safe to
 * add rather than a second writer to reason about. The sweep is a
 * compare-and-set over rows that have been stale longer than
 * `DIALER_ATTEMPT_TIMEOUT_MINS`: the second call finds nothing, and two
 * instances calling it at once means one of them finds nothing. No lock, no
 * leader, no coordination — the same reason the dispatch tick is safe to run
 * on every instance at once.
 */
export function createCampaignCleanupWorker(): Worker<CampaignCleanupJobData> {
  const worker = new Worker<CampaignCleanupJobData>(
    QUEUE_NAMES.CAMPAIGN_CLEANUP,
    async () => {
      const now = new Date();
      const closed = await closeStaleAttempts(now);
      // The other thing a killed instance leaves behind: contacts it claimed
      // whose placement jobs died with it, which have no attempt row for the
      // attempt sweep to reconcile. This is the "cleanup sweep gives it back"
      // the placement worker's design relies on.
      const released = await releaseStaleClaims(now);
      // The third thing left behind, and the only one that is not a campaign's:
      // a browser test session whose completion never arrived. It holds its
      // workspace's one live slot — so the Test button refuses with "already
      // running" when nothing is — and a line from the pool the dialer shares.
      // Free to call twice by the same compare-and-set argument above.
      const settled = await closeStaleTestSessions(now);

      // Silent when there was nothing stale, which is every pass on a healthy
      // deployment. A line per tick would make the one that matters invisible.
      if (closed > 0) console.log(`[cleanup] reconciled ${closed} stale attempt(s)`);
      if (settled > 0) console.log(`[cleanup] settled ${settled} stale test session(s)`);

      return closed + released + settled;
    },
    {
      connection: createWorkerConnection(),
      // One pass at a time. The sweep is bounded at fifty rows and idempotent,
      // so an overlap would be correct and pointless — it would read the same
      // fifty rows and ask the platform about them a second time.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[queue:${QUEUE_NAMES.CAMPAIGN_CLEANUP}] job ${job?.id ?? 'unknown'} ` +
        `attempt ${job?.attemptsMade ?? 0} failed:`,
      err,
    );
  });

  return worker;
}
