/**
 * Queue names and job payloads.
 *
 * A queue name is a key in Redis and therefore a compatibility surface: two
 * instances on different releases meet through these strings, and a rename is
 * a migration whether or not anyone calls it one. They live here, once.
 */

import type { AttemptKind } from '../attemptKind.js';

export const QUEUE_NAMES = {
  CAMPAIGN_DISPATCH: 'campaign-dispatch',
  CALL_PLACEMENT: 'call-placement',
  CAMPAIGN_CLEANUP: 'campaign-cleanup',
  WEBHOOK_PROCESSING: 'webhook-processing',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Repeatable jobs are identified by a stable id rather than by their position
 * in a list, because that id is what makes registering the same schedule from
 * ten instances produce one schedule instead of ten. Changing one of these
 * strings orphans the old schedule in Redis; it does not replace it.
 */
export const REPEATABLE_JOB_IDS = {
  CAMPAIGN_DISPATCH: 'campaign-dispatch-tick',
  CAMPAIGN_CLEANUP: 'campaign-cleanup-tick',
  SCHEDULE_SCAN: 'maintenance-schedule-scan',
  DID_RENEWAL: 'maintenance-did-renewal',
  ANALYTICS_SYNC: 'maintenance-analytics-sync',
  AGENT_SYNC: 'maintenance-agent-sync',
  WALLET_TOPUP_POLL: 'maintenance-wallet-topup-poll',
} as const;

/** The dispatch tick carries nothing: everything it needs is in Postgres. */
export interface CampaignDispatchJobData {
  readonly kind: 'dispatch-tick';
}

/**
 * One claimed contact, on its way to the phone.
 *
 * The contact is **already claimed** by the time this exists — the tick flipped
 * it to `QUEUED` inside the same statement that selected it. So this payload is
 * not a request to dial somebody, it is the continuation of a decision Postgres
 * already made and already holds. That is why the queue may lose it without
 * anybody being called twice, and why the cleanup sweep is the thing that
 * notices if it does.
 *
 * `batchId` groups the contacts one tick claimed for one campaign. It exists so
 * a halt observed while placing the third call can stop the fourth, which the
 * sequential loop this replaces did with a `break`.
 */
export interface CallPlacementJobData {
  readonly kind: 'place-call';
  readonly batchId: string;
  readonly campaignId: string;
  readonly contactId: string;
  /** The caller number this contact's turn in the rotation resolved to. */
  readonly fromNumberId: string;
  /**
   * Which dial of this contact's life this is, decided by the tick.
   *
   * **This is what makes a retried job unable to dial twice.** The attempt
   * row's unique `(campaignContactId, attemptNo)` is the dial's
   * mutual-exclusion token, and the reference the platform de-duplicates on
   * carries that row's id. Were the ordinal derived inside the worker as
   * "one more than the highest so far", a job that died after its insert
   * would come back, count one higher, insert a *second* row, and dial under
   * a reference the platform had never seen — the one thing a placement retry
   * must never do. Fixed here, at claim time, the retry re-inserts the same
   * pair, loses to the row it wrote itself, and reuses it.
   */
  readonly attemptNo: number;
  /**
   * What kind of dial this is — the contact's `armKind` as the claiming
   * statement read it, which is the lane that chose this row, carried so the
   * attempt can be stamped with it. Optional because jobs enqueued before this
   * field existed are still in Redis; a missing value stamps nothing and
   * readers fall back to the ordinal.
   */
  readonly attemptKind?: AttemptKind;
  /** The tick's clock, so a job placed late still reasons about its own pass. */
  readonly nowIso: string;
}

export interface CampaignCleanupJobData {
  readonly kind: 'cleanup-tick';
}

/**
 * A webhook the HTTP handler has already verified.
 *
 * Verification stays in the handler and never happens here: an unverified event
 * is rejected at the door and is never enqueued, so everything in this queue is
 * known to have come from the platform. What reaches the worker is the parsed
 * body and the event name, which is exactly what the inline path used.
 */
export interface WebhookProcessingJobData {
  readonly kind: 'webhook';
  readonly event: string;
  readonly data: Record<string, unknown>;
  /** When the handler accepted it, for measuring how far behind the queue is. */
  readonly receivedAtIso: string;
}

export type MaintenanceJobKind =
  | 'schedule-scan'
  | 'did-renewal'
  | 'analytics-sync'
  | 'agent-sync'
  | 'wallet-topup-poll';

export interface MaintenanceJobData {
  readonly kind: MaintenanceJobKind;
}
