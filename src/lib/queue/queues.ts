import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';
import {
  QUEUE_NAMES,
  type CallPlacementJobData,
  type CampaignCleanupJobData,
  type CampaignDispatchJobData,
  type MaintenanceJobData,
  type WebhookProcessingJobData,
} from './types.js';

/**
 * The five queues, and the retry policy each one is allowed to have.
 *
 * The policies are not uniform and must not be made uniform. Each says
 * something specific about what it is safe to do twice.
 */

/**
 * Ticks are not worth keeping. One fires every sweep period forever, and a
 * completed one says nothing a log line does not; `removeOnFail: 100` keeps
 * enough recent failures to see a pattern.
 *
 * No `attempts` here, so a failed tick is not retried — it does not need to
 * be. The next tick is along in a sweep period and reads the same rows, and a
 * retried tick would simply be an extra pass at an unhelpful moment.
 */
export const campaignDispatchQueue = new Queue<CampaignDispatchJobData>(
  QUEUE_NAMES.CAMPAIGN_DISPATCH,
  {
    connection: getQueueConnection(),
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 },
  },
);

/**
 * **Three attempts, and every retry reuses the same `client_reference_id`.**
 *
 * Retrying a dial is normally the one unforgivable move — a second telephone
 * call to a person who was already called. It is safe here for exactly one
 * reason: the platform treats `client_reference_id` as a per-account
 * idempotency key, and `/calls/start` answers a reference it has already seen
 * with the existing call (`idempotent_replay: true`) rather than dialing
 * again. So a retry can only do two things: place the call that never went
 * out, or learn what became of the one that did. Both are what a retry is
 * for. If the reference ever stopped being stamped, this policy would have to
 * go back to a single attempt the same day.
 *
 * A job that exhausts its attempts releases its contact back to the queue —
 * the existing transient-failure path in Postgres — so a dead dial strands
 * nothing. The dial-attempt row's mutual exclusion stays underneath as the
 * local backstop.
 *
 * Failures are kept 500 deep. A call that did not happen is the single most
 * useful thing in this system to be able to look at afterwards.
 */
export const callPlacementQueue = new Queue<CallPlacementJobData>(
  QUEUE_NAMES.CALL_PLACEMENT,
  {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  },
);

/**
 * Reconciliation, so retrying is free — the sweep is a compare-and-set over
 * rows that have been stale for longer than a threshold, and running it twice
 * finds nothing the second time.
 */
export const campaignCleanupQueue = new Queue<CampaignCleanupJobData>(
  QUEUE_NAMES.CAMPAIGN_CLEANUP,
  {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: 50,
    },
  },
);

/**
 * The one queue that genuinely wants an aggressive retry.
 *
 * The work behind a webhook is a charge, a contact resolution and possibly a
 * booked callback — all of it idempotent through the event keys the outcome
 * path already uses, and all of it something the customer is owed. Five
 * attempts over exponential backoff spans a few minutes, which covers a
 * database blip without holding a partner's sender open, because the handler
 * has already answered 200.
 */
export const webhookProcessingQueue = new Queue<WebhookProcessingJobData>(
  QUEUE_NAMES.WEBHOOK_PROCESSING,
  {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  },
);

/**
 * Slow, upstream-facing sweeps: DID renewal, the schedule scan, analytics
 * ingest. Three attempts over a long backoff, because the usual reason one
 * fails is that a partner API was briefly unavailable and the usual remedy is
 * to ask again in half a minute.
 */
export const maintenanceQueue = new Queue<MaintenanceJobData>(
  QUEUE_NAMES.MAINTENANCE,
  {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  },
);

/** Every queue, in the order the admin surface lists them. */
export const ALL_QUEUES = [
  campaignDispatchQueue,
  callPlacementQueue,
  campaignCleanupQueue,
  webhookProcessingQueue,
  maintenanceQueue,
] as const;

/**
 * Closes the queues, after the workers and before the connection.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all(ALL_QUEUES.map((queue) => queue.close()));
}
