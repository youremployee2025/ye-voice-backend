import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CampaignStatus } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { clampCampaignConfig } from '../src/lib/campaignLifecycle.js';
import {
  MAX_CONCURRENCY_LIMIT,
  MAX_GOAL_FOLLOW_UPS_CEILING,
  MAX_MAX_DIALS_PER_DAY,
  MIN_CONCURRENCY_LIMIT,
} from '../src/lib/campaignConfig.js';
import {
  addMember,
  as,
  makeAccount,
  makeAgent,
  makeDialable,
  makePhoneNumber,
  makeWorkspace,
} from './helpers.js';
import {
  createExtractionSet,
  getAgent,
  listExtractionSets,
  updateAgent,
} from '../src/adapter/vocobase.js';
import { withGoalBlock } from '../src/lib/goalPromptBlock.js';

/**
 * `start` and `resume` now reach the voice platform to make the campaign's
 * caller number outbound-ready. Mocked here, as every upstream call in this
 * suite is: no test may place a call or build routing on a live account.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(async () => ({ ready: true, readiness: { state: 'READY', issues: [] } })),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  // The callback extraction key, ensured on every start and resume. Stubbed as
  // "already set up" so these cases exercise the transition rather than it.
  listExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  attachAgentExtractionSet: vi.fn(),
  detachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(async () => ({ extraction_enabled: true })),
  updateAgent: vi.fn(),
}));


const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const ALL: CampaignStatus[] = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'CREDIT_EXHAUSTED',
  'COMPLETED',
  'STOPPED',
];

/**
 * from-status -> to-status for each action. Anything absent must 409.
 *
 * `CREDIT_EXHAUSTED` is a status only the dispatcher writes, when the owner's
 * balance falls below the float. It is a from-state for **resume** and **stop**
 * and for nothing else: a status no route accepts would strand the campaign
 * where a top-up could not reach it, and letting `start` accept it would skip
 * the estimate that resume exists to re-run.
 */
const MATRIX: Record<string, Partial<Record<CampaignStatus, CampaignStatus>>> = {
  start: { DRAFT: 'RUNNING', SCHEDULED: 'RUNNING' },
  pause: { RUNNING: 'PAUSED' },
  resume: { PAUSED: 'RUNNING', CREDIT_EXHAUSTED: 'RUNNING' },
  stop: {
    DRAFT: 'STOPPED',
    SCHEDULED: 'STOPPED',
    RUNNING: 'STOPPED',
    PAUSED: 'STOPPED',
    CREDIT_EXHAUSTED: 'STOPPED',
  },
};

/**
 * A campaign satisfying every guard: an agent, one pending contact, a caller
 * number, a priced tier, and a balance.
 *
 * The last three arrived with the dialer. `start` used to be a pure state
 * transition; it now refuses a campaign that could not actually place a call,
 * so a fixture that only sets an agent no longer represents a startable
 * campaign. `makeDialable` is shared so this file cannot drift from what
 * `assertCampaignDialable` checks.
 */
async function readyCampaign(status: CampaignStatus) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  // A real mirror row, not a literal: `agentId` is a foreign key now, and the
  // start guard re-resolves it against the workspace besides.
  const agent = await makeAgent(ws, 'Sales');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', status, agentId: agent.id },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210' },
  });
  await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: contact.id } });
  await makeDialable(ws, campaign, agent);
  return { alice, ws, campaign };
}

const act = (ws: string, campaign: string, action: string) =>
  request(app)
    .post(`/api/workspaces/${ws}/campaigns/${campaign}/${action}`)
    .set(...as('user_alice', 'alice@ezo.test'));

describe('lifecycle transition matrix', () => {
  for (const action of Object.keys(MATRIX)) {
    for (const from of ALL) {
      const to = MATRIX[action]![from];

      it(`${action} from ${from} ${to ? `-> ${to}` : '-> 409'}`, async () => {
        const { ws, campaign } = await readyCampaign(from);
        const res = await act(ws.id, campaign.id, action);

        const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

        if (to) {
          expect(res.status).toBe(200);
          expect(res.body.data.status).toBe(to);
          expect(stored.status).toBe(to);
        } else {
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe('INVALID_CAMPAIGN_TRANSITION');
          expect(stored.status).toBe(from); // unchanged
        }
      });
    }
  }
});

