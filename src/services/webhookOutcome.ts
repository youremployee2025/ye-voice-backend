import { readBoolean, readNumber, readRecord, readString } from '../lib/upstream.js';
import { parseCorrelationId } from '../lib/callCorrelation.js';
import { prisma } from '../lib/prisma.js';
import { boundExtractionValues } from '../lib/extractionCapture.js';
import { bookCallbackFromExtraction } from './campaignCallback.js';
import { settleInboundCall } from './campaignInbound.js';
import { settleTestSession } from './testSessionOutcome.js';
import { exhaustsPlatformCredit, normaliseErrorCode } from '../lib/dialOutcome.js';
import { isPlatformFault, normaliseEndCallReason } from '../lib/endCallReason.js';
import {
  applyTerminalOutcome,
  notifyPlatformCreditExhausted,
  pauseForPlatformCredit,
  classifyOutcome,
  normaliseOutcomeText,
  resolveContact,
} from './dialerOutcome.js';
import { recordAttempt } from './goalContext.js';
import { callbackRawFrom, deriveKind } from '../lib/attemptKind.js';
import type { WebhookProcessingJobData } from '../lib/queue/types.js';

/**
 * What a verified webhook actually does.
 *
 * Lifted out of the HTTP handler when this work moved onto a queue, and not
 * otherwise changed: the same two events, the same attempt lookup, the same
 * charge, the same contact resolution, the same callback booking. The handler
 * verifies and enqueues; this is the rest.
 *
 * **Every timestamp comes from `receivedAt`, never from `new Date()`.** The
 * job runs some milliseconds — or, after a retry, some minutes — after the
 * delivery arrived, and a call's `endedAt` is a fact about the call rather
 * than about how promptly we got round to recording it. Stamping the job's own
 * clock would make a retried delivery describe a longer call than a first-time
 * one, on the row that decides what a customer is charged.
 */

/** The two events this platform acts on. Anything else is acknowledged and dropped. */
export const HANDLED_WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  'session.completed',
  'call.status.updated',
]);

/**
 * Runs one verified delivery.
 *
 * Throws on a database failure, which is what makes the queue's five attempts
 * mean something: the work behind this is a charge, a contact resolution and
 * possibly a booked callback, all of it owed to a customer, and all of it made
 * exactly-once by the event key `applyTerminalOutcome` writes inside its own
 * transaction. A retry of a delivery that already landed finds that key and
 * changes nothing.
 */
export async function processWebhookEvent(job: WebhookProcessingJobData): Promise<void> {
  const receivedAt = new Date(job.receivedAtIso);

  if (job.event === 'session.completed') await handleSessionCompleted(job.data, receivedAt);
  else if (job.event === 'call.status.updated') await handleStatusUpdated(job.data, receivedAt);
}

/** The platform's terminal call statuses. Anything else is still in progress. */
const TERMINAL = new Set(['completed', 'failed', 'no_answer', 'busy', 'canceled']);

/** Non-terminal statuses, mapped onto our own attempt vocabulary. */
const LIVE_STATUS: Record<string, 'QUEUED' | 'RINGING' | 'IN_PROGRESS'> = {
  pending: 'QUEUED',
  ringing: 'RINGING',
  in_progress: 'IN_PROGRESS',
};

/**
 * Finds the attempt an event belongs to.
 *
 * Three routes, in order of how directly each names the attempt:
 *
 * 1. The platform's **call id**, recorded from the 201 that placed the call.
 * 2. Its **session id**, recorded from the same response.
 * 3. The **correlation key** we stamped, whose fourth segment is the attempt.
 *
 * The correlation key is last deliberately. It is free text on a shared
 * account, so it is the one field another integrator could collide with; the
 * ids came from the platform itself. The parser is strict, but preferring what
 * the platform told us over what we told the platform is the right order.
 */
/** Everything either handler needs about the attempt an event belongs to. */
const ATTEMPT_FIELDS = {
  id: true,
  campaignId: true,
  campaignContactId: true,
  attemptNo: true,
  kind: true,
  upstreamSessionId: true,
  // Stamped by this handler's own IN_PROGRESS event. The status event carries
  // no `answered_at`, so the row is the only proof here that the call
  // connected — and a connected call is never a platform fault.
  answeredAt: true,
  // The goal switch, joined here rather than read again below: this lookup
  // already runs once per delivery, it is what decides whether the pacing
  // event may resolve a connected call at all, and a switch that is off (or a
  // deleted campaign's null) is the feature's invisible state.
  // Name and workspace beside the id: the platform-credit pause below
  // notifies the workspace, and it should not need a second read to do so.
  campaign: { select: { id: true, name: true, workspaceId: true } },
} as const;

