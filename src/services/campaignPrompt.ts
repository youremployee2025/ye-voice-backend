import { getAgent, updateAgent } from '../adapter/vocobase.js';
import { readString } from '../lib/upstream.js';
import { notify } from '../lib/notify.js';
import { prisma } from '../lib/prisma.js';
import {
  hasEditedManagedBlock,
  hasIntactGoalBlock,
  hasLegacyBlock,
  unknownManagedMarkers,
  withGoalBlock,
  withoutGoalBlock,
} from '../lib/goalPromptBlock.js';

/**
 * Writing and removing the call-note block on an agent's prompt upstream.
 *
 * The same promise as the managed extraction keys: idempotent on every start
 * and resume, and never able to fail one — a campaign whose agent could not
 * be given the block still dials, and the notification is what tells an
 * ADMIN.
 *
 * The block itself is defined in `lib/goalPromptBlock.ts` and is pure. This
 * module is only the two round trips and the two decisions around them: when
 * a write is worth making, and when a removal is safe.
 */
export async function ensureGoalPromptBlock(
  agentExternalId: string,
  workspaceId: string,
  campaignName: string,
): Promise<boolean> {
  try {
    const prompt = readString(await getAgent(agentExternalId), ['prompt']) ?? '';

    // Said before anything else, and before the early return in particular: a
    // marker this file cannot recognise is a block no write can ever remove,
    // so the only start that could report it is every start.
    const unknown = unknownManagedMarkers(prompt);

    if (unknown.length > 0) await sayOnce(workspaceId, campaignName, unknown);

    // The ordinary case, and the reason this is one read and no write: start
    // and resume both call it, so a prompt already carrying our block must
    // cost nothing — otherwise pressing Resume rewrites the agent upstream
    // every time, on an account every customer of the platform shares.
    //
    // `hasLegacyBlock` as well, never the intact test alone: a prompt can
    // carry this release's block at the top AND a superseded one trailing
    // below, and returning early on the first would strand the second on the
    // agent for good — every later start would take this same exit and never
    // look inside again.
    if (hasIntactGoalBlock(prompt) && !hasLegacyBlock(prompt)) return true;

    // A managed block is there but no longer says what the release that wrote
    // it wrote: somebody edited inside the markers. Rewritten, because a block
    // that drifted from the variable the dial carries is a prompt that quietly
    // stops seeing the note — but said, because it was somebody's edit, and
    // both this release's markers and the branded pair before them count.
    //
    // The previous release's campaign-context block is not that case, and
    // neither is an untouched branded block. An agent carrying one was never
    // touched by anyone; the contract moved under it, and `withGoalBlock`
    // replaces it as a matter of course. A notification would tell an ADMIN
    // somebody edited a prompt nobody did, so a migration is written silently.
    const edited = hasEditedManagedBlock(prompt);

    await updateAgent(agentExternalId, { prompt: withGoalBlock(prompt) });

    if (edited) {
      void notify(
        workspaceId,
        'ADMINS_ONLY',
        'campaign.goal_prompt_rewritten',
        `${campaignName} restored its agent's call-note block`,
        "The managed call-note block in this campaign's agent prompt had been " +
          'edited. It was rewritten on start; put your own instructions outside the ' +
          'marked block.',
        '/campaigns',
      );
    }

    return true;
  } catch (err) {
    console.error(`[campaign] could not write the call-note block onto ${agentExternalId}:`, err);

    void notify(
      workspaceId,
      'ADMINS_ONLY',
      'campaign.goal_prompt_unavailable',
      `${campaignName} may not read its call notes`,
      'This campaign started, but its agent prompt could not be updated with the ' +
        'call-note block. Calls will be placed as normal; the agent will not be told what ' +
        'the last call to each person learned.',
      '/campaigns',
    );

    return false;
  }
}

const MARKER_NOTIFICATION = 'campaign.goal_prompt_marker_unrecognised';

