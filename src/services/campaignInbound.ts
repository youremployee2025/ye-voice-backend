import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { canonicalizeE164 } from '../lib/phone.js';
import { readCallNote } from '../lib/goalRecord.js';
import { boundExtractionValues } from '../lib/extractionCapture.js';
import { boundTranscript } from '../lib/sessionCapture.js';
import { chargeFor, resolveCallRate } from '../lib/dialerPricing.js';
import { TierRateUnavailableError } from '../lib/tierPricing.js';
import { findCampaignContactByPhone } from './inboundRouteDecide.js';

/**
 * Settling an inbound call, and re-basing the contact's chase around it.
 *
 * The attribution row was written by the routing-policy handler before the
 * session existed (design §7), so `session.completed` SETTLES a row that
 * already exists rather than deriving one — which is what removes the
 * pause-mid-call race: a claim released during a live call cannot orphan an
 * answered call, because attribution was decided before the session existed.
 */

export interface InboundSettlement {
  /** Vocobase's own id for the call (`call.call_id`, its PhoneCall row) — the
   *  id `GET /calls/:id` resolves. The policy callback never carries it (that
   *  event has only the carrier's id), so it is LEARNED here and written to
   *  `upstreamPhoneCallId`, which is what lets a redelivery settle the same
   *  row instead of fabricating a second one. */
  callId: string | null;
  /** The carrier's id (`call.provider_call_id`), the one the policy callback
   *  DID carry and the arrival row was written under. `buildSessionEndPayload`
   *  upstream does not send it today; honoured the day it does. */
  providerCallId: string | null;
  /** Always present on a real `session.completed` — it is `session.id`, the
   *  key of the record the payload is about. The dedupe below does not RELY on
   *  that, because a contract we do not own is not an invariant. */
  sessionId: string | null;
  /** The two numbers and the direction, for the match that works with what the
   *  platform sends today: the open row for this caller on this DID. */
  fromNumber: string | null;
  toNumber: string | null;
  direction: string | null;
  disposition: string | null;
  durationSecs: number;
  extraction: Record<string, unknown> | null;
  endedAt: Date;
  /**
   * The conversation as the platform sent it, raw — bounded here, by the same
   * rule the dial path applies, so neither caller decides what a stored
   * conversation may be. `undefined` means this delivery said nothing about
   * it and the column is left alone.
   */
  transcript?: unknown;
  /**
   * Whether the platform holds audio. `undefined` — not `false` — when
   * post-call processing has not produced it yet: the transcript and the
   * recording arrive after the call ends, and a `false` written early would
   * both misreport the call and mark the row as already looked at.
   */
  recordingAvailable?: boolean;
}

/** A call cannot be open longer than this; an older unsettled row is not the
 *  one that just ended. */
const OPEN_CALL_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Settles the `CampaignInboundCall` row for a completed inbound call. Returns
 * the settled row (so the caller can charge and re-base) or null when this
 * completion is not for an inbound call we recorded — an ordinary outbound
 * call, or another integrator's.
 */
