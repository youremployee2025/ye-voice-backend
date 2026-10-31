import { getQueueConnection } from './connection.js';

/**
 * The `break` that a posted batch cannot have.
 *
 * When the dial loop was sequential, a rate limit or a supplier refusal met on
 * the third contact stopped the fourth: the loop broke, and the remainder of
 * the batch was handed back untouched. A batch that has already been posted
 * has no loop left to break — the jobs are in Redis and some of them are
 * running right now — so the signal has to travel the same way the jobs did.
 *
 * One key per batch, written by the first job to meet an account-wide wall and
 * read by every job before it dials. It is **advisory and best-effort**, and
 * saying so plainly matters: with four placements running at once, the jobs
 * already in flight when the marker is written will not see it. What it stops
 * is the tail of a batch bigger than the worker's concurrency, which is the
 * common shape of a large pass and the case worth stopping.
 *
 * It is not a correctness mechanism and nothing rests on it. A job that dials
 * into a refusal meets the same triage it would have met anyway — the contact
 * is given back whole, the campaign is paused once if it should be — so the
 * cost of missing the marker is one cheap failed request, not a lost contact.
 * Correctness is the claim in Postgres, here as everywhere else in this tree.
 */

/**
 * Long enough to outlive the batch that wrote it, short enough that a stale
 * one cannot matter. Batch ids are fresh per pass, so a marker that outlived
 * its batch is only occupying a key nobody will ask for.
 */
const HALT_TTL_SECONDS = 120;

const key = (batchId: string) => `ezo:dialer:halt:${batchId}`;

/** Records that this batch met a wall. First writer wins; the rest is noise. */
export async function markBatchHalted(batchId: string, reason: string): Promise<void> {
  await getQueueConnection().set(key(batchId), reason, 'EX', HALT_TTL_SECONDS, 'NX');
}

/** Why this batch stopped, or null if it has not. */
export async function readBatchHalt(batchId: string): Promise<string | null> {
  return getQueueConnection().get(key(batchId));
}
