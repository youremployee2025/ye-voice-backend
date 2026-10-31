import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { canonicalizeE164 } from '../lib/phone.js';
import { variablesFor } from '../lib/callVariables.js';
import { goalVariables, type GoalRecordSnapshot } from '../lib/goalVariables.js';
import { goalSnapshot } from './goalContext.js';

type ContactLink = Prisma.CampaignContactGetPayload<{ include: { contact: true } }>;

/**
 * The decision the inbound routing policy returns to the platform, before it
 * creates any session. Only `ANSWER_WITH_AI` is ever returned — `TRANSFER` is
 * refused for VoiceLink upstream, and REJECT would drop a customer call.
 */
export interface InboundRouteDecision {
  action: 'ANSWER_WITH_AI';
  variables?: Record<string, string>;
}

const ANSWER_BLANK: InboundRouteDecision = { action: 'ANSWER_WITH_AI' };

export interface InboundRouteInput {
  fromNumber: string;
  toNumber: string;
  /** The platform's ids for the call about to be created, when it sends them —
   *  stored so `session.completed` can settle this exact row. */
  callId?: string | null;
  sessionId?: string | null;
}

/**
 * What the route handler gets back: the decision to send, and the arrival
 * write to run once it has been sent.
 *
 * Split on purpose. The caller hears every millisecond of this path as ring
 * time, so the decision is made from reads alone and the write is handed
 * back as a thunk for the handler to run AFTER `res.json`. `null` when there
 * is nothing to record — an unclaimed DID is an unattributed call.
 */
export interface InboundRouteResult {
  decision: InboundRouteDecision;
  record: (() => Promise<void>) | null;
}

const UNATTRIBUTED: InboundRouteResult = { decision: ANSWER_BLANK, record: null };

/**
 * Resolves campaign and contact from the two phone numbers and returns the
 * pre-call variables, plus the attribution write for the handler to run once
 * the response is on the wire.
 *
 * Three logical reads and SIX round trips, direct — never the job queue, never
 * an upstream call, and never a write: `timeout_ms` is 250–5000 with a live
 * caller holding, and this is the only synchronous path in this service on a
 * call's critical path. The claim lookup is the whole disambiguation
 * (design §6): at most one live campaign holds a DID, so an inbound call on it
 * has exactly one candidate campaign.
 *
 * Six, not three, because the schema has no `relationJoins` preview feature
 * and Prisma loads every relation as its own query: `PhoneNumber` +
 * `CampaignInboundClaim` + `Campaign` from the nested select below,
 * `CampaignContact` + `Contact` from `findCampaignContactByPhone`, and
 * `goalSnapshot`. Every one is index-backed, which is the property that
 * matters and the one to check before adding a seventh.
 */
export async function decideInboundRoute(input: InboundRouteInput): Promise<InboundRouteResult> {
  const number = await prisma.phoneNumber.findFirst({
    where: { did: canonicalizeE164(input.toNumber) ?? input.toNumber },
    select: {
      id: true,
      workspaceId: true,
      inboundClaim: {
        include: {
          campaign: { select: { id: true, variableMap: true, agent: { select: { variables: true } } } },
        },
      },
    },
  });

  const claim = number?.inboundClaim;
  const workspaceId = number?.workspaceId;
  // Unclaimed — paused, stopped, or never inbound-enabled. The only possible
  // outcome for those states is now an unattributed call, not a guess. (A
  // claimed DID always has a workspace; the null check is for the type.)
  if (!claim || !workspaceId) return UNATTRIBUTED;

  const campaign = claim.campaign;

  const phone = canonicalizeE164(input.fromNumber);
  const cc = phone ? await findCampaignContactByPhone(campaign.id, workspaceId, phone) : null;

  // An unknown caller is logged, not enrolled here: no Contact row and no
  // CampaignContact are created on this path, and the campaign is still
  // attributed through the DID claim. Enrolment happens at settle
  // (`campaignInbound.ts`), off the caller's path.
  // Stamped HERE, not inside the thunk: it is the instant the policy decided,
  // and `recordInboundArrival` uses it to tell "the settle already recovered
  // THIS call" from "a previous call by the same person".
  const decidedAt = new Date();

  const record = () =>
    recordInboundArrival({
      campaignId: campaign.id,
      campaignContactId: cc?.id ?? null,
      contactId: cc?.contactId ?? null,
      workspaceId,
      phoneNumberId: number.id,
      // Canonical when it parses, so the completion's E.164 rendering of the
      // same caller matches it exactly; the carrier's own spelling otherwise.
      fromNumber: phone ?? input.fromNumber,
      callId: input.callId ?? null,
      sessionId: input.sessionId ?? null,
      decidedAt,
    });

  if (!cc) return { decision: ANSWER_BLANK, record };

  return {
    decision: {
      action: 'ANSWER_WITH_AI',
      variables: buildInboundVariables(campaign, cc, await goalSnapshot(cc.id)),
    },
    record,
  };
}

