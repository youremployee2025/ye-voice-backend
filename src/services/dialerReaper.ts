import { REAPER_NO_CLASSIFIED_OUTCOME, REAPER_NO_OUTCOME } from '../lib/attemptReason.js';
import type { CallAttempt } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { getCall } from '../adapter/vocobase.js';
import { readNumber, readRecord, readString } from '../lib/upstream.js';
import { applyTerminalOutcome, resolveContact } from './dialerOutcome.js';
import { bookCallbackFromExtraction } from './campaignCallback.js';
import { callbackRawFrom, deriveKind } from '../lib/attemptKind.js';
import { recordAttempt } from './goalContext.js';

/**
 * Attempts whose outcome never arrived.
 *
 * A webhook is a delivery, not a guarantee. The platform retries four times
 * over eight hours and then stops, and an endpoint that was down for that
 * window simply never learns what happened. Without this, such an attempt sits
 * non-terminal forever — holding a line the campaign paid for, against a cap
 * that never frees, so the campaign quietly stops dialing and looks idle.
 *
 * The reaper does **not** guess. It asks the platform, which is the only party
 * that knows, using the endpoint the docs name as the missed-webhook recovery
 * path. Only a call the platform has never heard of, or one still live long
 * past any plausible call, is closed without an answer — and that outcome gets
 * its own status rather than being filed as a failure.
 */

/** Bounded like every other pass here: a stale set that is large is a symptom,
 *  and working through all of it in one tick is not the fix. */
const BATCH = 50;

/**
 * Reconciles every attempt that has been in flight too long.
 *
 * Returns how many were closed, by either route.
 */
export async function closeStaleAttempts(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - env.dialerAttemptTimeoutMins * 60_000);

  const stale = await prisma.callAttempt.findMany({
    where: {
      OR: [
        { status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
        /**
         * The second way an attempt goes stale: an unclassified pacing event
         * closed it to free the line and deliberately left `resolvedAt` null,
         * deferring the queue move to the completion — and the completion
         * never came. The call detail carries the classification by now, so
         * the reconcile below resolves and charges it exactly as the missed
         * webhook would have. `ABANDONED` is excluded by construction (its
         * writer stamps `resolvedAt` in the same statement), and a charged
         * attempt is excluded because the charging path stamps both — charged
         * is settled, whatever a hand-written row may say.
         */
        { status: { in: ['COMPLETED', 'FAILED'] }, resolvedAt: null, chargedAt: null },
      ],
      startedAt: { lte: cutoff },
    },
    orderBy: { startedAt: 'asc' },
    take: BATCH,
  });

  let closed = 0;

  for (const attempt of stale) {
    try {
      if (await reconcile(attempt, now)) closed += 1;
    } catch (err) {
      // One unreadable attempt must not stop the rest being closed; a line
      // held open is the exact problem this function exists to solve.
      console.error(`[dialer] could not reconcile attempt ${attempt.id}:`, err);
    }
  }

  return closed;
}

