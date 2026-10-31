import { platformFaultOnRow } from '../lib/dialOutcome.js';
import { attemptReason } from '../lib/attemptReason.js';
import type { CallAttempt, CampaignInboundCall } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/errors.js';
import { isArmedForCallback, isArmedForResume } from '../lib/campaignQueue.js';
import { toDisplayCredits } from '../lib/credits.js';
import { nextActionOf, readGoalLog } from '../lib/goalRecord.js';
import { IMMEDIATE_CALLBACK_MINUTES, retryWaitMinutes } from '../lib/campaignConfig.js';

/**
 * One contact's whole history on one campaign, as a timeline.
 *
 * The question this answers is "what has actually happened to this person, and
 * why are they still waiting" — which the contact row cannot answer on its own,
 * because it carries only the *last* of everything. The attempt rows carry the
 * rest, and the gaps between them carry the cooldowns.
 *
 * **Read-only, and it mints nothing.** `hasRecording` says whether a recording
 * is worth asking for — an upstream call with some reason to think it carried
 * audio, argued at the predicate itself — and no more; the
 * recording itself is a separate, rate-limited, token-gated route, and minting
 * one URL per attempt on a page load would turn a cheap read into an upstream
 * fan-out.
 */

/**
 * How many dials one journey will read.
 *
 * A blast-radius cap, not paging. Twenty retries plus three callbacks bounds a
 * real contact at twenty-four dials; nothing in the database enforces either
 * bound, and `attemptNo` is `MAX + 1`, so one corrupted row must not be able to
 * turn a page load into an unbounded read.
 */
const MAX_JOURNEY_ATTEMPTS = 200;

export interface JourneyCampaign {
  id: string;
  name: string;
  /**
   * Not used for the do-not-call lookup any more — that list is keyed by
   * campaign + phone and reads `id` above. Kept because the route already
   * loads it and a journey is still rendered inside a workspace.
   */
  workspaceId: string;
  retryCount: number;
  cooldownMinutes: number;
  retryDelaysMinutes: number[];
}

