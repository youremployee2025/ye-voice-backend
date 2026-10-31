import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, CampaignType, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { leadActivity, leadOutcome, leadSpend } from '../src/services/leadAnalytics.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The calls this workspace ANSWERED, on a page that counts leads.
 *
 * The lead surface was cut from a `main` that predated inbound campaigns, so
 * it read `CampaignContact` and `CallAttempt` and nothing else. An answered
 * inbound call writes no `CallAttempt` row — it lives in `CampaignInboundCall`
 * with its own contact pointer, duration and charge — so every inbound
 * campaign reported `attemptedLeads: 0` and contributed nothing to spend, on
 * the page that replaced the one showing it.
 *
 * The convention here is `services/analytics.ts`', deliberately, so the two
 * surfaces cannot come to disagree: **a received call is not a dial.** It is
 * never folded into `attemptedLeads` or `connectedLeads`, because
 * `connectivity` would then be dials-that-connected over dials-plus-calls-that-
 * arrived-already-connected — a fraction over two populations, with no
 * question attached to it. Money is the one thing that does add: a credit
 * spent is a credit spent whichever way the phone rang.
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

async function seedCampaign(ctx: Ctx, name: string, type: CampaignType): Promise<Campaign> {
  return prisma.campaign.create({
    data: { workspaceId: ctx.workspace.id, name, type },
  });
}

/** A caller the workspace has on its list, who rang in. */
async function seedKnownCaller(
  ctx: Ctx,
  campaign: Campaign,
  opts: { durationSecs: number; charge?: bigint; arrivedAt?: string },
) {
  counter += 1;
  const phone = `+1415333${String(counter).padStart(4, '0')}`;

  const contact = await prisma.contact.create({
    data: { workspaceId: ctx.workspace.id, phone },
  });
  const lead = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: 'COMPLETED',
      goalAchieved: true,
    },
  });

  return seedInboundCall(ctx, campaign, { ...opts, phone, campaignContactId: lead.id });
}

async function seedInboundCall(
  ctx: Ctx,
  campaign: Campaign,
  opts: {
    durationSecs: number;
    charge?: bigint;
    arrivedAt?: string;
    phone?: string;
    campaignContactId?: string;
  },
) {
  counter += 1;

  const call = await prisma.campaignInboundCall.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: opts.campaignContactId ?? null,
      workspaceId: ctx.workspace.id,
      phoneNumberId: `pn_inb_${counter}`,
      fromNumber: opts.phone ?? `+1415444${String(counter).padStart(4, '0')}`,
      upstreamCallId: `inb_${counter}`,
      arrivedAt: new Date(opts.arrivedAt ?? '2026-08-12T10:00:00.000Z'),
      endedAt: new Date('2026-08-12T10:05:00.000Z'),
      durationSecs: opts.durationSecs,
      disposition: 'completed',
      costCredits: opts.charge ?? null,
    },
  });

  if (opts.charge !== undefined) {
    await prisma.creditTransaction.create({
      data: {
        accountId: ctx.account.id,
        workspaceId: ctx.workspace.id,
        // An inbound charge carries `reference`, never `callAttemptId` — the
        // row it is about is not an attempt. A ledger read grouped on the
        // attempt cannot see it however it is scoped, which is why the credits
        // column read null on every inbound campaign.
        reference: call.id,
        amount: -opts.charge,
        type: 'CALL_USAGE',
      },
    });
  }

  return call;
}

beforeEach(async () => {
  await truncateAll();
});