type MatchedAttempt = {
  id: string;
  campaignId: string | null;
  campaignContactId: string | null;
  attemptNo: number;
  kind: string | null;
  upstreamSessionId: string | null;
  answeredAt: Date | null;
  campaign: { id: string; name: string; workspaceId: string } | null;
};

async function findAttempt(
  callId: string | null,
  sessionId: string | null,
  clientReferenceId: string | null,
): Promise<MatchedAttempt | null> {
  if (callId) {
    const byCall = await prisma.callAttempt.findUnique({
      where: { upstreamCallId: callId },
      select: ATTEMPT_FIELDS,
    });
    if (byCall) return byCall;
  }

  if (sessionId) {
    const bySession = await prisma.callAttempt.findUnique({
      where: { upstreamSessionId: sessionId },
      select: ATTEMPT_FIELDS,
    });
    if (bySession) return bySession;
  }

  const correlation = parseCorrelationId(clientReferenceId);
  if (!correlation?.attemptId) return null;

  return prisma.callAttempt.findUnique({
    where: { id: correlation.attemptId },
    select: ATTEMPT_FIELDS,
  });
}

/**
 * The charging event.
 *
 * `session.completed` fires for every outcome, including calls that were never
 * answered — those arrive with `duration_seconds: 0` and a `call.status` of
 * `no_answer`, `busy` or `failed`, and cost nothing.
 */