export async function campaignContactJourney(
  campaign: JourneyCampaign,
  campaignContactId: string,
) {
  /**
   * The campaign id is **re-asserted** here, not merely used to find the row.
   *
   * The caller has already proved this campaign is theirs; the join-row id in
   * the path has proved nothing, and it could name a contact on a different
   * campaign of the same workspace. Scoping the lookup is what makes that a 404
   * rather than a journey rendered under the wrong campaign's retry policy.
   */
  const link = await prisma.campaignContact.findFirst({
    where: { id: campaignContactId, campaignId: campaign.id },
    include: { contact: true },
  });

  if (!link) {
    throw new ApiError(404, 'NOT_FOUND', 'Contact not found on this campaign.');
  }

  const [attempts, inboundCalls, spend, goalRecord, doNotCall] = await Promise.all([
    prisma.callAttempt.findMany({
      where: { campaignContactId: link.id },
      orderBy: { attemptNo: 'asc' },
      take: MAX_JOURNEY_ATTEMPTS,
    }),
    /**
     * The inbound calls this contact made, a separate stream from the dialer's
     * attempts (an inbound call is never a `CallAttempt`). Merged into the
     * timeline by instant below, so a contact's whole history — calls we placed
     * and calls they made — reads in one column.
     */
    prisma.campaignInboundCall.findMany({
      where: { campaignContactId: link.id },
      orderBy: { arrivedAt: 'asc' },
      take: MAX_JOURNEY_ATTEMPTS,
    }),
    /**
     * From the LEDGER, not from `costCredits`.
     *
     * An attempt records what was **owed** on a shortfall as well as what was
     * charged, so summing the column would show this contact costing credits
     * that were never taken.
     */
    prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { type: 'CALL_USAGE', callAttempt: { campaignContactId: link.id } },
    }),
    /**
     * The goal context record — one indexed read on the unique. Null is the
     * first-dial state: the record is created lazily.
     */
    prisma.campaignContactGoal.findUnique({
      where: { campaignContactId: link.id },
      select: { memory: true, lastCallNote: true, goalMissing: true, attemptLog: true },
    }),
    /**
     * The do-not-call row for this phone on THIS campaign, goal or no goal —
     * the list is always on. This is the journey's "why excluded" source: the
     * reason lives here rather than on the contact row, precisely so it
     * survives contact deletion and re-import. Keyed by campaign, so a number
     * another campaign of the same workspace has listed does not show here:
     * this page answers why *this* campaign will not call, and that campaign
     * still would.
     */
    prisma.doNotCall.findUnique({
      where: { campaignId_phone: { campaignId: campaign.id, phone: link.contact.phone } },
      select: { reason: true, createdAt: true },
    }),
  ]);

  // The canonical defensive parser, keyed by ordinal for the annotation pass.
  const goalLog = new Map(
    readGoalLog(goalRecord?.attemptLog).map((entry) => [entry.attemptNo, entry] as const),
  );

  // The status is half the question: a promise is owed by a contact that is
  // still waiting, and a settled or swept-out one is not — whatever arm the row
  // is carrying.
  const callbackPending = isArmedForCallback(link, link.status);

  // The engine's own re-arm of a dropped conversation. Drawn as its own event
  // below rather than as a callback, because nobody asked for it.
  const resumePending = isArmedForResume(link, link.status);

  /**
   * Whether the attempt ordinal still tracks the retry index.
   *
   * Three kinds of dial take the next `attemptNo` while consuming no retry — a
   * callback, a goal follow-up and a resume — so once any of them is in the
   * history the ordinal and the ladder index have diverged, and the row
   * records how many of each there were but not where in the sequence they
   * fell. Printing a ladder entry then would attribute a different attempt's
   * wait to this gap, so the measured gap is left to stand alone.
   *
   * `followUpCount` covers the follow-up and the resume together: both spend
   * one. It is a lifetime tally, which is exactly the right shape here — the
   * question is whether such a dial ever happened on this contact, not which
   * lane it is waiting in now.
   */
  //
  // A dial the platform ended before the number was tested — an `errorCode`,
  // or a `SYSTEM_ERROR` end reason, on a call nobody answered — takes an
  // ordinal too and spends no retry — a fourth kind — so one such attempt
  // anywhere on the contact puts the ordinal ahead of the retry index for
  // good. `platformFaultOnRow` is the settle's own predicate for that dial,
  // shared with the budget; a second spelling here read only the code, which
  // the platform never emits, and printed the wrong ladder rung after every
  // give-back.
  const retryIndexIsRecoverable =
    link.callbackCount === 0 &&
    link.followUpCount === 0 &&
    attempts.every((attempt) => !platformFaultOnRow(attempt));

  const events: unknown[] = [];

  for (const [index, attempt] of attempts.entries()) {
    /**
     * The goal context this attempt left, off the context record's log.
     *
     * The log's `kind` is preferred over the attempt row's own stamp because
     * it is what the resolution actually recorded; `outcome`, `callbackType`
     * and `reason` are the bot's call note on this very call, which no
     * attempt column holds. All nullable on purpose — a silence has no note,
     * and so does a conversation the extraction never came back for — and
     * null is "no outcome", never a judgement about the person. Absent for a
     * non-goal campaign, and for an attempt the webhook has not recorded yet:
     * both read as "no goal context", which is the truth.
     *
     * `nextAction` is the dashboard's four-word reading of the same note
     * (`nextActionOf`), kept so its labels need not change in the release
     * that changed the contract. Derived here, never stored: the log holds
     * what the bot said, and the mapping can move without a backfill.
     */
    const goalEntry = goalLog.get(attempt.attemptNo);

    events.push(
      goalEntry === undefined
        ? attemptEvent(attempt)
        : {
            ...attemptEvent(attempt),
            goal: {
              kind: goalEntry.kind,
              outcome: goalEntry.outcome,
              callbackType: goalEntry.callbackType,
              reason: goalEntry.reason,
              nextAction: nextActionOf({
                outcome: goalEntry.outcome,
                callbackType: goalEntry.callbackType,
                reason: goalEntry.reason,
                callbackRequestedTime: goalEntry.callbackRequestedTime,
                immediateCallbackNeeded: goalEntry.immediateCallbackNeeded,
                immediateCallbackReason: goalEntry.immediateCallbackReason,
                note: null,
                callTimestamp: null,
              }),
              ...(goalEntry.callbackNote === undefined
                ? {}
                : { callbackNote: goalEntry.callbackNote }),
            },
          },
    );

    const next = attempts[index + 1];
    if (next === undefined) continue;

    const cooldown = cooldownEvent(
      attempt,
      next,
      scheduledGapMinutes(campaign, attempt, next, retryIndexIsRecoverable),
    );

    if (cooldown !== null) events.push(cooldown);
  }

  // The inbound calls, merged in by instant with the dialer's attempts and
  // their cooldowns. Tagged as their own kind so the page can draw a call that
  // came in differently from one we placed.
  for (const call of inboundCalls) {
    events.push(inboundCallEvent(call));
  }

  /**
   * Only for a promise somebody is still owed. Stale history is not an event —
   * it already happened, and drawing it as one puts a call in the future that
   * nobody is going to place.
   *
   * `resume_due` is a separate kind and not a second `callback_due`, which is
   * what the widened timestamp pair used to make it. A resume is the engine
   * going back to a call that cut out; a callback is a time a person named.
   * Drawing one as the other tells whoever reads this page that their lead
   * asked to be rung at an instant the lead never heard of — and the two carry
   * different instants for the same reason, `callbackAt` being the promise and
   * `nextEligibleAt` being when the queue will act.
   */
  if (callbackPending) {
    events.push({ kind: 'callback_due', at: link.callbackAt });
  } else if (resumePending) {
    events.push({ kind: 'resume_due', at: link.nextEligibleAt });
  }

  // One chronological order over both streams. Every node carries a time —
  // an attempt's `startedAt`, a cooldown's `from`, an inbound call's `at`, the
  // callback's `at` — so a single sort interleaves them without disturbing the
  // attempt/cooldown pairing (a cooldown's `from` sits between its two dials).
  events.sort((a, b) => instantOf(a) - instantOf(b));

  /**
   * The only way a live dial appears.
   *
   * An attempt row is written before the call is placed and `resolvedAt` stays
   * null until the outcome lands, so an unresolved attempt on a claimed contact
   * is a telephone that is ringing right now. It is deliberately not an event:
   * a timeline is what happened, and this has not finished happening.
   */
  const live =
    link.status === 'QUEUED'
      ? attempts.filter((attempt) => attempt.resolvedAt === null).at(-1)
      : undefined;

  /**
   * Contact-level proof that this person has been dialled at some point.
   *
   * Every field survives the re-arm that puts a contact back on the queue, so
   * none of them can be reset by later activity — which is what lets the flag
   * below mean something specific.
   *
   * ## The other spelling of this question, and why this one is wider
   *
   * Every *query* that asks it — `/stats`' `waiting` split, the campaign
   * list's `outcomes` bar, the analytics funnel's `attempted`, the bucket
   * report's `unreached` — reads one column, `lastAttemptAt`, through
   * `HAS_BEEN_DIALED_SQL` (`src/lib/campaignQueue.ts`). That is the claim's
   * own stamp: written in the same `UPDATE` that flips the contact to
   * `QUEUED`, out of every lane, and never cleared.
   *
   * | Reader | Evidence | Why |
   * |---|---|---|
   * | `HAS_BEEN_DIALED_SQL` | `lastAttemptAt` | a filter inside a `GROUP BY`, where one column is what keeps the count exact and every panel agreeing |
   * | this | five arms, `lastAttemptAt` among them | not a query — a row already in hand, where every column is free, and the flag it feeds must never be optimistic |
   *
   * A superset by construction, and deliberately so: this flag gates the
   * sentence "we have no record of a call", and a row whose `lastAttemptAt`
   * was never written but which carries a disposition or a session id is a
   * contact somebody rang. The extra arms are pinned one at a time in
   * `test/campaign-journey.test.ts`: reduced to the counters, `attemptsRecorded`
   * claims a pruned contact's rows are complete.
   *
   * **`followUpCount` is absent here and that is not the omission it looks
   * like.** The goal re-arm writes `disposition`, `answeredBy` and
   * `lastSessionId` alongside it (`dialerOutcome.ts`), and the dial that
   * produced it stamped `lastAttemptAt` — so a followed-up contact is caught by
   * three of the arms below whatever its counters say, and adding a fourth
   * counter would widen nothing.
   */
  const hasEverDialed =
    link.attempts > 0 ||
    link.callbackCount > 0 ||
    link.lastSessionId !== null ||
    link.lastAttemptAt !== null ||
    link.disposition !== null;

  // An inbound call is a real event in this contact's history, so a contact
  // that has only ever called in has a non-empty timeline — `attemptsRecorded`
  // below must not report it as the honest-empty "queued, never dialled".
  const hasInboundHistory = inboundCalls.length > 0;

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      retryCount: campaign.retryCount,
      cooldownMinutes: campaign.cooldownMinutes,
      retryDelaysMinutes: campaign.retryDelaysMinutes,
    },
    contact: {
      campaignContactId: link.id,
      contactId: link.contactId,
      // Identity off `Contact`, which is the workspace's own record of a
      // person. The join row is this campaign's opinion about them.
      name: link.contact.name,
      phone: link.contact.phone,
      email: link.contact.email,
      tags: link.contact.tags,
      metadata: link.contact.metadata,
      status: link.status,
      disposition: link.disposition,
      answeredBy: link.answeredBy,
      // Retries CONSUMED, not dials made — a callback adds a dial without
      // incrementing this, so it is not an attempt total.
      attempts: link.attempts,
      nextEligibleAt: link.nextEligibleAt,
      callbackAt: link.callbackAt,
      callbackCount: link.callbackCount,
      // The third counter, beside the other two rather than only inside the
      // goal block: a campaign whose switch is off can still hold a contact
      // that was followed up before it went off, and the contact block is where
      // this page says how many of each kind of dial a person has had.
      followUpCount: link.followUpCount,
      callbackPending,
      // Why this contact's clock is set, verbatim, so the page can name the
      // wait rather than infer it from three counters that each record
      // something else. Only meaningful beside a PENDING status, which is the
      // pairing the two flags above already make.
      armKind: link.armKind,
      creditsUsed: toDisplayCredits(-(spend._sum.amount ?? 0n)),
      lastSessionId: link.lastSessionId,
      lastAttemptAt: link.lastAttemptAt,
      addedAt: link.createdAt,
    },
    /**
     * The goal, as it stands for this contact. Null when the switch is off, so
     * the page can tell the feature being off from a contact nobody has spoken
     * to yet. `achieved` is the resolution's decision (null until a settle
     * judges it); `memory` is the call note as the next dial's variable would
     * render it, so the page and the bot are looking at the same words.
     *
     * No wording travels: what counts as a finished conversation is written in
     * the agent's own prompt, and a campaign-shaped goal string beside this
     * contact's verdict would be claiming otherwise.
     *
     * `lastCallNote` is never null — YE derives it on every recorded attempt,
     * silences included — so an empty string means "no attempt recorded yet",
     * which is exactly the state before the first dial resolves.
     *
     * `goalMissing` is kept in the shape for the page and is null under this
     * contract: nothing writes it any more. The field goes when the labels do.
     */
    goal: {
      achieved: link.goalAchieved,
      followUpCount: link.followUpCount,
      memory: goalRecord?.memory ?? null,
      lastCallNote: goalRecord?.lastCallNote ?? '',
      goalMissing: goalRecord?.goalMissing ?? null,
    },
    /**
     * Why this person will not be called: this campaign's do-not-call row for
     * this phone, when one exists. Present whether or not the row's EXCLUDED
     * settle has caught up — the list is checked at claim time, so a listed
     * contact is not going to be dialed either way — and null otherwise. The
     * list is the campaign's own, so this says nothing about whether another
     * campaign in the workspace may still dial the number.
     */
    optOut:
      doNotCall === null ? null : { reason: doNotCall.reason, listedAt: doNotCall.createdAt },
    /**
     * The honest-empty flag.
     *
     * Deliberately **not** `attempts.length > 0`: zero rows is both "queued,
     * never dialled" — the common case on any running campaign — and "dialled,
     * and the rows are gone". `false` claims only the second, and only when
     * contact-level state proves past dials.
     */
    attemptsRecorded: attempts.length > 0 || hasInboundHistory || !hasEverDialed,
    inFlight:
      live === undefined
        ? null
        : {
            attemptNo: live.attemptNo,
            sessionId: live.upstreamSessionId,
            fromNumber: live.fromNumber,
            startedAt: live.startedAt,
          },
    events,
  };
}

