import type { CampaignContact, CampaignInboundCall, Contact, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';
import { NOT_REMOVED, agentIsUsable } from './agentVisibility.js';
import { IS_HELD, phoneNumberIsUsable } from './phoneNumberVisibility.js';
import { isArmedForCallback } from './campaignQueue.js';
import { totalDialsFor } from './dialBudget.js';
import { IMMEDIATE_CALLBACK_MINUTES } from './campaignConfig.js';
import { readCallNote } from './goalRecord.js';
import { boundExtractionValues } from './extractionCapture.js';
import { toDisplayCredits } from './credits.js';

/**
 * Looks a campaign up inside one workspace only.
 *
 * This is the isolation boundary. An id belonging to another workspace finds
 * nothing and becomes a 404, so no caller can reach across by passing a
 * foreign id — and no handler has to remember a separate ownership check,
 * which is the version somebody eventually forgets to write.
 *
 * The 404 is deliberate where a 403 might seem natural: the caller is a member
 * here, and confirming that the id exists somewhere else would leak across the
 * boundary this function exists to hold.
 */
export async function campaignInWorkspace(
  workspaceId: string,
  campaignId: string,
): Promise<CampaignWithAgent> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, workspaceId },
    ...CAMPAIGN_INCLUDE,
  });

  if (!campaign) {
    throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
  }

  return campaign;
}

/**
 * The agent fields a campaign row needs, and no more.
 *
 * Not `serializeAgentSummary` — that projects voice, language and document
 * count for the agents surface, none of which a campaign shows, and a summary
 * that grew because that surface needed a field would quietly widen this
 * payload too.
 *
 * `workspaceId` is read to decide whether the agent is still this workspace's
 * and is never emitted. See `serializeCampaign`.
 */
export const CAMPAIGN_INCLUDE = {
  include: {
    /**
     * `workspaceId` and `voiceTierSlug` are read and never emitted — the first
     * to decide whether the agent is still this workspace's, the second to
     * resolve what a minute on its voice costs before the campaign may start.
     * See `serializeCampaign`, which projects explicitly rather than spreading.
     */
    agent: {
      select: {
        id: true,
        name: true,
        status: true,
        workspaceId: true,
        voiceTierSlug: true,
        // Read to decide whether an INBOUND/BOTH campaign's agent can answer —
        // the start gate's G2. Never emitted; `serializeCampaign` projects
        // explicitly, so it stays off the wire like the two ids beside it.
        inboundEnabled: true,
        // The platform's agent id, needed to bind the agent to a DID for
        // inbound. Read, never emitted — the wire carries the local id only.
        externalId: true,
        // Whether a revived face is overwritten from the base at start
        // (`ensureInboundFace`): a UNI agent's is, a BI agent's is its own.
        // Read, never emitted.
        direction: true,
      },
    },
    /**
     * `status` and `workspaceId` are read to decide whether the number is still
     * this workspace's to dial from, and are never emitted — the same shape,
     * and the same reason, as `agent.workspaceId` above.
     *
     * Not the whole row. `rawProvider` is the provider's last payload and
     * `rentedPriceCredits` is what somebody agreed to pay; neither has any
     * business being one careless spread away from a campaign response.
     */
    phoneNumber: { select: { id: true, did: true, status: true, workspaceId: true } },
    /**
     * The dialing rotation, in rotation order.
     *
     * Joined here rather than fetched per campaign for the reason the agent is:
     * a list of fifty campaigns must stay one round trip. `status` and
     * `workspaceId` come along for the same usability filter the single number
     * gets — a released DID must not be printed as a caller id anywhere.
     */
    dialNumbers: {
      select: {
        phoneNumberId: true,
        position: true,
        phoneNumber: { select: { id: true, did: true, status: true, workspaceId: true } },
      },
      orderBy: { position: 'asc' },
    },
  },
} as const;

/**
 * Derived from the include rather than hand-written, so `agent` is *required*:
 * a call site that forgets `CAMPAIGN_INCLUDE` fails to compile instead of
 * silently serializing `agent: null` and dropping a field the dashboard needs.
 * Field types track the schema too, with no second copy to drift.
 */
export type CampaignWithAgent = Prisma.CampaignGetPayload<typeof CAMPAIGN_INCLUDE>;

