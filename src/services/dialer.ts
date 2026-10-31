import { randomUUID } from 'node:crypto';
import type { CampaignStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { agentIsUsable } from '../lib/agentVisibility.js';
import { evaluateWindow, localDayStart } from '../lib/dialingWindow.js';
import {
  IN_FLIGHT,
  accountInFlight,
  campaignInFlight,
  campaignLaneInFlight,
  resolveAccountConcurrency,
  campaignPendingPlacement,
  accountPendingPlacement,
} from '../lib/concurrency.js';
import { computeLaneBudgets, splitPool } from '../lib/laneBudgets.js';
import { giveBackWithBackoff } from '../lib/giveBack.js';
import { totalDialsFor } from '../lib/dialBudget.js';
import { bindingCap } from '../lib/blockedReason.js';
import { resolveCallRate } from '../lib/dialerPricing.js';
import { TierRateUnavailableError } from '../lib/tierPricing.js';
import { formatCorrelationId } from '../lib/callCorrelation.js';
import { variablesFor } from '../lib/callVariables.js';
import { isInboundFacing } from '../lib/campaignConfig.js';
import { releaseInboundClaims } from '../lib/inboundStart.js';
import { getConcurrency, startCall } from '../adapter/vocobase.js';
import { closeStaleAttempts, releaseStaleClaims } from './dialerReaper.js';
import {
  claimContacts,
  excludeDoNotCallContacts,
  settleContactsOverDialBudget,
  type ClaimedContact,
  type ClaimLane,
} from './dialerClaim.js';
import { releaseGoalPromptBlock } from './campaignPrompt.js';
import { goalVariables } from '../lib/goalVariables.js';
import { contextVariables } from '../lib/contextVariables.js';
import { goalSnapshot } from './goalContext.js';
import { advanceRoundRobinCursor, resolveDialRotation, type DialNumber } from './dialerNumbers.js';
import type { CallPlacementJobData } from '../lib/queue/types.js';
import { attemptKindOf, type AttemptKind } from '../lib/attemptKind.js';
import { notifyPlatformCreditExhausted, pauseForPlatformCredit } from './dialerOutcome.js';

/**
 * The outbound dialer.
 *
 * A sweep walks RUNNING campaigns, claims contacts that are due, and places
 * their calls. It is modelled on `didRenewal.ts` throughout — started from
 * `server.ts` and never from `createApp()`, re-entrancy guarded, bounded,
 * idempotent by compare-and-set, and logging what it did rather than
 * discarding it.
 *
 * It differs from that sweep in one way that shapes everything below: the
 * renewal sweep spends money, and this one spends money **and rings a
 * stranger's telephone**. So every question it asks is asked again on every
 * pass — the agent, the number, the window, the balance, the caps — because
 * `start` checked them once and each of them can change underneath a campaign
 * through an UPDATE no foreign key can see.
 */

/** Most campaigns one pass will look at. Bounded for the reason the renewal
 *  sweep's batch is: a pass that runs again in a minute is the same throughput
 *  with a ceiling on the blast radius of any single run. */
const CAMPAIGN_BATCH = 200;

/** Why a pass stopped launching early. Each is account-wide, so continuing
 *  would collect the identical failure from every remaining campaign. */
export type SweepHalt = 'rate_limited' | 'supplier_refused' | 'supplier_unfunded' | 'pool_unreadable';

export interface DialerSweepResult {
  campaigns: number;
  /**
   * Contacts this pass claimed and posted to `call-placement`.
   *
   * The pass's own unit of work, and what the budget and the shared pool are
   * decremented by. A claim is a commitment to dial — an upper bound on what
   * will actually ring — so spending the budget on it can only under-fill a
   * pass, never over-fill one.
   */
  posted: number;
  /**
   * Calls that actually left, **reported by the placement worker, not by the
   * tick.** The tick no longer dials, so it no longer knows; these two stay in
   * the shape because the pass's observable outcome is still the sum of the
   * tick's claims and the placements they became, and the harnesses that grade
   * this engine add them back together.
   */
  launched: number;
  /** Claims that never became calls. Non-zero is worth reading the log for. */
  launchFailed: number;
  /** Contacts passed over because the test allowlist is active. */
  skippedNotAllowlisted: number;
  paused: number;
  completed: number;
  reaped: number;
  halted: SweepHalt | null;
}

export interface DialerSweepOptions {
  /** Injected so tests are deterministic rather than dependent on the clock. */
  now?: Date;
}

const emptyResult = (): DialerSweepResult => ({
  campaigns: 0,
  posted: 0,
  launched: 0,
  launchFailed: 0,
  skippedNotAllowlisted: 0,
  paused: 0,
  completed: 0,
  reaped: 0,
  halted: null,
});

/** Everything one pass needs about a campaign, in one round trip. */
export const CAMPAIGN_INCLUDE = {
  agent: { select: { id: true, externalId: true, name: true, status: true, workspaceId: true, variables: true, voiceTierSlug: true } },
  phoneNumber: { select: { id: true, did: true, status: true, workspaceId: true } },
  /**
   * The dialing rotation, in rotation order. Joined rather than fetched per
   * campaign, because this runs over every RUNNING campaign on the platform
   * once a minute and the pass must stay one round trip wide.
   */
  dialNumbers: {
    select: { phoneNumber: { select: { id: true, did: true, status: true, workspaceId: true } } },
    orderBy: { position: 'asc' },
  },
  workspace: {
    select: {
      id: true,
      ownerAccountId: true,
      owner: { select: { id: true, credits: true, concurrencyLimit: true } },
    },
  },
} satisfies Prisma.CampaignInclude;

export type SweepCampaign = Prisma.CampaignGetPayload<{ include: typeof CAMPAIGN_INCLUDE }>;

/**
 * Pauses a campaign and says why, once.
 *
 * Conditional on it still being RUNNING, so two runners cannot both pause it
 * and emit two notifications for one event — the same discipline the
 * completion transition uses below.
 */
async function pauseCampaign(
  campaign: SweepCampaign,
  type: string,
  title: string,
  body: string,
  href?: string,
  /**
   * `ALL_MEMBERS` by default, because "why is this campaign not dialling" is a
   * question a MEMBER asks and can act on. The exceptions are the two pauses
   * whose *reason* is billing — the balance and the rate — since credits and
   * the plan are ADMIN-only everywhere else in this service, and a
   * notification is not a place to make an exception to that.
   */
  scope: 'ALL_MEMBERS' | 'ADMINS_ONLY' = 'ALL_MEMBERS',
  /**
   * Which stopped state to leave the campaign in. `CREDIT_EXHAUSTED` is its own
   * status rather than a PAUSED with a note, so `resume` knows to re-run the
   * balance estimate and the page can say which of the two happened — an
   * operator who tops up and presses Resume must not be told the campaign was
   * merely paused.
   */
  to: CampaignStatus = 'PAUSED',
  now: Date = new Date(),
): Promise<boolean> {
  const paused = await prisma.campaign.updateMany({
    where: { id: campaign.id, status: 'RUNNING' },
    // The body the notification carries is the answer the campaign page
    // prints, so the two cannot say different things about one pause.
    //
    // Every member reads the campaign page, ADMINS_ONLY pauses included. That
    // is deliberate and it is the one exception to "billing and the plan are
    // ADMIN-only": a member watching a campaign that stopped dialing is owed
    // the reason, and every one of these bodies already tells them what to
    // DO ("top up", "contact support") without a number, a plan name or a
    // balance in it. The billing page itself stays ADMIN-only; the dashboard
    // prints no link to it from this sentence.
    data: { status: to, pausedAt: now, haltReason: body },
  });

  if (paused.count === 0) return false;

  console.warn(`[dialer] paused campaign ${campaign.id}: ${type}`);
  void notify(campaign.workspaceId, scope, type, title, body, href);

  // Every exit from RUNNING gives the inbound DIDs back (design §5.2), and
  // this is the exit nobody pressed: a BOTH campaign the dispatcher paused
  // must not keep answering for a campaign that has stopped. Post-commit and
  // best-effort, as the credit-exhaustion release is; a no-op for OUTBOUND.
  if (isInboundFacing(campaign.type)) {
    try {
      await releaseInboundClaims(campaign.id);
    } catch (err) {
      console.error(`[inbound] release on dispatcher pause of ${campaign.id} failed:`, err);
    }
  }

  return true;
}

/**
 * The queue statuses that mean this campaign still has work.
 *
 * `PENDING` is waiting — fresh, cooling down, or armed for a callback — and
 * `QUEUED` is a dial in flight. Eligibility is no longer computed from
 * `lastAttemptAt + cooldownMinutes` at query time: `nextEligibleAt` is a stored
 * column now, because a promised callback is a specific instant that no formula
 * over the campaign's settings can reproduce.
 *
 * `CALLING` is inert — nothing writes it — and is counted anyway. A row stuck
 * in it would otherwise let a campaign announce itself finished with a contact
 * still on the board.
 */
const UNFINISHED_CONTACT_STATUSES = ['PENDING', 'QUEUED', 'CALLING'] as const;


/**
 * What one failed launch tells the pass to do next.
 *
 * Three separate answers, because the causes are at three different scopes and
 * collapsing any two of them dials somebody who should not have been dialed —
 * or stops a platform's worth of campaigns over one workspace's fault.
 */
interface LaunchDisposition {
  /** Stop the whole pass. Account-wide: every remaining campaign would meet
   *  the identical wall. */
  halt: SweepHalt | null;
  /** Stop *this* campaign for this pass — it has just been paused, or another
   *  runner paused it first. Says nothing about anybody else's campaigns. */
  stopCampaign: boolean;
  /** Whether this runner is the one that recorded the pause. Counted, so two
   *  racing runners report one pause between them rather than one each. */
  paused: boolean;
}

const CARRY_ON: LaunchDisposition = { halt: null, stopCampaign: false, paused: false };

export interface LaunchOutcome extends LaunchDisposition {
  launched: boolean;
  /**
   * The dial was abandoned *before* the request went out and the contact has
   * already been disposed of. Counted separately from a launch failure, which
   * is a call that was attempted and did not happen: nothing was attempted
   * here, and folding the two together would report a stopped campaign as a
   * campaign whose calls are failing.
   */
  abandoned?: boolean;
  /**
   * This dial had already been placed, and this run of it is a replay.
   *
   * Only a retried placement job can produce it: the attempt row for this
   * contact and this ordinal already exists **and already carries the
   * platform's call id**, so the request went out and was answered, and the
   * only thing the first run lost was its own life. Neither a launch nor a
   * failure — the call is on the phone, and saying so twice would double every
   * figure a campaign reports.
   */
  alreadyPlaced?: boolean;
}

/**
 * Places the call for one already-claimed contact.
 *
 * The contact left `PENDING` in the claim's own statement, so nothing here has
 * to win a race for it. What this transaction still does is write the attempt
 * row **before** the dial, pinned to the claimed row's identity and its
 * `QUEUED` status: the unique on `(campaignContactId, attemptNo)` is the dial's
 * mutual-exclusion token, so a second runner that somehow reached the same
 * contact fails its insert instead of placing a second call.
 *
 * The upstream request is deliberately **outside** that transaction. A network
 * call inside one holds a pooled connection for the length of an upstream
 * timeout, and `didRenewal.ts` keeps the same separation for the same reason.
 *
 * ## Why the campaign is re-read here, one contact at a time
 *
 * A batch is claimed whole and dialled serially, so an operator pressing Stop
 * is racing this loop rather than the pass. `stop` sweeps every `PENDING`
 * contact and cannot see the claimed ones — they are `QUEUED` — and it leaves
 * that status exactly where it is, so a check on the contact alone would let
 * every remaining contact in the batch be dialled *after* the campaign was
 * stopped. Up to a batch of calls the operator believes they cancelled.
 *
 * The campaign row is taken `FOR UPDATE` first, which is both the order every
 * writer here holds and what makes this a decision rather than a guess: `stop`
 * holds that same lock while it sweeps, so this either reads the campaign
 * before the stop or reads the stop.
 *
 * The two refusals are deliberately different, because the decisions are:
 *
 * - **Stopped** (`stoppedAt` set, whatever the status now reads — `complete`
 *   relabels it): the operator's decision is that these calls are not going to
 *   be made. The contact is swept to `SKIPPED` with its counter, exactly as the
 *   stop sweep would have done had it been able to see it. Released to
 *   `PENDING` instead, it would sit on a stopped campaign as queue work the
 *   sweep already decided against — and a later top-up or restart would dial it.
 * - **Merely not RUNNING** (paused, credit-exhausted): the calls are not to be
 *   made *now*. The contact goes back untouched, on the same terms as
 *   `releaseUnlaunched` — no timestamp moved, so an armed callback stays armed
 *   and a retry stays due — and resume dials it.
 */
export async function dialContact(
  campaign: SweepCampaign,
  contact: ClaimedContact,
  from: DialNumber,
  rate: { tierId: string; tierSlug: string; rateCreditsPerMin: bigint; incrementSecs: number },
  now: Date,
  attemptNo: number,
  /**
   * What kind of dial this is, decided at claim time and carried by the job.
   * Null for a job enqueued before the field existed; nothing is stamped
   * then, and readers fall back to the ordinal.
   */
  attemptKind: AttemptKind | null = null,
): Promise<LaunchOutcome> {
  const agent = campaign.agent!;

  const attempt = await prisma
    .$transaction(async (tx) => {
      const [live] = await tx.$queryRaw<
        { status: CampaignStatus; stoppedAt: Date | null }[]
      >`SELECT status, "stoppedAt" FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

      // Deleted mid-batch. The contact rows went with it, so there is neither
      // anything to dial nor anything to hand back.
      if (live === undefined) return 'abandoned' as const;

      if (live.stoppedAt !== null) {
        const swept = await tx.campaignContact.updateMany({
          where: { id: contact.id, status: 'QUEUED' },
          data: { status: 'SKIPPED' },
        });

        if (swept.count > 0) {
          await tx.campaign.update({
            where: { id: campaign.id },
            data: { skippedCount: { increment: swept.count } },
          });
        }

        return 'abandoned' as const;
      }

      if (live.status !== 'RUNNING') {
        await tx.campaignContact.updateMany({
          where: { id: contact.id, status: 'QUEUED' },
          data: { status: 'PENDING' },
        });

        return 'abandoned' as const;
      }

      const claimed = await tx.campaignContact.findFirst({
        where: { id: contact.id, status: 'QUEUED' },
        select: { id: true },
      });

      if (!claimed) return null;

      /**
       * The row this dial may have already written.
       *
       * `attemptNo` is decided once, by the tick that claimed this contact,
       * and travels with the placement job — so a job that died between this
       * insert and its answer comes back asking for **the same** ordinal. The
       * unique on `(campaignContactId, attemptNo)` means only one row can ever
       * exist for it, and finding it here is how the replay reuses the
       * reference the platform has already seen rather than minting a second
       * one and ringing the phone again.
       *
       * The ordinal is not derived from `MAX + 1` any more for exactly that
       * reason: derived, a retry would count one higher than the row it wrote
       * itself and place a genuinely new call. It is still `MAX + 1` — the
       * tick computes it, over the same history, one step earlier.
       */
      const existing = await tx.callAttempt.findFirst({
        where: { campaignContactId: contact.id, attemptNo },
      });

      if (existing) return existing;

      return tx.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: contact.id,
          workspaceId: campaign.workspaceId,
          // The owner at dial time. Re-read with the campaign rather than
          // derived later, so an ownership change mid-call cannot redirect the
          // charge to somebody who never placed it.
          accountId: campaign.workspace.ownerAccountId,
          attemptNo,
          // The claim's own answer to what this dial was — see the schema
          // comment: the columns it was judged from mutate, this does not.
          ...(attemptKind === null ? {} : { kind: attemptKind }),
          // The tick's clock, not the database's. The release sweep and the
          // pending-placement counts decide "this claim's placement ran" by
          // `startedAt >= claimedAt`, and `claimedAt` is stamped from the
          // injected sweep clock — the same instant this job carries. Left to
          // the column default, the two sides come from different clocks, and
          // a sweep clock ahead of the database's reads every placed dial as
          // a claim whose job never ran.
          startedAt: now,
          // Which number in the rotation reached this person. A snapshot: the
          // rotation may have been edited by the time anybody reads the journey.
          fromNumber: from.did,
          tierId: rate.tierId,
          tierSlug: rate.tierSlug,
          rateCreditsPerMin: rate.rateCreditsPerMin,
          // The other half of the plan, snapshotted for the same reason and
          // from the same resolution. Split across two lookups they could
          // disagree, and a call billed at one plan's rate in another plan's
          // pulse is billed on a plan nobody sold.
          billingIncrementSecs: rate.incrementSecs,
        },
      });
    })
    .catch(async (err) => {
      console.error(`[dialer] could not open an attempt for contact ${contact.id}:`, err);

      /**
       * Released here and now, because nothing else ever would.
       *
       * The loop walks past this contact, so `releaseUnlaunched` never sees it;
       * the transaction rolled back, so there is no attempt row for the reaper
       * to reconcile; and the completion pass counts it as remaining work. One
       * failed INSERT would otherwise strand a contact `QUEUED` forever and,
       * with it, its campaign's ability to finish — `complete` refuses with a
       * 409 while any contact is claimed.
       *
       * The same terms as `releaseUnlaunched`: guarded on `QUEUED`, and not one
       * timestamp touched. Nothing was attempted, so an armed callback stays
       * armed and a retry stays due.
       */
      await prisma.campaignContact
        .updateMany({ where: { id: contact.id, status: 'QUEUED' }, data: { status: 'PENDING' } })
        .catch((releaseErr) => {
          console.error(`[dialer] could not release contact ${contact.id}:`, releaseErr);
        });

      return null;
    });

  if (attempt === 'abandoned') return { launched: false, abandoned: true, ...CARRY_ON };
  if (!attempt) return { launched: false, ...CARRY_ON };

  /**
   * The replay that has nothing left to replay.
   *
   * A reused row carrying the platform's call id is a dial that went out and
   * was answered — everything after it in the first run is already done. The
   * reference is idempotent, so asking again would be *safe*; it would simply
   * be a round trip to be told what this row already says, on a call that may
   * by now have ended.
   */
  if (attempt.upstreamCallId !== null) return { launched: false, alreadyPlaced: true, ...CARRY_ON };

  /**
   * The call-note overlay: the one reserved variable, on a dial whose contact
   * has a note, rendered at placement time from the context record.
   *
   * One indexed read (the `campaignContactId` unique), on every dial now that
   * every campaign follows an unfinished conversation up. A null row is the
   * first dial's normal state: the record is created lazily by the first
   * recorded attempt, and a dial with no note carries no variable at all —
   * the header YE wrote into the prompt then renders over nothing, which is
   * what "if any" means. Nothing else from YE rides along: no goal, no call
   * number, no memory paragraph.
   *
   * Spread AFTER the projection, so the reserved name wins any collision with
   * a `variableMap` or declared-list variable of the same name: the managed
   * prompt block interpolates it by name, and an operator's column that
   * happens to be called the same must not silently replace what the last
   * call told the next one to say.
   */
  const projected = variablesFor(campaign, agent.variables, contact);
  const variables = {
    ...projected,
    // Spread after the projection for the same reason the note is: the `ezo_`
    // names are reserved, and an operator's CSV column that happens to be
    // called one of them must not decide what a post-call action writes into
    // their sheet. The write paths refuse the prefix now, but a `variableMap`
    // is JSON in a column and a row predating that refusal must not be
    // trusted by the one thing that turns it into a dial.
    ...contextVariables({
      campaign: { id: campaign.id, name: campaign.name },
      contact: { id: contact.id },
      attemptNo: attempt.attemptNo,
    }),
    ...goalVariables(await goalSnapshot(contact.id)),
  };

  try {
    const call = await startCall({
      agent_id: agent.externalId,
      to_number: contact.phone,
      provider: 'voicelink',
      from_number: from.did,
      // Four segments. A key repeated across attempts would be treated as a
      // request to replay the first call rather than to dial again.
      client_reference_id: formatCorrelationId(campaign.id, contact.id, attempt.id),
      variables,
    });

    await prisma.callAttempt.update({
      where: { id: attempt.id },
      data: {
        upstreamCallId: call.call_id ?? null,
        upstreamSessionId: call.session_id ?? null,
        upstreamStatus: call.status ?? null,
      },
    });

    return { launched: true, ...CARRY_ON };
  } catch (err) {
    return { launched: false, ...(await rollbackLaunch(campaign, contact, attempt.id, err, now)) };
  }
}

/**
 * Undoes a claim whose call never left — or decides not to.
 *
 * Four outcomes, and collapsing any of them is how a dialer burns a customer's
 * retry budget for reasons that have nothing to do with them:
 *
 * - **400 is the only per-contact refusal.** The platform rejected *these
 *   values* — a number it will never dial. The attempt is *consumed*, so
 *   `retryCount` bounds it. Giving it back instead would re-claim the same
 *   contact every pass forever, spend the sweep budget on it, and leave the
 *   campaign unable to complete because its pool never drains. It is the one
 *   branch here that *settles* a contact, so it is also the one that moves a
 *   campaign counter — under the campaign lock, in the same transaction, and
 *   only when the status write matched.
 * - **403 and 404 are campaign-level**, and were the expensive mistake this
 *   triage used to make. A 403 is the account refused outright; a 404 mid-pass
 *   is the *agent* gone from the platform, not this contact's number, which was
 *   canonicalized here and whose ids were re-resolved on this very pass. Filed
 *   against the contact, a 404 settled one row per pass and burned the whole
 *   list in silence; met with a halt alone, a 403 left the campaign RUNNING to
 *   re-hit the identical wall a minute later with nobody told. Both now give
 *   the contact back whole, pause the campaign once, and say why.
 * - **The response never arrived** (`UPSTREAM_WRITE_UNCONFIRMED`). The call
 *   may be ringing right now. Nothing is rolled back and the attempt stays
 *   QUEUED; the reaper resolves it against the platform's own record, which is
 *   the only source that knows.
 * - **Anything else** — a 429, an outage — is transient and is not this
 *   contact's fault. The contact goes back on the queue, with its next-eligible
 *   time pushed out by one cooldown so a bad minute upstream cannot become a
 *   hot loop.
 *
 * Only the 403 halts the pass. A refusal of the account is met identically by
 * every other campaign on the platform; a missing agent is one workspace's
 * misconfiguration, and stopping everybody else's calls over it would be the
 * broader fault.
 *
 * ## The give-back and the promise
 *
 * A give-back is the one path that has to push a contact's eligibility out
 * **without** knowing what the row is waiting for, so it is written as three
 * guarded updates in one transaction, in this order — each later one matching
 * nothing once an earlier one has moved the row out of `QUEUED`:
 *
 * 1. **A promise the backoff would overrun.** `callbackAt` moves to the
 *    backoff instant beside `nextEligibleAt`, so the promised time stays the
 *    time the queue will actually ring: it is honoured late rather than left
 *    behind as a claim about a call that already should have happened.
 * 2. **A promise still ahead of the backoff.** Neither column moves. Pushing
 *    `nextEligibleAt` out would make the row un-dialable at the very instant
 *    somebody was told to expect the call.
 * 3. **Everything else** — fresh, retry, follow-up and resume alike.
 *    `nextEligibleAt` alone moves. Stamping `callbackAt` would manufacture a
 *    promise nobody made, which is exactly what the widened timestamp pair
 *    used to do to a resume that met a transient failure.
 *
 * Keyed on `armKind` rather than on the timestamps, so a RESUME row — which
 * carries no `callbackAt` of its own, but may still carry a stale one from a
 * promise long since kept — lands in branch 3 and comes back on the queue
 * still armed as a resume. Read off the pair, an unlucky equality between an
 * old promise and a resume instant would have moved a customer's history.
 *
 * `armKind` itself is untouched on every branch: a launch that never left
 * changed nothing about why this contact is waiting. `attempts` is untouched
 * for the same reason — it counts retries consumed, and a call that never left
 * consumed nothing.
 */
async function rollbackLaunch(
  campaign: SweepCampaign,
  contact: ClaimedContact,
  attemptId: string,
  err: unknown,
  now: Date,
): Promise<LaunchDisposition> {
  const status = err instanceof ApiError ? err.status : 502;
  const code = err instanceof ApiError ? err.code : 'UPSTREAM_ERROR';
  const message = err instanceof Error ? err.message : String(err);

  console.error(`[dialer] could not place a call for contact ${contact.id} (${code}):`, message);

  if (code === 'UPSTREAM_WRITE_UNCONFIRMED') {
    await prisma.callAttempt.update({
      where: { id: attemptId },
      data: { launchError: `${code}: the platform did not answer; awaiting reconciliation` },
    });

    return CARRY_ON;
  }

  // 400 alone. 403 and 404 are about the account and the agent, and are dealt
  // with at the campaign below — a contact settled for either of those is a
  // person never called for a reason that was never theirs.
  const permanent = status === 400;
  const backoffAt = new Date(now.getTime() + campaign.cooldownMinutes * 60_000);

  const closedAttempt = {
    status: 'FAILED',
    endedAt: now,
    resolvedAt: now,
    launchError: `${code}: ${message}`.slice(0, 500),
  } satisfies Prisma.CallAttemptUpdateInput;

  if (permanent) {
    /**
     * A terminal write, so it carries its counter — and takes the campaign row
     * `FOR UPDATE` first, which is the order every other writer in this tree
     * holds (stop, complete, delete, top-up, the callback re-arm, the
     * completion pass). Two of them holding one lock each and waiting for the
     * other is a deadlock, and Postgres resolves that by killing one.
     *
     * The increment is conditional on the status write having matched. This
     * contact may have been settled by something else while the dial was in
     * flight, and a counter moved by a write that moved nothing leaves the
     * stats page permanently disagreeing with the contact list — the same rule
     * `resolveContact` holds about a race it lost.
     */
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

      // The attempt is closed either way: this call failed whoever owns the
      // contact row now.
      await tx.callAttempt.update({ where: { id: attemptId }, data: closedAttempt });

      const settled = await tx.campaignContact.updateMany({
        where: { id: contact.id, status: 'QUEUED' },
        data: { status: 'FAILED' },
      });

      if (settled.count === 0) return;

      await tx.campaign.update({
        where: { id: campaign.id },
        data: { failedCount: { increment: 1 } },
      });
    });
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.callAttempt.update({ where: { id: attemptId }, data: closedAttempt });
      // The three-branch give-back, shared with the resolution's platform-fault
      // path: `attempts` untouched, `armKind` untouched, and the armed-callback
      // pair moved together or not at all.
      await giveBackWithBackoff(tx, { id: contact.id, status: 'QUEUED' }, backoffAt);
    });
  }

  // The shared account is at its ceiling, very often on somebody else's
  // traffic. Nothing is wrong with this campaign, so nothing is paused.
  if (code === 'UPSTREAM_RATE_LIMITED') return { halt: 'rate_limited', stopCampaign: true, paused: false };

  /**
   * The supplier's wallet is empty. Account-wide and not this contact's
   * fault, exactly like the 403 below, so the same shape: the contact goes
   * back whole, the campaign pauses, the pass halts.
   *
   * What differs is which pause. The settle path already handles this fact
   * when it arrives as `error_code` on a finished call, and the campaign page
   * and the notification must say the same thing whichever door it came
   * through — so this reuses that path's writer and its notifier rather than
   * `pauseCampaign` with a second sentence. Its type is what keeps the
   * dashboard from sending the customer to their own billing page for a
   * wallet that is not theirs.
   *
   * In production this is the door it actually came through: the 402 is
   * returned by `/calls/start`, so the dial never gets a call id and never
   * reaches the settle path at all.
   */
  if (code === 'UPSTREAM_PAYMENT_REQUIRED') {
    await giveBackWithBackoff(prisma, { id: contact.id, status: 'QUEUED' }, backoffAt);
    await prisma.callAttempt.update({ where: { id: attemptId }, data: closedAttempt });

    const paused = await pauseForPlatformCredit(prisma, campaign.id, now);
    if (paused) notifyPlatformCreditExhausted(campaign);

    return { halt: 'supplier_unfunded', stopCampaign: true, paused };
  }

  if (code === 'UPSTREAM_FORBIDDEN') {
    const paused = await pauseCampaign(
      campaign,
      'campaign.paused_upstream_refusal',
      `${campaign.name} was paused`,
      "The voice platform refused this campaign's calls. Check this account's credits, its plan " +
        'and its calling access, then resume — or contact support if they are all in order.',
      '/settings/billing',
      // The reason is billing and access, which are ADMIN-only everywhere else
      // in this service; a notification is not the place to make an exception.
      'ADMINS_ONLY',
      'PAUSED',
      now,
    );

    return { halt: 'supplier_refused', stopCampaign: true, paused };
  }

  if (status === 404) {
    const paused = await pauseCampaign(
      campaign,
      'campaign.paused_agent_missing_upstream',
      `${campaign.name} was paused`,
      'The voice platform no longer has the agent this campaign dials with. ' +
        'Assign another agent to continue.',
      `/campaigns/${campaign.id}`,
      // `ALL_MEMBERS`, exactly as the agent-unassigned pause is: the remedy is
      // picking another agent, which any member of this workspace may do.
      'ALL_MEMBERS',
      'PAUSED',
      now,
    );

    return { halt: null, stopCampaign: true, paused };
  }

  return CARRY_ON;
}

/**
 * Completes a campaign that has nothing left to do.
 *
 * **The campaign row is locked before anything is counted.** Postgres runs READ
 * COMMITTED, so a count and a status re-check take no row locks and a callback
 * re-arm can slip between them: it sees RUNNING, skips its own re-open, and is
 * then completed on top of the contact it just put back on the queue — a
 * promise made to a person, cancelled by a campaign announcing itself finished.
 * Every writer that can add work to a running campaign takes this same lock in
 * this same order.
 *
 * A contact still cooling down is `PENDING` with a future `nextEligibleAt`: not
 * dialable *yet*, and not finished either, so the remaining-work test is the
 * broader one over the queue statuses rather than over what the claim would
 * take right now.
 *
 * The transition is conditional on RUNNING inside the lock, so two runners
 * racing here produce one COMPLETED and one notification rather than two.
 */
async function completeIfDone(campaign: SweepCampaign, now: Date): Promise<boolean> {
  // An inbound-facing campaign has no "done" the dispatcher can decide: with
  // its list exhausted it is still answering on its DIDs, and COMPLETED is an
  // exit from RUNNING that would release them (design §5.2) — silently
  // stopping the campaign answering because its OUTBOUND half ran out. The
  // operator stops it; stop releases.
  if (isInboundFacing(campaign.type)) return false;

  const completed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

    const remaining = await tx.campaignContact.count({
      where: { campaignId: campaign.id, status: { in: [...UNFINISHED_CONTACT_STATUSES] } },
    });

    if (remaining > 0) return false;

    const moved = await tx.campaign.updateMany({
      where: { id: campaign.id, status: 'RUNNING' },
      data: { status: 'COMPLETED', completedAt: now, haltReason: null },
    });

    return moved.count > 0;
  });

  if (!completed) return false;

  void notify(
    campaign.workspaceId,
    'ALL_MEMBERS',
    'campaign.completed',
    `${campaign.name} finished`,
    'Every contact on this campaign has been called.',
    `/campaigns/${campaign.id}`,
  );

  /**
   * The same release a manual stop performs, and the one most goal campaigns
   * actually reach: a campaign that dials its list to the end finishes here,
   * under nobody's finger, and without this its agent kept the managed block
   * for ever — a prompt still promising the model seven variables no dial would
   * ever send it again.
   *
   * After the transaction, deliberately. The release is two round trips to the
   * platform, and neither belongs inside a lock on the campaign row; and it
   * counts the agent's other live campaigns, which must see this one already
   * COMPLETED. Nothing in it can throw — it swallows its own failures and
   * logs them — so a platform outage cannot turn a finished campaign back into
   * a sweep that fails on every pass.
   */
  if (campaign.agentId !== null) {
    await releaseGoalPromptBlock(campaign.agentId, campaign.workspaceId);
  }

  return true;
}

/**
 * One pass.
 *
 * Each campaign is handled independently and its failures are isolated: one
 * workspace's bad row must not stop the platform's dialing, which is the same
 * rule the renewal sweep holds about one workspace's bad charge.
 */
export async function runDialerSweep({ now = new Date() }: DialerSweepOptions = {}): Promise<DialerSweepResult> {
  const result = emptyResult();

  // The master switch, checked here as well as at startup. A sweep that was
  // already scheduled must not survive the switch being turned off.
  if (!env.dialerEnabled) return result;

  result.reaped = await closeStaleAttempts(now);
  // The claim-side half of the reaping: a QUEUED contact whose lease expired
  // with no attempt started since was claimed by a placement job that is
  // gone, and nothing else can reach it — the attempt sweep reconciles rows
  // that exist, and the claim selects only PENDING.
  await releaseStaleClaims(now);

  /**
   * The shared account's headroom, read **once per pass**.
   *
   * The platform names this as the endpoint to pace a dialer against, and the
   * pool is account-wide: every YE customer and every other integrator on the
   * partner account draws from it. Reading it first is what stops the sweep
   * discovering the ceiling one wasted 429 at a time.
   */
  let platformRemaining: number | null;

  try {
    const pool = await getConcurrency();
    // `remaining: null` means uncapped. A `?? 0` here would stop an unlimited
    // platform from placing a single call, which looks exactly like a dialer
    // that is switched off.
    platformRemaining = pool.remaining ?? null;
  } catch (err) {
    // Fail closed. A skipped pass self-heals in a minute and costs nobody
    // anything; guessing at the headroom of a shared account does not. This is
    // the same posture as `resolveTierRate` refusing an unpriced tier — a
    // visible refusal over a plausible guess.
    console.error('[dialer] could not read the shared call pool; launching nothing this pass:', err);
    result.halted = 'pool_unreadable';

    return result;
  }

  // A pure INBOUND campaign answers; it never dials. It is not the
  // dispatcher's at all — it neither claims contacts nor completes — so it is
  // left out here rather than gated per campaign below. BOTH still dials.
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'RUNNING', type: { not: 'INBOUND' } },
    include: CAMPAIGN_INCLUDE,
    take: CAMPAIGN_BATCH,
  });

  result.campaigns = campaigns.length;

  // Least recently dialed first, so one busy campaign cannot hold every line
  // its account was allotted while a campaign started an hour later never
  // dials. Deliberately not the reserved-floor-and-burst allocator this
  // eventually wants: round-robin is obviously correct, needs no new columns,
  // and can be replaced without touching anything else.
  const lastDialed = new Map<string, number>();

  if (campaigns.length > 0) {
    const grouped = await prisma.callAttempt.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaigns.map((c) => c.id) } },
      _max: { startedAt: true },
    });

    for (const row of grouped) {
      // `campaignId` is nullable since attempt rows outlive their campaign,
      // and the `in` filter above already excludes the orphans. The guard is
      // for the type, not for a case that can occur.
      if (row.campaignId === null) continue;

      lastDialed.set(row.campaignId, row._max.startedAt?.getTime() ?? 0);
    }
  }

  campaigns.sort((a, b) => (lastDialed.get(a.id) ?? 0) - (lastDialed.get(b.id) ?? 0));

  let budget = env.dialerMaxCallsPerSweep;

  /**
   * What this pass has already committed against each account's allotment.
   *
   * `accountInFlight` counts **attempt rows**, and a posted claim has no
   * attempt row yet — the placement worker writes it. So two campaigns of one
   * account, swept one after the other in the same pass, would each read the
   * same "nothing in flight" and each claim the whole allotment. The pass
   * therefore carries its own claims forward, exactly as it carries `budget`
   * and the shared pool's headroom, and for exactly the same reason: the tick
   * no longer waits around to be told what it did.
   *
   * Keyed by the owning account rather than the workspace, because that is the
   * scope the allotment is sold at.
   */
  const claimedByAccount = new Map<string, number>();

  /**
   * Scopes this pass has already explained itself about.
   *
   * The shared pool is one platform-wide fact and an allotment is one fact per
   * account, but the branch that reports them runs once per campaign. Without
   * this, one full pool logs once for every RUNNING campaign — up to
   * `CAMPAIGN_BATCH` lines a minute for a single condition.
   */
  const reported = new Set<string>();

  for (const campaign of campaigns) {
    if (result.halted) break;
    if (budget <= 0) break;

    try {
      /**
       * The budget and the shared pool are spent on **claims**, not launches.
       *
       * The pass no longer waits to find out which of them rang, so the only
       * number it has is what it committed to. Claimed is an upper bound on
       * launched — every claim either dials or gives the contact back — so a
       * pass can under-fill when placements fail and can never over-fill,
       * which is the direction a cap has to err in.
       */
      const owner = campaign.workspace.ownerAccountId;
      const posted = await sweepCampaign(
        campaign,
        {
          now,
          budget,
          platformRemaining,
          accountClaimed: claimedByAccount.get(owner) ?? 0,
          reported,
        },
        result,
      );

      budget -= posted;
      if (platformRemaining !== null) platformRemaining -= posted;
      claimedByAccount.set(owner, (claimedByAccount.get(owner) ?? 0) + posted);
    } catch (err) {
      console.error(`[dialer] campaign ${campaign.id} failed this pass:`, err);
    }
  }

  return result;
}

interface PassBudget {
  now: Date;
  budget: number;
  platformRemaining: number | null;
  /** Lines this pass has already claimed against this campaign's account. */
  accountClaimed: number;
  /**
   * What this pass has already said about a cap that is not per-campaign.
   *
   * The shared pool is one platform-wide fact and an allotment is one fact per
   * account, but the blocked branch is reached once per *campaign* — so
   * without this, one full pool speaks for every RUNNING campaign on the
   * platform, up to `CAMPAIGN_BATCH`, every minute. Keyed rather than
   * boolean because the account arm needs one line per account, not one line
   * in total.
   */
  reported: Set<string>;
}

/** Returns how many contacts this campaign claimed and posted for dialing. */
async function sweepCampaign(
  campaign: SweepCampaign,
  { now, budget, platformRemaining, accountClaimed, reported }: PassBudget,
  result: DialerSweepResult,
): Promise<number> {
  // Re-resolved on every pass, never trusted from `start`. Staff unassign an
  // agent and release a DID through UPDATEs no foreign key can see, so a
  // campaign can hold a perfectly valid id for something it may no longer use.
  if (!agentIsUsable(campaign.agent, campaign.workspaceId)) {
    if (await pauseCampaign(
      campaign,
      'campaign.paused_agent_unavailable',
      `${campaign.name} was paused`,
      'The agent this campaign dials with is no longer available in this workspace. Assign another to continue.',
      `/campaigns/${campaign.id}`,
    )) result.paused += 1;

    return 0;
  }

  // Resolved before anything is claimed. A campaign that cannot dial must hold
  // its queue where it is rather than claim contacts and fail every one of
  // them — each failure is an attempt row, a log line, and on some branches a
  // consumed retry, all for a fault that is nothing to do with the contact.
  const rotation = resolveDialRotation(campaign);

  if (rotation.state === 'none') {
    if (await pauseCampaign(
      campaign,
      'campaign.paused_number_unavailable',
      `${campaign.name} was paused`,
      'The phone number this campaign calls from is no longer available in this workspace. Choose another to continue.',
      `/campaigns/${campaign.id}`,
    )) result.paused += 1;

    return 0;
  }

  if (rotation.state === 'held') {
    // Every attached number is unusable. Held rather than paused: a campaign
    // that named its rotation explicitly has not been misconfigured, and the
    // numbers may well be back before the next pass. Pausing would also make
    // the remedy look like "choose another number" when the operator already
    // chose several.
    console.warn(
      `[dialer] campaign ${campaign.id}: all ${rotation.attached} attached number(s) are ` +
        'unusable; holding this pass',
    );

    return 0;
  }

  const window = evaluateWindow(campaign, now);

  /**
   * The instant the per-contact daily cap counts from, in the campaign's own
   * zone. Computed here rather than inside the claim so that the whole pass —
   * the window gate above and the cap below — reads one clock, the rule `now`
   * itself follows.
   */
  const dayStart = localDayStart(now, campaign.timezone);

  if (window.state === 'incomplete') {
    // Fail closed. An operator who set one end of a window was expressing a
    // restriction; reading it as "any hour" is how a campaign calls somebody
    // at 3am, and reading it as "never" is indistinguishable from a campaign
    // that has finished.
    if (await pauseCampaign(
      campaign,
      'campaign.paused_window_incomplete',
      `${campaign.name} was paused`,
      `This campaign's dialing window is missing ${window.reason}. Complete it to continue.`,
      `/campaigns/${campaign.id}`,
    )) result.paused += 1;

    return 0;
  }

  // A closed window is the campaign working exactly as configured. Nothing is
  // wrong, so nothing is paused and nobody is notified.
  if (window.state === 'closed') return 0;

  const owner = campaign.workspace.owner;

  if (owner.credits < env.dialerMinBalanceCredits) {
    // Checked before launching rather than at charge time, because a call is
    // charged minutes after it is placed: this float is the only thing between
    // a campaign and a queue of calls its owner cannot pay for.
    if (await pauseCampaign(
      campaign,
      'campaign.paused_insufficient_credits',
      `${campaign.name} was paused`,
      'This workspace does not have enough credits to keep calling. Top up to continue.',
      '/settings/billing',
      'ADMINS_ONLY',
      // Its own status, not PAUSED. The operator did not stop this campaign;
      // the balance did, and `resume` has to know to re-run the estimate before
      // letting it dial again.
      'CREDIT_EXHAUSTED',
      now,
    )) result.paused += 1;

    return 0;
  }

  /**
   * Priced before anything is claimed, and the price itself thrown away.
   *
   * The rate that reaches the attempt row is resolved again by the placement
   * worker, at the moment the row is written — a snapshot has to be taken
   * where it is stored. What this call is for is the *refusal*: an unpriced
   * account must not have its contacts claimed at all, because every one of
   * them would be posted, fail to price, and be handed back. Asking here is
   * how a campaign nobody can bill holds its queue instead of churning it.
   */
  try {
    await resolveCallRate(owner.id, campaign.agent!.voiceTierSlug);
  } catch (err) {
    if (!(err instanceof TierRateUnavailableError)) throw err;

    // Unpriced is not free. A call placed at an unknown price is a call whose
    // cost is decided after the money is spent.
    if (await pauseCampaign(
      campaign,
      'campaign.paused_rate_unavailable',
      `${campaign.name} was paused`,
      'Calling is not priced for this account yet, so this campaign cannot dial. Contact support to continue.',
      `/campaigns/${campaign.id}`,
      'ADMINS_ONLY',
    )) result.paused += 1;

    return 0;
  }

  /**
   * The do-not-call settle, before anything is counted or claimed.
   *
   * The claim refuses a listed number, but a refusal alone leaves the contact
   * PENDING forever — invisible work the completion pass would wait on for a
   * call that may never be placed. Settled here, ahead of the in-flight counts
   * and the completion check, so a campaign whose remaining queue is entirely
   * opted-out can complete on this very pass. Costs one indexed existence
   * probe when this campaign's list is empty, which is almost always.
   */
  const optedOut = await excludeDoNotCallContacts(prisma, {
    campaignId: campaign.id,
    now,
  });

  if (optedOut > 0) {
    // One line per campaign per pass, ids only — the reason lives on this
    // campaign's DoNotCall rows, which is where the journey reads it too.
    console.log(`[dialer] campaign ${campaign.id}: excluded ${optedOut} do-not-call contact(s)`);
  }

  /**
   * The dial-cap settle, for the same reason and in the same place.
   *
   * The claim refuses a contact whose placed dials have reached the dial
   * budget in every lane, and a refusal alone leaves it PENDING for ever:
   * never dialled, never settled, counted as remaining work by the completion
   * check below. Three things put a contact there — an operator lowering
   * `retryCount` or `maxGoalFollowUps` mid-campaign, and upstream weather
   * spending its ordinals on launches that never placed a call — and no
   * configuration or weather should be able to leave a person unreachable and
   * a campaign unable to finish.
   *
   * `totalDialsFor` is both lane budgets plus one since 2026-09-09, so a
   * lowered follow-up budget reaches this settle exactly as a lowered retry
   * budget always has — and the follow-up budget is swept on its own here
   * too, because a `FOLLOW_UP` row past it sits well inside that ceiling and
   * the claim's refusal is the only thing that would otherwise touch it.
   *
   * **The DAILY CAP is deliberately not here and must never be.** A contact at
   * its cap has run out of nothing — it is simply not their turn again today —
   * so it is held by the claim and settled by nobody, and a sweep that read
   * the cap would end a person's campaign over a clock that resets at
   * midnight.
   *
   * Every campaign, ahead of the counts and the completion check, so a
   * campaign whose whole remaining queue is out of reach completes on this
   * very pass.
   */
  const outOfReach = await settleContactsOverDialBudget(prisma, {
    campaignId: campaign.id,
    maxTotalDials: totalDialsFor(campaign),
    maxGoalFollowUps: campaign.maxGoalFollowUps,
    now,
  });

  if (outOfReach > 0) {
    console.log(
      `[dialer] campaign ${campaign.id}: skipped ${outOfReach} contact(s) past a budget`,
    );
  }

  const [lanes, accountCalls, pendingOwn, pendingAccount] = await Promise.all([
    campaignLaneInFlight(prisma, campaign.id),
    accountInFlight(prisma, owner.id),
    campaignPendingPlacement(prisma, campaign.id, now),
    accountPendingPlacement(prisma, owner.id, now),
  ]);

  // Everything outside this campaign that caps it, narrowed to one number: the
  // allotment YE sold the account, the capacity the platform sold YE, and the
  // operator's per-pass blast radius. The campaign's own limit is the fourth
  // cap and is applied by `computeLaneBudgets`, which also splits it between
  // the lanes.
  const accountRemaining = Math.min(
    // `accountClaimed` is this pass's own commitments and `pendingAccount`
    // is every earlier tick's, both invisible to `accountInFlight` because a
    // claim has no attempt row until its placement job runs. Without them a
    // second campaign — or the next tick, while a placement backlog drains —
    // re-spends what was already committed.
    resolveAccountConcurrency(owner) - accountCalls - accountClaimed - pendingAccount,
    platformRemaining ?? Number.MAX_SAFE_INTEGER,
    budget,
  );

  // The lane counts partition `lanes.all` by construction — they are summed
  // from one `groupBy` over the same rows — so nothing here needs bounding: an
  // attempt whose contact pointer was nulled by a campaign delete is counted
  // like any other, and a kind this release does not know narrows the
  // reservation rather than the fresh lane. The earlier-tick backlog is added
  // on top by the contact's own retry state, which is the only evidence there
  // is for a claim whose attempt row does not exist yet, so the campaign cap
  // and the reservation both see a committed dial before it is placed.
  const budgets = computeLaneBudgets({
    concurrencyLimit: campaign.concurrencyLimit,
    retryConcurrency: campaign.retryConcurrency,
    activeFresh: lanes.fresh + pendingOwn.fresh,
    activeNonFresh: lanes.retry + lanes.urgent + pendingOwn.retry,
    accountRemaining,
  });

  if (budgets.totalSlots <= 0) {
    // Only if it did not just finish. A campaign whose last calls landed while
    // it was at its ceiling completes on this very pass, and reporting that as
    // a campaign held by a cap would be the opposite of what happened.
    if (!(await completeIfDoneCounted(campaign, now, result))) {
      try {
        await reportBlocked(campaign, now, reported, {
          concurrencyLimit: campaign.concurrencyLimit,
          // The same sum `computeLaneBudgets` reduced to zero, spelled out from
          // the same parts, so the line can never name a cap the arithmetic did
          // not actually apply.
          activeAll: lanes.all + pendingOwn.fresh + pendingOwn.retry,
          accountLimit: resolveAccountConcurrency(owner),
          accountActive: accountCalls + accountClaimed + pendingAccount,
          platformRemaining,
        });
      } catch (err) {
        // Its own catch, not the pass's. This read is purely observational —
        // it changes nothing and the campaign contributes zero either way — so
        // letting it reach the per-campaign handler would print "campaign X
        // failed this pass" and make a healthy campaign look broken over a
        // diagnostic. That is precisely the misleading line this whole
        // function exists to stop.
        console.error(`[dialer] could not report why campaign ${campaign.id} is blocked:`, err);
      }
    }

    return 0;
  }

  const claimed = await claimLanes(campaign, budgets, lanes, now, dayStart);

  let posted = 0;

  try {
    /**
     * One cursor advance per batch, and only when there is a rotation to move
     * over. The i-th claimed contact dials from `numbers[(base + i) % len]`, so
     * a batch of three across two numbers uses A, B, A and the next batch
     * starts where this one left off rather than at A again.
     *
     * Unchanged by the move to a queue, and deliberately so: the pairing is
     * decided **here**, where the batch's order is known, and travels with each
     * job. Left to the workers, four jobs racing for the next cursor value
     * would produce a rotation that depends on which of them won.
     */
    const base =
      rotation.state === 'rotating'
        ? await advanceRoundRobinCursor(prisma, campaign.id, claimed.length)
        : 0;

    const jobs = await placementJobs(campaign, claimed, rotation.numbers, base, now);

    if (jobs.length > 0) {
      const { callPlacementQueue } = await import('../lib/queue/queues.js');
      await callPlacementQueue.addBulk(jobs.map((data) => ({ name: 'place-call', data })));
      posted = jobs.length;
    }
  } finally {
    /**
     * Whatever was claimed and not posted goes straight back.
     *
     * This is now the *narrow* case — a throw while numbering the batch or
     * while writing to Redis — rather than the halt path it also used to
     * serve. A halt is handled where a halt is now observed, in the worker.
     * Released with no timestamp touched at all, because nothing was
     * attempted: an armed callback stays armed, a retry stays due, and the
     * next pass picks them up.
     */
    await releaseUnlaunched(claimed.slice(posted));
  }

  await countAllowlistSkips(campaign, result);

  result.posted += posted;

  /**
   * Nothing claimed, so ask whether there is anything left at all.
   *
   * The test was `launched === 0` and is now `posted === 0`, which is the same
   * question asked one step earlier: a pass that claimed nothing is a pass
   * whose campaign may have finished. A pass that claimed and posted has work
   * in flight by definition, and a campaign with work in flight is not done —
   * so the check would have refused anyway, one round trip later.
   */
  if (posted === 0) await completeIfDoneCounted(campaign, now, result);

  return posted;
}

