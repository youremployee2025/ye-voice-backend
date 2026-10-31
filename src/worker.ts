// First, before anything that logs. The sweeps this process runs are the
// loudest sources of phone numbers in the codebase — the DID renewal sweep
// names a number in every line it writes, and the dialer names a contact.
// Without this import they would log unstructured and unmasked, and a split
// deployment would ship nothing from the half doing the dialing.
import './lib/logger.js';

import { startWorkers, stopWorkers } from './lib/queue/bootstrap.js';
import { startCampaignAgentSweep } from './services/campaignAgentSweep.js';

/**
 * The background workers, as their own process.
 *
 * There is no recurring work here, and that is the point the whole wave was
 * heading for. Every sweep this file used to hold — the dial sweep, the
 * schedule scan, the DID renewal, the analytics ingest — is a job on a queue
 * now, and the one composition of those workers lives in
 * `lib/queue/bootstrap.ts`. `server.ts` reaches the same function behind
 * `WORKERS_ENABLED`. Neither repeats the list, because two lists of workers is
 * how one of them silently loses a member.
 *
 * The one call below that is not a queue is the campaign-agent boot sweep, and
 * it is not a schedule: it is a thing that happens once because a process
 * started, which is the only kind of work a queue cannot express.
 *
 * **This process serves no HTTP**: it builds no app and opens no port, and a
 * test asserts that by reading this file.
 *
 * A worker-only deployment is therefore a configuration change rather than a
 * code change: run this entry point, and set `WORKERS_ENABLED=false` on the
 * API service. The API can then be restarted without interrupting a sweep, and
 * a crash in one is not a crash in the other.
 *
 * **A second instance shares the work rather than repeating it** — the
 * recurring schedules are deduplicated in Redis and everything else is claimed
 * with `FOR UPDATE SKIP LOCKED`. What it still does not buy is upstream
 * capacity: the per-minute call-start window, the concurrency pool and the
 * supplier balance are properties of the one partner account every YE
 * customer and every other integrator draws from. Two instances share that
 * ceiling; they do not each get one.
 */

/**
 * A rejection that escapes a job is logged loudly and does **not** end the
 * process — the same reversal of Node's default that `server.ts` makes, and
 * for the same reason. Every queue has a failure policy, and the process
 * staying up is what lets that policy run. `uncaughtException` is left alone.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection (logged, continuing):', reason);
});

await startWorkers();

/**
 * The one piece of work this process does that is not a queue: bringing the
 * agents of campaigns that were already RUNNING at deploy onto this release's
 * extraction contract.
 *
 * It is here rather than on a queue because it is a property of a process
 * starting, not of a schedule — and it is deliberately started *after* the
 * workers rather than before them, because it must never be able to hold the
 * boot open or fail it. `startCampaignAgentSweep` does not await, gates itself
 * on whether this process does background work at all, and swallows what it
 * cannot fix into a log line. The module header says what the window costs.
 */
startCampaignAgentSweep();

/**
 * Shutdown, in the one order that does not produce errors on the way out.
 * `stopWorkers` closes workers, then queues, then the connection; there is no
 * HTTP server here to close first.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[shutdown] ${signal} received; draining.`);

  try {
    await stopWorkers();
  } catch (err) {
    console.error('[shutdown] error while stopping workers:', err);
  }

  console.log('[shutdown] complete.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