async function handleSessionCompleted(
  data: Record<string, unknown>,
  receivedAt: Date,
): Promise<void> {
  const sessionId = readString(data, ['session_id', 'sessionId']);
  const call = readRecord(data, ['call']);

  /**
   * `call` is absent for a **browser** session — there was no carrier — so a
   * completion with no call object is either one of our test sessions or
   * another integrator's. Neither can belong to a campaign, so this leaves the
   * attempt machinery below entirely alone.
   */
  if (!call) {
    await settleBrowserSession(sessionId, data, receivedAt);
    return;
  }

  const callId = readString(call, ['call_id', 'callId']);
  const attempt = await findAttempt(
    callId,
    sessionId,
    readString(call, ['client_reference_id', 'clientReferenceId']),
  );

  if (!attempt) {
    // No CallAttempt means the dialer never placed this call. Before writing it
    // off, see whether it is an INBOUND call the routing policy recorded — those
    // deliberately have no attempt, so the invariant that an attempt exists only
    // for a dialer-placed call stays true, and inbound calls settle their own
    // row instead.
    const settled = await settleInboundCall({
      callId,
      providerCallId: readString(call, ['provider_call_id', 'providerCallId']),
      sessionId,
      fromNumber: readString(call, ['from_number', 'fromNumber']),
      toNumber: readString(call, ['to_number', 'toNumber']),
      direction: readString(call, ['direction']),
      disposition: readString(call, ['disposition']),
      durationSecs: readNumber(data, ['duration_seconds', 'durationSeconds']) ?? 0,
      extraction: readRecord(readRecord(data, ['extraction']) ?? {}, ['values']),
      endedAt: receivedAt,
      // The same two facts the attempt path captures below, under the same
      // rule: only once post-call processing has produced them.
      ...(processingHappened(data)
        ? {
            transcript: data.transcript,
            recordingAvailable: readString(data, ['recording_url', 'recordingUrl']) !== null,
          }
        : {}),
    });

    if (settled) return;

    // Another integrator's call on the shared account, or one of ours placed
    // before this table existed. The id alone, never the payload.
    console.warn(`[webhook] session.completed for an unknown call: ${callId ?? sessionId ?? '(no id)'}`);
    return;
  }

  const recordingUrl = readString(data, ['recording_url', 'recordingUrl']);

  const result = await applyTerminalOutcome({
    attemptId: attempt.id,
    status: readString(call, ['status']) ?? 'completed',
    disposition: readString(call, ['disposition']),
    answeredBy: readString(call, ['answered_by', 'answeredBy']),
    hangupCause: readString(call, ['hangup_cause', 'hangupCause']),
    // Who ended it, read with the same two-level precedence the pair below
    // uses: the contract puts it on the call object, and a delivery carrying
    // it one level up must not read as "nobody hung up".
    hangupSource:
      readString(call, ['hangup_source', 'hangupSource']) ?? readString(data, ['hangup_source', 'hangupSource']),
    // The platform's one-vocabulary ending. Lives on `data.call`; the envelope
    // is read second for the same reason `hangup_source` is.
    endCallReason:
      readString(call, ['end_call_reason', 'endCallReason']) ?? readString(data, ['end_call_reason', 'endCallReason']),
    // The carrier's answer time. Proof the call connected, read beside the
    // row's own stamp: a `SYSTEM_ERROR` on an answered call is a conversation
    // the platform tore down, not a number it never tested.
    answeredAt: readString(call, ['answered_at', 'answeredAt']),
    // The platform's own verdict. Read off the call object first and the
    // envelope second: the contract puts the pair beside `hangup_cause`, and
    // a delivery that carries it one level up must not read as "no code".
    errorCode: readString(call, ['error_code', 'errorCode']) ?? readString(data, ['error_code', 'errorCode']),
    errorMessage:
      readString(call, ['error_message', 'errorMessage']) ?? readString(data, ['error_message', 'errorMessage']),
    // Billed on this, never on the carrier's `bill_duration_seconds`: the
    // completion webhook carries only this one, and the same call must not
    // cost a different amount depending on how we learned of it.
    durationSecs: readNumber(data, ['duration_seconds', 'durationSeconds']) ?? 0,
    endedAt: receivedAt,
    // The answers the call returned, kept on the attempt. Read off the
    // envelope and handed over raw: what a stored extraction may be is
    // `applyTerminalOutcome`'s to decide, so that the reaper's copy of this
    // call cannot differ from the webhook's.
    extraction: readRecord(readRecord(data, ['extraction']) ?? {}, ['values']),
    // The session facts this product renders. Read off the envelope, which is
    // where the completion carries them — the `call` object beside it
    // describes the telephony leg and never the conversation.
    transcript: data.transcript,
    variables: readRecord(data, ['variables']) ?? {},
    /**
     * The FLAG, never the URL. A presigned link expires in seven days and is a
     * bearer credential for a customer's audio that outlives any membership
     * check; the bytes are served through this service against a freshly
     * minted one.
     *
     * **Written only when the delivery shows post-call processing has
     * happened**, and `undefined` — not `false` — otherwise. The transcript
     * and the recording are produced after the call ends, so a completion
     * arriving before that carries neither, and a `false` from it would be
     * wrong twice: the row would claim a call has no audio when it has some,
     * and this column is the marker the backfill reads to decide a row has
     * been looked at, so the wrong answer would never be revisited.
     *
     * The evidence is `processing_complete`, or a transcript, or a recording
     * url — any one of them means output exists. Leaving it unset costs one
     * fetch from the reaper or the backfill and cannot be wrong.
     */
    recordingAvailable: processingHappened(data) ? recordingUrl !== null : undefined,
    billDurationSeconds: readNumber(data, ['bill_duration_seconds', 'billDurationSeconds']),
    // The attempt id as the last resort: a delivery matched through
    // `client_reference_id` alone carries neither id, and a literal
    // `session.completed:null` would be consumed by the first such delivery —
    // every later one, for any call, would then read as its duplicate.
    eventKey: `session.completed:${sessionId ?? callId ?? attempt.id}`,
  });

  if (result === 'duplicate') {
    console.log(`[webhook] session.completed replayed for attempt ${attempt.id}; already charged.`);
  }

  /**
   * The callback, after the charge and never instead of it.
   *
   * Only for an outcome this delivery applied or was allowed to skip: a replay
   * must not book a second callback off the same promise. `'applied'` also
   * covers the normal path where the pacing event resolved the contact first —
   * the booking must still happen then — so it is not proof this dial is
   * current: the superseded-dial refusal lives inside the booking itself,
   * keyed on `attemptNo`.
   *
   * `bookCallbackFromExtraction` catches its own failures — a callback that
   * cannot be booked must not turn a charged call into a non-2xx the platform
   * re-delivers.
   */
  if (result === 'applied' && attempt.campaignId !== null && attempt.campaignContactId !== null) {
    await bookCallbackFromExtraction({
      campaignId: attempt.campaignId,
      campaignContactId: attempt.campaignContactId,
      attemptNo: attempt.attemptNo,
      /**
       * The promised time, raw and unparsed, because the booking is the one
       * place that decides what a promised time means — in the campaign's
       * own zone, which this handler has no way to know. `callbackRawFrom`
       * is the one reading of the note shared with the reaper: it names a
       * time only when the note also says a callback was requested.
       */
      raw: callbackRawFrom(readRecord(readRecord(data, ['extraction']) ?? {}, ['values'])),
      now: receivedAt,
    });
  }
}

