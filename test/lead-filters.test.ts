import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { leadOutcome } from '../src/services/leadAnalytics.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The four filters beyond the campaign picker and the window.
 *
 * Each exists because the reference product's filter bar has it. Each is
 * here rather than in the UI alone because a control that narrows nothing is
 * worse than a control that is absent — the reader trusts it and reads the
 * unnarrowed figure as the narrowed one.
 */

const RANGE = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-31T23:59:59.999Z'),
};

let counter = 0;

interface Ctx {
  account: Account;
  workspace: Workspace;
}

async function seedWorkspace(handle: string): Promise<Ctx> {
  const account = await makeAccount(handle);
  return { account, workspace: await makeWorkspace(account, handle) };
}

async function seedCampaign(ctx: Ctx, name: string, status = 'RUNNING'): Promise<Campaign> {
  return prisma.campaign.create({
    data: { workspaceId: ctx.workspace.id, name, status: status as never },
  });
}

async function reached(
  ctx: Ctx,
  campaign: Campaign,
  opts: { status?: string; createdAt?: string } = {},
) {
  counter += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: `+1415999${String(counter).padStart(4, '0')}`,
    },
  });
  const lead = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      attempts: 1,
      status: (opts.status ?? 'COMPLETED') as never,
      lastAttemptAt: new Date('2026-08-10T11:59:00.000Z'),
      ...(opts.createdAt ? { createdAt: new Date(opts.createdAt) } : {}),
    },
  });

  await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: lead.id,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      attemptNo: 1,
      upstreamCallId: `filt_${counter}`,
      status: 'COMPLETED',
      disposition: 'completed',
      durationSecs: 60,
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
    },
  });

  return lead;
}

beforeEach(async () => {
  await truncateAll();
});

describe('campaign status filter', () => {
  it('narrows to campaigns in the named statuses', async () => {
    const ctx = await seedWorkspace('filtcampstatus');
    const running = await seedCampaign(ctx, 'Running', 'RUNNING');
    const stopped = await seedCampaign(ctx, 'Stopped', 'STOPPED');
    await reached(ctx, running);
    await reached(ctx, stopped);

    const all = await leadOutcome(ctx.workspace.id, { range: RANGE });
    const live = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      campaignStatuses: ['RUNNING'],
    });

    expect(all.population).toBe(2);
    expect(live.population).toBe(1);
  });
});

describe('lead state filter', () => {
  it('narrows to leads in the named states', async () => {
    const ctx = await seedWorkspace('filtleadstate');
    const campaign = await seedCampaign(ctx, 'One');
    await reached(ctx, campaign, { status: 'COMPLETED' });
    await reached(ctx, campaign, { status: 'FAILED' });
    await reached(ctx, campaign, { status: 'PENDING' });

    const done = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      leadStates: ['COMPLETED'],
    });

    expect(done.population).toBe(1);
    expect(done.leadState).toEqual({ completed: 1, active: 0 });
  });
});

describe('lead created window', () => {
  it('narrows on when the lead entered, not when it was called', async () => {
    const ctx = await seedWorkspace('filtcreated');
    const campaign = await seedCampaign(ctx, 'One');

    // Both were CALLED in August. They entered the campaign months apart, so
    // this window is a different question from the interaction window and
    // has to be able to disagree with it.
    await reached(ctx, campaign, { createdAt: '2026-03-01T00:00:00.000Z' });
    await reached(ctx, campaign, { createdAt: '2026-08-05T00:00:00.000Z' });

    const everything = await leadOutcome(ctx.workspace.id, { range: RANGE });
    const recent = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      leadCreatedFrom: new Date('2026-08-01T00:00:00.000Z'),
    });
    const old = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      leadCreatedUntil: new Date('2026-04-01T00:00:00.000Z'),
    });

    expect(everything.population).toBe(2);
    expect(recent.population).toBe(1);
    expect(old.population).toBe(1);
  });
});

describe('filters compose', () => {
  it('ANDs every filter rather than letting one win', async () => {
    const ctx = await seedWorkspace('filtcompose');
    const running = await seedCampaign(ctx, 'Running', 'RUNNING');
    const stopped = await seedCampaign(ctx, 'Stopped', 'STOPPED');

    await reached(ctx, running, { status: 'COMPLETED', createdAt: '2026-08-05T00:00:00.000Z' });
    await reached(ctx, running, { status: 'PENDING', createdAt: '2026-08-05T00:00:00.000Z' });
    await reached(ctx, stopped, { status: 'COMPLETED', createdAt: '2026-08-05T00:00:00.000Z' });
    await reached(ctx, running, { status: 'COMPLETED', createdAt: '2026-03-05T00:00:00.000Z' });

    const narrowed = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      campaignStatuses: ['RUNNING'],
      leadStates: ['COMPLETED'],
      leadCreatedFrom: new Date('2026-08-01T00:00:00.000Z'),
    });

    // Exactly the one row satisfying all three. A filter set where the last
    // one applied wins would give 2, 3 or 4 here depending on order.
    expect(narrowed.population).toBe(1);
  });
});

describe('every ring on the card honours every filter', () => {
  it('narrows the interest ring by lead state, like the rings beside it', async () => {
    const ctx = await seedWorkspace('filtinterest');
    const campaign = await prisma.campaign.create({
      data: {
        workspaceId: ctx.workspace.id,
        name: 'Bucketing',
        status: 'RUNNING',
        leadBucketKey: 'interest_level',
      },
    });

    const settled = await reached(ctx, campaign, { status: 'COMPLETED' });
    const live = await reached(ctx, campaign, { status: 'PENDING' });

    for (const [lead, value] of [
      [settled, 'hot'],
      [live, 'cold'],
    ] as const) {
      await prisma.callAttempt.updateMany({
        where: { campaignContactId: lead.id },
        data: { extraction: { interest_level: value } },
      });
    }

    const narrowed = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      leadStates: ['COMPLETED'],
    });

    // The three rings on the Outcome tab are drawn over one population and
    // the card prints one denominator. An interest ring that ignored the
    // lead-state filter would sit beside a qualification ring half its size
    // under a single heading, with nothing saying they disagree.
    expect(narrowed.population).toBe(1);
    expect(narrowed.interest.bucketed).toBe(1);
    expect(narrowed.interest.buckets).toEqual([{ name: 'hot', count: 1 }]);
  });
});
