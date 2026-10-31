import { prisma } from '../lib/prisma.js';
import { resolveCallRate } from '../lib/dialerPricing.js';
import { TierRateUnavailableError } from '../lib/tierPricing.js';
import { resolveDialRotation } from './dialerNumbers.js';
import { CAMPAIGN_INCLUDE, dialContact, type SweepHalt } from './dialer.js';
import type { ClaimedContact } from './dialerClaim.js';
import type { CallPlacementJobData } from '../lib/queue/types.js';
import { armKindOf } from '../lib/attemptKind.js';
import { markBatchHalted, readBatchHalt } from '../lib/queue/haltMarker.js';

/**
 * Placing one call that a dispatch tick already decided on.
 *
 * This is the second half of a pass, and reading it as anything else is how
 * this file gets a bug. **It is not a request to dial somebody.** The tick
 * flipped this contact `PENDING → QUEUED` inside the claim's own statement,
 * under `FOR UPDATE SKIP LOCKED`, and every cap this platform honours was
 * already spent on it there. What arrives here is the continuation of a
 * decision Postgres has already made and still holds — so the first question
 * asked below is whether Postgres still holds it.
 *
 * Nothing here re-decides anything the claim decided. It does not consult a
 * concurrency limit, a lane budget, a dialing window or the account
 * allotment: those were all applied one step earlier, on the whole batch, by
 * the only component allowed to apply them. Re-checking them here would be
 * worse than redundant, because two components enforcing one cap is two
 * components that can disagree about it.
 *
 * What it *does* re-read is everything that can have changed in the seconds
 * between the claim and now: the campaign, the contact's status, the rotation
 * and the price. Every one of those is an UPDATE no foreign key can see, and
 * a stale copy of any of them is a call somebody has already told us not to
 * place.
 */

/** What became of one placement job. One value, so the caller counts once. */
export type PlacementDisposition =
  /** The call went out. */
  | 'launched'
  /** The request was made and refused. The contact has been dealt with. */
  | 'launch-failed'
  /** Abandoned before the request: stopped, paused, or deleted mid-flight. */
  | 'abandoned'
  /** A retry of a job whose dial had already gone out. Nothing left to do. */
  | 'already-placed'
  /** The contact is no longer this campaign's claimed row. Someone else owns it. */
  | 'not-claimed'
  /** The campaign was deleted between the claim and this job. */
  | 'campaign-gone'
  /** The number this contact's turn resolved to is no longer dialable. */
  | 'number-unavailable'
  /** The account lost its price between the claim and this job. */
  | 'rate-unavailable'
  /** An earlier job in this batch met an account-wide wall. Never dialed. */
  | 'batch-halted';

export interface PlacementResult {
  disposition: PlacementDisposition;
  /** Account-wide refusal: every other campaign would meet the same wall. */
  halt: SweepHalt | null;
  /** This campaign is done for now — paused, stopped, or refused upstream. */
  stopCampaign: boolean;
  /** This job is the one that recorded the pause, so it is the one that counts it. */
  paused: boolean;
}

const NOTHING_HAPPENED = { halt: null, stopCampaign: false, paused: false } as const;

/**
 * Everything `dialContact` needs about a contact, rebuilt from the row.
 *
 * The same shape the claim returned, read again rather than carried in the job
 * — a name or a mapped variable edited between the claim and the dial should
 * reach the agent as it stands now, and a payload carrying a stranger's phone
 * number through Redis is a payload that ends up in a log line one day.
 */
const CONTACT_SELECT = {
  id: true,
  attempts: true,
  contactId: true,
  contact: { select: { phone: true, name: true, email: true, tags: true, metadata: true } },
} as const;

/**
 * Runs one `call-placement` job.
 *
 * Returns rather than throws for every outcome the dialer has a name for: a
 * refused call, a stopped campaign, a contact somebody else resolved. Those
 * are answers, and BullMQ's retry is not the mechanism for an answer — the
 * dialer's own triage already gave the contact back, settled it, or paused
 * its campaign. A throw from here means something *below* the dialer failed
 * (the database, Redis), which is exactly the case a retry is for.
 */