describe('start guards', () => {
  it('refuses a campaign with no agent', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const res = await act(ws.id, campaign.id, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');
  });

  it('refuses a campaign with no pending contact', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'EXCLUDED' },
    });

    const res = await act(ws.id, campaign.id, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_REQUIRES_PENDING_CONTACTS');
  });
});

/**
 * Every campaign needs the call-note set on its agent, or a finished call can
 * never report an outcome, name a callback time or carry an opt-out. It is
 * attached on the way into RUNNING, and it may never fail the transition.
 */
describe('the call-note extraction set', () => {
  it('is ensured on start', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    vi.mocked(listExtractionSets).mockClear();

    await expect(act(ws.id, campaign.id, 'start')).resolves.toMatchObject({ status: 200 });

    expect(listExtractionSets).toHaveBeenCalledTimes(1);
  });

  it('is ensured again on resume', async () => {
    const { ws, campaign } = await readyCampaign('PAUSED');
    vi.mocked(listExtractionSets).mockClear();

    await act(ws.id, campaign.id, 'resume');

    expect(listExtractionSets).toHaveBeenCalledTimes(1);
  });

  /** The stored switches buy no exemption: a campaign holding `false` in both
   *  columns still follows every conversation up, so its agent still needs
   *  the set. */
  it('is attached whatever the stored switches say', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { callbackEnabled: false, goalEnabled: false },
    });
    vi.mocked(listExtractionSets).mockClear();

    await expect(act(ws.id, campaign.id, 'start')).resolves.toMatchObject({ status: 200 });

    expect(listExtractionSets).toHaveBeenCalledTimes(1);
  });

  it('does not fail the start when the platform refuses', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(listExtractionSets).mockRejectedValueOnce(new Error('upstream is down'));

    const res = await act(ws.id, campaign.id, 'start');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RUNNING');
  });
});

/**
 * The managed prompt block's other half: taking it back off.
 *
 * Gated on no other live goal campaign sharing the agent, because agents are
 * many-to-one with campaigns — one agent may serve several goal campaigns at
 * once, which is the whole reason the block's text is identical for all of
 * them and everything per-campaign is a dial variable. A pause is not the
 * end of a campaign and must leave the block exactly where it is.
 */
describe('the managed goal prompt block', () => {
  const goalCampaign = async (status: CampaignStatus) => {
    const seeded = await readyCampaign(status);
    await prisma.campaign.update({
      where: { id: seeded.campaign.id },
      data: { goalEnabled: true },
    });
    return seeded;
  };

  beforeEach(() => {
    vi.mocked(getAgent).mockResolvedValue({
      prompt: withGoalBlock('You are Asha.'),
      extraction_enabled: true,
    });
    vi.mocked(createExtractionSet).mockResolvedValue({ id: 'set_goal' });
    vi.mocked(updateAgent).mockClear();
  });

  it('survives a pause and a resume untouched, and comes off on stop', async () => {
    const { ws, campaign } = await goalCampaign('RUNNING');

    await expect(act(ws.id, campaign.id, 'pause')).resolves.toMatchObject({ status: 200 });
    expect(updateAgent).not.toHaveBeenCalled();

    // Resume re-runs the whole preparation, and finds nothing to do: the
    // block is intact, so the idempotent write is a read and no write.
    await expect(act(ws.id, campaign.id, 'resume')).resolves.toMatchObject({ status: 200 });
    expect(updateAgent).not.toHaveBeenCalled();

    await expect(act(ws.id, campaign.id, 'stop')).resolves.toMatchObject({ status: 200 });
    expect(updateAgent).toHaveBeenCalledWith(expect.any(String), { prompt: 'You are Asha.' });
  });

  it('stays on the agent while another goal campaign still runs on it', async () => {
    const { ws, campaign } = await goalCampaign('RUNNING');
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    await prisma.campaign.create({
      data: {
        workspaceId: ws.id,
        name: 'The other one',
        agentId: stored.agentId,
        status: 'PAUSED',
        goalEnabled: true,
      },
    });

    await expect(act(ws.id, campaign.id, 'stop')).resolves.toMatchObject({ status: 200 });

    expect(updateAgent).not.toHaveBeenCalled();
  });

  /** A stop must not depend on the platform being reachable — it is the one
   *  action an operator presses when something is already wrong. */
  it('stops the campaign even when the prompt cannot be rewritten', async () => {
    // Restored by hand rather than through `vi.restoreAllMocks()`, which would
    // also strip the implementations off the module mock above and leave every
    // later case in this file talking to a stub that returns nothing.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws, campaign } = await goalCampaign('RUNNING');
    vi.mocked(getAgent).mockRejectedValue(new Error('upstream is down'));

    const res = await act(ws.id, campaign.id, 'stop');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('STOPPED');
    logged.mockRestore();
  });

  /** `complete` relabels a stopped campaign, and a campaign stopped before
   *  this shipped reaches its agent for the first time here. */
  it('comes off when a stopped goal campaign is marked complete', async () => {
    const { ws, campaign } = await goalCampaign('STOPPED');

    await expect(act(ws.id, campaign.id, 'complete')).resolves.toMatchObject({ status: 200 });

    expect(updateAgent).toHaveBeenCalledWith(expect.any(String), { prompt: 'You are Asha.' });
  });
});