/**
 * The pacing event.
 *
 * It charges nothing. What it does is free the line the moment the carrier
 * hangs up, rather than when post-call processing finishes — the platform says
 * plainly not to wait for `session.completed` to release a dialer slot, and a
 * slot held through transcription is a slot the customer paid for and cannot
 * use.
 *
 * A terminal update closes the attempt at **zero cost** and lets the
 * completion event that follows record the duration and charge. The two are
 * separated by `chargedAt`, which only the charging path sets.
 */
/**
 * A browser test session's completion.
 *
 * Deliberately reached only when there is no `call` object, rather than tried
 * beside the attempt lookup: the two are disjoint by construction, so a
 * telephony call never pays a query for a table it cannot be in, and a test
 * session can never be settled by a delivery that describes a phone call.
 *
 * A session that matches nothing is the endpoint's oldest rule — the partner
 * account is shared, so this receives every other integrator's completions.
 * The id is logged and nothing else; the payload carries a transcript.
 */
/**
 * Whether a delivery shows that post-call processing produced anything.
 *
 * Any one of three is enough: the platform's own `processing_complete`, a
 * transcript array, or a recording url. Read permissively on purpose — the
 * cost of reading it as "not yet" when it was done is one extra fetch, and the
 * cost of the reverse is a call permanently recorded as having no audio.
 */
function processingHappened(data: Record<string, unknown>): boolean {
  return (
    readBoolean(data, ['processing_complete', 'processingComplete']) === true ||
    Array.isArray(data.transcript) ||
    readString(data, ['recording_url', 'recordingUrl']) !== null
  );
}

async function settleBrowserSession(
  sessionId: string | null,
  data: Record<string, unknown>,
  receivedAt: Date,
): Promise<void> {
  if (!sessionId) {
    console.warn('[webhook] session.completed with neither a call nor a session id');
    return;
  }

  const session = await prisma.testSession.findUnique({
    where: { upstreamSessionId: sessionId },
    select: { id: true },
  });

  if (!session) {
    console.warn(`[webhook] session.completed for an unknown session: ${sessionId}`);
    return;
  }

  const result = await settleTestSession({
    sessionId: session.id,
    // The same key shape the attempt path uses, and unambiguous beside it: a
    // test session and a call attempt are different sessions, so their ids
    // cannot collide on one key.
    eventKey: `session.completed:${sessionId}`,
    // Billed on this and never on anything else, for the reason the attempt
    // path gives: the completion event carries only this figure.
    durationSecs: readNumber(data, ['duration_seconds', 'durationSeconds']) ?? 0,
    upstreamStatus: readString(data, ['status']),
    endedAt: receivedAt,
  });

  if (result === 'already_closed') {
    console.log(`[webhook] session.completed replayed for test session ${session.id}.`);
  }
}

