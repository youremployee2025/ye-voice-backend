import { Prisma, type PhoneNumberStatus } from '@prisma/client';
import { ApiError } from './errors.js';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { phoneNumberIsUsable } from './phoneNumberVisibility.js';
import { isInboundFacing } from './campaignConfig.js';
import { rotationOf, type CampaignWithAgent } from './campaign.js';
import { clearPhoneNumberAgent, voicelinkInboundReady } from '../adapter/vocobase.js';
import { ensureInboundFace } from './ensureInboundFace.js';

/**
 * The DID shape the inbound start path needs — exactly what `CAMPAIGN_INCLUDE`
 * projects for a rotation number, so the resolved rotation can be passed
 * straight in. `phoneNumberIsUsable` reads `status`/`workspaceId`; the claim
 * and the readiness call read `id`/`did`.
 */
export interface InboundDid {
  id: string;
  did: string;
  /** The platform's own phone-number id, needed to unbind the agent on release
   *  or on a failed provisioning pass. Null on a row sync has not matched. */
  externalId: string | null;
  status: PhoneNumberStatus;
  workspaceId: string | null;
}

/**
 * The local gates an INBOUND/BOTH campaign passes before its start reaches the
 * platform — the inbound twin of `assertCampaignDialable`, and run beside it.
 *
 * Every gate is local, so a start that will be refused never writes routing to
 * a partner account every customer shares. The face enable, the claim and the
 * upstream readiness pass all come after this (design §5.1, G5–G6).
 *
 * G0 is the load-bearing one: an OUTBOUND campaign takes no new gate at all, so
 * this feature can never refuse a start that succeeds today.
 */
