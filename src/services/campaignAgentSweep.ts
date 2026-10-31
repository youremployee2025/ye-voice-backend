import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { prepareCampaignAgent } from './campaignExtraction.js';

/**
 * Re-preparing the agents of campaigns that were already RUNNING when this
 * process started.
 *
 * `prepareCampaignAgent` is the only thing that swaps the managed prompt block
 * and moves an agent from one release's extraction sets to this one's, and
 * until this file it ran on exactly one edge: a campaign crossing into
 * RUNNING. Nothing ran at boot. So a campaign that was already dialing when a
 * release landed kept whatever the release before it attached — for as long as
 * nobody happened to press Pause and Resume.
 *
 * That is invisible and it is not cosmetic. Under the release before this one
 * the agent carries `YE campaign goals` and answers `next_action: "stop"`
 * when somebody says never call me again; `readCallNote` looks for six keys
 * that are not in the payload, finds no note, and `optedOut` is false — so the
 * `doNotCall.upsert` never runs and the person is dialed again until the caps
 * are spent. The same window books no callback and freezes the memory column.
 * Nothing logs a complaint, because from every surface's point of view the
 * call simply had no note.
 *
 * ## What this is not
 *
 * Not a migration and not a schedule. It is the boot-time half of the same
 * idempotent write the start path already makes, and running it twice costs
 * two listings. If it does not run, or fails, the campaign is exactly where it
 * was — behind on its contract, which is the state this fixes rather than a
 * state it creates.
 *
 * ## The 2026-09-06 release leans on it harder than usual
 *
 * Follow-ups became always-on in that release, so a RUNNING campaign that had
 * the switch off has **no call-note set attached at all** — not a set from an
 * older contract, none. Until this sweep reaches its agent, every call it
 * places leaves no note, books no callback and hears no opt-out. That is the
 * same failure the paragraph above describes and it is why the filter below
 * no longer asks what a campaign has switched on: every RUNNING campaign with
 * an agent is swept, because every one of them now needs the set.
 */

/**
 * The gap between one agent and the next.
 *
 * This is a burst against the partner account every YE customer and every
 * other integrator on the platform shares, fired by every instance that
 * restarts, and a deploy restarts them together. Each agent costs up to six
 * upstream calls, so a hundred campaigns unpaced is six hundred requests in
 * whatever time the event loop takes — which is how a rate limit is spent on
 * bookkeeping while a campaign somewhere else cannot start a call.
 *
 * The 500ms holds after the always-on change even though every agent now
 * takes the heavier branch. The population did not grow: `callbackEnabled`
 * has been true on every campaign since the callbacks-always-on migration, so
 * the `OR` this filter used to carry already matched every RUNNING campaign
 * with an agent. What changed is the dedup key — one entry per agent now
 * rather than one per agent and branch — which can only lower the count.
 *
 * Concurrency of one, deliberately. There is no throughput requirement here:
 * the sweep is racing nothing, and the only thing that matters is that it
 * finishes before the campaigns it is fixing have dialed much.
 */
export const AGENT_SWEEP_PACE_MS = 500;

export interface AgentSweepResult {
  /** Agents this pass prepared, whether or not the preparation found anything
   *  to change upstream. */
  prepared: number;
  /** Campaigns that needed no pass of their own because an earlier campaign in
   *  this sweep already prepared the same agent for the same reason. */
  shared: number;
  /** Agents whose preparation threw. `prepareCampaignAgent` turns every
   *  upstream failure into a notification rather than a throw, so a non-zero
   *  count here is a bug or a dead database rather than a partner outage. */
  failed: number;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Prepares the agent behind every RUNNING campaign that has something to
 * prepare, one at a time.
 *
 * ## Deduplicated by agent *and* by what the agent is being prepared for
 *
 * Agents are many-to-one with campaigns, so preparing one per campaign would
 * be the same six upstream calls repeated for every campaign in a workspace
 * that shares its agent. But the agent alone is the wrong key: a goal campaign
 * and a plain campaign with callbacks on may share an agent, and the two want
 * different sets — the note set for the first, the callbacks set for the
 * second, and neither branch touches the other's, on purpose. Keying on the
 * pair prepares each agent at most twice and never repeats a branch.
 *
 * ## One bad agent does not end the sweep
 *
 * `prepareCampaignAgent` already turns every upstream failure into an ADMIN
 * notification and returns, so the catch here is for what is left: a
 * notification write that fails, a bug. Either way the next agent is still
 * swept, because the alternative is one unreachable agent leaving every
 * campaign after it in the list on the old contract.
 */
export async function sweepCampaignAgents(
  options: { delayMs?: number } = {},
): Promise<AgentSweepResult> {
  const delayMs = options.delayMs ?? AGENT_SWEEP_PACE_MS;

  /**
   * RUNNING only. A PAUSED or CREDIT_EXHAUSTED campaign places no call, and
   * the transition that starts it dialing again runs the same preparation on
   * its way through — so sweeping it here would spend the upstream calls for a
   * campaign that may never resume.
   */
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'RUNNING', agentId: { not: null } },
    select: {
      name: true,
      workspaceId: true,
      agent: { select: { externalId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const result: AgentSweepResult = { prepared: 0, shared: 0, failed: 0 };
  const swept = new Set<string>();

  for (const campaign of campaigns) {
    // The column can point at an agent the mirror no longer holds — staff
    // unassign with an UPDATE the foreign key cannot see — and there is no id
    // to prepare in that case.
    const externalId = campaign.agent?.externalId;
    if (!externalId) continue;

    // The agent alone is the deduplication key. It used to be the agent and
    // the branch `prepareCampaignAgent` would take, because two campaigns on
    // one agent could want different attachments; there is one branch now, so
    // two campaigns sharing an agent share the whole of the preparation.
    if (swept.has(externalId)) {
      result.shared += 1;
      continue;
    }

    swept.add(externalId);

    // Between agents rather than before the first: a restart with one campaign
    // running should not sit idle for half a second to say so.
    if (swept.size > 1 && delayMs > 0) await pause(delayMs);

    try {
      await prepareCampaignAgent(externalId, campaign.workspaceId, campaign);
      result.prepared += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[campaign] boot sweep could not prepare ${externalId}:`, err);
    }
  }

  console.log(
    `[campaign] boot sweep: prepared ${result.prepared} agent pass(es) across ` +
      `${campaigns.length} running campaign(s), ${result.shared} sharing an agent already ` +
      `swept, ${result.failed} failed.`,
  );

  return result;
}

/**
 * The sweep as a starting process fires it: not awaited, and gated.
 *
 * **Not awaited** because it must never block or crash startup. The workers
 * are already up by the time this runs, so the campaigns it is fixing may
 * place a call or two on the old contract before it reaches them — a window of
 * seconds against the alternative, which is holding a deploy open for a
 * paced burst of upstream calls and failing the boot if the platform is slow.
 *
 * **Gated on `env.workersEnabled`**, which is this process's answer to "do I
 * do background work at all" and is the gate `server.ts` already uses. It can
 * never be true under vitest — `resolveWorkersEnabled` refuses that branch
 * outright — so a suite that imports this module cannot fan out upstream calls
 * for whatever campaigns its fixtures left RUNNING. A test that wants the
 * sweep calls `sweepCampaignAgents` and says so.
 */
export function startCampaignAgentSweep(): void {
  if (!env.workersEnabled) {
    console.log('[campaign] boot sweep skipped: this process does not run background work.');

    return;
  }

  void sweepCampaignAgents().catch((err) => {
    console.error('[campaign] boot sweep failed:', err);
  });
}
