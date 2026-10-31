import { Prisma } from '@prisma/client';
import { getCall } from '../adapter/vocobase.js';
import { prisma } from '../lib/prisma.js';
import { boundTranscript, boundVariables } from '../lib/sessionCapture.js';
import { readNumber, readRecord, readString } from '../lib/upstream.js';

/**
 * Recovering the session facts for calls that settled before the columns
 * existed: the conversation, the variables the dial went out with, whether
 * audio exists, and the carrier's own billed duration.
 *
 * **This one reads the DETAIL, and that is the whole shape of it.** The call
 * listing carries no transcript, no variables and no recording — the
 * call-history design says so explicitly — so unlike the hangup-source walk
 * this is **one upstream request per call** rather than one per hundred. That
 * cost is why it is an operator script scoped to one campaign, with a budget
 * and a resume, rather than a background job.
 *
 * The shape is the re-extraction tool's, which already walks a campaign
 * fetching one session per contact and is proven at Touchbase scale: bounded
 * concurrency, a cap, and a run that can be stopped and restarted on the same
 * command without redoing what it did.
 *
 * **Fills absences only**, which is what makes the resume free: an attempt
 * that already carries a conversation is not fetched at all, so a re-run costs
 * nothing for the rows a previous run finished. The webhook is the fresher
 * source and writes the same columns at settle time; overwriting would churn
 * every row on each pass.
 */

/** Calls fetched at once. The re-extraction tool's number, for the reason it
 *  chose it: enough to be quick, few enough not to be a burst against a rate
 *  limit every customer on the platform shares. */
export const BACKFILL_CONCURRENCY = 4;

/** Calls one run will fetch before stopping and saying so. */
export const BACKFILL_MAX_CALLS = 20_000;

export interface SessionBackfillOptions {
  /** The campaign to recover. Required — see the refusal below. */
  campaignId: string;
  maxCalls?: number;
  concurrency?: number;
  /** Progress, so a long run says something while it runs. */
  onProgress?: (progress: { fetched: number; filled: number; gone: number; pending: number }) => void;
}

export interface SessionBackfillResult {
  /** Attempts considered — those with a call id and something still missing. */
  candidates: number;
  /** Calls actually fetched from the platform. */
  fetched: number;
  /** Attempts this run wrote facts onto. */
  filled: number;
  /**
   * Calls whose post-call processing had not finished, left untouched for a
   * later run. Expected at the head of a walk over a campaign that is still
   * dialing, and the figure to re-run against once it stops.
   */
  pending: number;
  /** Calls the platform no longer has. Pruned, or never really placed. */
  gone: number;
  /** The budget ran out before the campaign did. */
  truncated: boolean;
}

/**
 * What one call detail yields, or null when there is nothing worth writing.
 *
 * Null covers two different situations and the caller reports them
 * differently: a call with no session at all, and a call whose post-call
 * processing has not finished.
 */
function factsFrom(call: unknown): Prisma.CallAttemptUpdateInput | null {
  const session = readRecord(call, ['session']);

  // A call with no session at all: nothing here to recover. Distinguished from
  // a session with an empty transcript, which is a real answer.
  if (!session) return null;

  /**
   * **The transcript and the recording arrive after the call ends**, which is
   * what this flag is for. Captured mid-processing a call yields a null
   * transcript and no recording url, and storing those would be wrong twice:
   * the row would claim a call has no conversation and no audio when it has
   * both, and `recordingAvailable` is the marker that stops this walk ever
   * looking at the row again — so the wrong answer would be permanent.
   *
   * Read strictly. An absent flag is NOT taken as finished: this is the one
   * place where guessing costs a call its conversation for good, and a call
   * left for the next run costs only one more request.
   */
  if (session.processing_complete !== true) return null;

  return {
    // `DbNull` rather than leaving the key out: this run LOOKED, and a call
    // that never connected genuinely has no conversation. Writing SQL NULL
    // records that, where omitting the key would leave the row looking
    // un-backfilled and make the next run fetch it again for ever.
    transcript: boundTranscript(session.transcript) ?? Prisma.DbNull,
    variables: boundVariables(readRecord(session, ['variables']) ?? {}) ?? Prisma.DbNull,
    // The FLAG, never the URL. A presigned link expires in seven days and is a
    // bearer credential for a customer's call audio that outlives any
    // membership check; the bytes are served through this service against a
    // freshly minted one.
    recordingAvailable: readString(session, ['recording_url', 'recordingUrl']) !== null,
    billDurationSeconds: readNumber(call, ['bill_duration_seconds', 'billDurationSeconds']),
  };
}