export function serializeCampaign(campaign: CampaignWithAgent, contactCount?: number) {
  // Prisma cannot put a `where` on a to-one include, so the join returns the
  // agent whatever workspace it now sits in, and whatever its status. Emitting
  // it unfiltered would print another workspace's agent name inside this
  // workspace's campaign — the isolation the rest of this codebase enforces,
  // undone by a relation nobody thought to scope — and would show a retired
  // agent as a live one.
  //
  // Same predicate as the assignment check and the start gate, so what the
  // payload calls assigned is exactly what Start will accept.
  const joined = campaign.agent;
  const agent =
    joined && agentIsUsable(joined, campaign.workspaceId)
      ? { id: joined.id, name: joined.name, status: joined.status }
      : null;

  // The same filter, for the same reason, on the number: Prisma cannot put a
  // `where` on a to-one include, so the join returns the DID whoever holds it
  // now. Emitted unfiltered, a campaign would print a phone number that has
  // since been rented by somebody else — and a released number would still read
  // as a working caller id.
  const held = campaign.phoneNumber;
  const phoneNumber =
    held && phoneNumberIsUsable(held, campaign.workspaceId)
      ? { id: held.id, did: held.did }
      : null;

  /**
   * The rotation, and the legacy pointer standing in for it.
   *
   * A campaign written before the rotation existed has a `phoneNumberId` and
   * no join rows, and the dispatcher reads it exactly that way. Reporting an
   * empty rotation beside a populated pointer would tell the dashboard the
   * campaign dials from nothing, which is the opposite of what will happen.
   */
  const phoneNumberIds =
    campaign.dialNumbers.length > 0
      ? campaign.dialNumbers.map((row) => row.phoneNumberId)
      : campaign.phoneNumberId === null
        ? []
        : [campaign.phoneNumberId];

  // Same usability filter as the single number, for the same reason: an
  // unfiltered join prints a DID somebody else now rents.
  const phoneNumbers = campaign.dialNumbers
    .filter((row) => phoneNumberIsUsable(row.phoneNumber, campaign.workspaceId))
    .map((row) => ({ id: row.phoneNumber.id, did: row.phoneNumber.did }));

  return {
    id: campaign.id,
    name: campaign.name,
    // What the campaign does with calls. Decides which gates `start` runs and
    // whether it claims its DIDs for inbound; the dashboard reads it to show the
    // type selector (DRAFT-only) and the inbound-numbers panel.
    type: campaign.type,
    // Emitted even when `agent` is null. Nulling it too would make
    // "unavailable" indistinguishable from "not set" on the wire, and leave
    // the dashboard unable to say why the campaign will not start.
    agentId: campaign.agentId,
    agent,
    // Emitted even when `phoneNumber` is null, for the reason `agentId` is:
    // nulling both would make "unavailable" indistinguishable from "not set" on
    // the wire, and leave the dashboard unable to say why the campaign points
    // at nothing.
    phoneNumberId: campaign.phoneNumberId,
    phoneNumber,
    // Verbatim ids and usable rows, the same split the single number has: the
    // ids say what is configured, the objects say what will actually dial.
    phoneNumberIds,
    phoneNumbers,
    status: campaign.status,
    description: campaign.description,
    fromTime: campaign.fromTime,
    toTime: campaign.toTime,
    timezone: campaign.timezone,
    dialDays: campaign.dialDays,
    defaultCountry: campaign.defaultCountry,
    // Retries AFTER the first call, not dials made. The field was renamed
    // along with its meaning rather than left in place: a `maxAttempts` that
    // had quietly stopped counting attempts is the kind of name every reader
    // who did not follow the change reads wrongly.
    retryCount: campaign.retryCount,
    cooldownMinutes: campaign.cooldownMinutes,
    retryDelaysMinutes: campaign.retryDelaysMinutes,
    concurrencyLimit: campaign.concurrencyLimit,
    retryConcurrency: campaign.retryConcurrency,
    // How the slots `retryConcurrency` sends to the non-fresh side are split:
    // this percent to plain retries, the rest to the urgent lanes. One number,
    // so the settings page renders and round-trips a single control and the
    // two shares can never be saved disagreeing.
    retrySharePercent: campaign.retrySharePercent,
    callbackEnabled: campaign.callbackEnabled,
    variableMap: campaign.variableMap,
    // Which extracted answer sorts this campaign's leads, and which of its
    // values count as won. The counts themselves are computed at read time and
    // travel on `/stats` and the list's aggregate — these two are the settings
    // that produce them.
    leadBucketKey: campaign.leadBucketKey,
    wonBuckets: campaign.wonBuckets,
    /**
     * The goal fields, reported as what the ENGINE DOES rather than as what
     * the columns hold.
     *
     * Two of the five are inert as of 2026-09-06 and all of them are still
     * written by a PATCH that sends them, so a row can perfectly well hold
     * `goalEnabled = false, maxTotalDials = 6` on a campaign that follows
     * every conversation up and stops at `retryCount + maxGoalFollowUps + 1`.
     * Echoing the stored
     * value back would tell an older dashboard build — the one whose panel
     * still renders these — a straight untruth about the campaign it is
     * showing, and the operator would read a switch marked off beside a
     * campaign that is following people up.
     *
     * So the two inert ones are DERIVED — `goalEnabled` answers `true` and
     * `maxTotalDials` answers the effective ceiling — while
     * `maxGoalFollowUps`, `followUpDelayHours` and `maxDialsPerDay` are echoed
     * exactly as STORED, because since 2026-09-09 they are real settings again
     * and what the operator typed is what the campaign runs under. That is a
     * change of reason and not of shape: the first two were passed through
     * before because there was no effective value left to report, and they are
     * passed through now because the stored value IS the effective one.
     *
     * `immediateCallbackMinutes` remains derived from the constant: the resume
     * gap is still fixed and still not a knob.
     *
     * The deprecated `goal` prose column stays absent: nothing reads it, and a
     * payload carrying it would keep teaching the dashboard — and the operator
     * reading the panel — that the words go somewhere.
     */
    goalEnabled: true,
    maxTotalDials: totalDialsFor(campaign),
    maxGoalFollowUps: campaign.maxGoalFollowUps,
    followUpDelayHours: campaign.followUpDelayHours,
    maxDialsPerDay: campaign.maxDialsPerDay,
    immediateCallbackMinutes: IMMEDIATE_CALLBACK_MINUTES,
    // The schedule, as a pair. A start time with no way to see why the last
    // one refused is a campaign that silently did not run, which is the exact
    // failure the column exists to make visible.
    scheduledStartAt: campaign.scheduledStartAt,
    scheduleError: campaign.scheduleError,
    /**
     * The counters, maintained transactionally with the status change each one
     * describes. Emitted so a list of campaigns can draw progress without a
     * per-row aggregate — and `totalContacts` is what the list's `outcomes`
     * partition adds up to, so it has to travel beside them.
     *
     * `totalContacts` is not decremented by the sweeps, on purpose: a contact
     * that was skipped is still on the list somebody uploaded.
     */
    totalContacts: campaign.totalContacts,
    completedCount: campaign.completedCount,
    failedCount: campaign.failedCount,
    skippedCount: campaign.skippedCount,
    // The lifecycle's own clocks. `completedAt` is when the campaign stopped
    // running, which for a stopped-then-completed campaign is when it stopped;
    // `stoppedAt` is the column top-up and callback booking refuse on, and it
    // survives the relabel.
    startedAt: campaign.startedAt,
    pausedAt: campaign.pausedAt,
    // Why it is not dialing, for the campaign page. Null while running, and on
    // a campaign halted before the column existed.
    haltReason: campaign.haltReason,
    completedAt: campaign.completedAt,
    stoppedAt: campaign.stoppedAt,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    ...(contactCount === undefined ? {} : { contactCount }),
  };
}

