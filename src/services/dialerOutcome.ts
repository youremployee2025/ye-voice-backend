import { Prisma, type CampaignContactStatus, type PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { releaseInboundClaims } from '../lib/inboundStart.js';
import { notify } from '../lib/notify.js';
import { chargeFor } from '../lib/dialerPricing.js';
import { boundExtractionValues } from '../lib/extractionCapture.js';
import { boundTranscript, boundVariables } from '../lib/sessionCapture.js';
import { parseCallbackAt, rollIntoDialWindow } from '../lib/callbackTime.js';
import { wantsResume } from '../lib/immediateResume.js';
import {
  IMMEDIATE_CALLBACK_MINUTES,
  IMMEDIATE_REPEAT_WINDOW_MINUTES,
  retryWaitMinutes,
} from '../lib/campaignConfig.js';
import { dialBudgetSpent, totalDialsFor } from '../lib/dialBudget.js';
import { callbackRawFrom, deriveKind } from '../lib/attemptKind.js';
import { classifyOutcome, exhaustsPlatformCredit, normaliseErrorCode } from '../lib/dialOutcome.js';
import { giveBackWithBackoff } from '../lib/giveBack.js';
import { normaliseEndCallReason } from '../lib/endCallReason.js';
import { settledDisposition } from '../lib/dialOutcome.js';
import {
  hasSpokenAttempt,
  readCallNote,
  readGoalLog,
  recordAttempt,
} from './goalContext.js';

/**
 * Closing an attempt, deciding what happens to the contact, and charging for
 * the minutes.
 *
 * Two callers reach this: the completion webhook, and the reaper reconciling
 * an attempt whose webhook never arrived. They must produce **identical**
 * results — a call that cost 2.12 credits when we heard about it promptly
 * cannot cost something else because our endpoint was down — so the whole of
 * the outcome logic lives here and neither caller re-derives any of it.
 *
 * ## Exactly once, by constraint rather than by care
 *
 * The `WebhookEvent` marker is written **inside** the same transaction as the
 * charge. A duplicate delivery violates its unique index, the whole
 * transaction rolls back, and the balance moves once.
 *
 * The two obvious alternatives both fail. Writing the marker first and
 * charging afterwards loses the charge entirely if the process dies between
 * them — a call nobody is billed for, with a marker saying it was handled.
 * Writing it afterwards double-charges on the retry that the platform will
 * certainly send, because it retries anything that is not a 2xx.
 *
 * The ledger row carries `reference = attempt.id` as well, so the existing
 * `@@unique([accountId, reference])` refuses a second charge for one attempt
 * even if this transaction were bypassed entirely. Two mechanisms, because one
 * of them is a database constraint and constraints do not have bugs.
 *
 * ## Where the retry decision lives
 *
 * Here, and only here. It used to fall out of the sweep's eligibility
 * predicate — a `FAILED` contact within budget and past its cooldown was
 * simply re-claimed — but eligibility is a stored column now, because a
 * promised callback is an instant no formula over the campaign's settings can
 * reproduce. So this is the one place that decides whether a phone rings
 * again, and `FAILED` means settled.
 */

type Db = PrismaClient | Prisma.TransactionClient;

// The decision sets and the classification they make live in `lib/dialOutcome`
// now, so the goal record — a lib module every read surface imports — can
// judge "did this attempt reach a person" by the same rule the retry decision
// below uses. Re-exported here because this is where every caller has always
// found them.
export { classifyOutcome, type OutcomeClass } from '../lib/dialOutcome.js';

/** The platform's terminal statuses that mean the call was answered and ended. */
const ANSWERED = new Set(['completed']);

export interface TerminalOutcome {
  attemptId: string;
  /** Verbatim from the platform. Never an enum — carriers add values. */
  status: string;
  disposition: string | null;
  answeredBy: string | null;
  hangupCause: string | null;
  /**
   * WHO ended the call, beside the cause that says how. Verbatim, never an
   * enum, and optional because the reaper's abandoned path has no platform
   * envelope to read one off — the same reason `errorCode` below is optional.
   */
  hangupSource?: string | null;
  /** The platform's `end_call_reason`, verbatim. Optional for the same reason
   *  `hangupSource` is: the reaper reads a detail payload that may predate it. */
  endCallReason?: string | null;
  /**
   * The telephony answer time (`answered_at` on the completion and the
   * detail). Read beside the attempt row's own stamp, which the IN_PROGRESS
   * status event sets: whichever is present proves the call connected, and a
   * connected call is never a platform fault. Optional: the status event
   * does not carry it, and the row is consulted either way.
   */
  answeredAt?: Date | string | null;
  /**
   * The platform's own verdict, when IT ended the attempt rather than the
   * carrier: `error_code` / `error_message` off `session.completed` and
   * `call.status.updated`. Non-null means the number was never tested — the
   * contact is handed back at no cost to its ladder, the pair is kept on the
   * attempt row so the journey can say why the dial produced nothing, and
   * `TELEPHONY_CREDIT_EXHAUSTED` pauses the campaign. Optional because the
   * reaper's abandoned path has no platform envelope to read one off.
   */
  errorCode?: string | null;
  errorMessage?: string | null;
  durationSecs: number;
  endedAt: Date;
  /**
   * The idempotency key. `session.completed:{session_id}` from the webhook, or
   * `reconcile:{call_id}` from the reaper — distinct namespaces on purpose, so
   * a reconciliation and a late webhook for the same call are one charge
   * (blocked by the ledger's reference constraint) rather than a silent
   * conflict on a shared key.
   */
  eventKey: string;
  /**
   * The conversation, the variables the dial went out with, whether audio
   * exists, and the carrier's own billed duration — the session facts this
   * product renders and used to fetch live on every view.
   *
   * Handed over RAW and bounded here, exactly as `extraction` below is and for
   * the identical reason: both callers reach this with the same values out of
   * different envelopes, and the invariant this module exists for is that they
   * leave the same row behind. A caller that bounded its own would be a second
   * place deciding what a stored conversation may be.
   *
   * All optional. The reaper's abandoned path has no session to read one off,
   * and `undefined` means "this delivery said nothing about it" — which must
   * leave a stored value alone rather than blanking it.
   */
  transcript?: unknown;
  variables?: unknown;
  recordingAvailable?: boolean | null;
  billDurationSeconds?: number | null;
  /**
   * The session's extraction results, exactly as they arrived — bounded and
   * stored here rather than by either caller.
   *
   * Both callers reach this with the same blob from different envelopes (the
   * delivery's `data.extraction.values`, the call detail's
   * `session.extraction.values`), and the invariant this whole module exists
   * for is that they leave the same row behind. A caller that bounded its own
   * would be a second place deciding what a stored answer may be.
   */
  extraction?: unknown;
  /**
   * Ours, not the platform's: a reaper timeout, or a launch that never became a
   * call. It is not a disposition and must never read as one, so it is carried
   * separately — but it is a silence like any other, so it is retried while the
   * budget lasts and can never be a success.
   */
  failureReason?: string | null;
}

export type OutcomeResult = 'applied' | 'duplicate' | 'unknown' | 'already_closed';

/**
 * Pauses a campaign because the PLATFORM is out of telephony credit.
 *
 * `PAUSED`, deliberately not `CREDIT_EXHAUSTED`: that status means the YE
 * customer's own balance stopped the campaign, its page tells them to top up
 * and `resume` re-runs the balance estimate — none of which is true or useful
 * here, where a different party is out of credit and the customer can do
 * nothing about it but wait for YE. The notification type is what tells an
 * operator which of the two happened. It follows `campaign.paused_upstream_refusal`,
 * the launch-time pause for the same supplier saying no.
 *
 * Conditional on RUNNING, so a burst of in-flight calls all ending the same
 * way produces one pause and one notification. Run inside the caller's
 * transaction behind the campaign lock; the notification goes out after the
 * commit, from `notifyPlatformCreditExhausted`. No auto-resume: the condition
 * never clears on its own.
 */
export async function pauseForPlatformCredit(db: Db, campaignId: string, now: Date): Promise<boolean> {
  const paused = await db.campaign.updateMany({
    where: { id: campaignId, status: 'RUNNING' },
    data: { status: 'PAUSED', pausedAt: now, haltReason: PLATFORM_CREDIT_HALT_REASON },
  });

  if (paused.count === 0) return false;

  console.warn(`[dialer] paused campaign ${campaignId}: campaign.paused_platform_credit_exhausted`);

  return true;
}

export const PLATFORM_CREDIT_PAUSE_TYPE = 'campaign.paused_platform_credit_exhausted';

/** The notification behind `pauseForPlatformCredit`, once the pause has committed. */
const SHORTFALL_HALT_REASON =
  'A call could not be charged because this workspace ran out of credits. Top up to resume calling.';

/** One sentence for the notification and the campaign page alike. */
const PLATFORM_CREDIT_HALT_REASON =
  'The voice platform cannot place calls right now: its own telephony account is out of ' +
  'credit. Nothing is wrong with this campaign or its contacts, and none of them lost a ' +
  'retry. Contact support; resume once they confirm calling is restored.';

export function notifyPlatformCreditExhausted(campaign: { id: string; name: string; workspaceId: string }): void {
  void notify(
    campaign.workspaceId,
    // Billing, and not this workspace's: ADMIN-only, as every other pause
    // whose reason is money.
    'ADMINS_ONLY',
    PLATFORM_CREDIT_PAUSE_TYPE,
    `${campaign.name} was paused`,
    PLATFORM_CREDIT_HALT_REASON,
    `/campaigns/${campaign.id}`,
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Lowercased and trimmed, or null. The platform sends lowercase; a carrier
 *  value that arrives capitalised must not become a second bucket. */
export function normaliseOutcomeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();

  return trimmed ? trimmed : null;
}

export interface ContactResolution {
  /** Null when the campaign was deleted mid-call. There is still an attempt to
   *  close and a bill to settle, but no queue to move anything through. */
  campaignId: string | null;
  campaignContactId: string;
  /** This dial's ordinal, which is what pins the write to this dial. */
  attemptNo: number;
  /** The session the outcome came from, kept on the contact after the attempt
   *  pointer is freed by a re-arm. */
  sessionId: string | null;
  /** Normalised, and copied onto the contact — not joined, because the re-arm
   *  that puts a contact back on the queue frees the attempt it came from. */
  disposition: string | null;
  answeredBy: string | null;
  retryable: boolean;
  permanent: boolean;
  /**
   * The platform ended this attempt before the carrier tested the number.
   * Handed back at no cost to the retry ladder, whatever `retryable` and
   * `permanent` say — see `giveBackWithBackoff`.
   */
  platformFault: boolean;
  /**
   * This call's extraction answers, already bounded by the caller. Only the
   * goal path reads it, and it reads it for one thing: the bot's call note on
   * this call, which is the whole of the decision below. The context record
   * has already been written by the caller, inside this same transaction and
   * ahead of this call, so nothing here needs to preview it.
   *
   * Every caller passes whatever its envelope carried. Absent only on the
   * reaper's abandoned path, which has no extraction to pass — and which is
   * always a silence, so there is no note it could be missing.
   */
  extraction?: Prisma.JsonObject | null;
  now: Date;
}

/**
 * `given_back` is a platform fault: back on the queue with nothing spent, the
 * way a launch that never left is handed back. Distinct from `retrying`
 * because that one consumed a rung of the ladder and this one did not.
 */
export type ContactOutcome =
  | 'retrying'
  | 'following_up'
  | 'completed'
  | 'failed'
  | 'race_lost'
  | 'given_back';

/**
 * Moves the contact out of the queue, or back onto it.
 *
 * Shared with the reaper's abandoned-attempt path, which has no platform
 * outcome to report but the same decision to make. A second copy of the retry
 * rule would eventually disagree with this one about how many times somebody's
 * phone rings.
 *
 * ## The two guards, and why a miss writes nothing at all
 *
 * The write is guarded on the contact still being **claimed** (`QUEUED`, or the
 * inert `CALLING`) and on this dial still being its **latest** — the attempt
 * ordinal is unique per contact, so "no attempt numbered above mine" is exactly
 * "nothing has been dialled since". A late delivery for a call that was already
 * abandoned, given back and re-dialled matches neither.
 *
 * A guard miss returns `race_lost` and the caller changes **no counter**. A
 * campaign whose `failedCount` was incremented by a resolution that moved
 * nothing would report more settled contacts than it has.
 *
 * Neither guard can close the milliseconds between a re-claim and the insert of
 * that dial's attempt row, where both are true of the *previous* dial as well.
 * That pin is the attempt row's own `resolvedAt` and it lives at each caller,
 * which is where the attempt row is in hand: all three refuse to call this at
 * all for an attempt whose outcome has already been applied.
 *
 * ## The campaign lock, and why it is first
 *
 * Every writer in this tree that touches a campaign and its contacts in one
 * transaction takes the **campaign row `FOR UPDATE` first**: stop, complete,
 * delete, top-up, the retry-budget sweep, the dispatcher's completion pass, the
 * callback re-arm. This function used to write the contact and *then* the
 * campaign, which is that order inverted — and two transactions each holding
 * one of the pair while waiting for the other is a deadlock. Postgres resolves
 * one by killing a transaction, which here is a webhook answering 500 and a
 * charge rolled back, on a delivery the platform will retry into the same race.
 *
 * The lock is taken for the retry branch as well as the settle branch. That
 * branch touches no campaign column, but it does write the contact, and a lock
 * order that holds only on some paths is not a lock order.
 *
 * It is re-entrant within one transaction, so the callers that already hold it
 * pay nothing for taking it again.
 */
export async function resolveContact(db: Db, r: ContactResolution): Promise<ContactOutcome> {
  // One read for everything the resolution may need about the contact: the
  // counters, the phone a `stop` lists, and the goal record's attempt log.
  // Two of the three joins are unique-index probes and the goal row is absent
  // for most contacts, so folding them here is cheaper than the reads it
  // replaces — and it keeps the work held under the campaign lock below to the
  // writes.
  const contact = await db.campaignContact.findUnique({
    where: { id: r.campaignContactId },
    select: {
      attempts: true,
      followUpCount: true,
      // The resume throttle's anchor, read only when this call is immediate.
      lastImmediateAt: true,
      contact: { select: { phone: true } },
      // The log alone: whether ANY attempt reached a person is what separates
      // a FAILED settle that never spoke to anybody from one that follows a
      // real conversation. This call's own entry is already in it — the caller
      // records the attempt before resolving — which is right: an attempt that
      // was a conversation is one whether it settles or re-arms.
      goal: { select: { attemptLog: true } },
    },
  });

  if (!contact) return 'race_lost';

  if (r.campaignId !== null) {
    await db.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${r.campaignId} FOR UPDATE`;
  }

  // Read live, inside the caller's transaction, and behind the lock above.
  // Lowering the retry budget mid-campaign has to stop a retry that has not
  // been armed yet, or the setting is a control that lies.
  const campaign =
    r.campaignId === null
      ? null
      : await db.campaign.findUnique({
          where: { id: r.campaignId },
          select: {
            // BOTH lane budgets and both waits, live: lowering either one
            // mid-campaign has to stop a dial that has not been armed yet, or
            // the setting is a control that lies. `retryCount` and the ladder
            // beside it belong to the contact nobody has reached;
            // `maxGoalFollowUps` and `followUpDelayHours` belong to the one
            // somebody has. The window columns feed the re-arm's roll into
            // dialing hours. No workspace id: the do-not-call row is keyed by
            // the campaign, which the caller already named.
            retryCount: true,
            maxGoalFollowUps: true,
            followUpDelayHours: true,
            cooldownMinutes: true,
            retryDelaysMinutes: true,
            fromTime: true,
            toTime: true,
            timezone: true,
            dialDays: true,
          },
        });

  /**
   * The goal path. Null when, and only when, the campaign is gone.
   *
   * There used to be a second way to get null here — `goalEnabled = false` —
   * and everything below treated the two identically, which is what made the
   * switch invisible. The switch is gone as of 2026-09-06: every campaign
   * follows an unfinished conversation up until its dial budget runs out, and
   * `campaign === null` is the only state left in which there is no queue to
   * move anything through.
   *
   * Kept as a named binding rather than folded into `campaign` because the
   * whole table below reads `goal !== null` as "there is a campaign to decide
   * for", and spelling that out at each of the eight sites would be a worse
   * way of saying the same thing.
   */
  const goal = campaign;

  const claimed = {
    id: r.campaignContactId,
    status: { in: ['QUEUED', 'CALLING'] satisfies CampaignContactStatus[] },
    // The pin. `attemptNo` is unique per contact and only ever increases.
    callAttempts: { none: { attemptNo: { gt: r.attemptNo } } },
  };

  const carried = {
    // The contact's copy is the one that drives our own decisions and the
    // outcome bar, the `/stats` disposition groups and the contact badge read
    // it. A `no_answer` the detector heard a person on is settled below as a
    // conversation, and the contact says so; the attempt row keeps the
    // platform's own label, verbatim, as the record of what it said.
    disposition: settledDisposition(r.disposition, r.answeredBy),
    answeredBy: r.answeredBy,
    ...(r.sessionId === null ? {} : { lastSessionId: r.sessionId }),
  };

  /**
   * The bot's call note on THIS call, and the one row of the table that is
   * decided before anything else.
   *
   * Read from the call's own extraction rather than from the record: the
   * record keeps the note the NEXT call is told, while the outcome is what
   * this one conversation decided, and the two are different questions.
   *
   * Read for every campaign, which since 2026-09-06 is no longer a caveat:
   * the call-note set is attached to every campaign's agent, every campaign
   * follows an unfinished conversation up, and the only campaign this note
   * decides nothing for is one that has been deleted mid-call.
   */
  /**
   * A platform fault is decided before anything else, the note included: the
   * number was never tested, so there is no conversation to read a note off
   * and no silence to spend a retry on. Back on the queue after the
   * campaign's cooldown — the same wait `rollbackLaunch` gives a launch the
   * platform refused, because this is the same event heard one step later —
   * with `attempts` and `armKind` untouched and the armed-callback pair kept
   * whole. It does not consult the retry or dial budgets either: the budget
   * gate reads `dialBudget`, which does not count an attempt carrying an
   * `errorCode` — nor a `SYSTEM_ERROR` end reason beside nobody heard, the
   * same fact through the field the platform actually emits — so the next
   * claim sees exactly the ladder this contact had before the dial.
   *
   * A campaign deleted mid-call has no queue to hand anything back to, which
   * is the one case that falls through to the settle below unchanged.
   */
  if (r.platformFault && campaign !== null) {
    const backoffAt = new Date(r.now.getTime() + campaign.cooldownMinutes * 60_000);
    const moved = await giveBackWithBackoff(db, claimed, backoffAt);

    if (moved > 0) {
      console.warn(
        `[dialer] gave back contact ${r.campaignContactId} after attempt ${r.attemptNo}: the platform ended it before the number was tested; retrying after the campaign cooldown`,
      );
    }

    return moved === 0 ? 'race_lost' : 'given_back';
  }

  const note = readCallNote(r.extraction);
  const optedOut = note.outcome === 'stop';
  const stop = goal !== null && optedOut;

  /**
   * The opt-out, written for ANY campaign's `stop` before any branching and
   * outside the `claimed` guard: even a resolution that loses its race heard
   * the person ask to be left alone, and that must stand regardless. First
   * writer wins — a number already listed keeps the reason and the source
   * that first put it there.
   *
   * Not gated on the goal, deliberately. A person who says "never call me
   * again" has said it whichever campaign was calling, and the only reason a
   * plain campaign can hear it at all is that its agent carries the goal
   * keys — which is a fact about the agent, not a reason to ignore the
   * person. What a plain campaign does NOT do is settle on it: the retry
   * ladder and the settle below run exactly as they always have, and it is
   * the claim-side exclusion, reading this row, that keeps the number from
   * being dialed again.
   *
   * Per campaign — the design's decision — so the row is keyed by this
   * campaign and this phone, and a second campaign on the same number is
   * unaffected. Keyed by phone rather than by contact so it survives contact
   * deletion and re-import.
   */
  if (optedOut && r.campaignId !== null) {
    await db.doNotCall.upsert({
      where: { campaignId_phone: { campaignId: r.campaignId, phone: contact.contact.phone } },
      create: {
        campaignId: r.campaignId,
        phone: contact.contact.phone,
        reason: note.reason ?? 'Asked not to be called again during a campaign call.',
        sourceCampaignContactId: r.campaignContactId,
      },
      update: {},
    });
  }

  /**
   * The absolute cap, asked exactly the way the claim asks it — a PLACED
   * attempt at or past the ceiling — rather than off `r.attemptNo` alone. The
   * ordinal counts rows a launch failure closed without ever reaching the
   * platform, and a gate that spends the budget on calls nobody made would
   * settle a contact whose phone never rang.
   *
   * The ceiling is DERIVED from the retry budget (`totalDialsFor`), not read
   * off the retired `maxTotalDials` column, and it bounds every kind of dial:
   * the retry re-arm below consults it, and so does the follow-up.
   */
  const budgetSpent =
    goal !== null && (await dialBudgetSpent(db, r.campaignContactId, totalDialsFor(goal)));

  /**
   * Which LANE this contact is in: whether ANY attempt has reached a person.
   *
   * The first answer moves a contact into the follow-up lane FOR GOOD.
   * Whatever retries were left are forfeited, deliberately: the retry ladder
   * says how patient to be with a NUMBER, and once somebody has picked up the
   * question is no longer whether the number is reachable — it is how often
   * to go back to a person who already spoke to us, which is a smaller budget
   * on a longer clock.
   *
   * **This call is judged from `r`, and every earlier one from the log**, and
   * the split is not cosmetic. The caller records this dial's own entry before
   * resolving, so it IS in the log — but a log entry carries neither
   * `failureReason` nor `hangupCause`, and `classifyOutcome` over what is left
   * reads "retryable" off the status and disposition alone. A call the reaper
   * closed having never learned an outcome is logged with the carrier's own
   * `completed` status and a null disposition, which reads there as a
   * conversation; trusting it would put a contact nobody has ever spoken to
   * into the follow-up lane, forfeiting its retries and moving it onto the
   * 24-hour clock, on a dial that never reached anybody. `r` carries the full
   * classification the caller derived, so this call is asked of that instead
   * and its lossy entry is filtered out.
   */
  const reachedNow = !r.retryable && !r.permanent;
  const reached =
    reachedNow ||
    hasSpokenAttempt(
      readGoalLog(contact.goal?.attemptLog).filter((entry) => entry.attemptNo !== r.attemptNo),
    );

  const retrying =
    campaign !== null &&
    r.retryable &&
    !r.permanent &&
    // Never-reached only. Once somebody has answered, a silence is a MISSED
    // FOLLOW-UP and spends the follow-up budget below, never a retry.
    !reached &&
    contact.attempts + 1 <= campaign.retryCount &&
    // A silence at the ceiling settles by today's rules instead of re-arming.
    !budgetSpent &&
    // A contact who asked to be left alone gets no further dial, whatever the
    // last outcome classified as. The settle below turns this into COMPLETED.
    // Reachable only when this very call said so: a silence carries no note,
    // so the retry ladder is untouched by any of this in every case that is
    // not a conversation.
    !stop;

  if (retrying) {
    // The ladder, from the one function that defines it. The follow-up re-arm
    // below waits the same thing, and `retryWaitMinutes` is what stops the two
    // from drifting apart.
    const delay = retryWaitMinutes(campaign, contact.attempts);

    const rearmed = await db.campaignContact.updateMany({
      where: claimed,
      data: {
        status: 'PENDING',
        attempts: { increment: 1 },
        nextEligibleAt: new Date(r.now.getTime() + delay * 60_000),
        // Written outright, not left as it was. A contact the goal engine
        // followed up and that then went to voicemail is waiting on the retry
        // ladder now, and a lane that still read it as a follow-up would give
        // it follow-up priority for the rest of its life — which is exactly
        // what `followUpCount > 0` did before this column existed.
        armKind: 'RETRY',
        // `callbackAt` is deliberately untouched. It stays behind as history of
        // a promise already kept, and moving it here would either honour a
        // promise at the cooldown or manufacture one nobody made.
        ...carried,
      },
    });

    return rearmed.count === 0 ? 'race_lost' : 'retrying';
  }

  // A real conversation is the only completion. Everything else — a silence out
  // of budget, a blocked number, an outcome we never heard — is a failure, and
  // saying otherwise would put people who never picked up on a customer's
  // completed list. The one addition: a goal campaign's `stop` settles
  // COMPLETED even off a retryable outcome — "never call me again" is a
  // conversation's answer, not a failure — while a permanent disposition
  // (blocked, carrier-failed) stays FAILED: nobody spoke, whatever the note
  // says, and the do-not-call row above already stops every future dial.
  const connected = !r.retryable && !r.permanent;
  const status = connected || (stop && !r.permanent) ? 'COMPLETED' : 'FAILED';

  /**
   * The goal decision table, and the one branch it changes.
   *
   * A COMPLETED settle of a goal campaign enters the table below, read top to
   * bottom. The dial cap is computed ahead of it, but it decides nothing until
   * row 3: a `stop` or a `completed` settles whatever the budgets say, because
   * a person who asked to be left alone, or one who gave everything, is not
   * somebody a spent budget should re-arm or re-judge.
   *
   * 1. `call_outcome = stop` → settle COMPLETED, `goalAchieved = false`. The
   *    do-not-call row was already written above, outside the race guard.
   * 2. `call_outcome = completed` → COMPLETED, `goalAchieved = true`.
   * 3. Anything else on a contact somebody has REACHED — `incomplete`, no
   *    outcome at all, or this very call a silence after an earlier
   *    conversation — with the FOLLOW-UP budget remaining → re-arm PENDING at
   *    a gap the callback type chooses, rolled into the dial window exactly
   *    the way a callback booking rolls:
   *      - `immediate` — the call dropped mid-conversation — waits
   *        `IMMEDIATE_CALLBACK_MINUTES` and is armed `RESUME`. In its own lane
   *        deliberately: the ladder does not roll into the window, so a drop
   *        at closing time would ring at night.
   *      - `requested`, `flexible`, null, and no outcome — wait
   *        `followUpDelayHours`, armed `FOLLOW_UP`. A `requested` is then
   *        MOVED by the callback booking that runs after this resolution
   *        returns, to the time the note named — which re-arms it `CALLBACK`;
   *        when that time cannot be read, the wait it leaves standing is the
   *        right fallback.
   *    `followUpCount` moves; `attempts` (the retry counter) and `callbackAt`
   *    (history of a promise, and now only ever a promise) deliberately do
   *    not. Guarded by the same `claimed` predicate as every resolution write
   *    — a lost race drops the write and moves no counter.
   * 4. The same, the follow-up budget spent → settle. `goalAchieved = false`
   *    either way; they did talk to us. A last dial that was a conversation
   *    settles COMPLETED and one that was a silence settles FAILED, which is
   *    the existing rule about what the LAST dial was and is left alone here.
   *    A `requested` past the budget settles too: the promise cannot be kept
   *    inside it, and the journey says so.
   *
   * **Two budgets, and they belong to two different contacts.** `retryCount`
   * times a number NOBODY HAS ANSWERED; `maxGoalFollowUps` times a contact
   * somebody HAS, and the first answer forfeits whatever retries were left.
   * That is not the second ceiling over one telephone that was removed on
   * 2026-09-06 — the two are never spent by the same contact, so neither can
   * be the control that silently does nothing. The retry ladder says how
   * patient to be with a number; a conversation that happened is not evidence
   * the number is unreachable, and a person who already spoke to us is owed a
   * smaller budget on a longer clock, which is what `followUpDelayHours` is.
   *
   * No outcome — no extraction, a failed extraction, an answer outside the
   * pinned vocabulary — is row 3 as `flexible` and never a guess. It costs one
   * more call, bounded by the follow-up budget; read as anything else it would
   * put a judgement on a conversation nobody read. The journey shows the
   * attempt with a null outcome, which is how it says "no outcome" rather than
   * inventing one.
   */
  /**
   * The FOLLOW-UP LANE.
   *
   * A reached contact whose conversation is not finished — this call
   * incomplete, or carrying no outcome at all, or this call a silence after an
   * earlier conversation — gets one more call while the follow-up budget
   * lasts, `followUpDelayHours` from now, rolled into the window.
   *
   * Placed AHEAD of the settle rather than inside its COMPLETED arm, which is
   * where it used to live, because a missed follow-up is a retryable silence
   * and would otherwise have settled FAILED without ever asking whether this
   * contact was owed another call. The lane is entered on `reached`, and the
   * budget it spends is the follow-up one; the retry branch above has already
   * taken every contact nobody has answered.
   *
   * `!r.permanent` and `!stop` are the two facts no budget overrides: a
   * blocked number and a person who asked to be left alone are not somebody
   * to go back to. `completed` likewise — a finished conversation is finished.
   */
  const followingUp =
    goal !== null &&
    reached &&
    !stop &&
    !r.permanent &&
    note.outcome !== 'completed' &&
    contact.followUpCount < goal.maxGoalFollowUps &&
    !budgetSpent;

  if (followingUp) {
    // The one rule, shared with the re-extraction planner, and false for every
    // note while `IMMEDIATE_RESUME_ENABLED` is off. Why the flag and the
    // bookability both feed it is explained on `wantsResume`.
    const bookable = parseCallbackAt(note.callbackRequestedTime, goal.timezone, r.now).ok;
    const immediate = wantsResume(note, bookable);
    // Once an hour, not once a gap. A second immediate inside
    // `IMMEDIATE_REPEAT_WINDOW_MINUTES` of the last one — the resumed call
    // dropped again, or a model that answers "yes" to every abrupt ending —
    // is armed a whole window out from now, on the same lane. The anchor
    // moves with it, so a third inside the hour after THAT is pushed out
    // again; one that lands after the window has closed resumes on the gap.
    const repeated =
      immediate &&
      contact.lastImmediateAt !== null &&
      r.now.getTime() - contact.lastImmediateAt.getTime() <
        IMMEDIATE_REPEAT_WINDOW_MINUTES * 60_000;
    // A resume waits the fixed gap — or a whole window, when the throttle
    // above caught it. Every other follow-up waits `followUpDelayHours`, the
    // follow-up lane's own clock, and NOT the retry ladder: the ladder is
    // indexed by the retry counter, which a follow-up never moves, so a
    // contact followed up four times would have waited the same rung every
    // time — and that rung is sized for a number that did not pick up, not for
    // a person who did.
    const gapMinutes = immediate
      ? repeated
        ? IMMEDIATE_REPEAT_WINDOW_MINUTES
        : IMMEDIATE_CALLBACK_MINUTES
      : goal.followUpDelayHours * 60;

    const at = rollIntoDialWindow(new Date(r.now.getTime() + gapMinutes * 60_000), goal);

    const followedUp = await db.campaignContact.updateMany({
      where: claimed,
      data: {
        status: 'PENDING',
        nextEligibleAt: at,
        followUpCount: { increment: 1 },
        /**
         * An `immediate` re-arm is a RESUME; every other follow-up is a
         * FOLLOW_UP. Both spend a follow-up, and neither writes `callbackAt`.
         *
         * A dropped conversation is the most time-sensitive dial the engine
         * places — the person is still sitting there — so the resume lane
         * runs ahead of retries and of fresh contacts. It used to reach that
         * priority by arming `nextEligibleAt == callbackAt`, borrowing the
         * marker of a promise, and that had two costs paid by everybody
         * downstream. The lane it borrowed draws from the whole pass budget
         * and is exempt from the retry budget, so a bad window of drops
         * claimed every slot a campaign had and dialled nobody else; and
         * every consumer of `callbackAt` — the journey's `callback_due`, the
         * contacts list's `callbackPending`, the stats tile — described a
         * call the engine chose to place as one the lead had asked for.
         *
         * `callbackAt` keeps its narrow meaning: written by a real promise
         * and by nothing else. A resume is bounded by the retry reservation
         * it shares with the retry lane, and is drawn as its own thing
         * everywhere a person can read it.
         */
        armKind: immediate ? 'RESUME' : 'FOLLOW_UP',
        // The throttle's anchor: the instant this note said `immediate`,
        // whether or not the arm was pushed out. Untouched by every other
        // re-arm, so a follow-up between two drops does not reset the hour.
        ...(immediate ? { lastImmediateAt: r.now } : {}),
        ...carried,
      },
    });

    // Not settled: completedCount/failedCount must not move, exactly as the
    // retry re-arm leaves them.
    return followedUp.count === 0 ? 'race_lost' : 'following_up';
  }

  let goalAchieved: boolean | null = null;

  /**
   * A FAILED settle records the outcome too, whenever an EARLIER attempt
   * actually reached a person.
   *
   * The premise that a FAILED settle means nobody was spoken to holds only for
   * the first dial. A contact whose earlier dial was a conversation and whose
   * last one hit a blocked number is a contact we did talk to, and leaving its
   * outcome null drops it from BOTH sides of the stats page's
   * `groupBy(['goalAchieved'])` — so the goal-achieved percentage counts only
   * the contacts whose LAST dial connected, which is the population most
   * likely to have finished.
   *
   * **A conversation, not merely a recorded attempt.** `recordAttempt` logs
   * every attempt-naming result, so a contact whose retries were two busy
   * signals has a record full of entries and was never spoken to; an outcome
   * there would count somebody nobody reached as a goal not achieved. That is
   * the conformance matrix's G3 row, and it caught exactly this. It is the
   * same `reached` the lane above turns on, asked once.
   *
   * A campaign whose contact has no such attempt keeps today's null, which is
   * the case the null was always for.
   *
   * The outcome recorded is this failed call's own, and it is almost always
   * absent — a blocked number returns no extraction, and so does a missed
   * follow-up — so the value written is `false`: we spoke to this person at
   * some point and the goal was not reported met. That is the honest reading,
   * and it is the one the tile needs in order to count the contact at all.
   */
  if (goal !== null && status === 'FAILED' && reached) {
    goalAchieved = note.outcome === 'completed';
  }

  /**
   * A COMPLETED settle, once the lane above has declined to re-arm: achieved
   * only when the conversation actually finished. `stop` is not achieved — the
   * person asked to be left alone — and an `incomplete` that has run out of
   * follow-ups is not either, though it is still a COMPLETED settle rather
   * than a failure, because they did talk to us.
   */
  if (goal !== null && status === 'COMPLETED') {
    goalAchieved = !stop && note.outcome === 'completed';
  }

  const settled = await db.campaignContact.updateMany({
    where: claimed,
    data: {
      status,
      /**
       * Disarmed: a settled contact is waiting for nothing, because the call
       * was either made or has definitively failed.
       *
       * `armKind` is deliberately NOT rewritten here, and `callbackAt` stays
       * as it always did. Both are history on a settled row — the arm the
       * contact last waited under, and the record that a promise was once made
       * — and every reader of either pairs it with `status = 'PENDING'`, which
       * this write has just made false. Clearing the clock is what actually
       * ends the wait; a second column saying the same thing would only be a
       * second column to forget.
       *
       * The retry and follow-up branches above are the opposite case and stay
       * as they are — they move `nextEligibleAt`, because that contact *is*
       * still waiting.
       */
      nextEligibleAt: null,
      // Written only when the goal path decided one; `undefined` leaves the
      // column alone, so non-goal campaigns and FAILED settles stay byte-for-
      // byte what they were.
      ...(goalAchieved === null ? {} : { goalAchieved }),
      ...carried,
    },
  });

  if (settled.count === 0) return 'race_lost';

  if (r.campaignId !== null) {
    await db.campaign.update({
      where: { id: r.campaignId },
      data:
        status === 'COMPLETED'
          ? { completedCount: { increment: 1 } }
          : { failedCount: { increment: 1 } },
    });
  }

  return status === 'COMPLETED' ? 'completed' : 'failed';
}

/**
 * Closes an attempt, resolves its contact, and charges for the minutes.
 *
 * Returns what actually happened, so the caller can log it rather than guess.
 */
export async function applyTerminalOutcome(outcome: TerminalOutcome): Promise<OutcomeResult> {
  const attempt = await prisma.callAttempt.findUnique({
    where: { id: outcome.attemptId },
    // No goal switch any more: the record is written for every campaign, and
    // a deleted campaign's null is the one state in which there is nothing to
    // record against.
    include: {
      campaign: { select: { id: true, name: true, workspaceId: true } },
    },
  });

  if (!attempt) return 'unknown';
  if (attempt.chargedAt !== null) return 'already_closed';

  const now = new Date();
  const rate = attempt.rateCreditsPerMin ?? 0n;

  /**
   * The plan this call was launched under, both halves of it, read back from
   * the snapshot rather than resolved again — staff may have re-priced or
   * re-pulsed the tier while the phone was ringing.
   *
   * `?? 1` is not a default anybody chose. It is the honest reading of an
   * attempt row created **before this column existed**, which was billed per
   * second; those rows are in flight for minutes rather than days, so the
   * window is small, and erring the other way would charge a customer a pulse
   * they were never on.
   */
  const increment = attempt.billingIncrementSecs ?? 1;
  const { billedSecs, cost } = chargeFor(rate, outcome.durationSecs, increment);

  const status = normaliseOutcomeText(outcome.status);
  const disposition = normaliseOutcomeText(outcome.disposition);
  const answeredBy = normaliseOutcomeText(outcome.answeredBy);

  const errorCode = normaliseErrorCode(outcome.errorCode);
  // Normalised once, here, and null for a blank: the guard on the write below
  // reads THIS value, so a whitespace-only reason cannot slip past it and
  // write null over what a webhook stored.
  const endCallReason = normaliseEndCallReason(outcome.endCallReason);
  // The carrier's clock, from the payload or the row: an answered call was
  // tested, whatever the detector says. The row is stamped by the IN_PROGRESS
  // status event; the payload covers a call whose live events were lost.
  const answeredAtRaw = outcome.answeredAt ?? null;
  const answeredAt =
    answeredAtRaw instanceof Date
      ? answeredAtRaw
      : answeredAtRaw && !Number.isNaN(Date.parse(answeredAtRaw))
        ? new Date(answeredAtRaw)
        : null;
  const { retryable, permanent, platformFault } = classifyOutcome({
    status,
    answeredAt: answeredAt ?? attempt.answeredAt,
    disposition,
    answeredBy,
    failureReason: outcome.failureReason,
    // The carrier's cause decides whether a `failed` disposition is this
    // number's fault or the platform's — see `PERMANENT_DISPOSITION`.
    hangupCause: outcome.hangupCause,
    // The one-vocabulary ending beside the cause: SYSTEM_ERROR on a silence
    // is the platform's fault like an `error_code`, INVALID_NUMBER / BLOCKED
    // a verdict on the number like a Q.850 cause.
    endCallReason,
    // And the platform's own code outranks the cause: set, the carrier never
    // gave a verdict at all.
    errorCode,
    // Read for one thing only: the supplier's wallet running dry, which
    // arrives as text with no code beside it.
    errorMessage: outcome.errorMessage,
  });
  // Account-wide and never clears on its own: pause on the first sight of it.
  const platformCreditDry = exhaustsPlatformCredit(errorCode, outcome.errorMessage);

  // The attempt row records what the platform said about the *call*: a call
  // that connected to voicemail did complete. What it meant for the contact is
  // the classification above, and the two are deliberately different questions.
  const answered = status !== null && ANSWERED.has(status);

  // Bounded once, outside the transaction: it is pure, and a blob big enough
  // to be worth bounding is not worth holding a row lock while we do it.
  const extraction = boundExtractionValues(outcome.extraction);

  let shortfall = false;
  let alreadyCharged = false;
  let pausedForPlatformCredit = false;

  try {
    await prisma.$transaction(async (tx) => {
      // The marker, inside the transaction. This is the whole of the
      // exactly-once guarantee.
      await tx.webhookEvent.create({
        data: { eventKey: outcome.eventKey, event: outcome.eventKey.split(':')[0]! },
      });

      /**
       * The campaign row, before the attempt row — the shared lock order.
       *
       * Every writer in this tree that touches a campaign and its rows in one
       * transaction takes the campaign `FOR UPDATE` first. This transaction
       * locks an attempt row below, and `DELETE /campaigns/:cid` takes the
       * campaign lock and then SET-NULLs every attempt row of the campaign —
       * the same pair in the opposite order, which is a deadlock with one side
       * killed. Killed here, that is a webhook answering 500 with the charge
       * rolled back, on a delivery the platform retries into the same race.
       *
       * The id is the pre-transaction read's; if the campaign was deleted in
       * between, this locks nothing and the delete has already nulled the
       * pointers, so there is no pair left to deadlock over. The later lock
       * inside `resolveContact` is re-entrant. The shortfall branch below
       * writes the campaign too, and is covered by this same lock.
       */
      if (attempt.campaignId !== null) {
        await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${attempt.campaignId} FOR UPDATE`;
      }

      /**
       * The pin, read *inside* the transaction and behind the row lock.
       *
       * `attempt.resolvedAt` from the read above is stale by however long this
       * transaction waited to start — and it reliably waits, because the
       * pacing event's transaction holds this row lock while it resolves the
       * contact. Two writers stamp `resolvedAt` while deliberately leaving
       * `chargedAt` null (the pacing event, the reaper's abandoned path), so
       * the `chargedAt` guard on the close below does not re-cover it: judged
       * on the stale value, a delivery that lost that wait would re-apply an
       * outcome the queue has already moved past. `FOR UPDATE` first, so the
       * value cannot change between this read and the close.
       */
      const pinned = await tx.$queryRaw<{ resolvedAt: Date | null }[]>`
        SELECT "resolvedAt" FROM "CallAttempt" WHERE id = ${outcome.attemptId} FOR UPDATE`;

      if (pinned.length === 0) {
        alreadyCharged = true;

        return;
      }

      /**
       * The `chargedAt` check above again, this time **inside** the transaction
       * and as a `where` rather than a read.
       *
       * The read is taken before the transaction opens, so two deliveries for
       * one attempt through different event keys — a webhook and the reaper's
       * reconciliation are exactly that pair, and their keys are deliberately
       * different — can both see a null and both proceed. The ledger's
       * `@@unique([accountId, reference])` refuses the second charge, but only
       * when there *is* a charge: a zero-duration call writes no ledger row at
       * all, and both would have applied their outcome to the contact.
       *
       * Guarded here, the second one matches nothing (Postgres re-evaluates the
       * predicate after the first commits and releases the row) and everything
       * below it is skipped.
       */
      const closed = await tx.callAttempt.updateMany({
        where: { id: outcome.attemptId, chargedAt: null },
        data: {
          status: answered ? 'COMPLETED' : 'FAILED',
          upstreamStatus: outcome.status,
          // Verbatim upstream text, deliberately: the attempt row is the record
          // of what the platform actually said, and the normalised copy that
          // drives our own decisions lands on the contact.
          disposition: outcome.disposition,
          answeredBy: outcome.answeredBy,
          hangupCause: outcome.hangupCause,
          hangupSource: outcome.hangupSource ?? null,
          // Only when carried, so a reconcile over a detail that predates the
          // field cannot blank what a webhook wrote. Unconditional otherwise:
          // the completion's bot view overwrites the status event's carrier
          // snapshot, which is the whole point of reading both.
          ...(endCallReason === null ? {} : { endCallReason }),
          // The answer stamp, only when the payload carries one the row lacks:
          // the budget reads the row, and a completion that says "answered"
          // over a row whose live events were lost must leave the row saying
          // the same, or the settle and the budget disagree about this dial.
          ...(answeredAt !== null && attempt.answeredAt === null ? { answeredAt } : {}),
          // Spread rather than assigned: `undefined` means this delivery said
          // nothing about the field, and Prisma omits an undefined key from
          // the UPDATE — so a pacing event that carries no session cannot
          // blank a conversation the completion already stored.
          ...(outcome.transcript === undefined
            ? {}
            : { transcript: boundTranscript(outcome.transcript) ?? Prisma.DbNull }),
          ...(outcome.variables === undefined
            ? {}
            : { variables: boundVariables(outcome.variables) ?? Prisma.DbNull }),
          ...(outcome.recordingAvailable === undefined
            ? {}
            : { recordingAvailable: outcome.recordingAvailable }),
          ...(outcome.billDurationSeconds === undefined
            ? {}
            : { billDurationSeconds: outcome.billDurationSeconds }),
          durationSecs: outcome.durationSecs,
          // Beside the duration and never instead of it. A charge that records
          // only what was billed cannot answer "why is this a minute when the
          // call was forty-seven seconds", which is the first question a
          // billing increment generates.
          billedSecs,
          endedAt: outcome.endedAt,
          resolvedAt: now,
          // `undefined` leaves the column alone, which is what a delivery that
          // carried no extraction means: the answers of a call we already have
          // answers for must not be erased by a later reconciliation that read
          // a detail payload without them.
          ...(extraction === null ? {} : { extraction }),
          costCredits: cost,
          chargedAt: now,
          ...(outcome.failureReason ? { launchError: outcome.failureReason.slice(0, 500) } : {}),
          // Verbatim, like the disposition beside it: the row is the record of
          // what the platform said. Written only when CARRIED: every caller
          // reads the pair with `readString`, which answers null for an absent
          // key, so a completion or a reconciliation that arrived without it
          // must leave what the pacing event wrote — the code is also what
          // keeps the dial out of the budget, and blanking it here would
          // charge the ladder for the very dial the give-back protected.
          ...(outcome.errorCode == null ? {} : { errorCode: outcome.errorCode }),
          ...(outcome.errorMessage == null ? {} : { errorMessage: outcome.errorMessage.slice(0, 500) }),
        },
      });

      if (closed.count === 0) {
        alreadyCharged = true;

        return;
      }

      /**
       * The context record, BEFORE the resolution and in its transaction: the
       * decision reads the record, and a follow-up re-armed here must never be
       * dialled ahead of its own memory. Written on every terminal outcome of
       * a goal campaign, silences included — the note has to exist for every
       * attempt, or the next call's `last_call_note` would describe the call
       * before last. Keyed by attempt number, so a replay is a no-op.
       *
       * Inside the charge's transaction rather than after it, which is what
       * retires the old "record on a duplicate delivery too" rule: the record
       * and the charge now commit or roll back together, so there is no longer
       * a window in which one exists without the other for a redelivery to
       * repair.
       */
      //
      // Not for a platform fault. The number was never dialled, so there is
      // no call for the record to describe: an entry here would move the
      // last-call line onto "the call could not be connected" and hand the
      // next dial a note about a call nobody had, over the conversation it
      // should be picking up from. Skipping it is also what keeps the log
      // bounded by the dial budget while a fault repeats at the cooldown.
      if (attempt.campaignContactId !== null && attempt.campaign !== null && !platformFault) {
        await recordAttempt(
          {
            campaignContactId: attempt.campaignContactId,
            attemptNo: attempt.attemptNo,
            kind: deriveKind(attempt),
            status,
            disposition,
            answeredBy,
            extraction,
            // The promised time, verbatim, so the record's last-call line can
            // say "asked to be called back: <when>". Kept on the entry whose
            // call made the promise, whatever kind of dial that call was.
            //
            // Read by the SAME rule as the booking (`callbackRawFrom`, goal
            // arm): the note's time, and only when the note says a callback
            // was requested. A goal campaign's agent may still carry the
            // plain `callback_requested_at` key from a callbacks campaign it
            // shares the agent with, and a line built off that key would tell
            // the next call the person asked for a time this campaign never
            // booked.
            callbackNote: ((raw) => (typeof raw === 'string' ? raw : null))(
              callbackRawFrom(extraction),
            ),
            durationSecs: outcome.durationSecs,
          },
          tx,
        );
      }

      /**
       * The pin this dial's outcome carries, and why it is the attempt row.
       *
       * The contact's own guards — claimed, and nothing numbered above this
       * attempt — read as "nothing has been dialled since", and between a
       * re-claim and the insert of that dial's attempt row they are true of the
       * *previous* dial too: the contact is `QUEUED` again, and the row that
       * would outrank this one does not exist yet. A delivery landing in those
       * milliseconds would apply an outcome belonging to a call already over
       * onto the call replacing it — a voicemail from ten minutes ago settling
       * a conversation happening right now.
       *
       * The attempt row is the one thing that is unique per dial, and
       * `resolvedAt` is stamped by whoever applies its outcome. One already
       * carrying one has had its say about this contact, and the queue has
       * moved on without it. The charge below still runs: the minutes were
       * real, and refusing the queue move is not refusing the bill.
       */
      const alreadyResolved = pinned[0]!.resolvedAt !== null;

      // Null when the campaign was deleted while this call was still up. The
      // charge below still runs — the minutes were real and somebody owes for
      // them — but there is no queue entry left to move.
      if (attempt.campaignContactId !== null && !alreadyResolved) {
        await resolveContact(tx, {
          campaignId: attempt.campaignId,
          campaignContactId: attempt.campaignContactId,
          attemptNo: attempt.attemptNo,
          sessionId: attempt.upstreamSessionId,
          disposition,
          answeredBy,
          retryable,
          permanent,
          platformFault,
          // The same bounded blob the attempt row stores, for the goal path's
          // progress preview — the context record has not merged it yet.
          extraction,
          now,
        });
      }

      if (platformCreditDry && attempt.campaign !== null) {
        pausedForPlatformCredit = await pauseForPlatformCredit(tx, attempt.campaign.id, now);
      }

      // A zero-duration call — never answered, or answered and hung up inside
      // a second — costs nothing. No ledger row is written for it: the DID
      // release markers are zero-amount rows because they carry a fact nothing
      // else records, and a zero-credit call carries nothing the attempt does
      // not already say. `chargedAt` is still set, so it cannot be charged
      // later by a late delivery.
      if (cost === 0n) return;

      // The same conditional debit renting and renewal use: the sufficiency
      // test is in the `where`, so there is no window between checking the
      // balance and spending it and a negative balance is unreachable rather
      // than unlikely.
      const debited = await tx.account.updateMany({
        where: { id: attempt.accountId, credits: { gte: cost } },
        data: { credits: { decrement: cost } },
      });

      if (debited.count === 0) {
        // Fail closed. Nothing is partially debited: the ledger's rule is that
        // a balance never goes negative and every movement pairs with a row,
        // and breaking both to recover a fraction of a credit is not a trade
        // worth making.
        shortfall = true;

        await tx.callAttempt.update({ where: { id: outcome.attemptId }, data: { shortfall: true } });

        await tx.creditTransaction.create({
          data: {
            accountId: attempt.accountId,
            workspaceId: attempt.workspaceId,
            callAttemptId: attempt.id,
            reference: attempt.id,
            amount: 0n,
            type: 'CALL_USAGE_SHORTFALL',
          },
        });

        if (attempt.campaignId !== null) {
          // `CREDIT_EXHAUSTED` rather than PAUSED, and the same status the
          // dispatcher's own low-balance gate writes: the operator did not stop
          // this campaign, the balance did, and `resume` has to know to re-run
          // the estimate before letting it dial again.
          await tx.campaign.updateMany({
            where: { id: attempt.campaignId, status: 'RUNNING' },
            data: { status: 'CREDIT_EXHAUSTED', pausedAt: now, haltReason: SHORTFALL_HALT_REASON },
          });
        }

        return;
      }

      await tx.creditTransaction.create({
        data: {
          accountId: attempt.accountId,
          workspaceId: attempt.workspaceId,
          callAttemptId: attempt.id,
          // Rides the existing per-account unique index, so a second charge
          // for one attempt is refused by the database.
          reference: attempt.id,
          amount: -cost,
          type: 'CALL_USAGE',
        },
      });
    });
  } catch (err) {
    // A duplicate marker means this exact delivery has already been applied.
    // The rollback is the correct outcome, and the caller answers 200 so the
    // platform stops retrying.
    if (isUniqueViolation(err)) return 'duplicate';

    throw err;
  }

  // Another delivery for this attempt committed its charge while this one was
  // in flight. Nothing here ran, and the caller answers as it would for any
  // other already-closed attempt.
  if (alreadyCharged) return 'already_closed';

  if (pausedForPlatformCredit && attempt.campaign !== null) {
    notifyPlatformCreditExhausted(attempt.campaign);
  }

  if (shortfall) {
    void notify(
      attempt.workspaceId,
      'ADMINS_ONLY',
      'campaign.paused_insufficient_credits',
      // The campaign is gone only when it was deleted mid-call, and the
      // shortfall is still worth saying: the workspace ran out of credits,
      // which is about the balance rather than about the campaign.
      `${attempt.campaign?.name ?? 'A campaign'} was paused`,
      SHORTFALL_HALT_REASON,
      '/settings/billing',
    );

    // CREDIT_EXHAUSTED is an exit from RUNNING, so a BOTH campaign that just ran
    // out of credits gives its inbound DIDs back too — an insolvent campaign
    // cannot answer either (design §5.2). Post-commit, best-effort and
    // idempotent (no-op for an outbound campaign, which holds no claims).
    if (attempt.campaignId !== null) {
      try {
        await releaseInboundClaims(attempt.campaignId);
      } catch (err) {
        console.error('[inbound] release on credit exhaustion failed:', err);
      }
    }
  }

  return 'applied';
}