export async function placeClaimedCall(job: CallPlacementJobData): Promise<PlacementResult> {
  const { batchId, campaignId, contactId, fromNumberId, attemptNo, nowIso } = job;
  const now = new Date(nowIso);

  /**
   * Asked first, and before anything is read, because the point of it is to be
   * cheap: a batch that has already met a rate limit should cost one Redis GET
   * per remaining contact, not a campaign read and an upstream request each.
   */
  const halted = await readBatchHalt(batchId);

  if (halted !== null) {
    await giveBack(job, `an earlier call in this batch was refused (${halted})`);

    return { disposition: 'batch-halted', ...NOTHING_HAPPENED };
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: CAMPAIGN_INCLUDE,
  });

  // Deleted between the claim and now. The contact rows went with it, so there
  // is neither anything to dial nor anything to hand back.
  if (!campaign) return { disposition: 'campaign-gone', ...NOTHING_HAPPENED };

  /**
   * **The claim re-check, and the reason this job is safe to lose.**
   *
   * Scoped to the campaign as well as the id, and to `QUEUED`. A contact that
   * has moved on — stopped, swept, resolved by a webhook, released by the
   * cleanup sweep, settled by an operator — is somebody else's now, and the
   * one thing this job must not do is take it back. It exits without
   * releasing for the same reason: releasing a row we no longer own would
   * undo whatever the owner just wrote.
   */
  const row = await prisma.campaignContact.findFirst({
    where: { id: contactId, campaignId, status: 'QUEUED' },
    select: CONTACT_SELECT,
  });

  if (!row) return { disposition: 'not-claimed', ...NOTHING_HAPPENED };

  const contact: ClaimedContact = {
    id: row.id,
    contactId: row.contactId,
    attempts: row.attempts,
    phone: row.contact.phone,
    name: row.contact.name,
    email: row.contact.email,
    tags: row.contact.tags,
    metadata: row.contact.metadata,
    // From the job, not the row: the claim's reading of why this contact was
    // due is the durable one, and a booking or a settle may have rewritten the
    // arm since. Absent on legacy jobs reads as `FRESH`, and `dialContact`
    // stamps nothing for those anyway.
    armKind: job.attemptKind === undefined ? 'FRESH' : armKindOf(job.attemptKind),
  };

  /**
   * The number this contact's turn in the rotation resolved to, re-checked.
   *
   * The job carries the id and not the DID, so a number released or
   * deactivated between the claim and now simply falls out of the rotation and
   * is not found here. Dialing from it anyway — which carrying the string
   * would have done — is placing a call from a number the workspace no longer
   * holds. The contact goes back untouched and the next pass re-resolves the
   * rotation over what is left.
   */
  const rotation = resolveDialRotation(campaign);
  const from =
    rotation.state === 'rotating' || rotation.state === 'legacy'
      ? rotation.numbers.find((number) => number.id === fromNumberId)
      : undefined;

  if (!from) {
    await giveBack(job, 'the number its turn of the rotation resolved to is no longer dialable');

    return { disposition: 'number-unavailable', ...NOTHING_HAPPENED };
  }

  let rate;

  try {
    rate = await resolveCallRate(campaign.workspace.owner.id, campaign.agent!.voiceTierSlug);
  } catch (err) {
    if (!(err instanceof TierRateUnavailableError)) throw err;

    /**
     * Unpriced between the claim and the dial.
     *
     * The tick asks this same question before it claims anything, so reaching
     * it here means the price went away in between — a tier retired, an
     * account tier deleted. The campaign is not paused from here: the next
     * tick asks again, in the one place that pauses, and pauses once for the
     * whole campaign rather than once per job in a batch.
     */
    await giveBack(job, 'calling is no longer priced for this account');

    return { disposition: 'rate-unavailable', ...NOTHING_HAPPENED };
  }

  const outcome = await dialContact(campaign, contact, from, rate, now, attemptNo, job.attemptKind ?? null);

  /**
   * Both, not just the halt.
   *
   * A halt is account-wide and a `stopCampaign` is campaign-wide, and a batch
   * belongs to exactly one campaign — so either one means every remaining
   * contact in *this* batch would meet the same answer. The sequential loop
   * broke out of the batch on both for the same reason.
   */
  if (outcome.halt !== null || outcome.stopCampaign) {
    await markBatchHalted(batchId, outcome.halt ?? 'campaign stopped');
  }

  const disposition: PlacementDisposition = outcome.launched
    ? 'launched'
    : outcome.alreadyPlaced
      ? 'already-placed'
      : outcome.abandoned
        ? 'abandoned'
        : 'launch-failed';

  return {
    disposition,
    halt: outcome.halt,
    stopCampaign: outcome.stopCampaign,
    paused: outcome.paused,
  };
}

/**
 * Puts a claim back on the queue, unchanged.
 *
 * `releaseUnlaunched`'s terms, exactly: guarded on `QUEUED`, scoped to the
 * campaign that claimed it, and **not one timestamp touched**. Nothing was
 * attempted, so an armed callback stays armed, a retry stays due, and
 * `attempts` counts what it counted before. A cooldown stamped here would be
 * this platform punishing a contact for a fault that was never the contact's.
 *
 * The campaign scope is what makes this safe to call from a job that has been
 * sitting in a queue: a contact released, re-claimed and re-posted by another
 * campaign is not this job's to hand back, and the predicate says so.
 */
async function giveBack(job: CallPlacementJobData, reason: string): Promise<void> {
  const released = await prisma.campaignContact.updateMany({
    where: { id: job.contactId, campaignId: job.campaignId, status: 'QUEUED' },
    data: { status: 'PENDING' },
  });

  if (released.count > 0) {
    console.warn(`[placement] gave contact ${job.contactId} back: ${reason}`);
  }
}

/**
 * Gives a contact back when the queue has given up on its dial.
 *
 * Called from the placement worker's `failed` handler and **only on the final
 * attempt**. Everything before that is a job that will run again, and handing
 * the contact back between attempts would let the next tick claim it while a
 * retry of the first dial is still pending — the one shape that can put two
 * jobs on one contact.
 */
export async function releaseFailedPlacement(job: CallPlacementJobData): Promise<void> {
  await giveBack(job, 'the queue exhausted its attempts');
}