/**
 * Turns a claimed batch into the jobs that will dial it.
 *
 * Two things are decided here and never in the worker, because both depend on
 * the batch as a whole and neither survives being raced for:
 *
 * - **Which number each contact is dialed from.** The i-th claim takes the
 *   i-th step of the rotation, from the base this batch advanced the cursor to.
 * - **Which attempt of that contact's life this is.** One `groupBy` over the
 *   whole batch, so the numbering costs one round trip rather than one per
 *   contact — and so the ordinal is a fact fixed at claim time, which is what
 *   lets a retried job re-find the row it wrote instead of writing another.
 *
 * `batchId` groups them, so the first job to meet an account-wide refusal can
 * tell the rest of its own batch to stop before they meet the same one.
 */
async function placementJobs(
  campaign: SweepCampaign,
  claimed: readonly ClaimedContact[],
  numbers: readonly DialNumber[],
  base: number,
  now: Date,
): Promise<CallPlacementJobData[]> {
  if (claimed.length === 0) return [];

  const highest = await prisma.callAttempt.groupBy({
    by: ['campaignContactId'],
    where: { campaignContactId: { in: claimed.map((contact) => contact.id) } },
    _max: { attemptNo: true },
  });

  const attemptNos = new Map<string, number>();
  for (const row of highest) {
    if (row.campaignContactId === null) continue;
    attemptNos.set(row.campaignContactId, row._max.attemptNo ?? 0);
  }

  const batchId = randomUUID();
  const nowIso = now.toISOString();

  return claimed.map((contact, index) => {
    const attemptNo = (attemptNos.get(contact.id) ?? 0) + 1;

    return {
      kind: 'place-call' as const,
      batchId,
      campaignId: campaign.id,
      contactId: contact.id,
      fromNumberId: numbers[(base + index) % numbers.length]!.id,
      attemptNo,
      // Decided here, beside the ordinal and for the same reason: what kind
      // of dial this is was a fact at claim time and must not be re-derived
      // from columns that will have moved by the time anybody asks.
      //
      // Straight off the arm the claim read, so the label is the lane. It used
      // to be reconstructed — a callback from the armed timestamp pair, a
      // follow-up from `followUpCount > 0` — and both readings had drifted
      // from the lane that actually chose the row: the pair had been widened
      // to cover an engine-chosen resume, and the counter is a lifetime tally
      // that never goes back down. A batch could be picked as retries and
      // labelled follow-ups.
      attemptKind: attemptKindOf(contact.armKind),
      nowIso,
    };
  });
}