/** The timeline node an inbound call becomes. `at` is `arrivedAt`, so the same
 *  sort that orders attempts by `startedAt` interleaves these by when they
 *  came in. Tagged `inbound_call` with `direction: 'inbound'` so the page draws
 *  it as a call that came in, not one we placed. */
function inboundCallEvent(call: CampaignInboundCall) {
  return {
    kind: 'inbound_call' as const,
    direction: 'inbound' as const,
    at: call.arrivedAt,
    endedAt: call.endedAt,
    durationSecs: call.durationSecs,
    disposition: call.disposition,
    fromNumber: call.fromNumber,
    sessionId: call.upstreamSessionId,
    /**
     * `upstreamPhoneCallId`, NOT `upstreamCallId`, and the difference is the
     * whole bug this line was.
     *
     * The two events describing one inbound call carry ids from different
     * namespaces: the routing policy sends only the carrier's
     * `provider_call_id`, which lands in `upstreamCallId` and is what the
     * settle correlates on; `session.completed` sends Vocobase's own
     * `call.call_id`, which lands in `upstreamPhoneCallId`. `GET
     * /api/v2/calls/:id` resolves the second. Handing the recording route the
     * first is a guaranteed 404 — on the page, a panel that spins forever
     * rather than an error anyone could act on.
     *
     * `serializeInboundCall` was fixed for this during #77's review; this call
     * site was missed, so the Calls tab linked correctly while the journey did
     * not.
     */
    callId: call.upstreamPhoneCallId,
    // Same meaning as an attempt's: an upstream call id is what the recording
    // route needs, not a promise the audio exists. Null on the imported history
    // and on everything settled before the column existed, and false here is
    // what keeps those rows from opening a panel that can only spin.
    hasRecording: call.upstreamPhoneCallId !== null,
    costCredits: call.costCredits === null ? null : toDisplayCredits(call.costCredits),
  };
}