export async function backfillSessionFacts(
  options: SessionBackfillOptions,
): Promise<SessionBackfillResult> {
  // One campaign at a time, refused rather than defaulted. A walk that costs a
  // request per call must never be pointed at the whole platform by somebody
  // leaving an argument out — the same reason the re-extraction tool refuses
  // to run without one.
  if (!options.campaignId) {
    throw new Error('A campaign id is required: this walk costs one upstream request per call.');
  }

  const maxCalls = Math.max(1, options.maxCalls ?? BACKFILL_MAX_CALLS);
  const concurrency = Math.max(1, options.concurrency ?? BACKFILL_CONCURRENCY);

  /**
   * The attempts worth fetching: a real call id, and nothing recovered yet.
   *
   * `recordingAvailable IS NULL` is the marker rather than `transcript`,
   * because a call that never connected legitimately stores a null transcript
   * — keyed on that, every silent dial would be re-fetched on every run for
   * ever. The boolean is written on every successful recovery whatever the
   * conversation turned out to be, so it is the one column that means "this
   * row has been looked at".
   */
  const candidates = await prisma.callAttempt.findMany({
    where: {
      campaignId: options.campaignId,
      upstreamCallId: { not: null },
      recordingAvailable: null,
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, upstreamCallId: true },
  });

  const wanted = candidates.slice(0, maxCalls);

  let fetched = 0;
  let filled = 0;
  let gone = 0;
  let pending = 0;

  for (let i = 0; i < wanted.length; i += concurrency) {
    const batch = wanted.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (row) => {
        // An upstream failure propagates and ends the run, the rule every walk
        // here holds: a short walk reported as a complete one leaves an
        // operator with no reason to run it again. `getCall` already draws the
        // one distinction that matters — `null` is the platform being certain
        // there is no such call, and everything else throws.
        const call = await getCall(row.upstreamCallId!);

        fetched += 1;

        if (call === null) {
          // Pruned upstream, or a call that never really existed. A fact about
          // this call rather than a failure of the run: stopping here would
          // mean one pruned call blocks every later one from being recovered.
          gone += 1;

          return;
        }

        const facts = factsFrom(call);

        if (!facts) {
          // Told apart from "no session at all" so the operator knows whether
          // re-running later will find anything.
          if (readRecord(call, ['session'])) pending += 1;

          return;
        }

        // Guarded on the column still being null, so a webhook or a
        // reconciliation landing mid-walk keeps its fresher answer rather than
        // being overwritten by this one.
        const written = await prisma.callAttempt.updateMany({
          where: { id: row.id, recordingAvailable: null },
          data: facts as Prisma.CallAttemptUpdateManyMutationInput,
        });

        filled += written.count;
      }),
    );

    options.onProgress?.({ fetched, filled, gone, pending });
  }

  return {
    candidates: candidates.length,
    fetched,
    filled,
    gone,
    pending,
    truncated: candidates.length > wanted.length,
  };
}

/**
 * The inbound half: the same walk over `CampaignInboundCall`.
 *
 * Keyed on `upstreamPhoneCallId` — the platform's own call id, learned at
 * completion — because the policy's `upstreamCallId` is the carrier's
 * provider id and not one `GET /calls/:id` accepts. A row that never learned
 * the platform id is not a candidate; `backfill:inbound-call-id` is the walk
 * that recovers those.
 *
 * Only the conversation and the recording flag: an inbound row carries no
 * variables and no billed-duration column, and a walk should not write what
 * the table cannot hold.
 */
export async function backfillInboundSessionFacts(
  options: SessionBackfillOptions,
): Promise<SessionBackfillResult> {
  if (!options.campaignId) {
    throw new Error('A campaign id is required: this walk costs one upstream request per call.');
  }

  const maxCalls = Math.max(1, options.maxCalls ?? BACKFILL_MAX_CALLS);
  const concurrency = Math.max(1, options.concurrency ?? BACKFILL_CONCURRENCY);

  const candidates = await prisma.campaignInboundCall.findMany({
    where: {
      campaignId: options.campaignId,
      upstreamPhoneCallId: { not: null },
      recordingAvailable: null,
    },
    orderBy: [{ arrivedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, upstreamPhoneCallId: true },
  });

  const wanted = candidates.slice(0, maxCalls);

  let fetched = 0;
  let filled = 0;
  let gone = 0;
  let pending = 0;

  for (let i = 0; i < wanted.length; i += concurrency) {
    const batch = wanted.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (row) => {
        const call = await getCall(row.upstreamPhoneCallId!);

        fetched += 1;

        if (call === null) {
          gone += 1;

          return;
        }

        const facts = factsFrom(call);

        if (!facts) {
          if (readRecord(call, ['session'])) pending += 1;

          return;
        }

        const written = await prisma.campaignInboundCall.updateMany({
          where: { id: row.id, recordingAvailable: null },
          data: {
            transcript: facts.transcript as Prisma.InputJsonValue | typeof Prisma.DbNull,
            recordingAvailable: facts.recordingAvailable as boolean,
          },
        });

        filled += written.count;
      }),
    );

    options.onProgress?.({ fetched, filled, gone, pending });
  }

  return {
    candidates: candidates.length,
    fetched,
    filled,
    gone,
    pending,
    truncated: candidates.length > wanted.length,
  };
}
