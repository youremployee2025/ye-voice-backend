import { Worker } from 'bullmq';
import { createWorkerConnection } from '../connection.js';
import { QUEUE_NAMES, type CampaignDispatchJobData } from '../types.js';
import { runDialerSweep } from '../../../services/dialer.js';

/**
 * The dial sweep, on a queue instead of a timer.
 *
 * **The tick logic is unchanged.** This worker's whole body is a call to
 * `runDialerSweep`, the same function the `setInterval` called and the same
 * function the conformance harness drives directly. Nothing about claiming,
 * lane budgets, the dialing window or the concurrency caps is re-implemented
 * here, and nothing should ever be: those live in Postgres behind
 * `FOR UPDATE SKIP LOCKED`, which is the single enforcement point and the only
 * reason it is safe to run this on more than one instance at once.
 *
 * What the queue replaces is the `setInterval` and the `let running = false`
 * that guarded it. Concurrency 1 is that guard, and it is a stronger one: the
 * timer's version could only stop a pass overlapping *itself in that process*,
 * while this also stops the schedule firing twice across instances, because
 * the repeatable is registered under one key in Redis.
 *
 * Two instances each running this worker is still two concurrent sweeps, and
 * that is fine and intended — the second claims what the first did not. It is
 * `SKIP LOCKED` that makes it fine, not the queue.
 */
export function createCampaignDispatchWorker(): Worker<CampaignDispatchJobData> {
  const worker = new Worker<CampaignDispatchJobData>(
    QUEUE_NAMES.CAMPAIGN_DISPATCH,
    async () => {
      const result = await runDialerSweep();

      const { posted, paused, completed, reaped, skippedNotAllowlisted, halted } = result;

      /**
       * `posted`, not `launched`, because the tick no longer waits to find out.
       * What became of each of these is the placement worker's line to write,
       * one per claim that did not become a call.
       */
      if (posted || paused || completed || reaped || skippedNotAllowlisted || halted) {
        console.log(
          `[dialer] posted=${posted} paused=${paused} completed=${completed} ` +
            `reaped=${reaped} skipped=${skippedNotAllowlisted}` +
            (halted ? ` HALTED=${halted}` : ''),
        );
      }
    },
    {
      connection: createWorkerConnection(),
      // One pass at a time. A pass that outlives its interval must not be
      // joined by the next: overlapping passes stay correct — the claim sees
      // to that — but they pile upstream requests onto the rate limit that is
      // already the reason the pass is slow.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[queue:${QUEUE_NAMES.CAMPAIGN_DISPATCH}] job ${job?.id ?? 'unknown'} ` +
        `attempt ${job?.attemptsMade ?? 0} failed:`,
      err,
    );
  });

  return worker;
}
