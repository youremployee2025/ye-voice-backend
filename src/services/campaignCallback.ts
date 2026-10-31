import { prisma } from '../lib/prisma.js';
import { parseCallbackAt, rollIntoDialWindow } from '../lib/callbackTime.js';
import { dialBudgetSpent, totalDialsFor } from '../lib/dialBudget.js';
import type { CallbackRejection } from '../lib/callbackTime.js';

/**
 * Booking the call somebody was told to expect.
 *
 * A callback is the only entry in a campaign's queue carrying a time a human
 * agreed to. Everything else is a position in a list nobody chose, which is why
 * the dispatcher's callback lane runs first and why this module is careful in
 * ways the rest of the queue does not need to be.
 *
 * Two entry points. `scheduleCampaignCallback` is the booking itself and knows
 * nothing about where the instant came from; `bookCallbackFromExtraction` is
 * what the webhook and the reaper call, and it is the one that reads a model's
 * output, parses it, rolls it into the campaign's hours, and says in one line
 * what happened.
 */

/**
 * How many callbacks one contact may be given.
 *
 * A chain of "call me back tomorrow" has no natural end, and each link in it is
 * a real call somebody is billed for.
 */
export const MAX_CALLBACKS_PER_CONTACT = 3;

export type CallbackBooking =
  | 'SCHEDULED'
  | 'LIMIT_REACHED'
  | 'DIAL_BUDGET_EXHAUSTED'
  | 'NOT_RESOLVED'
  | 'CAMPAIGN_CANCELLED'
  | 'SUPERSEDED';

/**
 * Puts a resolved contact back on the queue at a promised instant.
 *
 * ## Why the campaign row is locked first
 *
 * The dispatcher's completion pass counts a campaign's remaining work under a
 * lock on the campaign row, and then completes it. Without taking the same lock
 * in the same order, this re-arm slips between that count and that write: the
 * campaign is completed on top of a contact just put back on the queue, and a
 * promise made to a person is cancelled by a campaign announcing itself
 * finished. Every writer that can add work to a running campaign takes this
 * lock first — stop, top-up and the completion pass included.
 */