export async function settleInboundCall(s: InboundSettlement) {
  const row = (await findInboundCall(s)) ?? (await recoverArrival(s));
  if (!row) return null;

  const updated = await prisma.campaignInboundCall.update({
    where: { id: row.id },
    data: {
      endedAt: s.endedAt,
      durationSecs: s.durationSecs,
      disposition: s.disposition,
      extraction: (s.extraction ?? undefined) as Prisma.InputJsonValue | undefined,
      // The session facts, the way `applyTerminalOutcome` writes them: an
      // absent field is spread out rather than written, so a delivery that
      // carries no conversation cannot blank one a backfill already stored.
      ...(s.transcript === undefined ? {} : { transcript: boundTranscript(s.transcript) ?? Prisma.DbNull }),
      ...(s.recordingAvailable === undefined ? {} : { recordingAvailable: s.recordingAvailable }),
      // BOTH ids are learned at completion — neither existed at policy time —
      // and stamping them is what makes the next delivery of this same event
      // find this row by id instead of falling through to `recoverArrival`.
      // Written only when still null: an id already on the row is the one that
      // matched, and overwriting it would break the unique index it lives on.
      ...(row.upstreamSessionId === null && s.sessionId ? { upstreamSessionId: s.sessionId } : {}),
      ...(row.upstreamPhoneCallId === null && s.callId ? { upstreamPhoneCallId: s.callId } : {}),
    },
  });

  /**
   * Charged FIRST, before anything best-effort.
   *
   * Everything below is enrichment — enrolment, the chase re-base, the goal —
   * and any of it can throw: `enrolInboundCaller` is a read-then-write under
   * READ COMMITTED, so two settles racing across instances can P2002. Billing
   * must not be sequenced behind work that is allowed to fail; the minutes
   * already happened. The charge is idempotent (three guards, all keyed on
   * this row id), so a retry that re-runs it changes nothing.
   */
  await chargeInboundCall(updated.id, s.durationSecs);

  // Off the caller's path, so this is where a stranger becomes a contact.
  // Wrapped: an enrolment that loses a race must not un-settle a settled call
  // or re-run the charge; the retry, or the caller's next call, enrols them.
  let campaignContactId = updated.campaignContactId;
  if (campaignContactId === null) {
    try {
      campaignContactId = await enrolInboundCaller(updated);
    } catch (err) {
      console.error(`[inbound] could not enrol caller for inbound call ${updated.id}:`, err);
    }
  }
  const settled = campaignContactId === updated.campaignContactId ? updated : { ...updated, campaignContactId };

  await reBaseNextAttempt(settled.campaignContactId, s.endedAt);
  await recordInboundGoal(settled.campaignContactId, s.extraction);

  return settled;
}

/**
 * The arrival row, recreated from the claim when the routing handler's write
 * never landed.
 *
 * That write runs AFTER the routing response and is best-effort — the caller
 * hears everything before `res.json` as ring time — so a lost one is an
 * ordinary event, not a bug, and must not turn a real inbound conversation
 * into "session.completed for an unknown call". Only an explicitly inbound
 * completion on a DID a campaign holds a CLAIM on qualifies: a null direction
 * is another integrator's call until proven otherwise, and an unclaimed
 * number is an unattributed call by design.
 *
 * "Holds a claim", not "is RUNNING", and deliberately so: `releaseInboundClaims`
 * drops the claim on every exit from RUNNING, so a campaign stopped DURING a
 * live call has no claim by the time that call completes, and requiring one
 * would throw the call away rather than file it. The cost is the reverse case —
 * stop A, start B on the same DID, and a late completion for A's call is filed
 * under B. Both are rare; losing a real conversation is the worse of the two.
 */
async function recoverArrival(s: InboundSettlement) {
  if (s.direction === null || s.direction.toLowerCase() !== 'inbound') return null;
  if (!s.fromNumber || !s.toNumber) return null;

  const number = await prisma.phoneNumber.findFirst({
    where: { did: canonicalizeE164(s.toNumber) ?? s.toNumber },
    select: { id: true, workspaceId: true, inboundClaim: { select: { campaignId: true } } },
  });
  const claim = number?.inboundClaim;
  if (!number || !claim || !number.workspaceId) return null;

  const phone = canonicalizeE164(s.fromNumber);
  const cc = phone ? await findCampaignContactByPhone(claim.campaignId, number.workspaceId, phone) : null;

  console.warn(
    `[inbound] arrival row missing for ${s.callId ?? s.providerCallId ?? s.sessionId ?? '(no id)'}; created at settle`,
  );

  return prisma.campaignInboundCall.create({
    data: {
      campaignId: claim.campaignId,
      campaignContactId: cc?.id ?? null,
      contactId: cc?.contactId ?? null,
      workspaceId: number.workspaceId,
      phoneNumberId: number.id,
      fromNumber: phone ?? s.fromNumber,
      // Each id in its OWN namespace. Putting the completion's `call_id` in
      // `upstreamCallId` — the policy's column — would make this row invisible
      // to the arrival write that is still in flight, and that write would then
      // create a second row for the same call. It also leaves `upstreamCallId`
      // null, which is the marker `recordInboundArrival` adopts on.
      upstreamCallId: s.providerCallId,
      upstreamPhoneCallId: s.callId,
      upstreamSessionId: s.sessionId,
      // The best clock this late: the end minus what the platform says the
      // call ran to. Never `now`, which would date the arrival after the end.
      arrivedAt: new Date(s.endedAt.getTime() - s.durationSecs * 1000),
    },
  });
}