/**
 * One row of a campaign's contact list.
 *
 * The identity half comes off `Contact` — the workspace's own record of a
 * person — and the queue half off the join row, which is this campaign's
 * opinion about them. Both are needed on the same line: a queue view that shows
 * a cooldown without saying whose it is answers nothing an operator asked.
 *
 * `callbackPending` is derived rather than stored: it is `armKind` read beside
 * the status, because only a contact still waiting is owed a call. It means a
 * promise a person made, and nothing else — a `RESUME` is the engine going
 * back to a conversation that dropped, and a list that called that a pending
 * callback would be telling an operator their lead asked for it.
 *
 * `armKind` travels raw beside it for exactly that reason: `callbackPending`
 * answers one question, and the column answers the rest of them, so the page
 * can label a resume, a follow-up and a cooldown apart without a second read.
 */
export function serializeCampaignContact(row: CampaignContact & { contact: Contact }) {
  return {
    id: row.id,
    status: row.status,
    // Retries CONSUMED, not dials made: a callback adds a dial without moving
    // this, so it is not a count of calls placed.
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt,
    nextEligibleAt: row.nextEligibleAt,
    callbackAt: row.callbackAt,
    callbackCount: row.callbackCount,
    callbackPending: isArmedForCallback(row, row.status),
    // Why this row's clock is set, verbatim. Only meaningful while it is
    // PENDING — a settled row keeps the arm it last waited under — which is
    // the same pairing every predicate in `campaignQueue.ts` makes.
    armKind: row.armKind,
    // Normalised and copied onto the join row at resolution time, so it
    // survives the re-arm that frees the attempt it came from.
    disposition: row.disposition,
    answeredBy: row.answeredBy,
    // The goal columns, emitted for every campaign: 0 and null are their
    // honest values where no goal exists, and dropping them would make the
    // row's shape depend on its campaign's settings.
    followUpCount: row.followUpCount,
    goalAchieved: row.goalAchieved,
    lastSessionId: row.lastSessionId,
    createdAt: row.createdAt,
    contactId: row.contactId,
    phone: row.contact.phone,
    name: row.contact.name,
    email: row.contact.email,
    tags: row.contact.tags,
    metadata: row.contact.metadata,
  };
}