/** The instant a timeline node sorts by — whichever of its time fields it
 *  carries. Nodes without one (there are none today) sort to the front. */
function instantOf(node: unknown): number {
  const n = node as Record<string, unknown>;
  const t = n.startedAt ?? n.from ?? n.at;
  return t instanceof Date ? t.getTime() : 0;
}

function attemptEvent(attempt: CallAttempt) {
  return {
    kind: 'attempt',
    attemptNo: attempt.attemptNo,
    // The claim's stamp of what this dial was (fresh/retry/callback/
    // follow_up). Null on rows from before the stamp existed; the goal
    // annotation's `kind`, where present, is the resolution's own record.
    attemptKind: attempt.kind,
    // Verbatim upstream text, as the attempts feed reports it. The normalised
    // copy is on the contact, written once at resolution time; re-deriving it
    // per row here would be a second copy of that rule.
    disposition: attempt.disposition,
    answeredBy: attempt.answeredBy,
    /**
     * The platform's own reason, when IT ended the dial before the carrier
     * tested the number. Beside the disposition because the disposition is
     * useless on such a row — `failed`, with no cause — and a reader who sees
     * only that blames the contact. With a code here, the row says the dial
     * produced nothing, why, and (by the counters not moving) that it cost
     * the contact no retry.
     */
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    // The sentence the page prints for a dial that produced nothing; the two
    // fields above are the record, this is the reading. Same rule as the
    // attempts feed, from the same function, so the two cannot disagree.
    failureReason: attemptReason(attempt),
    fromNumber: attempt.fromNumber,
    startedAt: attempt.startedAt,
    resolvedAt: attempt.resolvedAt,
    durationSecs: attempt.durationSecs,
    /**
     * What was charged — or, when `shortfall`, what was owed and never taken.
     * The flag travels beside the number for that reason: a reader seeing only
     * the amount would conclude they had been billed.
     */
    costCredits: attempt.costCredits === null ? null : toDisplayCredits(attempt.costCredits),
    shortfall: attempt.shortfall,
    sessionId: attempt.upstreamSessionId,
    /**
     * The handle the recording route takes. `sessionId` is not it — the
     * `/calls/:callId/recording-token` route resolves the upstream call id,
     * so the page must be handed that id or every playback 404s.
     */
    callId: attempt.upstreamCallId,
    /**
     * Whether playback is worth offering: an upstream id **and** some reason
     * to think the call carried audio.
     *
     * The id alone is not enough, and reading it as enough put a Play link on
     * dials that failed at 0:00. A launch the platform refused, a blocked
     * number and a carrier failure all record an id and zero seconds, and
     * there is no audio of a call nobody had — the recording route answers 404
     * and the reader learns that by clicking. A row must not offer what it
     * cannot deliver.
     *
     * **A null duration is not that zero, and reading it as one cost answered
     * calls their Play button.** Every terminal settle writes a number:
     * `webhookOutcome.ts` and the reaper's reconcile both coerce an unreported
     * duration with `?? 0`, and `applyTerminalOutcome` takes a `number`. So a
     * duration that is still null was never written by a settle at all — it
     * belongs to one of the two rows `dialerReaper.ts` closes by hand, and only
     * one of them is a call somebody answered:
     *
     * - **`COMPLETED` with a `resolvedAt` and no duration** is the reaper's
     *   second stamp: a terminal attempt an unclassified pacing event closed,
     *   whose completion webhook never arrived. The carrier says the call was
     *   answered and ended; only our record of how long it ran is missing, and
     *   the recording is upstream where it always was. **This one is offered.**
     * - **`FAILED`** reaches that same stamp — the sweep takes both — and
     *   **`ABANDONED`** is the reaper's verdict on a dial it gave up on, from
     *   `QUEUED`, `RINGING` or `IN_PROGRESS`, including the branch where the
     *   call detail still said `ringing` long past the timeout. Neither is a
     *   conversation: there is no audio of a call the carrier could not place
     *   or of a telephone that was still ringing when we stopped waiting.
     *   **Neither is offered.**
     *
     * So the null arm asks the status, not `resolvedAt` alone. `resolvedAt` is
     * still required with it: a dial nothing has closed out is a telephone that
     * may still be ringing, and there is no recording of a call that has not
     * ended.
     *
     * **Zero therefore also means "not reported", and this cannot tell which.**
     * A settled call the platform reported no duration for is indistinguishable
     * here from one that failed at 0:00, and it is read as the latter — the
     * asymmetry below is why.
     *
     * **It errs toward withholding, and that asymmetry is the point.** A dial
     * that did carry audio but was reported at zero seconds — or that was
     * abandoned mid-conversation, where the null is genuinely ambiguous —
     * loses its Play button, which is recoverable: opening the attempt asks the
     * call detail and finds the recording. A Play button on a call that has
     * none is not recoverable — it spends a click to reach a 404 and teaches the reader
     * that the control lies. The cheap wrong answer is the one that can be
     * undone.
     *
     * Still existence-only, and it still mints nothing: this is a cheap
     * heuristic off columns already loaded, and `recordingAvailable` on the
     * call detail is the authoritative answer.
     */
    /**
     * The stored answer where there is one, and the old heuristic only where
     * there is not.
     *
     * `recordingAvailable` is what the platform said about this call, recorded
     * at settle time or recovered by the backfill — the authoritative answer
     * this predicate's own comment used to point at while guessing instead.
     * The guess is kept for attempts settled before the column existed: it
     * reads a zero duration as no audio, because withholding a Play button is
     * recoverable by opening the attempt and a Play button that only 404s is
     * not.
     */
    hasRecording:
      attempt.upstreamCallId !== null &&
      (attempt.recordingAvailable ??
        (attempt.durationSecs === null
          ? attempt.resolvedAt !== null && attempt.status === 'COMPLETED'
          : attempt.durationSecs > 0)),
  };
}