/**
 * The lane passes, in the one order they may run in.
 *
 * ## The campaign this shape exists for
 *
 * The callback lane used to run first and draw from the **whole pass budget**.
 * A promise is exempt from the retry reservation because it spends no retry,
 * and that is still true — but the exemption was also an unbounded first
 * claim, and those are not the same thing.
 *
 * `rollIntoDialWindow` builds every booked instant through `instantOf`, which
 * zeroes seconds, so every promise booked while the dial window was shut lands
 * on the opening minute together. Production, 2026-09-07: two campaigns on
 * `concurrencyLimit = 11`, dial window `10:00–20:00 Asia/Kolkata`, 64 promises
 * stacked on one instant. Two whole quarter-hours placed 192 and 260 callbacks
 * and **zero** retries, with ~880 retries eligible throughout. The resume lane
 * had the same shape one level down, and the borrow pass that was meant to
 * give the slots back was a single `any` claim ordered `CALLBACK, RESUME,
 * FOLLOW_UP, createdAt` — which handed them straight to the herd again.
 *
 * ## What changed, and what deliberately did not
 *
 * **Only the urgent lanes are bounded.** `retrySharePercent` caps what
 * `CALLBACK` and `RESUME` may take of any pool, and everything below that cap
 * keeps the structure it has always had: the reservation, the fresh budget,
 * and a shared pass settled by age.
 *
 * That is a much smaller change than dividing every pool three ways, and it is
 * the one the report actually calls for. The dispatcher's other contracts are
 * load-bearing and none of them was the bug:
 *
 * - **A promise still beats a list position.** The urgent pass runs before the
 *   fresh lane, at every reservation including none, because a callback is the
 *   only entry in this queue carrying a time a human being was told. What it
 *   no longer does is take the whole pass while doing so.
 * - **With no reservation it is still one shared pass settled by age.** A
 *   campaign on the column default contests its retries and its fresh list in
 *   `routine`, FIFO, exactly as before — the retries in that pool are older,
 *   so they still win, which is what makes the reservation worth setting.
 * - **The reservation still holds across passes**, and the fresh lane still
 *   has `freshBudget` protecting it from a long tail of retries, which is the
 *   fault `retryConcurrency` was built for.
 *
 * **`retrySharePercent = 0` is the column default and is a no-op.** The urgent
 * bound becomes the whole pool, so the urgent pass takes everything it can
 * reach and the lanes below get what is left — which is precisely the old
 * ordering. That is what lets this migration re-pace nobody, and makes setting
 * the column an opt-in.
 *
 * The bound is recomputed for each pool against what the pass has already
 * committed, so spreading one share over two pools cannot round it away twice.
 */