/**
 * Resolves an agent inside one workspace, or throws.
 *
 * The workspace is part of the lookup rather than a check after it — the same
 * shape `campaignInWorkspace` uses — so there is no path where a handler holds
 * an agent it was not entitled to.
 *
 * A foreign key cannot stand in for this. It guarantees the row exists; it has
 * no opinion on whose it is, and an id belonging to another workspace's agent
 * satisfies it completely.
 *
 * Four causes, one answer: the id names nothing, names an unassigned agent,
 * names another workspace's agent, or names one that has been retired.
 * Distinguishing them would let a caller sort ids into real and unreal by
 * watching the status code, one request at a time. The message names no agent
 * for the same reason.
 *
 * Input that is malformed *in shape* — not a string, or over the column width —
 * is a different matter and is refused by the schema as a 400 before reaching
 * here. That is not a leak: the caller already knows the type and length of
 * what they sent.
 *
 * 422 rather than the usual 400: the body is well-formed and the field is a
 * string of the right shape. It is the referent that is wrong, which is a
 * different failure from malformed input and deserves a different answer.
 *
 * Nothing is returned. The caller only needs to know the reference is good, and
 * an agent row handed back here is one a later change could accidentally
 * forward into a response — `rawConfig` carries webhook URLs and partner
 * credentials, so the row is never loaded in the first place.
 */
export async function assertAgentAssignable(workspaceId: string, agentId: string): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, workspaceId, ...NOT_REMOVED },
    select: { id: true },
  });

  if (!agent) {
    throw new ApiError(
      422,
      'CAMPAIGN_AGENT_NOT_FOUND',
      'That agent is not available in this workspace.',
    );
  }
}

/**
 * Resolves a phone number inside one workspace, or throws.
 *
 * The mirror of `assertAgentAssignable`, deliberately written out rather than
 * abstracted over it: the two share a shape and not a rule, and a single
 * parameterised checker would be one call site's typo away from validating a
 * campaign's number against the agent rule.
 *
 * The workspace and the held-status are both part of the lookup rather than
 * checks after it, so there is no path where a handler holds a number it was
 * not entitled to. A foreign key cannot stand in for either: it guarantees the
 * row exists and has no opinion on whose it is or whether it is still rented.
 *
 * Four causes, one answer: the id names nothing, names a number in the shared
 * pool, names one released for non-payment, or names another workspace's.
 * Distinguishing them would let a caller sort ids into real and unreal by
 * watching the status code, one request at a time — and what is being
 * enumerated here is a set of real-world phone numbers, which makes the leak
 * worth more than an opaque row id would be. The message names no number for
 * the same reason.
 *
 * Input malformed *in shape* — not a string, or over the column width — is
 * refused by the schema as a 400 before reaching here. That is not a leak: the
 * caller already knows the type and length of what they sent.
 *
 * 422 rather than 400: the body is well-formed and the field is a string of the
 * right shape. It is the referent that is wrong.
 *
 * Nothing is returned. The caller only needs to know the reference is good, and
 * a `PhoneNumber` row handed back here is one a later change could accidentally
 * forward into a response — `rawProvider` carries the provider's last payload
 * and `rentedPriceCredits` what somebody agreed to pay, so the row is never
 * loaded in the first place.
 */