/** How long one telling of it stands for. Long enough that a worker boot, a
 *  resume and a start on the same afternoon are one row; short enough that a
 *  condition still true next week is said again to whoever is on that week. */
const MARKER_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The unrecognised-marker notification, at most once a day per campaign.
 *
 * Nothing can remove the marker, so the condition is permanent — and this
 * routine runs on every start, every resume AND on every worker boot, where
 * `campaignAgentSweep` walks every RUNNING goal campaign. Unguarded that is an
 * unbounded pile of identical rows in one workspace's bell, which is exactly
 * how a real warning becomes noise somebody learns to scroll past.
 *
 * Keyed on the title, which already carries the campaign's name: two campaigns
 * sharing one agent are two people who each have to be told, and there is no
 * campaign id on the row to key on instead. Scope and `createdAt` come first
 * in the only index this table has.
 *
 * A failed lookup notifies rather than staying silent, and never propagates: a
 * duplicate row is a small cost, a start refused because the bell could not be
 * read is not, and this whole module's promise is that it can fail no
 * transition.
 */
async function sayOnce(workspaceId: string, campaignName: string, markers: string[]): Promise<void> {
  const title = `${campaignName}'s agent prompt carries a managed block this platform cannot read`;

  try {
    const said = await prisma.notification.findFirst({
      where: {
        workspaceId,
        scope: 'ADMINS_ONLY',
        type: MARKER_NOTIFICATION,
        title,
        createdAt: { gte: new Date(Date.now() - MARKER_NOTIFICATION_WINDOW_MS) },
      },
      select: { id: true },
    });

    if (said) return;
  } catch (err) {
    console.error('[campaign] could not check whether the marker warning was already sent:', err);
  }

  void notify(
    workspaceId,
    'ADMINS_ONLY',
    MARKER_NOTIFICATION,
    title,
    'A marker line in this agent\u2019s prompt looks like one of ours but is not one this ' +
      'release writes or supersedes, most likely because its punctuation was rewritten ' +
      'somewhere. It cannot be removed automatically, and the block under it now sits ' +
      `beside the managed one. Delete it by hand: ${markers.join(', ')}`,
    '/campaigns',
  );
}

/**
 * Takes the block off the agent once no RUNNING, PAUSED or CREDIT_EXHAUSTED
 * goal campaign in the workspace still uses it. Agents are many-to-one with
 * campaigns, so stopping one campaign must not silence another's.
 *
 * `CREDIT_EXHAUSTED` counts as live for the same reason `resume` accepts it:
 * it is a campaign waiting on a top-up, not one somebody ended, and stripping
 * its agent's call-note block would make the calls it places after the top-up
 * the only ones in the campaign that never read their notes.
 *
 * Nothing here can throw. A removal that failed when the platform is down
 * would be a stop that fails exactly when an operator most needs one, and a
 * block left on an agent nothing dials with is harmless — the variables it
 * names simply never arrive, and the platform drops the ones it does not
 * substitute.
 */
export async function releaseGoalPromptBlock(agentId: string, workspaceId: string): Promise<void> {
  try {
    // Every live campaign on this agent counts. It used to be every live
    // campaign with the goal switch on; the switch is gone and every campaign
    // wants the block, so the question is simply whether the agent still has
    // a campaign that may dial.
    const live = await prisma.campaign.count({
      where: {
        agentId,
        workspaceId,
        status: { in: ['RUNNING', 'PAUSED', 'CREDIT_EXHAUSTED'] },
      },
    });

    if (live > 0) return;

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { externalId: true },
    });

    if (!agent) return;

    const prompt = readString(await getAgent(agent.externalId), ['prompt']) ?? '';
    const bare = withoutGoalBlock(prompt);

    // Compared rather than written unconditionally: an agent that never
    // carried the block, or whose prompt somebody already cleaned up, is one
    // this must not touch.
    if (bare !== prompt) await updateAgent(agent.externalId, { prompt: bare });
  } catch (err) {
    console.error(`[campaign] could not remove the call-note block from agent ${agentId}:`, err);
  }
}