describe('resume guards', () => {
  it('resumes a campaign whose contacts are all already in flight', async () => {
    // A campaign paused near its end legitimately has nothing PENDING left, so
    // resume does not carry the pending-contact requirement that start does.
    const { ws, campaign } = await readyCampaign('PAUSED');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'CALLING' },
    });

    const res = await act(ws.id, campaign.id, 'resume');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RUNNING');
  });

  it('still requires an agent', async () => {
    const { ws, campaign } = await readyCampaign('PAUSED');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const res = await act(ws.id, campaign.id, 'resume');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');
  });
});

describe('stop', () => {
  it('sweeps the rest of the queue out and counts what it swept', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');

    const res = await act(ws.id, campaign.id, 'stop');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('STOPPED');

    // SKIPPED, not PENDING: the operator's decision is that these calls are
    // not going to be made, and a queue left PENDING is one a top-up or a
    // re-start would silently resume dialing.
    const link = await prisma.campaignContact.findFirstOrThrow();
    expect(link.status).toBe('SKIPPED');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.skippedCount).toBe(1);
  });

  it('stamps stoppedAt and completedAt with the same instant', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');

    await act(ws.id, campaign.id, 'stop');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.stoppedAt).not.toBeNull();
    expect(stored.completedAt).not.toBeNull();
    expect(stored.completedAt!.getTime()).toBe(stored.stoppedAt!.getTime());
  });

  it('leaves a live dial alone', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'QUEUED' },
    });

    await act(ws.id, campaign.id, 'stop');

    // The call is already connected. Sweeping it would make the contact list
    // disagree with a telephone that is ringing.
    const link = await prisma.campaignContact.findFirstOrThrow();
    expect(link.status).toBe('QUEUED');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(0);
  });

  it('needs no agent', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const res = await act(ws.id, campaign.id, 'stop');
    expect(res.status).toBe(200);
  });
});

