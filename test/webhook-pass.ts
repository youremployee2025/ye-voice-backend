import { processWebhookEvent } from '../src/services/webhookOutcome.js';
import { webhookProcessingQueue, closeQueues } from '../src/lib/queue/queues.js';
import { closeQueueConnection } from '../src/lib/queue/connection.js';

/**
 * A delivery, all the way through.
 *
 * The handler verifies a webhook and enqueues it; the work — the charge, the
 * contact resolution, the callback — happens on a worker. What these cases
 * grade is the whole of that, exactly as they did when it ran on the request
 * thread, so this is where the two halves are put back together.
 *
 * Through **the real queue and the real processor**: the handler writes to
 * Redis and this reads what it wrote. What is left out is only BullMQ's worker
 * loop, which the conformance harness runs for real.
 *
 * In order, one at a time, which is also how the worker runs them — a single
 * call's events are a sequence, and the sender emits them in that order.
 */
export async function drainWebhooks(): Promise<number> {
  let ran = 0;

  for (;;) {
    const jobs = await webhookProcessingQueue.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1);

    if (jobs.length === 0) return ran;

    jobs.sort((a, b) => Number(a.id) - Number(b.id));

    for (const job of jobs) {
      await processWebhookEvent(job.data);
      await job.remove();
      ran += 1;
    }
  }
}

/** Empties the queue between cases, so no delivery inherits another's. */
export async function clearWebhooks(): Promise<void> {
  await webhookProcessingQueue.obliterate({ force: true });
}

/** Closes the queue's Redis handles, so the file's worker can exit. */
export async function closeWebhookQueue(): Promise<void> {
  await closeQueues();
  await closeQueueConnection();
}