/**
 * A caller nobody uploaded becomes a contact on first settle — INBOUND
 * campaigns only. On BOTH, the contact list is still the dial list, and
 * enrolling strangers there would put them on it.
 *
 * Settled `COMPLETED` on purpose, and the reason is the STATUS invariant, not
 * the campaign's type. (An earlier version of this comment cited "a campaign's
 * type is locked once it has started"; it is not — `type` is absent from
 * `MID_CAMPAIGN_EDITABLE_FIELDS`, so it is locked only in RUNNING/PAUSED/
 * CREDIT_EXHAUSTED and a STOPPED INBOUND campaign can be switched to BOTH and
 * restarted.) What actually makes an enrolled caller undiallable is that
 * nothing moves a settled row back to PENDING: the lane claim filters
 * `cc.status = 'PENDING'`, the sweep excludes `type: 'INBOUND'` outright, a
 * CSV top-up dedupes an existing row without touching it, and the reextraction
 * re-arm needs a `CallAttempt`, which an enrolled caller has none of.
 *
 * The DISPOSITION is the call's own, not a constant: a caller who hung up
 * during the greeting did not have a conversation, and writing `completed`
 * over that puts a call that never happened in the campaign's `settled`
 * bucket and feeds `last_outcome: completed` into the next call's prompt.
 * `completed` remains the fallback for a platform that reported nothing.
 *
 * `lastAttemptAt` is the arrival — the column means "when this contact was
 * last on a call with us", and `buildInboundVariables` renders it as
 * `last_called_at`, so a returning caller's agent reads the time THEY called
 * US as the time we called them. Deliberate: it is the only recency signal the
 * inbound path has, and a blank one is worse.
 *
 * Idempotent: the contact is upserted on (workspace, phone) and the campaign
 * row is reused, so a redelivery or a second call enrols once. One consequence
 * worth knowing: an enrolled caller later uploaded on a CSV top-up is counted
 * as a duplicate and left COMPLETED, so if the campaign ever becomes BOTH that
 * person is never dialled.
 */
async function enrolInboundCaller(row: {
  id: string;
  campaignId: string;
  fromNumber: string;
  arrivedAt: Date;
  disposition: string | null;
}): Promise<string | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: row.campaignId },
    select: { type: true, workspaceId: true },
  });
  if (!campaign || campaign.type !== 'INBOUND') return null;

  const phone = canonicalizeE164(row.fromNumber);
  if (!phone) return null;

  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.upsert({
      where: { workspaceId_phone: { workspaceId: campaign.workspaceId, phone } },
      create: { workspaceId: campaign.workspaceId, phone },
      update: {},
    });

    const existing = await tx.campaignContact.findUnique({
      where: { campaignId_contactId: { campaignId: row.campaignId, contactId: contact.id } },
    });

    const cc =
      existing ??
      (await tx.campaignContact.create({
        data: {
          campaignId: row.campaignId,
          contactId: contact.id,
          status: 'COMPLETED',
          disposition: row.disposition ?? 'completed',
          lastAttemptAt: row.arrivedAt,
          nextEligibleAt: null,
        },
      }));

    if (!existing) {
      await tx.campaign.update({
        where: { id: row.campaignId },
        data: { totalContacts: { increment: 1 }, completedCount: { increment: 1 } },
      });
    }

    await tx.campaignInboundCall.update({
      where: { id: row.id },
      data: { campaignContactId: cc.id, contactId: contact.id },
    });

    return cc.id;
  });
}