/**
 * What the campaign's settings said the wait before `next` would be.
 *
 * **The gap belongs to the dial that ends it**, so it is read off the *next*
 * attempt's kind — the stamp the claim wrote from the arm that chose the row —
 * and never from the ordinal alone. A resume waits the fixed
 * `IMMEDIATE_CALLBACK_MINUTES`; a retry and a follow-up both walk the retry
 * ladder, which they have shared since 2026-09-06. Printing the ladder entry
 * against a resume — which is what this did, because a resume left no mark the
 * ordinal could see — reported a three-minute wait as thirty, on the page
 * whose whole job is saying what happened and when.
 *
 * `null` means "no honest number", and there are two ways to get one. A
 * callback's gap is a time a person named rather than a policy, so no setting
 * here can name it. And the ladder is indexed by the RETRY counter, which a
 * contact that has ever taken a callback, a follow-up or a resume no longer
 * has an ordinal for — that is `retryIndexIsRecoverable`, and it is why a
 * follow-up's gap is null rather than a ladder entry: sharing the ladder did
 * not make the index recoverable. The measured gap is drawn alone in both
 * cases, which is the truth rather than a guess dressed as a setting.
 *
 * An attempt written before the kind stamp existed carries `null` and falls
 * through to the ladder, which is exactly where it fell before: the ordinal is
 * the only fact such a row has, and a campaign old enough to hold one has no
 * goal dials in it to confuse the count.
 */
