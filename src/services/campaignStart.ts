import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/errors.js';
import type { ErrorCode } from '../lib/errors.js';
import { agentIsUsable } from '../lib/agentVisibility.js';
import { CAMPAIGN_INCLUDE, campaignInWorkspace, type CampaignWithAgent } from '../lib/campaign.js';
import { assertCampaignDialable, ensureCallerNumberReady } from '../lib/campaignStart.js';
import { validateConcurrencyUpdate, isInboundFacing } from '../lib/campaignConfig.js';
import { runInboundStart } from '../lib/inboundStart.js';
import { prepareCampaignAgent } from './campaignExtraction.js';
import { notify } from '../lib/notify.js';

/**
 * Putting a campaign into RUNNING, in one place.
 *
 * There are two doors into dialing — an operator pressing Start, and the
 * schedule scanner firing at a time somebody chose last week — and they must
 * apply the same checks. A second copy of them would drift the moment either
 * one gained a gate, and the copy that drifted would be the one nobody is
 * watching: a scheduled start runs at 3am against a campaign whose agent was
 * retired at 6pm.
 *
 * The gates themselves live in `src/lib/campaignStart.ts`. This is the routine
 * that orders them, writes the transition, and reports a refusal as a value —
 * the scanner has nowhere to throw an HTTP error to, and must be able to write
 * the reason into a column instead.
 */

export type StartOutcome =
  | { ok: true; campaign: CampaignWithAgent }
  | { ok: false; status: number; code: ErrorCode; message: string };

/** The statuses a start may be asked for. `SCHEDULED` is legacy: nothing
 *  writes it any more, but rows written before the schedule moved into a
 *  column still carry it. */
const STARTABLE: readonly string[] = ['DRAFT', 'SCHEDULED'];

export async function startCampaign({
  campaignId,
  workspaceId,
  overrides,
  actorEmail,
}: {
  campaignId: string;
  workspaceId: string;
  /**
   * A body that may carry concurrency settings to apply on the way in.
   *
   * The route passes the request body; the scanner passes nothing, because a
   * scheduled start uses the values the campaign was saved with.
   */
  overrides?: unknown;
  /** Who pressed Start, for the notification. Absent means the schedule did. */
  actorEmail?: string;
}): Promise<StartOutcome> {
  try {
    const campaign = await campaignInWorkspace(workspaceId, campaignId);

    if (!STARTABLE.includes(campaign.status)) {
      throw new ApiError(
        409,
        'INVALID_CAMPAIGN_TRANSITION',
        `A ${campaign.status.toLowerCase()} campaign cannot be started.`,
      );
    }

    // Not a null check. `agentId` being set proves only that an Agent row
    // exists — staff unassign by setting `Agent.workspaceId = null` and sync
    // retires by setting `status`, both UPDATEs the foreign key cannot see, so
    // a campaign can hold a perfectly valid id for an agent it cannot use.
    if (!agentIsUsable(campaign.agent, campaign.workspaceId)) {
      throw new ApiError(
        409,
        'CAMPAIGN_AGENT_REQUIRED',
        'Assign an agent before starting this campaign.',
      );
    }

    // A pure INBOUND campaign answers rather than dials, so the outbound gates
    // below — pending contacts, dialability, caller-number readiness — do not
    // apply to it. BOTH dials and answers, so it runs both sets.
    const dials = campaign.type === 'OUTBOUND' || campaign.type === 'BOTH';

    if (dials) {
      const pending = await prisma.campaignContact.count({
        where: { campaignId: campaign.id, status: 'PENDING' },
      });

      // A campaign with nothing to dial is not running, it is misconfigured, and
      // the operator should learn that here rather than from an empty report.
      if (pending === 0) {
        throw new ApiError(
          409,
          'CAMPAIGN_REQUIRES_PENDING_CONTACTS',
          'Add at least one contact before starting this campaign.',
        );
      }
    }

    // Validated against the stored pair, because `retryConcurrency` is a
    // reservation inside `concurrencyLimit` and neither can be judged alone.
    const concurrency = validateConcurrencyUpdate(overrides ?? {}, campaign);

    /**
     * The dialer's own gates, and then the one thing start does upstream.
     *
     * Local checks first and the platform call last, so a start that is going
     * to be refused never writes to a partner account every customer shares —
     * no routing built for a campaign that cannot run.
     */
    if (dials) {
      await assertCampaignDialable(campaign);
      await ensureCallerNumberReady(campaign.phoneNumber!.did);
    }

    // The inbound half: local gates, then claim and provision the DIDs. A no-op
    // for OUTBOUND. After the outbound gates and before the transition, matching
    // where the outbound upstream call sits — every local refusal first.
    if (isInboundFacing(campaign.type)) {
      await runInboundStart(campaign);
    }

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        // Cleared together: the schedule has fired, and the reason the last
        // one did not must not outlive the start that succeeded.
        scheduledStartAt: null,
        scheduleError: null,
        // A running campaign is halted by nothing.
        haltReason: null,
        ...concurrency,
      },
      ...CAMPAIGN_INCLUDE,
    });

    /**
     * The things a campaign needs upstream that are not about placing the
     * call: the extraction keys that let a finished call say a callback was
     * asked for, and — for a goal campaign — the verdict set plus the managed
     * block in the agent's prompt that is the only way the goal reaches the
     * model at all.
     *
     * **After** the transition, deliberately. Each write is idempotent and
     * safe to re-run on every start, and none may ever fail one — a campaign
     * that cannot book callbacks or judge its goal still dials, and refusing
     * to start it over this would be the worse outcome. Failures notify.
     */
    if (campaign.agent) {
      const agent = await prisma.agent.findUnique({
        where: { id: campaign.agent.id },
        select: { externalId: true },
      });

      if (agent) await prepareCampaignAgent(agent.externalId, workspaceId, updated);
    }

    void notify(
      workspaceId,
      'ALL_MEMBERS',
      'campaign.started',
      `${updated.name} was started`,
      actorEmail === undefined
        ? 'This campaign started on the schedule it was given.'
        : `${actorEmail} started this campaign.`,
      `/campaigns/${updated.id}`,
    );

    return { ok: true, campaign: updated };
  } catch (err) {
    // A refusal is a value here, not an exception: the scanner has nowhere to
    // throw one to and has to write the reason into a column. Anything that is
    // not a refusal — a dropped connection, a bug — is still a throw, and the
    // scanner leaves the schedule in place so the next tick retries it.
    if (err instanceof ApiError) {
      return { ok: false, status: err.status, code: err.code, message: err.message };
    }

    throw err;
  }
}