export async function scheduleCampaignCallback({
  campaignContactId,
  callbackAt,
  attemptNo,
}: {
  campaignContactId: string;
  callbackAt: Date;
  /**
   * The dial this promise was extracted from. A booking is refused when a
   * later attempt exists for the contact: the outcome path deliberately lets a
   * late delivery for a superseded dial through to the charge (the minutes
   * were real) while refusing its queue move — and this is the queue move.
   * Without the guard, a delayed completion for an attempt the reaper already
   * abandoned and the dispatcher already re-dialled would re-arm a callback
   * from a call the queue moved past, and re-open a campaign the operator
   * watched finish.
   */
  attemptNo: number;
}): Promise<CallbackBooking> {
  return prisma.$transaction(async (tx) => {
    // Read for its campaign only. Nothing is decided on this row: the state
    // that matters is re-read below, after the lock.
    const owner = await tx.campaignContact.findUnique({
      where: { id: campaignContactId },
      select: { campaignId: true },
    });

    if (!owner) return 'NOT_RESOLVED';

    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${owner.campaignId} FOR UPDATE`;

    const campaign = await tx.campaign.findUnique({
      where: { id: owner.campaignId },
      select: {
        id: true,
        status: true,
        stoppedAt: true,
        retryCount: true,
        // Half of the dial cap below: it is `retryCount + maxGoalFollowUps + 1`
        // since the follow-up lane got a budget of its own.
        maxGoalFollowUps: true,
      },
    });

    if (!campaign) return 'NOT_RESOLVED';

    /**
     * Keyed on `stoppedAt`, not on the status.
     *
     * `complete` relabels STOPPED to COMPLETED, so a status-only guard would
     * let a lead in a call that outlived the stop re-open a campaign the
     * operator killed — and the re-open at the end of this function would put
     * it straight back to RUNNING. The column is written once by stop and never
     * cleared, precisely so that relabel is not a two-click bypass of this.
     */
    if (campaign.stoppedAt !== null || campaign.status === 'STOPPED') return 'CAMPAIGN_CANCELLED';

    const contact = await tx.campaignContact.findUnique({
      where: { id: campaignContactId },
      select: {
        status: true,
        callbackCount: true,
        followUpCount: true,
        armKind: true,
      },
    });

    if (!contact) return 'NOT_RESOLVED';

    /**
     * The follow-up re-arm, and why it may book.
     *
     * A partial conversation does not settle the contact — it re-arms it
     * PENDING at the retry ladder's own wait. When that same conversation
     * ALSO promised a callback, the booking (which runs after the resolution)
     * used to find PENDING, read it as "never resolved", and drop the promise
     * — so the person who said "call me at four" was called at the ladder's
     * gap instead. The design says the explicit time wins: they told us when
     * to call, and the gap is only our own guess.
     *
     * Recognised narrowly: a contact with follow-up history (a retry re-arm
     * on such a contact also matches — booking the explicit time over the
     * retry delay is equally the design's intent), and no promise already
     * standing — `CALLBACK` means somebody was already given a time, and this
     * path must not move it. A `RESUME` is not a promise and is bookable
     * over: the engine picked that instant, the lead named this one. The
     * superseded and dial-cap checks below still apply in full.
     */
    const followUpRearmed =
      contact.status === 'PENDING' &&
      contact.followUpCount > 0 &&
      contact.armKind !== 'CALLBACK';

    // The two states resolution just wrote — or the goal re-arm above.
    // Anything else means the contact was never resolved, or was resolved and
    // has since been claimed again.
    if (contact.status !== 'COMPLETED' && contact.status !== 'FAILED' && !followUpRearmed) {
      return 'NOT_RESOLVED';
    }

    if (contact.callbackCount >= MAX_CALLBACKS_PER_CONTACT) return 'LIMIT_REACHED';

    // The same pin resolution carries: `attemptNo` is unique per contact and
    // only ever increases, so "an attempt numbered above mine exists" is
    // exactly "the queue has dialled past the call this promise came from".
    // Checked under the campaign lock. A settled contact cannot be re-claimed
    // between here and the arm below; a PENDING one (the goal re-arm path)
    // can — the status-guarded arm below is what actually closes that window.
    const superseded = await tx.callAttempt.count({
      where: { campaignContactId, attemptNo: { gt: attemptNo } },
    });

    if (superseded > 0) return 'SUPERSEDED';

    /**
     * The absolute cap, asked exactly the way the claim and the resolution ask
     * it — a PLACED attempt at or past `totalDialsFor`
     * (`retryCount + maxGoalFollowUps + 1`). A
     * promise extracted on the campaign's last allowed dial is refused rather
     * than armed; a promise on a contact whose ordinals were spent by launches
     * that never reached the platform is not. A callback is exempt from the
     * RETRY reservation, deliberately; it is not exempt from this one, which
     * counts dials of every kind.
     */
    if (await dialBudgetSpent(tx, campaignContactId, totalDialsFor(campaign))) {
      return 'DIAL_BUDGET_EXHAUSTED';
    }

    const armed = await tx.campaignContact.updateMany({
      // Guarded on the status this decision was taken against: between the read
      // above and this write the dispatcher may have claimed the contact.
      where: { id: campaignContactId, status: contact.status },
      data: {
        status: 'PENDING',
        // The clock and the promise, written together. `callbackAt` is the
        // record of what a person was told and `nextEligibleAt` is when the
        // queue will act on it; they are one instant here because this is the
        // one path where the two are the same fact.
        nextEligibleAt: callbackAt,
        callbackAt,
        // The only writer of this arm, as `callbackAt` is the only writer of
        // that column — which is what makes the callback lane a lane of
        // promises and nothing else. It overwrites whatever the resolution
        // armed a moment ago: a `requested` note re-arms FOLLOW_UP at the
        // configured delay and this booking moves it to the named time.
        armKind: 'CALLBACK',
        callbackCount: { increment: 1 },
        // `attempts` is deliberately untouched. A callback spends no retry, or
        // a lowered retry budget would silently cancel a call somebody expects.
      },
    });

    // A lost race, and nothing below it runs: a counter given back for a
    // re-arm that did not happen is a campaign under-reporting its own work.
    if (armed.count === 0) return 'NOT_RESOLVED';

    // The contact is no longer terminal, so the counter that described it is
    // handed back. Guarded above zero rather than decremented blindly — a
    // counter that has drifted must not be driven negative by the correction.
    // A follow-up re-arm was never counted, so there is nothing to hand back
    // for it — decrementing would under-report a contact that IS still coming.
    if (!followUpRearmed) {
      const counter = contact.status === 'COMPLETED' ? 'completedCount' : 'failedCount';

      await tx.campaign.updateMany({
        where: { id: campaign.id, [counter]: { gt: 0 } },
        data: { [counter]: { decrement: 1 } },
      });
    }

    /**
     * A scheduled callback *is* pending work, so a finished campaign re-opens
     * to RUNNING — there is nobody to press Resume at 3pm tomorrow.
     *
     * Deliberately asymmetric with a top-up, which re-opens to PAUSED: somebody
     * adding contacts is present and can resume, while the person owed this
     * call is not.
     *
     * Matching zero rows is the normal case — most callbacks are booked on a
     * campaign that is still running.
     */
    await tx.campaign.updateMany({
      where: { id: campaign.id, status: 'COMPLETED' },
      data: { status: 'RUNNING', completedAt: null, haltReason: null },
    });

    return 'SCHEDULED';
  });
}

/** Everything that can come of one extracted value, for the log line. */
type BookingOutcome = CallbackBooking | CallbackRejection | 'callbacks_disabled' | 'no_campaign';

/**
 * Reads what a finished call extracted, and books what it promised.
 *
 * **Never throws.** It runs after the charge has been applied, on both the
 * webhook and the reaper path, and a callback that cannot be booked must not
 * take a charge — or a 200 — down with it. The platform retries anything that
 * is not a 2xx, so an exception escaping here would be re-delivered four times
 * and charged... once, by the idempotency marker, but the operator would be
 * reading incident pages about it.
 *
 * One line per outcome, booked or rejected, carrying the contact, the reason,
 * the raw value and both instants when the roll moved one. `absent` is the
 * exception and is silent: the overwhelming majority of calls promise nothing,
 * and a rejection line for each of them is a log nobody can read.
 */
export async function bookCallbackFromExtraction({
  campaignId,
  campaignContactId,
  attemptNo,
  raw,
  now = new Date(),
}: {
  campaignId: string;
  campaignContactId: string;
  /** The dial the extraction came from — see `scheduleCampaignCallback`. */
  attemptNo: number;
  raw: unknown;
  now?: Date;
}): Promise<void> {
  try {
    const parsed = parseCallbackAt(raw, null, now);

    // Cheapest possible exit for the common case: no promise, no queries.
    if (!parsed.ok && parsed.reason === 'absent') return;

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        fromTime: true,
        toTime: true,
        timezone: true,
        dialDays: true,
      },
    });

    if (!campaign) return log(campaignContactId, 'no_campaign', raw);

    // No `callbackEnabled` gate any more, and none is reachable: every
    // campaign's agent carries the call-note set, whose `call_back_at` is
    // only actionable beside a time, and an explicit promise beats every gap
    // the engine would have picked. The switch that could forbid this was
    // already true on every row before this release and read by nothing after
    // the goal branch it was the exception to became the only branch.

    // Re-parsed in the campaign's own zone now that we have it: the first parse
    // exists only to answer "is there anything here at all", and a naive
    // datetime read in the wrong zone is a call at the wrong hour.
    const inZone = parseCallbackAt(raw, campaign.timezone, now);

    if (!inZone.ok) return log(campaignContactId, inZone.reason, raw);

    const rolled = rollIntoDialWindow(inZone.at, campaign);

    const outcome = await scheduleCampaignCallback({
      campaignContactId,
      callbackAt: rolled,
      attemptNo,
    });

    log(campaignContactId, outcome, raw, inZone.at, rolled);
  } catch (err) {
    console.error(`[callback] could not book a callback for contact ${campaignContactId}:`, err);
  }
}

function log(
  campaignContactId: string,
  outcome: BookingOutcome,
  raw: unknown,
  promised?: Date,
  rolled?: Date,
): void {
  // The raw value is a model's output about a customer's own call, so it is
  // truncated rather than printed at whatever length it arrived at.
  const value = typeof raw === 'string' ? raw.slice(0, 60) : typeof raw;

  const when =
    promised === undefined
      ? ''
      : rolled !== undefined && rolled.getTime() !== promised.getTime()
        ? ` promised=${promised.toISOString()} rolled=${rolled.toISOString()}`
        : ` at=${promised.toISOString()}`;

  // The raw value goes in a field rather than in the message. It is one of a
  // model's answers about a customer's own call, and the logger can only
  // redact what it can see a name for — interpolated into the sentence it
  // would ship to the log aggregator verbatim.
  console.log(`[callback] contact ${campaignContactId}: ${outcome}${when}`, {
    extractionValue: value,
  });
}