/** Terminal on the platform's own vocabulary. Anything else is still live. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'no_answer', 'busy', 'canceled']);

async function reconcile(attempt: CallAttempt, now: Date): Promise<boolean> {
  const { id: attemptId, upstreamCallId } = attempt;

  // An attempt with no call id is one whose launch never confirmed — the
  // request went out and the answer was lost. There is nothing to ask about,
  // because the id we would ask with is the thing we never received.
  if (upstreamCallId) {
    const call = await getCall(upstreamCallId);

    if (call) {
      const status = readString(call, ['status']);

      if (status && TERMINAL_STATUSES.has(status.toLowerCase())) {
        const session = readRecord(call, ['session']);
        /**
         * The session's extraction results, read once and used twice: stored
         * on the attempt, and read for the promise the missed webhook would
         * have carried. Absent whenever the agent has no extraction keys
         * configured, which is most calls.
         */
        const values = readRecord(readRecord(session ?? {}, ['extraction']) ?? {}, ['values']);

        /**
         * The session facts, from the same detail this reconcile already
         * fetches. `GET /calls/:id` returns `session: { transcript,
         * recording_url, variables, extraction, ... }`, so a reconciliation
         * leaves the same row a webhook would have — which is the invariant
         * this whole module exists to hold, and what makes a lost delivery
         * self-healing rather than a permanent gap in the record.
         *
         * A call the platform has no session for at all yields `undefined`
         * for each, which leaves any stored value alone rather than blanking
         * it. That matters on the abandoned path, which reaches
         * `applyTerminalOutcome` with no session and must not erase a
         * conversation a late webhook already stored.
         */
        const sessionFacts = session
          ? {
              transcript: (session as Record<string, unknown>).transcript,
              variables: readRecord(session, ['variables']) ?? {},
              recordingAvailable: readString(session, ['recording_url', 'recordingUrl']) !== null,
              billDurationSeconds: readNumber(call, ['bill_duration_seconds', 'billDurationSeconds']),
            }
          : {};

        const result = await applyTerminalOutcome({
          attemptId,
          status: status.toLowerCase(),
          disposition: readString(call, ['disposition']),
          answeredBy: readString(call, ['answered_by', 'answeredBy']),
          hangupCause: readString(call, ['hangup_cause', 'hangupCause']),
          // Who ended it. Unlike `error_code` below, the call detail DOES
          // carry this one — the call-history surface has read it off exactly
          // this payload since that slice shipped — so a reconciliation
          // records the same attribution the webhook would have, which is the
          // whole invariant this module exists to hold. It is also what makes
          // the export's disconnect columns self-heal on a lost delivery
          // rather than depending on the backfill being re-run.
          hangupSource: readString(call, ['hangup_source', 'hangupSource']),
          // The one-vocabulary ending. `GET /calls/:id` derives it on read, so
          // a reconciliation records the same answer the lost webhook would
          // have — and, unlike `error_code` below, the detail DOES carry it,
          // so a platform fault reconciled here is handed back the way the
          // webhook path hands it back. Absent on a detail that predates the
          // field: the settle then writes nothing and the backfill fills it.
          endCallReason: readString(call, ['end_call_reason', 'endCallReason']),
          // The carrier's answer time, for the same reason the webhook reads
          // it: a `SYSTEM_ERROR` on an answered call is not a free redial.
          answeredAt: readString(call, ['answered_at', 'answeredAt']),
          ...sessionFacts,
          // The platform's own verdict, when it ended the call itself. Read
          // off the detail the way the webhook reads it off the delivery, so
          // a reconciliation hands the contact back the same way — ONCE the
          // platform emits it there. As of 2026-09-07 `GET /calls/:id` carries
          // `hangup_cause` and `error_message` but not `error_code` (platform
          // `call.routes.ts`; the code is emitted by the webhook service
          // alone), so this reads null on a reconcile. That no longer costs a
          // retry on its own: `end_call_reason` above IS on the detail, and a
          // `SYSTEM_ERROR` beside nobody heard is classified as the same
          // platform fault the code would name, so the hand-back happens
          // through the reason. What a reconcile still leaves off the row is
          // the code itself; the sentence is unaffected, because
          // `attemptReason` reads the reason too. Until the detail endpoint
          // carries the code, that is all a reconcile misses.
          errorCode: readString(call, ['error_code', 'errorCode']),
          errorMessage: readString(call, ['error_message', 'errorMessage']),
          // Billed on `duration_seconds`, never the carrier's
          // `bill_duration_seconds`, because the completion webhook carries
          // only the former — and the same call must not cost a different
          // amount depending on how we came to hear about it.
          durationSecs:
            readNumber(session ?? {}, ['duration_seconds', 'durationSeconds']) ??
            readNumber(call, ['duration_seconds', 'durationSeconds']) ??
            0,
          endedAt: now,
          // Reconciliation is a recovery path, so it charges exactly as the
          // webhook does. A call the platform confirms as completed has been
          // billed to YE whether or not our endpoint was reachable — and it
          // leaves the same extraction behind, so a campaign whose endpoint
          // was down for an hour does not read as one whose leads said nothing.
          extraction: values,
          eventKey: `reconcile:${upstreamCallId}`,
        });

        /**
         * The promise the missed webhook would have carried.
         *
         * The call detail returns the session's extraction alongside its
         * transcript and recording, so a callback agreed on a call whose
         * webhook never arrived is still honoured. Read defensively — the field
         * is absent whenever the agent has no extraction keys configured, which
         * is most calls — and only for an outcome this pass actually applied.
         *
         * Which key holds the time depends on whether the campaign has a goal
         * (`callbackRawFrom`, shared with the webhook so the two paths cannot
         * read one call differently). The goal is read here rather than
         * joined on the stale batch: the reconcile already runs one detail
         * call per attempt, and the campaign row is the cheaper of the two.
         */
        if (
          result === 'applied' &&
          attempt.campaignId !== null &&
          attempt.campaignContactId !== null
        ) {
          const campaign = await prisma.campaign.findUnique({
            where: { id: attempt.campaignId },
            select: { id: true },
          });

          await bookCallbackFromExtraction({
            campaignId: attempt.campaignId,
            campaignContactId: attempt.campaignContactId,
            attemptNo: attempt.attemptNo,
            raw: callbackRawFrom(values),
            now,
          });
        }

        return true;
      }

      // Still live upstream, long past the timeout. Falls through to
      // ABANDONED below: whatever this is, it is not a call in progress, and
      // the line cannot be held for it indefinitely.
    }
  }

  /**
   * `ABANDONED`, and deliberately not `FAILED`.
   *
   * "We never found out" and "the callee did not answer" are different facts.
   * Filed as a failure, an unreachable webhook endpoint would show up on a
   * customer's report as a list of people who did not pick up — a claim about
   * their contacts that we cannot support and that they would act on.
   *
   * `resolvedAt` is stamped with the rest, because an outcome **is** applied to
   * the contact below. It is the mark a late delivery for this same dial reads
   * to know the queue has already moved on without it — the contact's own
   * guards cannot tell, for the milliseconds between a re-claim and the insert
   * of that dial's attempt row. It also keeps the journey from drawing an
   * abandoned attempt as a telephone that is still ringing.
   */
  const closedRow = await prisma.callAttempt.updateMany({
    where: { id: attemptId, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
    data: {
      status: 'ABANDONED',
      endedAt: now,
      resolvedAt: now,
      launchError: REAPER_NO_OUTCOME,
    },
  });

  if (closedRow.count === 0) {
    /**
     * Not live — the other way in: a terminal attempt an unclassified pacing
     * event closed, whose completion never arrived and whose call detail just
     * gave no terminal answer either. The status stays what the carrier said
     * (the call did end); only the resolution is ours to invent, and it is
     * invented the same way an abandoned call's is — below, as a silence. The
     * stamp is what takes it out of this sweep's selection.
     */
    const stamped = await prisma.callAttempt.updateMany({
      where: {
        id: attemptId,
        status: { in: ['COMPLETED', 'FAILED'] },
        resolvedAt: null,
        chargedAt: null,
      },
      data: {
        resolvedAt: now,
        launchError: REAPER_NO_CLASSIFIED_OUTCOME,
      },
    });

    if (stamped.count === 0) return false;
  }

  // A null pointer means the campaign was deleted while this call was still
  // open. The attempt row is closed above either way — it is the billing
  // record — but there is no queue entry left to hand back.
  if (attempt.campaignContactId !== null) {
    /**
     * Back onto the queue, through the same routine the webhook resolves
     * through. "We never found out" is a silence like any other: it is retried
     * while the budget lasts and settles as a failure once it is gone, and it
     * can never be a success. It is the ordinary retry rather than a free one —
     * the abandoned call may well have happened.
     */
    const campaignContactId = attempt.campaignContactId;

    await prisma.$transaction(async (tx) => {
      /**
       * The context record, BEFORE the resolution and in its transaction —
       * the rule every resolver of a goal contact holds. An abandoned attempt
       * is still an attempt the next call is told about, and the retry armed
       * below may dial before anything else touches the record; left
       * unwritten, that dial's `last_call_note` would describe the call before
       * this one. Every field null, so the line says what is true: nothing
       * was reported. The goal is read here rather than joined on the stale
       * batch, as the callback booking above reads it.
       */
      const campaign =
        attempt.campaignId === null
          ? null
          : await tx.campaign.findUnique({
              where: { id: attempt.campaignId },
              select: { id: true },
            });

      if (campaign !== null) {
        await recordAttempt(
          {
            campaignContactId,
            attemptNo: attempt.attemptNo,
            kind: deriveKind(attempt),
            status: null,
            disposition: null,
            answeredBy: null,
            extraction: null,
            callbackNote: null,
          },
          tx,
        );
      }

      await resolveContact(tx, {
        campaignId: attempt.campaignId,
        campaignContactId,
        attemptNo: attempt.attemptNo,
        sessionId: attempt.upstreamSessionId,
        // No platform outcome to copy: nothing was ever reported.
        disposition: null,
        answeredBy: null,
        retryable: true,
        permanent: false,
        // Nothing was reported, so nothing said the platform ended it.
        platformFault: false,
        now,
      });
    });
  }

  console.warn(`[dialer] abandoned attempt ${attemptId}: no outcome was ever reported`);

  return true;
}