async function handleStatusUpdated(
  data: Record<string, unknown>,
  receivedAt: Date,
): Promise<void> {
  const callId = readString(data, ['call_id', 'callId']);
  const status = readString(data, ['status'])?.toLowerCase();

  if (!status) return;

  const attempt = await findAttempt(
    callId,
    readString(data, ['session_id', 'sessionId']),
    readString(data, ['client_reference_id', 'clientReferenceId']),
  );

  if (!attempt) return;

  const live = LIVE_STATUS[status];

  if (live) {
    // Only ever forwards, and only over a non-terminal row: a late `ringing`
    // must not reopen a call that has already completed and been charged.
    await prisma.callAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
      data: {
        status: live,
        upstreamStatus: status,
        ...(live === 'IN_PROGRESS' ? { answeredAt: receivedAt } : {}),
      },
    });

    return;
  }

  if (!TERMINAL.has(status)) return;

  /**
   * Terminal. The line is freed now; the money is settled by
   * `session.completed`.
   *
   * `chargedAt` is deliberately left null, which is what lets the completion
   * event still do its work — `applyTerminalOutcome` treats a set `chargedAt`
   * as already-settled and does nothing.
   *
   * The contact is resolved **through the same routine the completion event
   * uses**, rather than being written terminal here — but **only when this
   * payload actually carries a classification**. This event fires at the
   * status transition, and for a *completed* call the provider computes
   * `disposition` and `answered_by` with post-call processing, after this
   * event has already gone out: a completed status with neither field is not
   * "a conversation happened", it is "not classified yet". Resolving from it
   * would settle every voicemail and machine answer as a success, the
   * completion that knows better would find the contact already resolved and
   * change nothing, and the retry ladder would never arm. So a bare completed
   * status closes the attempt to free the line and leaves `resolvedAt` null —
   * the mark the completion (and, failing that, the reaper) reads to know the
   * resolution is still theirs to make.
   *
   * A terminal status other than `completed` is its own classification —
   * `no_answer` and `busy` classify by status alone — so those resolve here
   * whatever else the payload carries, as does any payload with a
   * `disposition` or `answered_by`. Whichever event arrives first with a real
   * answer resolves the contact, and the second finds it already resolved and
   * changes nothing.
   *
   * One exception, and it is the reason this whole rule was revisited: a goal
   * campaign's CONNECTED call is left for `session.completed` even when this
   * payload is fully classified. See `resolvesHere` below.
   */
  const now = receivedAt;
  const disposition = readString(data, ['disposition']);
  const answeredBy = readString(data, ['answered_by', 'answeredBy']);
  const errorCode = readString(data, ['error_code', 'errorCode']);
  const errorMessage = readString(data, ['error_message', 'errorMessage']);
  // Null while the call is live. On the terminal event it is the CARRIER's
  // view only — the bot has not reported yet — so a connected call reads
  // COMPLETED here and its real ending arrives on session.completed.
  const endCallReason = normaliseEndCallReason(readString(data, ['end_call_reason', 'endCallReason']));

  const normalised = {
    status,
    disposition: normaliseOutcomeText(disposition),
    answeredBy: normaliseOutcomeText(answeredBy),
    // Verbatim, not normalised: `classifyOutcome` reads the leading Q.850
    // number off it, and the carrier's own spelling is what carries that.
    hangupCause: readString(data, ['hangup_cause', 'hangupCause']),
    // The carrier's one-vocabulary ending beside its cause.
    endCallReason,
    // The row's answer stamp: `SYSTEM_ERROR` on a call a person answered is
    // that conversation, not a free redial.
    answeredAt: attempt.answeredAt,
    // The platform's own verdict, outranking the cause when both arrive.
    errorCode,
    // Read for one thing only: the supplier's wallet running dry, which the
    // platform reports as text with no code beside it.
    errorMessage,
  };

  // "The platform decided" is a classification of its own, so it resolves
  // here whatever the status says — through either field that says so: an
  // `error_code`, or a `SYSTEM_ERROR` end reason (the one the platform's
  // call surfaces actually emit). A bare `completed` beside either is not
  // "not classified yet"; it is a call the platform tore down, and waiting
  // on a completion to say the same thing would hold the contact off the
  // queue for a delivery that may never come. Any OTHER reason is not a
  // classification on its own: COMPLETED here is the carrier's snapshot of
  // an answered call, and what the call was is still the completion's to say.
  const carriesClassification =
    status !== 'completed' ||
    normalised.disposition !== null ||
    normalised.answeredBy !== null ||
    normaliseErrorCode(errorCode) !== null ||
    isPlatformFault(endCallReason);

  /**
   * A goal campaign's connected call is decided on `session.completed`, and
   * only there. The platform sends this status event for a completed call
   * WITH its disposition and answered-by but BEFORE it has run extraction, so
   * a resolution here would judge the goal with no call note at all — which is
   * exactly the bug that scheduled a follow-up for every person who answered
   * everything on the first call. The attempt is still closed, so the line
   * is freed on time; `resolvedAt` stays null, the mark the completion (and,
   * failing that, the reaper) reads to know the decision is still theirs.
   *
   * Only a CONNECTED outcome waits. A silence — retryable, or permanently
   * refused — has no note to wait for and keeps today's semantics exactly:
   * it resolves here, the retry ladder arms here, and the goal decision table
   * never sees it.
   */
  const { retryable, permanent, platformFault } = classifyOutcome(normalised);
  const platformCreditDry = exhaustsPlatformCredit(errorCode, errorMessage);
  let pausedForPlatformCredit = false;
  const goalConversation =
    attempt.campaign !== null && !retryable && !permanent;
  const resolvesHere = carriesClassification && !goalConversation;

  await prisma.$transaction(async (tx) => {
    // The campaign row before the attempt row — the shared lock order. The
    // delete route takes the campaign lock and then SET-NULLs the campaign's
    // attempt rows; taking the attempt row first here is that pair inverted,
    // which is a deadlock with one side killed. See `applyTerminalOutcome`.
    if (attempt.campaignId !== null) {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${attempt.campaignId} FOR UPDATE`;
    }

    const closed = await tx.callAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
      data: {
        status: status === 'completed' ? 'COMPLETED' : 'FAILED',
        upstreamStatus: status,
        disposition,
        answeredBy,
        hangupCause: readString(data, ['hangup_cause', 'hangupCause']),
        // Beside the cause, for the same reason: when the completion never
        // arrives and the reaper never reconciles, this event is the only
        // delivery that said who hung up. Only when carried — this `updateMany`
        // matches open attempts alone, so it can never blank a settled value.
        ...(readString(data, ['hangup_source', 'hangupSource']) === null
          ? {}
          : { hangupSource: readString(data, ['hangup_source', 'hangupSource']) }),
        // Only when carried, like the source: this `updateMany` matches open
        // attempts alone, so it never blanks a settled value, and the
        // completion that follows overwrites this carrier snapshot with the
        // bot's answer.
        ...(endCallReason === null ? {} : { endCallReason }),
        // Verbatim, and only when carried: a pacing event without the pair
        // must not blank what a completion already wrote, and vice versa.
        ...(errorCode === null ? {} : { errorCode }),
        ...(errorMessage === null ? {} : { errorMessage: errorMessage.slice(0, 500) }),
        endedAt: now,
        ...(resolvesHere ? { resolvedAt: now } : {}),
      },
    });

    // A late terminal update over an attempt that is already closed must not
    // resolve its contact a second time — by then the contact may well have
    // been given back, re-claimed and dialled again. And an unclassified
    // completion resolves nothing at all, nor does a goal campaign's
    // conversation: the line is freed above, the queue move belongs to whoever
    // first knows what the call actually was — and for a goal, to whoever
    // knows what the bot decided.
    if (!resolvesHere || closed.count === 0 || attempt.campaignContactId === null) return;

    // Bounded exactly as the charging path bounds it. A goal campaign never
    // reaches here with a conversation, so there is no call note in it to
    // read; it is still passed because this is the shared resolution and a
    // caller that quietly dropped a field would be a second definition of
    // what a resolution is told.
    const extraction = boundExtractionValues(
      readRecord(readRecord(data, ['extraction']) ?? {}, ['values']),
    );

    /**
     * The context record, BEFORE the resolution and in its transaction — the
     * same rule `applyTerminalOutcome` holds, for the same reason. This is
     * the event that re-arms a silence, and the retry it arms may be dialled
     * before the completion arrives; a record written only by the completion
     * would hand that dial a `last_call_note` describing the conversation
     * BEFORE the voicemail. Keyed by attempt number, so the completion's own
     * write of this attempt (with the duration only it knows) replaces this
     * entry rather than adding beside it, and a stale replay is a no-op.
     */
    //
    // Not for a platform fault: the number was never dialled, and an entry
    // would overwrite the last-call line with a call nobody had. See
    // `applyTerminalOutcome`.
    if (attempt.campaign !== null && !platformFault) {
      await recordAttempt(
        {
          campaignContactId: attempt.campaignContactId,
          attemptNo: attempt.attemptNo,
          kind: deriveKind(attempt),
          status,
          disposition: normalised.disposition,
          answeredBy: normalised.answeredBy,
          extraction,
          // A silence made no promise, and this payload carries no duration.
          callbackNote: null,
        },
        tx,
      );
    }

    await resolveContact(tx, {
      campaignId: attempt.campaignId,
      campaignContactId: attempt.campaignContactId,
      attemptNo: attempt.attemptNo,
      sessionId: attempt.upstreamSessionId,
      disposition: normalised.disposition,
      answeredBy: normalised.answeredBy,
      retryable,
      permanent,
      platformFault,
      extraction,
      now,
    });

    // The platform's own telephony account is dry. Paused here, behind the
    // campaign lock this transaction already holds, on the first sight of
    // it; the completion that follows finds the campaign PAUSED and pauses
    // nothing a second time.
    if (platformCreditDry && attempt.campaign !== null) {
      pausedForPlatformCredit = await pauseForPlatformCredit(tx, attempt.campaign.id, now);
    }
  });

  if (pausedForPlatformCredit && attempt.campaign !== null) {
    notifyPlatformCreditExhausted(attempt.campaign);
  }
}