async function claimLanes(
  campaign: SweepCampaign,
  budgets: { totalSlots: number; nonFreshBudget: number; freshBudget: number },
  /**
   * This campaign's live calls, by the lane that claimed them.
   *
   * `splitPool` needs both, because the share is a property of what the
   * campaign is *doing* rather than of what one pass happened to have spare.
   * The earlier-tick placement backlog is deliberately absent: it splits only
   * into fresh and non-fresh, so attributing it to either side of *this*
   * division would be a guess, and a guess in the numerator of a ratio is
   * worse than a slightly conservative bound.
   */
  lanes: { retry: number; urgent: number },
  now: Date,
  /**
   * Campaign-local midnight, computed once by the caller beside its window
   * check. Injected exactly as `now` is, and for the same reason: the pass
   * runs off one instant, and a claim deriving its own day boundary could
   * count against a different day from the gate that let it get this far.
   */
  dayStart: Date,
): Promise<ClaimedContact[]> {
  /**
   * The test allowlist, applied **inside** the claim.
   *
   * Filtering after the claim would leave every skipped contact QUEUED — a
   * permanent mark on a customer's own list, left by an operator's test switch.
   * Contacts it excludes are never claimed at all, exactly as before.
   */
  const onlyPhones = env.dialerTestAllowlist.size > 0 ? [...env.dialerTestAllowlist] : undefined;

  const take = (limit: number, lane: ClaimLane) =>
    claimContacts(prisma, {
      campaignId: campaign.id,
      limit,
      lane,
      // Re-read every pass, so lowering it mid-campaign stops a retry that is
      // already waiting rather than only the ones not yet scheduled.
      retryCount: campaign.retryCount,
      // The FOLLOW-UP budget, live for the reason the retry budget is:
      // lowering it mid-campaign has to stop a follow-up already waiting.
      maxGoalFollowUps: campaign.maxGoalFollowUps,
      // The absolute cap, derived from BOTH lane budgets, and live for the
      // same reason: lowering either moves this clause on the next pass.
      maxTotalDials: totalDialsFor(campaign),
      // How often one contact may be rung in a day, and the local midnight
      // that day is counted from.
      maxDialsPerDay: campaign.maxDialsPerDay,
      dayStart,
      now,
      onlyPhones,
    });

  const claimed: ClaimedContact[] = [];
  let remaining = budgets.totalSlots;

  /**
   * What the pass has already committed to each side.
   *
   * Added to the in-flight counts the split is computed against, which is what
   * stops one share spread over two pools being rounded away twice: a
   * reservation of 3 and a borrow of 8 at `retrySharePercent = 60` would
   * otherwise hold `floor(3 × 0.6) + floor(8 × 0.6) = 5` of 11 for retries
   * rather than 6, with the remainder falling to the urgent side both times.
   * It is the property `splitPool` gives the pass sequence, applied one level
   * down — a slot committed toward the share counts whether it was committed a
   * minute ago or a line ago.
   */
  let takenRetry = 0;
  let takenUrgent = 0;

  const urgentShare = (pool: number) =>
    splitPool({
      pool,
      retrySharePercent: campaign.retrySharePercent,
      activeRetry: lanes.retry + takenRetry,
      activeUrgent: lanes.urgent + takenUrgent,
    }).urgentFloor;

  /**
   * One pool, divided, and then the division given back where it did not fit
   * the queue.
   *
   * Three claims at most, each returning without a round trip on a limit of
   * zero — which matters, because this runs for every RUNNING campaign on the
   * platform every minute:
   *
   * 1. The urgent lanes at their share, a promise ahead of a resume.
   * 2. Retries, at their share **plus everything the urgent lanes left**.
   *    Spelled `pool - urgent.length` rather than `retryFloor + spare` because
   *    the two are one number and one of them cannot drift.
   * 3. The urgent lanes again, for what the retry lane left when it was dry.
   *
   * Step 3 is not symmetry for its own sake: a campaign that has worked
   * through its retry queue still has promises waiting, and without it those
   * would wait for a slot the pass was holding open for nothing.
   */
  const drainSplit = async (pool: number): Promise<void> => {
    if (pool <= 0) return;

    const urgent = await take(urgentShare(pool), 'urgent');
    const retries = await take(pool - urgent.length, 'retry');

    const spare = pool - urgent.length - retries.length;
    const extra = spare > 0 ? await take(spare, 'urgent') : [];

    claimed.push(...urgent, ...retries, ...extra);
    remaining -= urgent.length + retries.length + extra.length;
    takenRetry += retries.length;
    takenUrgent += urgent.length + extra.length;
  };

  /**
   * No reservation: one shared pass settled by age, which is what the
   * dispatcher has always done on the column default — with the urgent lanes
   * served first, and now bounded while they are.
   *
   * The second claim is `routine` and not `any`. The urgent arms have had
   * their share; asking the unfiltered lane here would let a herd straight
   * past the bound it was just held to, since `any` orders `CALLBACK` and
   * `RESUME` ahead of everything.
   *
   * The third gives the urgent lanes back what the routine lane could not
   * use. Without it a share held open a slot for a fresh contact that did not
   * exist while a promise waited — and, the urgent count being unchanged, held
   * the same slot open on every later pass. A floor that idles a line is a
   * cap.
   */
  if (campaign.retryConcurrency <= 0) {
    const urgent = await take(urgentShare(remaining), 'urgent');
    claimed.push(...urgent);
    remaining -= urgent.length;
    takenUrgent += urgent.length;

    const routine = await take(remaining, 'routine');
    claimed.push(...routine);
    remaining -= routine.length;

    claimed.push(...(await take(remaining, 'urgent')));

    return claimed;
  }

  // 1. Promises first, out of the WHOLE pass and ahead of every reservation —
  //    bounded by the share, which at the column default is the whole pass.
  //    This is the contract the split must not touch: a callback is the one
  //    entry carrying a time a person was told, and before the split it drew
  //    from the pass budget rather than from the reservation. Claiming it out
  //    of the reservation instead capped a herd at `retryConcurrency` lines
  //    while the fresh list held the rest — and at a share of 0, which is
  //    every existing campaign, that re-paced an importing campaign the
  //    migration promised to leave alone.
  const callbacks = await take(urgentShare(remaining), 'callback');
  claimed.push(...callbacks);
  remaining -= callbacks.length;
  takenUrgent += callbacks.length;

  // 2. The reservation the resume and retry lanes share, divided. Capped by
  //    `remaining` too: a reservation is a ceiling on a lane and never an
  //    addition to the pass. The urgent side of this split is where a resume
  //    draws — a resume is not a promise, and it has been bounded by the
  //    reservation since the resume lane landed.
  await drainSplit(Math.min(budgets.nonFreshBudget, remaining));

  // 3. The fresh list, out of the budget that protects it from a long tail of
  //    retries — the fault `retryConcurrency` exists for, and not the one
  //    being fixed here.
  const fresh = await take(Math.min(budgets.freshBudget, remaining), 'fresh');
  claimed.push(...fresh);
  remaining -= fresh.length;

  // 4. The borrow, under the same split. This is the pass a campaign whose
  //    import is finished spends everything in, and the one a herd of promises
  //    used to take whole.
  await drainSplit(remaining);

  // 5. And what neither non-fresh lane could use goes back to the fresh list,
  //    so the reservation still costs no throughput when only one side has
  //    work — which is what makes it a floor rather than a cap.
  claimed.push(...(await take(remaining, 'fresh')));

  return claimed;
}

