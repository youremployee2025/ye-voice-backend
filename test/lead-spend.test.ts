import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { leadSpend } from '../src/services/leadAnalytics.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * What the leads cost.
 *
 * Two rules carry this file. Credits are summed from the **ledger**, never
 * from `CallAttempt.costCredits` — that column also records what was *owed*
 * on a shortfall, where nothing was debited, so summing it shows a workspace
 * spending credits it still holds. And a cost-per-lead with no leads is
 * null, not zero: zero is a price, and "nothing to divide by" is not one.
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

async function seedCampaign(ctx: Ctx, name: string): Promise<Campaign> {
  return prisma.campaign.create({ data: { workspaceId: ctx.workspace.id, name } });
}

/**
 * One lead, one dial, and optionally the ledger row that charged it.
 *
 * `charge` is in INTERNAL credits, the 10000x units the column holds, and the
 * ledger stores usage as a negative amount exactly as the dialer writes it.
 */
async function billedLead(
  ctx: Ctx,
  campaign: Campaign,
  opts: {
    charge?: bigint | null;
    shortfall?: boolean;
    disposition?: string;
    goalAchieved?: boolean | null;
    startedAt?: string;
  } = {},
) {
  counter += 1;

  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: `+1415888${String(counter).padStart(4, '0')}`,
    },
  });
  const lead = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      attempts: 1,
      status: 'COMPLETED',
      goalAchieved: opts.goalAchieved ?? null,
      lastAttemptAt: new Date('2026-08-10T11:59:00.000Z'),
    },
  });

  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: lead.id,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      attemptNo: 1,
      upstreamCallId: `spend_att_${counter}`,
      status: 'COMPLETED',
      disposition: opts.disposition ?? 'completed',
      durationSecs: 60,
      startedAt: new Date(opts.startedAt ?? '2026-08-10T12:00:00.000Z'),
      costCredits: opts.charge ?? null,
      shortfall: opts.shortfall ?? false,
    },
  });

  if (opts.charge !== undefined && opts.charge !== null) {
    await prisma.creditTransaction.create({
      data: {
        accountId: ctx.account.id,
        workspaceId: ctx.workspace.id,
        callAttemptId: attempt.id,
        // A shortfall writes a ZERO-amount marker of its own type: the cost
        // was real and the charge never happened.
        amount: opts.shortfall ? 0n : -opts.charge,
        type: opts.shortfall ? 'CALL_USAGE_SHORTFALL' : 'CALL_USAGE',
        reference: attempt.id,
      },
    });
  }

  return { lead, attempt };
}

beforeEach(async () => {
  await truncateAll();
});

describe('total spend', () => {
  it('sums the ledger, not the attempt column', async () => {
    const ctx = await seedWorkspace('spendtotal');
    const campaign = await seedCampaign(ctx, 'Spend');

    // 2.0000 and 3.0000 display credits, actually charged.
    await billedLead(ctx, campaign, { charge: 20_000n });
    await billedLead(ctx, campaign, { charge: 30_000n });
    // A call that completed against a balance too small to cover it. The
    // cost is on the attempt and nothing was debited — counting it reports
    // a workspace spending credits it still has.
    await billedLead(ctx, campaign, { charge: 90_000n, shortfall: true });

    const result = await leadSpend(ctx.workspace.id, { range: RANGE });

    expect(result.totalSpend).toBe('5');
  });

  it('reports null, never zero, when nothing was charged', async () => {
    const ctx = await seedWorkspace('spendnone');
    const campaign = await seedCampaign(ctx, 'Free');
    await billedLead(ctx, campaign, {});

    const result = await leadSpend(ctx.workspace.id, { range: RANGE });

    // A zero under a credits heading reads as "these calls were free".
    expect(result.totalSpend).toBeNull();
  });

  it('counts a charge by its call, not by when the ledger row landed', async () => {
    const ctx = await seedWorkspace('spendlate');
    const campaign = await seedCampaign(ctx, 'Late');

    const { attempt } = await billedLead(ctx, campaign, {
      charge: 10_000n,
      startedAt: '2026-08-31T23:50:00.000Z',
    });
    // The charge settles after midnight, outside the range. Scoping on the
    // ledger's own timestamp drops the last day's calls out of the money
    // column while leaving them in the call count beside it.
    await prisma.creditTransaction.update({
      where: { id: (await prisma.creditTransaction.findFirstOrThrow({
        where: { callAttemptId: attempt.id },
      })).id },
      data: { createdAt: new Date('2026-09-01T00:10:00.000Z') },
    });

    const result = await leadSpend(ctx.workspace.id, { range: RANGE });

    expect(result.totalSpend).toBe('1');
  });
});