function scheduledGapMinutes(
  campaign: JourneyCampaign,
  attempt: CallAttempt,
  next: CallAttempt,
  retryIndexIsRecoverable: boolean,
): number | null {
  if (next.kind === 'resume') return IMMEDIATE_CALLBACK_MINUTES;
  if (next.kind === 'callback') return null;

  if (!retryIndexIsRecoverable) return null;

  // The index is the count of retries already consumed — which, while the
  // ordinal still tracks the retry index, is the ordinal of the dial this gap
  // follows minus one. `retryWaitMinutes` is the resolution's own rule,
  // fallback to the cooldown included.
  return retryWaitMinutes(campaign, attempt.attemptNo - 1);
}

/**
 * The wait between two dials: what was actually served, and what was scheduled.
 *
 * Both are reported because they routinely disagree in the honest direction —
 * the sweep runs on an interval, so a served gap is normally a little longer
 * than the one configured, and a page showing only the setting would look
 * wrong to anybody comparing it with the clock.
 */
function cooldownEvent(attempt: CallAttempt, next: CallAttempt, scheduledMinutes: number | null) {
  // `resolvedAt` is when the outcome was applied, which is when the cooldown
  // started. The fallbacks are for rows that predate it, or that were closed
  // without one.
  const from = attempt.resolvedAt ?? attempt.endedAt ?? attempt.startedAt;
  const served = next.startedAt.getTime() - from.getTime();

  // A gap that runs backwards is clock skew, and there is no honest way to draw
  // it. Dropped rather than clamped to zero, which would assert a cooldown of
  // no time at all.
  if (served < 0) return null;

  return {
    kind: 'cooldown',
    from,
    to: next.startedAt,
    // One decimal. The raw quotient ships false precision — 30.016666666666666
    // — off inputs whose granularity is a sweep interval.
    servedMinutes: Math.round(served / 6_000) / 10,
    scheduledMinutes,
  };
}
