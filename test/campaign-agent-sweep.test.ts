import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `prepareCampaignAgent` is the thing under test's one effect, and it is a
 * fan-out of six upstream calls. Mocked whole: what this file asserts is which
 * agents the sweep reaches and how many times, which is a property of the
 * query and the deduplication rather than of what happens upstream.
 * `campaign-extraction.test.ts` owns the other half.
 */
vi.mock('../src/services/campaignExtraction.js', () => ({
  prepareCampaignAgent: vi.fn(),
}));

const extraction = await import('../src/services/campaignExtraction.js');
const { sweepCampaignAgents, startCampaignAgentSweep } = await import(
  '../src/services/campaignAgentSweep.js'
);
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const prepare = vi.mocked(extraction.prepareCampaignAgent);

let workspaceId = '';

/** A campaign in whatever state the case is about. Nothing here dials, so a
 *  campaign needs no number, no contacts and no balance. */
async function makeCampaign(fields: {
  agentId: string | null;
  name: string;
  status?: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'COMPLETED' | 'CREDIT_EXHAUSTED';
  goalEnabled?: boolean;
  callbackEnabled?: boolean;
}) {
  return prisma.campaign.create({
    data: {
      workspaceId,
      name: fields.name,
      agentId: fields.agentId,
      status: fields.status ?? 'RUNNING',
      goalEnabled: fields.goalEnabled ?? false,
      callbackEnabled: fields.callbackEnabled ?? true,
    },
  });
}

/** The agents the sweep actually reached, in no particular order — the query
 *  orders by creation time and two rows can share a millisecond. */
const swept = () => prepare.mock.calls.map((call) => call[0]).sort();

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const account = await makeAccount(`sw${Math.random().toString(36).slice(2, 7)}`);
  workspaceId = (await makeWorkspace(account, 'Sweepers')).id;
});

afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