/**
 * Charges an inbound call to the workspace, on the same event and through the
 * same conditional write the outbound path bills on (design §8).
 *
 * The moment this service provisions inbound for its own customers, an
 * unbilled inbound minute is this platform paying the supplier for time it
 * never bills on. So an inbound call is priced exactly as an outbound one:
 * `chargeFor` over the same `duration_seconds`, at the rate the campaign's
 * agent's voice tier resolves to for the workspace owner's account.
 *
 * `CampaignInboundCall` carries no rate snapshot or `chargedAt` — it is priced
 * at settle time — so `costCredits` is the charged marker: the update guards on
 * `costCredits: null`, and a replay finds it set and does nothing. The ledger's
 * `@@unique([accountId, reference])`, keyed on the row id, is the second guard,
 * for the non-zero charge that actually writes a row. This is the fourth module
 * that moves credits, and it follows the same conditional-write-in-a-transaction
 * rule as the other three.
 */
async function chargeInboundCall(inboundCallId: string, durationSecs: number): Promise<void> {
  const row = await prisma.campaignInboundCall.findUnique({
    where: { id: inboundCallId },
    select: { costCredits: true, workspaceId: true, campaignId: true },
  });

  // Already charged, or gone. `costCredits` is the marker: null means unbilled.
  if (!row || row.costCredits !== null) return;

  // Deliberately not filtered on `deletedAt`. This settles a call that already
  // happened, and a workspace deleted between the hangup and the settlement
  // must still bill for it — dropping the charge here would be the billing
  // history evaporating exactly when somebody deletes, which is the thing the
  // `Restrict` FKs on `CreditTransaction` exist to prevent.
  //
  // A deleted workspace cannot take a NEW inbound call regardless: arrival
  // resolves a `PhoneNumber` the workspace holds, and the delete refuses while
  // it holds any.
  const workspace = await prisma.workspace.findUnique({
    where: { id: row.workspaceId },
    select: { ownerAccountId: true },
  });
  if (!workspace) return;

  // The campaign's agent decides the voice tier the call is priced at. Read
  // separately: CampaignInboundCall names its campaign by id, not by relation.
  const campaign = await prisma.campaign.findUnique({
    where: { id: row.campaignId },
    select: { agent: { select: { voiceTierSlug: true } } },
  });

  let cost: bigint;
  try {
    const rate = await resolveCallRate(workspace.ownerAccountId, campaign?.agent?.voiceTierSlug ?? null);
    ({ cost } = chargeFor(rate.rateCreditsPerMin, durationSecs, rate.incrementSecs));
  } catch (err) {
    // No priceable tier — the same state the outbound dial refuses at, but here
    // the minutes already happened. Leave the call unbilled and loud rather than
    // crashing the completion; a missing default tier is an operator fix.
    if (err instanceof TierRateUnavailableError) {
      console.error(`[inbound] could not price inbound call ${inboundCallId}; leaving it unbilled:`, err);
      return;
    }
    throw err;
  }

  const accountId = workspace.ownerAccountId;
  const eventKey = `inbound.completed:${inboundCallId}`;

  try {
    await prisma.$transaction(async (tx) => {
      // The exactly-once marker, inside the transaction — a replay violates the
      // unique index and the whole charge rolls back.
      await tx.webhookEvent.create({ data: { eventKey, event: 'inbound.completed' } });

      // The charged marker as a `where`, so two deliveries that both read null
      // before the transaction cannot both charge.
      const marked = await tx.campaignInboundCall.updateMany({
        where: { id: inboundCallId, costCredits: null },
        data: { costCredits: cost },
      });
      if (marked.count === 0) return;

      // A call nobody spoke on costs nothing at every increment; no ledger row,
      // and the marker is set regardless so a late delivery cannot charge it.
      if (cost === 0n) return;

      // The same conditional debit the dialer, the renewal sweep and the test
      // session use: the sufficiency test is in the `where`, so a negative
      // balance is unreachable rather than unlikely.
      const debited = await tx.account.updateMany({
        where: { id: accountId, credits: { gte: cost } },
        data: { credits: { decrement: cost } },
      });

      if (debited.count === 0) {
        await tx.creditTransaction.create({
          data: {
            accountId,
            workspaceId: row.workspaceId,
            reference: inboundCallId,
            amount: 0n,
            type: 'CALL_USAGE_SHORTFALL',
          },
        });
        return;
      }

      await tx.creditTransaction.create({
        data: {
          accountId,
          workspaceId: row.workspaceId,
          reference: inboundCallId,
          amount: -cost,
          type: 'CALL_USAGE',
        },
      });
    });
  } catch (err) {
    // A duplicate marker means this delivery already charged; the rollback is
    // the correct outcome. Anything else is a real failure and propagates.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
    throw err;
  }
}