/**
 * The one lookup that says whether a caller is somebody this campaign knows:
 * the campaign's contact row for that phone, in that workspace. Shared with
 * the settle, which needs the same answer when it has to recreate an arrival
 * row the routing handler never got to write.
 */
export function findCampaignContactByPhone(
  campaignId: string,
  workspaceId: string,
  phone: string,
): Promise<ContactLink | null> {
  return prisma.campaignContact.findFirst({
    where: { campaignId, contact: { phone, workspaceId } },
    include: { contact: true },
  });
}

/**
 * The attribution row, written before the session exists so `session.completed`
 * settles a row rather than deriving one — which is what removes the
 * pause-mid-call race.
 *
 * ONE statement, and every guard is inside it, because this write runs AFTER
 * the routing response and therefore races the completion. Two things can
 * already have happened by the time it lands:
 *
 * - The policy fired twice for one call. `ON CONFLICT DO NOTHING` on
 *   `upstreamCallId` leaves the first row exactly as it is.
 * - The whole call finished and `session.completed` recreated the arrival row
 *   from the claim. `NOT EXISTS` is that case: a row already settled, carrying
 *   no policy id, whose call ended AT OR AFTER the moment this policy decided,
 *   can only be this same call. Insert one anyway and the campaign counts the
 *   call twice and keeps a second row nothing will ever settle — which the
 *   caller's NEXT call would then settle against, so the damage spreads.
 *
 * A read-then-write would leave a window between the check and the insert;
 * `INSERT ... SELECT ... WHERE NOT EXISTS` has none, and costs one round trip
 * rather than two.
 *
 * `arrivedAt` is the decision instant rather than the column default, so the
 * row is dated when the call actually rang rather than when this write got a
 * connection.
 */
async function recordInboundArrival(row: {
  campaignId: string;
  campaignContactId: string | null;
  contactId: string | null;
  workspaceId: string;
  phoneNumberId: string;
  fromNumber: string;
  callId: string | null;
  sessionId: string | null;
  decidedAt: Date;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "CampaignInboundCall" (
      "id", "campaignId", "campaignContactId", "contactId", "workspaceId",
      "phoneNumberId", "fromNumber", "upstreamCallId", "upstreamSessionId", "arrivedAt"
    )
    SELECT ${randomUUID()}, ${row.campaignId}, ${row.campaignContactId}, ${row.contactId},
           ${row.workspaceId}, ${row.phoneNumberId}, ${row.fromNumber}, ${row.callId},
           ${row.sessionId}, ${row.decidedAt}
    WHERE NOT EXISTS (
      SELECT 1 FROM "CampaignInboundCall"
       WHERE "campaignId" = ${row.campaignId}
         AND "phoneNumberId" = ${row.phoneNumberId}
         AND "fromNumber" = ${row.fromNumber}
         AND "upstreamCallId" IS NULL
         AND "endedAt" >= ${row.decidedAt}
    )
    ON CONFLICT DO NOTHING`;
}

/**
 * The variables an inbound call answers with: the same projection the outbound
 * dialer builds over `variableMap` and the contact, plus what only inbound
 * knows — the last outcome, how many attempts so far, and when it last called.
 * Every value is a string, as the outbound path's are.
 *
 * `goalVariables` is merged for the reason `dialer.ts` merges it: the whole
 * point of an inbound face on a campaign is the contact who was dialled and
 * rings back, and an agent that opens cold on that call has thrown away the
 * conversation it is continuing. Same reserved variable, same renderer, same
 * managed prompt block — `prepareCampaignAgent` writes that block for every
 * campaign, INBOUND included, so the name is already declared on the agent
 * that answers.
 *
 * Merged AFTER the projection and outside `variablesFor`'s allow-list, exactly
 * as the dial does: the name is YE's own reserved key rather than one of the
 * customer's declared variables, and filtering it through their list would
 * drop it on every agent that has not declared it — which is all of them.
 */
function buildInboundVariables(
  campaign: { variableMap: unknown; agent: { variables: unknown } | null },
  cc: {
    attempts: number;
    disposition: string | null;
    lastAttemptAt: Date | null;
    contact: { phone: string; name: string | null; email: string | null; tags: string[]; metadata: unknown };
  },
  goal: GoalRecordSnapshot | null,
): Record<string, string> {
  const projected = variablesFor(
    { variableMap: (campaign.variableMap ?? null) as never },
    campaign.agent?.variables ?? [],
    cc.contact,
  );

  return {
    ...projected,
    ...goalVariables(goal),
    last_outcome: cc.disposition ?? '',
    attempts_so_far: String(cc.attempts),
    last_called_at: cc.lastAttemptAt ? cc.lastAttemptAt.toISOString() : '',
  };
}