export async function assertPhoneNumberAssignable(
  workspaceId: string,
  phoneNumberId: string,
): Promise<void> {
  const number = await prisma.phoneNumber.findFirst({
    where: { id: phoneNumberId, workspaceId, ...IS_HELD },
    select: { id: true },
  });

  if (!number) {
    throw new ApiError(
      422,
      'CAMPAIGN_PHONE_NUMBER_NOT_FOUND',
      'That phone number is not available in this workspace.',
    );
  }
}

/** How many numbers one campaign may rotate through. */
export const MAX_CAMPAIGN_PHONE_NUMBERS = 20;

/**
 * Resolves a whole dialing rotation, or throws on the first thing wrong with
 * it.
 *
 * Shape first, then references: a list that is too long or names a number
 * twice is a 400 about what the caller sent, while a number this workspace
 * cannot use is the 422 `assertPhoneNumberAssignable` already defines. A
 * duplicate is refused rather than de-duplicated — the list *is* the rotation
 * order, so collapsing it would have the campaign dial from a pattern nobody
 * described.
 *
 * The whole list is checked before any of it is written, so a rotation is
 * never left half-replaced by a bad id in the middle of it.
 */
export async function assertRotationAssignable(
  workspaceId: string,
  phoneNumberIds: readonly string[],
): Promise<void> {
  if (phoneNumberIds.length > MAX_CAMPAIGN_PHONE_NUMBERS) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `phoneNumberIds must name at most ${MAX_CAMPAIGN_PHONE_NUMBERS} numbers.`,
    );
  }

  if (new Set(phoneNumberIds).size !== phoneNumberIds.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'phoneNumberIds must name each number once.');
  }

  for (const phoneNumberId of phoneNumberIds) {
    await assertPhoneNumberAssignable(workspaceId, phoneNumberId);
  }
}

/**
 * What a campaign dials from today, as an ordered list.
 *
 * Falls back to the legacy pointer when there are no join rows, because that
 * is what the dispatcher does: a campaign written before the rotation existed
 * still dials, and reporting it as "no numbers" would make every comparison
 * against a requested rotation look like a change.
 */
export function rotationOf(campaign: CampaignWithAgent): string[] {
  if (campaign.dialNumbers.length > 0) return campaign.dialNumbers.map((row) => row.phoneNumberId);

  return campaign.phoneNumberId === null ? [] : [campaign.phoneNumberId];
}

/**
 * One inbound call as the campaign's calls tab reads it.
 *
 * The caller is resolved by the route (one lookup per page, not per row) and
 * handed in; null is a stranger the settle has not enrolled, or a call on a
 * BOTH campaign. `callOutcome` is the bot's own verdict off the call note —
 * the one extraction field worth a column — and the rest of the extraction
 * stays behind the call detail. `costCredits` is what THIS row was charged,
 * in display units, or null for a call that was never billed here: the
 * imported history was charged elsewhere, and a zero would say it was free.
 *
 * `upstreamCallId` on the WIRE is `upstreamPhoneCallId` on the row, and the
 * mismatch is deliberate: the field's contract is "the id `GET /calls/:id`
 * accepts", and that endpoint resolves Vocobase's `PhoneCall.id`. The row's
 * own `upstreamCallId` column holds the CARRIER's `provider_call_id` — the
 * only id the routing-policy callback carries — which that endpoint has never
 * heard of. Sending it would put a link on every inbound row that 404s. Null
 * until the call settles, and the caller withholds the link on null.
 */
export function serializeInboundCall(
  row: CampaignInboundCall,
  contact: { id: string; name: string | null } | null,
) {
  return {
    id: row.id,
    fromNumber: row.fromNumber,
    contact,
    arrivedAt: row.arrivedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationSecs: row.durationSecs,
    disposition: row.disposition,
    // Bound the same way the settle reads it, so one stored blob cannot read
    // two ways: `readCallNote` is total, but an oversized or non-string value
    // is trimmed by `boundExtractionValues` before it is read there.
    callOutcome: readCallNote(boundExtractionValues(row.extraction)).outcome,
    costCredits: row.costCredits === null ? null : toDisplayCredits(row.costCredits),
    upstreamCallId: row.upstreamPhoneCallId,
  };
}