describe('a campaign that answers calls', () => {
  it('counts what it answered, without folding it into the dials', async () => {
    const ctx = await seedWorkspace('inbcount');
    const campaign = await seedCampaign(ctx, 'Support', 'INBOUND');

    await seedKnownCaller(ctx, campaign, { durationSecs: 120 });
    await seedInboundCall(ctx, campaign, { durationSecs: 60 });

    const outcome = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(outcome.inbound).toEqual({
      calls: 2,
      callers: 2,
      unknownCalls: 1,
      talkSecs: 180,
    });

    // A received call is not a dial. Folding it in would make `connectivity`
    // a fraction over two different populations.
    expect(outcome.totals.attemptedLeads).toBe(0);
    expect(outcome.totals.connectedLeads).toBe(0);
    expect(outcome.totals.connectivity).toBeNull();
  });

  it('is absent, never zeroed, on a workspace that only dials', async () => {
    const ctx = await seedWorkspace('inbabsent');
    await seedCampaign(ctx, 'Outreach', 'OUTBOUND');

    const outcome = await leadOutcome(ctx.workspace.id, { range: RANGE });

    // Zero would assert that a workspace which answers calls took none.
    expect(outcome.inbound).toBeUndefined();
  });

  it('reports zero on an inbound campaign that took no calls', async () => {
    const ctx = await seedWorkspace('inbzero');
    await seedCampaign(ctx, 'Quiet line', 'INBOUND');

    const outcome = await leadOutcome(ctx.workspace.id, { range: RANGE });

    // Present and zero: the campaign answers calls and took none, which is a
    // true count rather than an absence.
    expect(outcome.inbound?.calls).toBe(0);
  });

  it('averages talk time over the calls that have a duration', async () => {
    const ctx = await seedWorkspace('inbtalk');
    const campaign = await seedCampaign(ctx, 'Support', 'BOTH');

    await seedInboundCall(ctx, campaign, { durationSecs: 100 });
    await seedInboundCall(ctx, campaign, { durationSecs: 200 });

    const activity = await leadActivity(ctx.workspace.id, { range: RANGE });

    expect(activity.inbound?.avgTalkSecs).toBe(150);
  });

  it('narrows with the filter bar like every other figure', async () => {
    const ctx = await seedWorkspace('inbfilter');
    const keep = await seedCampaign(ctx, 'Kept', 'INBOUND');
    const drop = await seedCampaign(ctx, 'Dropped', 'INBOUND');
    await prisma.campaign.update({ where: { id: drop.id }, data: { status: 'STOPPED' } });

    await seedInboundCall(ctx, keep, { durationSecs: 60 });
    await seedInboundCall(ctx, drop, { durationSecs: 60 });

    const outcome = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      campaignStatuses: ['DRAFT'],
    });

    expect(outcome.inbound?.calls).toBe(1);
  });

  it('leaves a call outside the window out of it', async () => {
    const ctx = await seedWorkspace('inbwindow');
    const campaign = await seedCampaign(ctx, 'Support', 'INBOUND');

    await seedInboundCall(ctx, campaign, { durationSecs: 60 });
    await seedInboundCall(ctx, campaign, {
      durationSecs: 60,
      arrivedAt: '2026-07-01T10:00:00.000Z',
    });

    // On `arrivedAt` — when the phone rang — never `endedAt`, so a call that
    // arrives at 23:58 and hangs up after midnight belongs to the first day.
    const outcome = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(outcome.inbound?.calls).toBe(1);
  });
});

describe('what the answered calls cost', () => {
  it('adds the inbound half to the total, and names both halves', async () => {
    const ctx = await seedWorkspace('inbspend');
    const campaign = await seedCampaign(ctx, 'Support', 'INBOUND');

    await seedInboundCall(ctx, campaign, { durationSecs: 60, charge: 20_000n });
    await seedInboundCall(ctx, campaign, { durationSecs: 60, charge: 10_000n });

    const spend = await leadSpend(ctx.workspace.id, { range: RANGE });

    // The inbound charge carries `reference`, not `callAttemptId`, so the
    // attempt-joined read cannot see it however it is scoped.
    expect(spend.inboundSpend).toBe('3');
    expect(spend.outboundSpend).toBeNull();
    expect(spend.totalSpend).toBe('3');
  });

  it('reports nothing charged as null, not zero', async () => {
    const ctx = await seedWorkspace('inbspendnull');
    const campaign = await seedCampaign(ctx, 'Support', 'INBOUND');
    await seedInboundCall(ctx, campaign, { durationSecs: 60 });

    const spend = await leadSpend(ctx.workspace.id, { range: RANGE });

    expect(spend.inboundSpend).toBeNull();
    expect(spend.totalSpend).toBeNull();
  });
});