describe('complete', () => {
  it('relabels a stopped campaign without moving its clocks', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');
    await act(ws.id, campaign.id, 'stop');
    const stopped = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

    const res = await act(ws.id, campaign.id, 'complete');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    // `completedAt` is when it stopped running. Rewriting it to now would put
    // a duration on the clock that no call spent.
    expect(stored.completedAt!.getTime()).toBe(stopped.completedAt!.getTime());
    // And `stoppedAt` stays, so top-up and callback booking keep refusing.
    expect(stored.stoppedAt!.getTime()).toBe(stopped.stoppedAt!.getTime());
  });

  it('refuses a campaign that is already complete', async () => {
    const { ws, campaign } = await readyCampaign('COMPLETED');

    const res = await act(ws.id, campaign.id, 'complete');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('already marked complete');
  });

  it('refuses a live campaign, saying it completes on its own', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');

    const res = await act(ws.id, campaign.id, 'complete');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('completes on its own');
  });

  it('409s with the live count while a call is still connected', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'QUEUED' },
    });
    await act(ws.id, campaign.id, 'stop');

    const res = await act(ws.id, campaign.id, 'complete');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('1 call is still connected');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
      .toBe('STOPPED');
  });

  it('409s when the status changed under it', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');
    await act(ws.id, campaign.id, 'stop');

    // The window this guard exists for: between counting the live calls and
    // writing the new status, something else moved the campaign.
    vi.spyOn(prisma.campaignContact, 'count').mockImplementationOnce(async () => {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'RUNNING' },
      });
      return 0;
    });

    const res = await act(ws.id, campaign.id, 'complete');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('reload and try again');

    vi.restoreAllMocks();
  });

  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await readyCampaign('STOPPED');
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/complete`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('delete', () => {
  const remove = (ws: string, campaign: string) =>
    request(app)
      .delete(`/api/workspaces/${ws}/campaigns/${campaign}`)
      .set(...as('user_alice', 'alice@ezo.test'));

  it('keeps the call history, with its campaign pointers nulled', async () => {
    const { ws, campaign } = await readyCampaign('RUNNING');
    const link = await prisma.campaignContact.findFirstOrThrow();
    const attempt = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ws.id,
        accountId: (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } }))
          .ownerAccountId,
        attemptNo: 1,
        status: 'QUEUED',
        upstreamCallId: 'c_kept',
        rateCreditsPerMin: 10_000n,
      },
    });

    expect((await remove(ws.id, campaign.id)).status).toBe(200);

    // The attempt is the record of a telephone call somebody is billed for.
    // Deleting a campaign must not erase the phone bill.
    const kept = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(kept.campaignId).toBeNull();
    expect(kept.campaignContactId).toBeNull();
    // The queue itself goes with the campaign.
    expect(await prisma.campaignContact.count()).toBe(0);
  });

  it('deletes from every status', async () => {
    for (const status of ALL) {
      const { ws, campaign } = await readyCampaign(status);

      expect((await remove(ws.id, campaign.id)).status, status).toBe(200);
      expect(await prisma.campaign.findUnique({ where: { id: campaign.id } })).toBeNull();

      await truncateAll();
    }
  });
});

describe('duplicate', () => {
  const duplicate = (ws: string, campaign: string, body: unknown = {}) =>
    request(app)
      .post(`/api/workspaces/${ws}/campaigns/${campaign}/duplicate`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(body);

  /**
   * A campaign carrying a value in every copyable column, so the assertions
   * below are about the copy and not about the defaults.
   */
  async function configured(status: CampaignStatus = 'COMPLETED') {
    const { alice, ws, campaign } = await readyCampaign(status);
    const second = await makePhoneNumber(ws, '+918011330000', 'ASSIGNED');
    const first = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        description: 'Third quarter outreach',
        defaultCountry: 'IN',
        retryCount: 4,
        cooldownMinutes: 45,
        retryDelaysMinutes: [5, 15],
        concurrencyLimit: 3,
        retryConcurrency: 1,
        callbackEnabled: false,
        variableMap: { City: 'city' },
        leadBucketKey: 'lead_stage',
        wonBuckets: ['Hot'],
        totalContacts: 9,
        completedCount: 4,
        rrCursor: 7,
        dialNumbers: {
          create: [
            { phoneNumberId: first.phoneNumberId!, position: 0 },
            { phoneNumberId: second.id, position: 1 },
          ],
        },
      },
    });

    return { alice, ws, campaign };
  }

  it('copies the whole dialing policy into a fresh DRAFT', async () => {
    const { ws, campaign } = await configured();

    const res = await duplicate(ws.id, campaign.id);
    expect(res.status).toBe(201);

    const clone = await prisma.campaign.findUniqueOrThrow({
      where: { id: res.body.data.id },
      include: { dialNumbers: { orderBy: { position: 'asc' } } },
    });
    const source = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });

    // Copied by omission: everything that is not identity, state or a clock.
    expect(clone).toMatchObject({
      description: 'Third quarter outreach',
      defaultCountry: 'IN',
      fromTime: source.fromTime,
      toTime: source.toTime,
      timezone: source.timezone,
      agentId: source.agentId,
      retryCount: 4,
      cooldownMinutes: 45,
      retryDelaysMinutes: [5, 15],
      concurrencyLimit: 3,
      retryConcurrency: 1,
      callbackEnabled: false,
      variableMap: { City: 'city' },
      // A duplicate dials the same agent with the same settings, so it sorts
      // its leads by the same answer. Copied by omission like the rest.
      leadBucketKey: 'lead_stage',
      wonBuckets: ['Hot'],
    });

    // And nothing that describes what the source has already done.
    expect(clone).toMatchObject({
      status: 'DRAFT',
      totalContacts: 0,
      completedCount: 0,
      rrCursor: 0,
      startedAt: null,
      completedAt: null,
      stoppedAt: null,
    });

    // The rotation is cloned in order, and the legacy pointer follows its head.
    expect(clone.dialNumbers.map((row) => row.phoneNumberId)).toEqual(
      (
        await prisma.campaignPhoneNumber.findMany({
          where: { campaignId: campaign.id },
          orderBy: { position: 'asc' },
        })
      ).map((row) => row.phoneNumberId),
    );
    expect(clone.phoneNumberId).toBe(clone.dialNumbers[0]!.phoneNumberId);

    // No contacts and no results: a copy is a campaign to fill, not a re-run.
    expect(await prisma.campaignContact.count({ where: { campaignId: clone.id } })).toBe(0);
  });

  it('re-clamps numbers that were stored out of range', async () => {
    const { ws, campaign } = await configured();
    // Written past the validators, as a row from before a bound existed would
    // be. Refusing the copy over these would leave the operator unable to make
    // one at all, over values they cannot see and did not choose.
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        concurrencyLimit: 400,
        retryConcurrency: 300,
        retrySharePercent: 150,
        retryCount: 99,
        cooldownMinutes: 0,
        retryDelaysMinutes: [0, 99_999, ...Array.from({ length: 25 }, () => 5)],
      },
    });

    const res = await duplicate(ws.id, campaign.id);

    const clone = await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(clone.concurrencyLimit).toBe(MAX_CONCURRENCY_LIMIT);
    expect(clone.retryConcurrency).toBe(MAX_CONCURRENCY_LIMIT);
    expect(clone.retrySharePercent).toBe(100);
    expect(clone.retryCount).toBe(20);
    expect(clone.cooldownMinutes).toBe(1);
    expect(clone.retryDelaysMinutes).toHaveLength(20);
    expect(clone.retryDelaysMinutes[0]).toBe(1);
    expect(clone.retryDelaysMinutes[1]).toBe(10_080);
  });

  it('names the copy, and the copy of the copy', async () => {
    const { ws, campaign } = await configured();

    const first = await duplicate(ws.id, campaign.id);
    expect(first.body.data.name).toBe('Q3 (Copy)');

    const second = await duplicate(ws.id, campaign.id);
    expect(second.body.data.name).toBe('Q3 (Copy 2)');
  });

  it('takes a name from the body, and refuses an empty one', async () => {
    const { ws, campaign } = await configured();

    const named = await duplicate(ws.id, campaign.id, { name: '  Q4 pilot  ' });
    expect(named.status).toBe(201);
    expect(named.body.data.name).toBe('Q4 pilot');

    for (const name of ['', '   ', 7]) {
      const res = await duplicate(ws.id, campaign.id, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.error.message).toContain('name');
    }
  });

  it('refuses when the agent is no longer available', async () => {
    const { ws, campaign } = await configured();
    // Unassigned by staff — an UPDATE the foreign key cannot see, which is
    // exactly why the copy re-resolves rather than trusting the column.
    const source = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    await prisma.agent.update({ where: { id: source.agentId! }, data: { workspaceId: null } });

    const res = await duplicate(ws.id, campaign.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('agent');
    expect(await prisma.campaign.count()).toBe(1);
  });

  it('refuses when one of its numbers is no longer held', async () => {
    const { ws, campaign } = await configured();
    const rotation = await prisma.campaignPhoneNumber.findMany({
      where: { campaignId: campaign.id },
      orderBy: { position: 'desc' },
    });
    await prisma.phoneNumber.update({
      where: { id: rotation[0]!.phoneNumberId },
      data: { status: 'RELEASED_NONPAYMENT' },
    });

    const res = await duplicate(ws.id, campaign.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('phone number');
    expect(await prisma.campaign.count()).toBe(1);
  });

  it('copies from any status', async () => {
    for (const status of ALL) {
      const { ws, campaign } = await configured(status);

      expect((await duplicate(ws.id, campaign.id)).status, status).toBe(201);

      await truncateAll();
    }
  });

  it('refuses a MEMBER and 404s across workspaces', async () => {
    const { alice, ws, campaign } = await configured();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const member = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/duplicate`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({});
    expect(member.status).toBe(403);

    const other = await makeWorkspace(alice, 'B Co');
    const crossed = await duplicate(other.id, campaign.id);
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe('NOT_FOUND');
    expect(await prisma.campaign.count()).toBe(1);
  });
});