/**
 * Counts an inbound call toward the campaign's goal (design §11): extraction
 * runs on inbound calls, and the achieved-percentage readout keys off
 * `CampaignContact.goalAchieved`, so an inbound call the customer completed the
 * goal on must be able to move it.
 *
 * Deliberately POSITIVE-ONLY and additive: it flips `goalAchieved` to true when
 * the inbound verdict is achieved, and never the other way. An inbound call
 * does not stop the chase (Task 15) — it re-bases it — so it must not mark a
 * goal unmet, decide COMPLETED/FAILED, or arm follow-ups; those are the
 * attempt-centric dial engine's, and an inbound call has no attempt. Making the
 * readout count a genuine inbound success is the whole of "counts toward the
 * goal" without reaching into that machinery.
 */
async function recordInboundGoal(
  campaignContactId: string | null,
  extraction: Record<string, unknown> | null,
): Promise<void> {
  if (!campaignContactId || !extraction) return;

  const cc = await prisma.campaignContact.findUnique({
    where: { id: campaignContactId },
    select: { goalAchieved: true },
  });
  if (!cc || cc.goalAchieved === true) return;

  // The same reading the dial engine settles on: the call note's outcome, and
  // only `completed` is achieved — `stop` is a person asking to be left alone.
  const note = readCallNote(boundExtractionValues(extraction));
  if (note.outcome !== 'completed') return;

  await prisma.campaignContact.update({
    where: { id: campaignContactId },
    data: { goalAchieved: true },
  });
}

/**
 * The contact rang in, so the clock restarts — calling them ten minutes after
 * they just spoke to us is what this prevents (design §11). `nextEligibleAt`
 * moves to the inbound call's end plus the cooldown for the rung the contact is
 * on; the ladder position and the retry budget are UNTOUCHED — `attempts`
 * counts retries CONSUMED and an inbound call consumes none.
 *
 * Three cases are left alone, and the `where` is exactly those exemptions:
 *
 * - **An armed callback is exempt.** `nextEligibleAt == callbackAt`, both
 *   non-null, is the sole marker of one, so moving `nextEligibleAt` would
 *   destroy a promise the customer asked for. Written null-safely — SQL's
 *   `NOT (a = b)` is NULL when either side is NULL and a NULL predicate excludes
 *   the row, which would silently skip exactly the contacts this must move — so
 *   the negation spells its null arms out. In Prisma the field comparison is
 *   `NOT: { equals: fieldRef }`; `{ not: fieldRef }` does not work at runtime.
 *   This is the third spelling of the invariant; the other two are raw SQL in
 *   dialerClaim.ts and campaignLifecycle.ts.
 * - **A QUEUED contact is left alone** — a dial is in flight and cannot be
 *   re-timed — via `status: 'PENDING'`.
 * - **A settled contact is not reopened** — COMPLETED/FAILED never match
 *   `status: 'PENDING'`.
 *
 * An unknown caller has no `campaignContactId` and re-bases nothing.
 */