describe('cost per lead', () => {
  it('divides by each denominator and nulls the ones with no leads', async () => {
    const ctx = await seedWorkspace('spendper');
    const campaign = await seedCampaign(ctx, 'Per');

    // Two reached leads, one of which met the goal. 4 credits spent total.
    await billedLead(ctx, campaign, { charge: 20_000n, goalAchieved: true });
    await billedLead(ctx, campaign, { charge: 20_000n, goalAchieved: false });

    const result = await leadSpend(ctx.workspace.id, { range: RANGE });

    expect(result.totalSpend).toBe('4');
    expect(result.costPerConnectedLead).toBe('2');
    expect(result.costPerGoalLead).toBe('4');
    // Nothing bucketed — this campaign has no leadBucketKey — so there is no
    // denominator, and a cost per interested lead does not exist. Zero would
    // claim those leads were free.
    expect(result.costPerInterestedLead).toBeNull();
  });

  it('nulls every per-lead cost when nothing was reached', async () => {
    const ctx = await seedWorkspace('spendnolead');
    const campaign = await seedCampaign(ctx, 'None');
    await billedLead(ctx, campaign, { charge: 20_000n, disposition: 'no_answer' });

    const result = await leadSpend(ctx.workspace.id, { range: RANGE });

    expect(result.totalSpend).toBe('2');
    expect(result.costPerConnectedLead).toBeNull();
    expect(result.costPerGoalLead).toBeNull();
    expect(result.costPerInterestedLead).toBeNull();
  });
});

describe('spend timeline', () => {
  it('is dense across the range, with a zero for a quiet day', async () => {
    const ctx = await seedWorkspace('spendline');
    const campaign = await seedCampaign(ctx, 'Line');

    await billedLead(ctx, campaign, { charge: 10_000n, startedAt: '2026-08-02T12:00:00.000Z' });
    await billedLead(ctx, campaign, { charge: 20_000n, startedAt: '2026-08-04T12:00:00.000Z' });

    const result = await leadSpend(ctx.workspace.id, {
      range: {
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-05T23:59:59.999Z'),
      },
    });

    // Dense, from the range rather than from the rows. A sparse series drawn
    // as a line connects across the gap and renders a quiet day as a slope.
    expect(result.timeline).toEqual([
      { date: '2026-08-01', credits: '0' },
      { date: '2026-08-02', credits: '1' },
      { date: '2026-08-03', credits: '0' },
      { date: '2026-08-04', credits: '2' },
      { date: '2026-08-05', credits: '0' },
    ]);
  });
});

describe('spend scope', () => {
  it('never counts another workspace’s charges', async () => {
    const mine = await seedWorkspace('spendmine');
    const theirs = await seedWorkspace('spendtheirs');
    const ours = await seedCampaign(mine, 'Ours');
    const yours = await seedCampaign(theirs, 'Yours');

    await billedLead(mine, ours, { charge: 10_000n });
    await billedLead(theirs, yours, { charge: 90_000n });

    const result = await leadSpend(mine.workspace.id, { range: RANGE });

    expect(result.totalSpend).toBe('1');
  });
});