/** Puts claims that never became calls back on the queue, unchanged. */
async function releaseUnlaunched(contacts: readonly ClaimedContact[]): Promise<void> {
  if (contacts.length === 0) return;

  await prisma.campaignContact.updateMany({
    where: { id: { in: contacts.map((contact) => contact.id) }, status: 'QUEUED' },
    data: { status: 'PENDING' },
  });
}

/**
 * How many contacts the test allowlist held back this pass.
 *
 * Counted rather than accumulated while walking a page, because the allowlist
 * is now a predicate inside the claim and those rows are never read. One query
 * per campaign per pass, and only while the switch is on — which is a bounded
 * live test, never production.
 */
async function countAllowlistSkips(
  campaign: SweepCampaign,
  result: DialerSweepResult,
): Promise<void> {
  if (env.dialerTestAllowlist.size === 0) return;

  const skipped = await prisma.campaignContact.count({
    where: {
      campaignId: campaign.id,
      // Left exactly as they were: never claimed, and never marked EXCLUDED,
      // which is a customer's irreversible edit to their own list.
      status: 'PENDING',
      contact: { phone: { notIn: [...env.dialerTestAllowlist] } },
    },
  });

  if (skipped === 0) return;

  // One line per campaign per pass rather than one per contact: with an
  // allowlist active every contact is skipped on every pass, and per-row
  // logging would bury everything else the sweep says.
  console.warn(
    `[dialer] campaign ${campaign.id}: skipped ${skipped} contact(s) not on DIALER_TEST_ALLOWLIST`,
  );
  result.skippedNotAllowlisted += skipped;
}