async function reBaseNextAttempt(campaignContactId: string | null, inboundEndedAt: Date): Promise<void> {
  if (!campaignContactId) return;

  const cc = await prisma.campaignContact.findUnique({
    where: { id: campaignContactId },
    select: { attempts: true, campaign: { select: { retryDelaysMinutes: true, cooldownMinutes: true } } },
  });
  if (!cc) return;

  // Element *i* of the ladder is the wait after *i* retries consumed — exactly
  // what `attempts` holds — and entries that run out fall back to the cooldown.
  const delayMinutes = cc.campaign.retryDelaysMinutes[cc.attempts] ?? cc.campaign.cooldownMinutes;
  const nextEligibleAt = new Date(inboundEndedAt.getTime() + delayMinutes * 60_000);

  await prisma.campaignContact.updateMany({
    where: {
      id: campaignContactId,
      status: 'PENDING',
      OR: [
        { callbackAt: null },
        { nextEligibleAt: null },
        { NOT: { nextEligibleAt: { equals: prisma.campaignContact.fields.callbackAt } } },
      ],
    },
    data: { nextEligibleAt },
  });
}

/**
 * Finds the row the routing policy wrote for this call.
 *
 * The two events carry DIFFERENT identifiers. At policy time Vocobase sends
 * only the carrier's `provider_call_id` (stored as `upstreamCallId`); at
 * completion it sends its own `call.call_id` (a PhoneCall row id) and the
 * `session_id`, and neither is known at policy time. So the ids are tried
 * first — the two the completion learned (`upstreamPhoneCallId`,
 * `upstreamSessionId`) are what a SECOND delivery of the same completion
 * matches on, and they are stamped by the first — and the row is otherwise
 * found by what both events DO share: the caller, the DID, and the fact that
 * the call is still open. Oldest open row first: calls end in the order they
 * began far more often than not, and a second open row from the same caller on
 * the same DID is the rare case.
 *
 * The number fallback is the ONLY match that can fail on a redelivery, because
 * it requires `endedAt: null` and the first delivery closed the row. That is
 * why the ids above are stamped rather than merely read: without them a
 * redelivery falls through to `recoverArrival` and fabricates a duplicate row,
 * which is a second charge — every idempotency guard on the charge is keyed on
 * the row id.
 */
async function findInboundCall(s: InboundSettlement) {
  for (const id of [s.providerCallId, s.callId]) {
    if (!id) continue;
    const byCall = await prisma.campaignInboundCall.findUnique({ where: { upstreamCallId: id } });
    if (byCall) return byCall;
  }
  // The completion's own id, stamped by whichever delivery settled this row
  // first. This is the lookup that makes a redelivery idempotent WITHOUT a
  // session id — the only id namespace both deliveries are guaranteed to share.
  if (s.callId) {
    const byPhoneCall = await prisma.campaignInboundCall.findUnique({
      where: { upstreamPhoneCallId: s.callId },
    });
    if (byPhoneCall) return byPhoneCall;
  }
  if (s.sessionId) {
    const bySession = await prisma.campaignInboundCall.findUnique({
      where: { upstreamSessionId: s.sessionId },
    });
    if (bySession) return bySession;
  }

  // Only an inbound completion can be an inbound row. An outbound completion
  // reaching here (no CallAttempt: another integrator's, or pre-table) must not
  // consume an open inbound row by number coincidence.
  if (s.direction !== null && s.direction.toLowerCase() !== 'inbound') return null;
  if (!s.fromNumber || !s.toNumber) return null;

  const number = await prisma.phoneNumber.findFirst({
    where: { did: canonicalizeE164(s.toNumber) ?? s.toNumber },
    select: { id: true },
  });
  if (!number) return null;

  const callerForms = [...new Set([s.fromNumber, canonicalizeE164(s.fromNumber) ?? s.fromNumber])];

  return prisma.campaignInboundCall.findFirst({
    where: {
      phoneNumberId: number.id,
      fromNumber: { in: callerForms },
      endedAt: null,
      arrivedAt: { gte: new Date(s.endedAt.getTime() - OPEN_CALL_WINDOW_MS) },
    },
    orderBy: { arrivedAt: 'asc' },
  });
}
