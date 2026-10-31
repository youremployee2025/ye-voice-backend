import { Worker } from 'bullmq';
import { createWorkerConnection } from '../connection.js';
import { QUEUE_NAMES, type WebhookProcessingJobData } from '../types.js';
import { processWebhookEvent } from '../../../services/webhookOutcome.js';

/**
 * The work a verified webhook asks for, off the request path.
 *
 * The one queue here that genuinely wants an aggressive retry. Behind a
 * delivery is a charge, a contact resolution and possibly a booked callback —
 * every part of it owed to a customer, and every part of it idempotent through
 * the event key the outcome path writes inside the same transaction as the
 * charge. Five attempts over exponential backoff spans a few minutes, which
 * covers a database blip; the sender is not waiting for any of it, because the
 * handler answered 200 the moment the job was durable.
 *
 * A delivery that never lands even then is not lost: the reaper reconciles the
 * attempt against the platform's own record, which is the recovery path that
 * existed before this queue did and is why no new table was needed to hold
 * events in flight.
 */
export function createWebhookProcessingWorker(): Worker<WebhookProcessingJobData> {
  const worker = new Worker<WebhookProcessingJobData>(
    QUEUE_NAMES.WEBHOOK_PROCESSING,
    async (job) => processWebhookEvent(job.data),
    {
      connection: createWorkerConnection(),
      /**
       * One at a time, and for the reason the placement worker is: order.
       *
       * A single call's events arrive as a sequence — ringing, in progress,
       * terminal, then the completion that charges — and the platform sends
       * them in that order. The handlers are written to tolerate a reordering
       * (the status write only ever moves forwards, and whichever event first
       * carries a classification resolves the contact), but tolerating one is
       * not a reason to manufacture one. Four workers would reorder a single
       * call's own events against each other, which the sender never does.
       *
       * The work is a short transaction, so one lane is a few hundred events a
       * second. When that is not enough, the answer is another instance — the
       * same answer as everywhere else in this tree.
       */
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[queue:${QUEUE_NAMES.WEBHOOK_PROCESSING}] ${job?.data?.event ?? 'unknown'} job ` +
        `${job?.id ?? 'unknown'} attempt ${job?.attemptsMade ?? 0} failed:`,
      err,
    );
  });

  return worker;
}