/**
 * How long a claim may sit with nothing dialed before it is given back.
 *
 * Must comfortably exceed everything a *live* placement job can legitimately
 * spend: three attempts over exponential backoff from two seconds, plus the
 * stalled-job window (`stalledInterval` × the stall allowance) a SIGKILLed
 * worker's job crosses before its retry. Five minutes is that with a wide
 * margin, so this sweep can never race a job that is merely slow.
 */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Gives back claims whose placement job is gone.
 *
 * The claim flips `PENDING -> QUEUED` and hands the dial to Redis, but writes
 * no attempt row — that happens later, in the placement worker. A job lost in
 * that window (stalled past the allowance, a Redis flush, a shutdown cutting
 * the failed-handler's release) left the contact stranded: invisible to
 * `closeStaleAttempts`, which reconciles attempt rows, and unreachable by
 * `claimContacts`, which selects only `PENDING`. `QUEUED` counts as
 * unfinished work, so the campaign could never complete either.
 *
 * The predicate is the claim's own record. `claimedAt` is stamped by the
 * claim statement; an attempt **started at or after it** means this claim's
 * placement ran and the attempt sweep owns whatever happens next, so only a
 * lease-expired claim with no such attempt is released. The release moves the
 * status and clears the lease and nothing else — `attempts` counts retries
 * consumed and a dial that never left consumed nothing, and `armKind` still
 * says why this contact was waiting, exactly as `releaseUnlaunched` leaves
 * them. The row goes back into the lane it came out of.
 *
 * A compare-and-set over stale rows, like the attempt sweep: a second caller
 * finds nothing, so the dispatch tick and the cleanup queue may both run it.
 * Rows claimed before the column existed carry `NULL` and are left alone —
 * there is no instant to measure their lease from.
 */
export async function releaseStaleClaims(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CLAIM_LEASE_MS);

  const released = await prisma.$executeRaw`
    UPDATE "CampaignContact" cc
    SET status = 'PENDING', "claimedAt" = NULL, "updatedAt" = ${now}
    WHERE cc.id IN (
      SELECT stale.id
      FROM "CampaignContact" stale
      WHERE stale.status = 'QUEUED'
        AND stale."claimedAt" IS NOT NULL
        AND stale."claimedAt" <= ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "CallAttempt" ca
          WHERE ca."campaignContactId" = stale.id
            AND ca."startedAt" >= stale."claimedAt"
        )
      LIMIT ${BATCH}
    )`;

  if (released > 0) {
    console.warn(`[reaper] released ${released} claim(s) whose placement job never ran`);
  }

  return released;
}