describe('the boot sweep', () => {
  /**
   * The reason the sweep exists at all. A campaign already RUNNING when a
   * release lands never crosses into RUNNING again, so nothing else in this
   * service ever swaps its agent onto the new contract: its calls go on
   * answering the previous release's keys, `readCallNote` finds no note, and
   * an opt-out is silently not recorded.
   */
  it('prepares the agent of every running campaign', async () => {
    const first = await makeAgent(await workspace(), 'First');
    const second = await makeAgent(await workspace(), 'Second');
    await makeCampaign({ agentId: first.id, name: 'A', goalEnabled: true });
    await makeCampaign({ agentId: second.id, name: 'B' });

    const result = await sweepCampaignAgents({ delayMs: 0 });

    expect(result).toMatchObject({ prepared: 2, failed: 0 });
    expect(swept()).toEqual([first.externalId, second.externalId].sort());
  });

  /** Agents are many-to-one with campaigns. Preparing one per campaign would
   *  be the same six upstream calls repeated for every campaign in a workspace
   *  that shares its agent. */
  it('prepares an agent once however many campaigns share it', async () => {
    const shared = await makeAgent(await workspace(), 'Shared');
    await makeCampaign({ agentId: shared.id, name: 'A', goalEnabled: true });
    await makeCampaign({ agentId: shared.id, name: 'B', goalEnabled: true });
    await makeCampaign({ agentId: shared.id, name: 'C', goalEnabled: true });

    const result = await sweepCampaignAgents({ delayMs: 0 });

    expect(result).toMatchObject({ prepared: 1, shared: 2 });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  /**
   * And the agent alone is now the RIGHT key.
   *
   * There used to be two branches — the goal branch attaching the note set and
   * the prompt block, the callback branch attaching the callbacks set — so an
   * agent shared by one campaign of each kind needed two passes, and the key
   * was the agent and the branch. There is one branch since 2026-09-06: every
   * campaign wants the note set, so two campaigns sharing an agent share the
   * whole of the preparation and the second is deduplicated.
   */
  it('prepares a shared agent once whatever the campaigns had switched on', async () => {
    const shared = await makeAgent(await workspace(), 'Shared');
    await makeCampaign({ agentId: shared.id, name: 'Goals', goalEnabled: true });
    await makeCampaign({ agentId: shared.id, name: 'Plain', goalEnabled: false, callbackEnabled: true });

    const result = await sweepCampaignAgents({ delayMs: 0 });

    expect(result).toMatchObject({ prepared: 1, shared: 1 });
    expect(swept()).toEqual([shared.externalId]);
  });

  /** A PAUSED or STOPPED campaign places no call, and the transition that
   *  starts it dialing again prepares it on the way through. */
  it('leaves campaigns that are not running alone', async () => {
    const running = await makeAgent(await workspace(), 'Running');
    const idle = await makeAgent(await workspace(), 'Idle');
    await makeCampaign({ agentId: running.id, name: 'Live', goalEnabled: true });
    for (const status of ['DRAFT', 'PAUSED', 'STOPPED', 'COMPLETED', 'CREDIT_EXHAUSTED'] as const) {
      await makeCampaign({ agentId: idle.id, name: status, status, goalEnabled: true });
    }

    const result = await sweepCampaignAgents({ delayMs: 0 });

    expect(result.prepared).toBe(1);
    expect(swept()).toEqual([running.externalId]);
  });

  /**
   * The case this sweep exists for in THIS release.
   *
   * A RUNNING campaign whose stored switches are both off used to be skipped
   * outright — neither branch applied, so there was nothing to attach. It now
   * follows every conversation up like every other campaign, and it has **no
   * call-note set at all**: until this sweep reaches its agent, every call it
   * places leaves no note, books no callback and hears no opt-out. So the
   * filter no longer asks what a campaign has switched on.
   */
  it('prepares a running campaign whose stored switches are both off', async () => {
    const agent = await makeAgent(await workspace(), 'Quiet');
    await makeCampaign({ agentId: agent.id, name: 'Off', goalEnabled: false, callbackEnabled: false });

    const result = await sweepCampaignAgents({ delayMs: 0 });

    expect(result).toMatchObject({ prepared: 1, shared: 0, failed: 0 });
    expect(swept()).toEqual([agent.externalId]);
  });

  /** `agentId` can point at an agent the mirror no longer holds — staff
   *  unassign with an UPDATE the foreign key cannot see. */
  it('skips a running campaign that has no agent', async () => {
    await makeCampaign({ agentId: null, name: 'Agentless', goalEnabled: true });

    expect(await sweepCampaignAgents({ delayMs: 0 })).toMatchObject({ prepared: 0 });
    expect(prepare).not.toHaveBeenCalled();
  });

  /**
   * `prepareCampaignAgent` already turns every upstream failure into a
   * notification rather than a throw, so what is left for the catch is a bug
   * or a dead database. Either way the sweep goes on: one unreachable agent
   * must not leave every campaign after it in the list on the old contract.
   */
  it('goes on after one agent throws', async () => {
    const bad = await makeAgent(await workspace(), 'Bad');
    const good = await makeAgent(await workspace(), 'Good');
    await makeCampaign({ agentId: bad.id, name: 'A', goalEnabled: true });
    await makeCampaign({ agentId: good.id, name: 'B', goalEnabled: true });

    prepare.mockImplementation(async (agentExternalId) => {
      if (agentExternalId === bad.externalId) throw new Error('upstream is down');
    });

    const result = await sweepCampaignAgents({ delayMs: 0 });

    expect(result).toMatchObject({ prepared: 1, failed: 1 });
    expect(swept()).toContain(good.externalId);
  });

  /** Concurrency of one, and a gap between agents: this is a burst against a
   *  partner account every customer of the platform shares, fired by every
   *  instance a deploy restarts. */
  it('runs one agent at a time', async () => {
    const first = await makeAgent(await workspace(), 'First');
    const second = await makeAgent(await workspace(), 'Second');
    await makeCampaign({ agentId: first.id, name: 'A', goalEnabled: true });
    await makeCampaign({ agentId: second.id, name: 'B', goalEnabled: true });

    let inFlight = 0;
    let overlapped = false;
    prepare.mockImplementation(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    await sweepCampaignAgents({ delayMs: 0 });

    expect(overlapped).toBe(false);
  });
});

/**
 * The gate, which is the whole reason a suite can import this module at all.
 *
 * `env.workersEnabled` can never be true under vitest — `resolveWorkersEnabled`
 * refuses that branch outright and no environment variable overrides it — so
 * the started form of the sweep is inert here, and a file whose fixtures leave
 * a campaign RUNNING cannot fan out upstream calls for it.
 */
describe('startCampaignAgentSweep', () => {
  it('does nothing in a process that does not run background work', async () => {
    const agent = await makeAgent(await workspace(), 'Live');
    await makeCampaign({ agentId: agent.id, name: 'Live', goalEnabled: true });

    startCampaignAgentSweep();
    // The started form does not await, so a pass that ignored the gate would
    // still be mid-query here. One turn of the loop is enough for it to have
    // reached the mock if it were ever going to.
    await new Promise((resolve) => setImmediate(resolve));

    expect(prepare).not.toHaveBeenCalled();
  });
});

/** The sweep reads the agent mirror, not the workspace, so every case here
 *  wants the one workspace the fixtures made. */
async function workspace() {
  return prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
}