/**
 * How long a campaign's own ceiling must have been full before the pass calls
 * it wedged rather than busy.
 *
 * Half the reaper's timeout, so the warning always lands **before**
 * `closeStaleAttempts` gives up on the same attempt and the log names the row
 * while it is still the live explanation rather than after the sweep cleaned it
 * up. (At the floor of `DIALER_ATTEMPT_TIMEOUT_MINS=1` the two coincide at a
 * minute and the reaper wins — a degenerate setting nobody runs, noted so the
 * claim is not read as unconditional.) Derived rather than configured:
 * shortening the reaper's patience shortens this, instead of leaving a second
 * knob that has to be kept in step.
 */
function wedgedAfterMs(): number {
  return Math.max(1, Math.floor(env.dialerAttemptTimeoutMins / 2)) * 60_000;
}

/**
 * The oldest live call in some scope that has been unresolved long enough to
 * look wedged, or `null` if everything there is turning over normally.
 *
 * **The age is a predicate, not a post-filter.** Asking for the oldest live
 * attempt and then comparing it in JS made the *healthy* case — which is
 * almost every case — pay for a row fetch on every pass. Pushed into the
 * `where`, the common answer is an empty index probe.
 *
 * That also fixes which index answers it. `(campaignId, startedAt)` cannot
 * satisfy the status test, so an `ORDER BY startedAt LIMIT 1` over it walks a
 * campaign's whole attempt history — oldest first, every row terminal — before
 * reaching the in-flight rows, which are always the newest. `(campaignId,
 * status)` and `(accountId, status)` both exist and bound the match set by the
 * concurrency cap, which is ten at most.
 *
 * `startedAt` is stamped from the sweep's own injected clock rather than the
 * column default, so this comparison is same-clock. Comparing it against a
 * `now()` default is the exact mistake that made the conformance harness read
 * every placed dial as a job that never ran.
 */