describe('lifecycle access', () => {
  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await readyCampaign('DRAFT');
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(403);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
      .toBe('DRAFT');
  });

  it('404s across workspaces without changing the campaign', async () => {
    const { alice, campaign } = await readyCampaign('DRAFT');
    const other = await makeWorkspace(alice, 'B Co');

    const res = await act(other.id, campaign.id, 'start');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
      .toBe('DRAFT');
  });
});

/**
 * The duplicate's clamp, checked against the constant rather than a literal.
 *
 * `clampCampaignConfig` is the one place the concurrency ceiling is spelled
 * out a second time, and a copy that keeps the old bound is invisible to
 * `tsc` and to every route test: the API accepts the new maximum and the
 * duplicate quietly hands back the old one.
 */
describe('clampCampaignConfig', () => {
  const flat = {
    retryConcurrency: 0,
    retryCount: 2,
    cooldownMinutes: 30,
    retryDelaysMinutes: [],
    maxGoalFollowUps: 2,
    maxDialsPerDay: 2,
  };

  it('keeps a source at the ceiling the API accepts', () => {
    expect(
      clampCampaignConfig({ ...flat, concurrencyLimit: MAX_CONCURRENCY_LIMIT }).concurrencyLimit,
    ).toBe(MAX_CONCURRENCY_LIMIT);
  });

  it('clamps a source above it down to the ceiling', () => {
    expect(
      clampCampaignConfig({ ...flat, concurrencyLimit: MAX_CONCURRENCY_LIMIT + 40 })
        .concurrencyLimit,
    ).toBe(MAX_CONCURRENCY_LIMIT);
  });

  it('clamps a source below the floor up to it', () => {
    expect(clampCampaignConfig({ ...flat, concurrencyLimit: 0 }).concurrencyLimit).toBe(
      MIN_CONCURRENCY_LIMIT,
    );
  });

  /**
   * The follow-up ceiling came down from fifty to ten on 2026-09-09, and a
   * column written under the old bound is still there to be copied. A
   * duplicate that carried it verbatim would hold a value the PATCH refuses,
   * so the first edit of the copy would 400 on a field nobody touched.
   */
  it('clamps the two follow-up settings to the bounds the API accepts', () => {
    const copy = clampCampaignConfig({
      ...flat,
      concurrencyLimit: 2,
      maxGoalFollowUps: 50,
      maxDialsPerDay: 40,
    });

    expect(copy.maxGoalFollowUps).toBe(MAX_GOAL_FOLLOW_UPS_CEILING);
    expect(copy.maxDialsPerDay).toBe(MAX_MAX_DIALS_PER_DAY);
  });

  it('keeps follow-up settings already inside the bounds', () => {
    const copy = clampCampaignConfig({
      ...flat,
      concurrencyLimit: 2,
      maxGoalFollowUps: 3,
      maxDialsPerDay: 1,
    });

    expect(copy.maxGoalFollowUps).toBe(3);
    expect(copy.maxDialsPerDay).toBe(1);
  });
});