export async function assertInboundStartable(
  campaign: CampaignWithAgent,
  dids: InboundDid[],
): Promise<void> {
  // G0 — outbound-only campaigns are untouched.
  if (!isInboundFacing(campaign.type)) return;

  // G1 — the deployment kill switch, the shape DIALER_ENABLED has.
  if (!env.inboundEnabled) {
    throw new ApiError(
      409,
      'INBOUND_DISABLED',
      'Inbound calling is turned off on this deployment.',
    );
  }

  // G2 is gone: an agent without a face is no longer refused here, it is
  // given one. See `ensureInboundFace`, which `runInboundStart` calls after
  // these gates — after, so a start that is going to be refused for any other
  // reason never writes to the partner account, and deliberately not from
  // inside this function, which asserts and must not act.

  // G3 — an inbound campaign with nothing to answer on.
  if (dids.length === 0) {
    throw new ApiError(
      409,
      'CAMPAIGN_INBOUND_DID_REQUIRED',
      'Attach at least one phone number before starting this campaign.',
    );
  }

  // G4 — the existing rule: ASSIGNED | PAST_DUE, and this workspace's.
  for (const did of dids) {
    if (!phoneNumberIsUsable(did, campaign.workspaceId)) {
      throw new ApiError(
        409,
        'CAMPAIGN_INBOUND_DID_UNAVAILABLE',
        `${did.did} is no longer available to this workspace.`,
      );
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * The full DID rows this campaign will answer on — its rotation, loaded whole.
 *
 * The rotation carries only ids on the joined campaign row; the inbound path
 * needs each number's `did`, `externalId` and usability, so those are read
 * here rather than widening `CAMPAIGN_INCLUDE`'s deliberately narrow number
 * projection.
 */
export async function resolveInboundDids(campaign: CampaignWithAgent): Promise<InboundDid[]> {
  const ids = rotationOf(campaign);
  if (ids.length === 0) return [];

  const rows = await prisma.phoneNumber.findMany({
    where: { id: { in: ids } },
    select: { id: true, did: true, externalId: true, status: true, workspaceId: true },
  });

  // Preserve rotation order; a number that vanished between read and here is
  // simply absent, which G3/G4 then judge.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is InboundDid => row !== undefined);
}

/**
 * The whole inbound half of a start or resume, in order: resolve the DIDs, run
 * the local gates, create the agent's inbound face if it has none, then claim
 * and provision. A no-op for OUTBOUND. Called by both doors into RUNNING so
 * they cannot drift.
 *
 * **The enable sits between the gates and the claim, and the order is the
 * point.** Every local refusal has already been made, so a start that was
 * going to fail never asks the platform to build anything; and the face
 * exists before the readiness pass binds the agent to a DID, which is the
 * step that needs it. A campaign with no agent skips the enable, and none of
 * the gates above looks at the agent: the one refusal it meets is
 * `claimInboundDids`' own fail-closed guard, before anything is claimed.
 */
export async function runInboundStart(campaign: CampaignWithAgent): Promise<void> {
  if (!isInboundFacing(campaign.type)) return;
  const dids = await resolveInboundDids(campaign);
  await assertInboundStartable(campaign, dids);
  if (campaign.agent) await ensureInboundFace(campaign.agent);
  await claimInboundDids(campaign, dids);
}

/**
 * Claims every DID for this inbound campaign, then provisions inbound routing
 * for each — all-or-nothing (design §5.1, G5–G6).
 *
 * The claim is the invariant: `CampaignInboundClaim.phoneNumberId` is the
 * primary key, so two starts in the same second cannot both hold a DID — the
 * second INSERT fails on the key rather than on our reading of the world. One
 * transaction, so a conflict on any row leaves none claimed.
 *
 * Provisioning is sequential, not concurrent: a burst of routing writes against
 * a shared telephony account is how one campaign's start becomes somebody
 * else's incident. On any failure every claim is released and every DID that
 * bound is unbound, so a half-provisioned start never leaves a number quietly
 * answering for a campaign that did not finish starting.
 */
export async function claimInboundDids(
  campaign: CampaignWithAgent,
  dids: InboundDid[],
): Promise<void> {
  if (!isInboundFacing(campaign.type)) return;

  const agentExternalId = campaign.agent?.externalId;
  if (!agentExternalId) {
    // The only refusal for an inbound campaign with no agent: the start-time
    // agent gate (G2) is gone and `ensureInboundFace` is skipped when there is
    // no agent to give a face to, so nothing above has checked this. The
    // readiness call cannot be made without it, and a claim that binds a DID
    // to nobody is a number ringing into silence — fail closed, claim nothing.
    throw new ApiError(
      409,
      'AGENT_INBOUND_NOT_ENABLED',
      'This campaign has no usable agent to answer inbound calls.',
    );
  }

  // G5 — the claim, all-or-nothing. The unique violation IS the refusal.
  //
  // This campaign's OWN leftover rows are taken over first, in the same
  // transaction: a start that claimed and then failed before the status
  // write, or an exit whose release did not land, must not make the next
  // start refuse on the campaign's own name. A rival's row still conflicts.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.campaignInboundClaim.deleteMany({ where: { campaignId: campaign.id } });
      for (const did of dids) {
        await tx.campaignInboundClaim.create({
          data: { phoneNumberId: did.id, campaignId: campaign.id, agentId: campaign.agentId! },
        });
      }
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Name the collision. Without this the operator hunts through rotations by
    // hand for which of twenty numbers is taken.
    const held = await prisma.campaignInboundClaim.findMany({
      where: { phoneNumberId: { in: dids.map((d) => d.id) } },
      include: {
        campaign: { select: { name: true } },
        phoneNumber: { select: { did: true } },
      },
    });
    const first = held[0];
    throw new ApiError(
      409,
      'CAMPAIGN_INBOUND_DID_CONFLICT',
      first
        ? `${first.phoneNumber.did} is already answering for the campaign "${first.campaign.name}". ` +
          'Stop that campaign or choose a different number.'
        : 'One of these numbers is already answering for another running campaign.',
    );
  }

  // G6 — provision each DID, sequentially.
  for (const did of dids) {
    let ok = false;
    try {
      const result = await voicelinkInboundReady(did.did, agentExternalId);
      ok = result.ready === true && result.readiness?.inbound?.ready === true;
    } catch (err) {
      console.error(`[inbound] readiness call failed for ${did.did}:`, err);
    }

    if (ok) continue;

    // This DID did not reach inbound-ready. Unwind every claim and unbind every
    // DID that bound — the same release the exit paths use — and refuse.
    await releaseInboundClaims(campaign.id);
    throw new ApiError(
      409,
      'CAMPAIGN_DID_NOT_INBOUND_READY',
      `${did.did} could not be made ready to answer inbound calls. Try again, or remove it ` +
        'from this campaign.',
    );
  }
}

/**
 * Releases a campaign's inbound claims and unbinds every DID they held —
 * design §5.2. Reads the claims (with each DID's platform id), clears the agent
 * binding upstream, then deletes the claim rows.
 *
 * Used by every exit from RUNNING (pause, stop, complete, credit exhaustion,
 * delete) and by the start rollback. Idempotent: a campaign with no claims is a
 * no-op, and `clearPhoneNumberAgent` writes nothing to VoiceLink and treats an
 * already-gone number as done, so a double release cannot fail. The upstream
 * unbind is best-effort and sequential — one slow clear must not strand the
 * rest, and a stop is pressed exactly when something is already wrong, so it
 * cannot depend on the platform being reachable.
 */
export async function releaseInboundClaims(campaignId: string): Promise<void> {
  const claims = await prisma.campaignInboundClaim.findMany({
    where: { campaignId },
    include: { phoneNumber: { select: { did: true, externalId: true } } },
  });

  if (claims.length === 0) return;

  await prisma.campaignInboundClaim.deleteMany({ where: { campaignId } });

  for (const claim of claims) {
    const externalId = claim.phoneNumber.externalId;
    if (!externalId) continue;
    try {
      await clearPhoneNumberAgent(externalId);
    } catch (err) {
      console.error(
        `[inbound] could not clear the agent binding on ${claim.phoneNumber.did}:`,
        err,
      );
    }
  }
}