function oldestWedgedAttempt(
  scope: { campaignId: string } | { accountId: string },
  now: Date,
): Promise<{ id: string; startedAt: Date } | null> {
  return prisma.callAttempt.findFirst({
    where: { ...scope, ...IN_FLIGHT, startedAt: { lte: new Date(now.getTime() - wedgedAfterMs()) } },
    orderBy: { startedAt: 'asc' },
    select: { id: true, startedAt: true },
  });
}

/** `47m`, for a line whose whole job is to make a duration obvious. */
const unresolvedFor = (now: Date, startedAt: Date): string =>
  `${Math.floor((now.getTime() - startedAt.getTime()) / 60_000)}m`;

/**
 * Says why a campaign that placed nothing placed nothing.
 *
 * The gap this closes: a campaign held at zero slots dialed nothing and said
 * nothing, so **a campaign waiting on one stuck attempt and a campaign nobody
 * had started produced identical logs** — none. The only visible symptom was
 * an operator reporting that a running campaign "looks idle", and there was no
 * line to read that would confirm or deny it.
 *
 * **The question is never "which cap", it is "is anything turning over".** A
 * campaign pinned at a cap with calls completing and being replaced is a busy
 * campaign working exactly as configured; one pinned at the same cap with its
 * oldest call unresolved for forty minutes is wedged. So the age gate applies
 * to the campaign arm *and* the account arm, and only the shared pool — whose
 * occupants are other integrators' calls that this service cannot see the age
 * of — is reported on sight.
 *
 * An earlier version gated only the campaign arm, on the reasoning that a
 * spent allotment is "somebody's problem" and worth saying every pass. The
 * shipped defaults make that wrong: `Campaign.concurrencyLimit` defaults to 2
 * and `DIALER_DEFAULT_ACCOUNT_CONCURRENCY` to 2, so an ordinary busy campaign
 * sits at *both* zero at once and the account arm — ungated — spoke for it
 * every minute forever. Worse, the campaign ceiling may be raised to 10 while
 * the account default stays 2, which makes the account the binding cap in the
 * ordinary case rather than the exceptional one. The gate has to be on the
 * symptom, not on which number happens to be smaller.
 *
 * Deduplicated per pass by scope, because the blocked branch is per campaign
 * while these facts are not: one full pool would otherwise speak once for
 * every RUNNING campaign on the platform, up to `CAMPAIGN_BATCH`, every tick.
 */
