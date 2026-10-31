import type { Worker } from 'bullmq';
import { env } from '../env.js';
import { closeQueueConnection, closeWorkerConnections } from './connection.js';
import { closeQueues } from './queues.js';
import { registerRepeatableJobs } from './repeatable.js';
import { createCampaignDispatchWorker } from './workers/campaign-dispatch.worker.js';
import { createCallPlacementWorker } from './workers/call-placement.worker.js';
import { createCampaignCleanupWorker } from './workers/campaign-cleanup.worker.js';
import { createMaintenanceWorker } from './workers/maintenance.worker.js';
import { createWebhookProcessingWorker } from './workers/webhook-processing.worker.js';

/**
 * The one composition of the background workers.
 *
 * There is exactly one list of workers and this file holds it, for the reason
 * the timer version gave: two lists of workers is how one of them silently
 * loses a member. `server.ts` reaches this behind `WORKERS_ENABLED`;
 * `worker.ts` is a one-line entrypoint over the same function. Neither
 * repeats the list.
 *
 * That shape is also what makes a worker-only deployment a configuration
 * change later rather than a code change: a process that calls `startWorkers`
 * and never listens on a port already exists, and the API service turning its
 * workers off is one environment variable.
 */

/** Every worker this process is running, in creation order. */
let workers: Worker[] = [];

/**
 * The factories, in the order they are started.
 *
 * Imported explicitly rather than self-registered from each worker module. A
 * module that adds itself to a list as a side effect of being imported is a
 * module that silently does nothing the day someone stops importing it, and
 * the symptom is a sweep that quietly never runs.
 */
const WORKER_FACTORIES: Array<() => Worker> = [
  createCampaignDispatchWorker,
  createCallPlacementWorker,
  createCampaignCleanupWorker,
  createMaintenanceWorker,
  createWebhookProcessingWorker,
];

/**
 * Creates the workers, then registers the recurring schedules.
 *
 * Workers first, deliberately. Registering a schedule before anything can
 * consume it leaves jobs accumulating in `waiting` for however long the boot
 * takes — harmless at one instance, and an unhelpful spike on the queue-depth
 * panel at ten.
 */
export async function startWorkers(): Promise<void> {
  if (workers.length > 0) return;

  announceDialingState();

  workers = WORKER_FACTORIES.map((create) => create());

  await registerRepeatableJobs();

  console.log(`[workers] started ${workers.length} worker(s)`);
}

/**
 * The dialing state, logged rather than left to be inferred.
 *
 * Said here because this is the one place both entry points pass through. An
 * operator must be able to read the first few lines of a log and know whether
 * this process can dial, how bounded it is, and whether an allowlist is
 * holding it to a handful of numbers. The alternative is finding out from a
 * phone bill.
 */
function announceDialingState(): void {
  if (!env.dialerEnabled) {
    console.log('[dialer] disabled. No campaign will dial. Set DIALER_ENABLED=true to turn it on.');

    return;
  }

  const allowlist = env.dialerTestAllowlist.size;

  console.log(
    `[dialer] ENABLED — sweep every ${env.dialerSweepMs}ms, ` +
      `at most ${env.dialerMaxCallsPerSweep} call(s) per pass, ` +
      (allowlist > 0
        ? `restricted to ${allowlist} allowlisted number(s).`
        : 'NO test allowlist: every campaign contact is dialable.'),
  );
}

/**
 * Shuts down in the one order that does not produce errors on the way out:
 * **workers, then their connections, then queues, then the shared
 * connection.**
 *
 * Workers first so an in-flight job finishes, or is returned to its queue,
 * rather than being cut off partway — for `call-placement` that is the
 * difference between a call that completes and an attempt row nobody ever
 * resolves. The workers' dedicated connections next: BullMQ treats a supplied
 * instance as shared and leaves it open on `worker.close()`, so skipping this
 * step strands five live sockets holding the event loop of any caller that
 * does not `process.exit()`. Queues after that, because a queue writing to a
 * closed socket logs like a crash. The shared connection last, when nothing
 * is left to use it.
 */
export async function stopWorkers(): Promise<void> {
  const running = workers;
  workers = [];

  await Promise.all(running.map((worker) => worker.close()));
  await closeWorkerConnections();
  await closeQueues();
  await closeQueueConnection();

  if (running.length > 0) console.log('[workers] stopped');
}