async function reportBlocked(
  campaign: SweepCampaign,
  now: Date,
  reported: Set<string>,
  facts: {
    concurrencyLimit: number;
    activeAll: number;
    accountLimit: number;
    accountActive: number;
    platformRemaining: number | null;
  },
): Promise<void> {
  const cap = bindingCap(facts);

  // Nothing is exhausted, so nothing here is the explanation. Only reachable
  // if the caller's precondition breaks; saying nothing is the honest answer.
  if (cap === null) return;

  if (cap === 'platform_pool') {
    if (reported.has('platform')) return;
    reported.add('platform');

    console.warn(
      `[dialer] no slots — the shared platform pool is full ` +
        `(${facts.platformRemaining ?? 0} remaining); every campaign is waiting on it`,
    );

    return;
  }

  const account = campaign.workspace.ownerAccountId;

  if (cap === 'account_allotment') {
    const key = `account:${account}`;
    if (reported.has(key)) return;

    // Zero is a limit somebody set — `concurrency.ts` is emphatic that it
    // means staff stopped this account. Reporting that as "at its allotment"
    // sends a reader hunting for in-flight calls that do not exist, so it gets
    // its own sentence and no age gate: there is no call to be old.
    if (facts.accountLimit === 0) {
      reported.add(key);
      console.warn(
        `[dialer] account ${account}: no slots — allotted zero lines, so nothing dials ` +
          `until staff raise it`,
      );

      return;
    }

    const oldest = await oldestWedgedAttempt({ accountId: account }, now);
    if (oldest === null) return;

    reported.add(key);
    console.warn(
      `[dialer] account ${account}: no slots — at its allotment ` +
        `(${facts.accountActive}/${facts.accountLimit} in flight), and its oldest attempt ` +
        `${oldest.id} has been unresolved for ${unresolvedFor(now, oldest.startedAt)} ` +
        `(started ${oldest.startedAt.toISOString()})`,
    );

    return;
  }

  const oldest = await oldestWedgedAttempt({ campaignId: campaign.id }, now);

  // Nothing old enough. Either the campaign is simply busy, or its ceiling is
  // held entirely by claims whose placement jobs have not run yet — a queue
  // draining, bounded by the claim lease, which `releaseStaleClaims` already
  // reports when it is not.
  if (oldest === null) return;

  console.warn(
    `[dialer] campaign ${campaign.id}: no slots — at its own ceiling ` +
      `(${facts.activeAll}/${facts.concurrencyLimit} in flight), and its oldest attempt ` +
      `${oldest.id} has been unresolved for ${unresolvedFor(now, oldest.startedAt)} ` +
      `(started ${oldest.startedAt.toISOString()})`,
  );
}

async function completeIfDoneCounted(
  campaign: SweepCampaign,
  now: Date,
  result: DialerSweepResult,
): Promise<boolean> {
  const done = await completeIfDone(campaign, now);

  if (done) result.completed += 1;

  return done;
}
