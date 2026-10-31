import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { leadActivity, leadOutcome, leadSpend } from '../src/services/leadAnalytics.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * Every figure of one payload narrows under every filter, or none of them do.
 *
 * **This file exists because the obvious test cannot see the bug.** The three
 * endpoints assemble one payload out of several reads: a Prisma predicate over
 * `CampaignContact`, raw SQL over `CallAttempt`, and a ledger aggregate. A
 * filter wired into one and not the others does not make two tabs disagree —
 * it makes two numbers *in the same card* disagree, one narrowed and one not,
 * with nothing on screen saying so.
 *
 * So every assertion here is deliberately aimed at a figure the SUSPECT read
 * produces — `avgTalkSecs`, `callerIds`, `weekly`, `totalSpend`, `timeline` —
 * and never at `connectedLeads`, which comes from the read that was never at
 * risk. A test that asserts the latter passes whether the filter is wired up
 * or not, which is how this shipped green the first time.
 *
 * The money case is the one that matters most: an unfiltered numerator over a
 * filtered denominator inflates a cost-per-lead without bound, and the tile
 * beside it is unfiltered too, so the row looks internally consistent.
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

/**
 * One campaign, one lead, one reached dial, one ledger charge.
 *
 * Every axis the filter bar can narrow on is a parameter, so a single call
 * produces a row that is either kept or dropped by exactly one filter.
 */
async function seedSlice(
  ctx: Ctx,
  opts: {
    campaignStatus: Campaign['status'];
    leadStatus: 'COMPLETED' | 'PENDING';
    leadCreatedAt: string;
    durationSecs: number;
    fromNumber: string;
    /** Internal credits. The ledger stores usage as a negative amount. */
    charge: bigint;
    startedAt?: string;
  },
) {
  counter += 1;

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ctx.workspace.id,
      name: `Slice ${counter}`,
      status: opts.campaignStatus,
    },
  });

  const contact = await prisma.contact.create({
    data: {
      workspaceId: ctx.workspace.id,
      phone: `+1415222${String(counter).padStart(4, '0')}`,
    },
  });

  const lead = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      attempts: 1,
      status: opts.leadStatus,
      createdAt: new Date(opts.leadCreatedAt),
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
      upstreamCallId: `fcons_att_${counter}`,
      status: 'COMPLETED',
      disposition: 'completed',
      durationSecs: opts.durationSecs,
      startedAt: new Date(opts.startedAt ?? '2026-08-10T12:00:00.000Z'),
      fromNumber: opts.fromNumber,
      costCredits: opts.charge,
    },
  });

  await prisma.creditTransaction.create({
    data: {
      accountId: ctx.account.id,
      workspaceId: ctx.workspace.id,
      callAttemptId: attempt.id,
      amount: -opts.charge,
      type: 'CALL_USAGE',
      reference: attempt.id,
    },
  });

  return { campaign, lead, attempt };
}

/**
 * Two slices that differ on every filterable axis at once.
 *
 * `keep` is selected by each filter below and `drop` is not, so one fixture
 * serves all four and every assertion reads the same expected numbers.
 */
async function twoSlices(handle: string) {
  const ctx = await seedWorkspace(handle);

  const keep = await seedSlice(ctx, {
    campaignStatus: 'RUNNING',
    leadStatus: 'COMPLETED',
    leadCreatedAt: '2026-07-01T00:00:00.000Z',
    durationSecs: 100,
    fromNumber: '+14152220001',
    charge: 10_000n,
  });

  const drop = await seedSlice(ctx, {
    campaignStatus: 'STOPPED',
    leadStatus: 'PENDING',
    leadCreatedAt: '2026-02-01T00:00:00.000Z',
    durationSecs: 300,
    fromNumber: '+14152220002',
    charge: 50_000n,
  });

  return { ctx, keep, drop };
}

/** What every narrowed payload below must say, on every read that feeds it. */
async function expectNarrowedToKeep(
  workspaceId: string,
  query: Parameters<typeof leadOutcome>[1],
) {
  const [outcome, activity, spend] = await Promise.all([
    leadOutcome(workspaceId, query),
    leadActivity(workspaceId, query),
    leadSpend(workspaceId, query),
  ]);

  // The read that was never at risk, asserted only so a failure here is
  // legible as "the filter did nothing at all" rather than as a wiring bug.
  expect(outcome.totals.attemptedLeads).toBe(1);
  expect(outcome.population).toBe(1);

  // The three figures `attemptScopeSql` produces. Unfiltered, the average
  // folds in the dropped slice's 300s call and reads 200.
  expect(activity.totals.avgTalkSecs).toBe(100);
  expect(activity.callerIds.map((row) => row.fromNumber)).toEqual(['+14152220001']);
  expect(activity.weekly.reduce((sum, cell) => sum + cell.attempted, 0)).toBe(1);

  // The two the ledger reads produce, and the ratio built from both halves.
  // Unfiltered, spend is 6 credits over a population of 1 — a cost-per-lead
  // six times the truth, under a total that looks consistent with it.
  expect(spend.totalSpend).toBe('1');
  expect(spend.costPerConnectedLead).toBe('1');
  expect(spend.timeline.reduce((sum, point) => sum + Number(point.credits), 0)).toBe(1);
}

beforeEach(async () => {
  await truncateAll();
});

describe('one filter bar, one population', () => {
  it('narrows every figure on campaign status', async () => {
    const { ctx } = await twoSlices('fconsstatus');

    await expectNarrowedToKeep(ctx.workspace.id, {
      range: RANGE,
      campaignStatuses: ['RUNNING'],
    });
  });

  it('narrows every figure on lead state', async () => {
    const { ctx } = await twoSlices('fconsstate');

    await expectNarrowedToKeep(ctx.workspace.id, {
      range: RANGE,
      leadStates: ['COMPLETED'],
    });
  });

  it('narrows every figure on the lead-created window', async () => {
    const { ctx } = await twoSlices('fconscreated');

    await expectNarrowedToKeep(ctx.workspace.id, {
      range: RANGE,
      leadCreatedFrom: new Date('2026-06-01T00:00:00.000Z'),
    });
  });

  it('narrows every figure on the named campaigns', async () => {
    const { ctx, keep } = await twoSlices('fconscampaign');

    await expectNarrowedToKeep(ctx.workspace.id, {
      range: RANGE,
      campaigns: [keep.campaign.id],
    });
  });

  it('leaves every figure wide when nothing is named', async () => {
    const { ctx } = await twoSlices('fconswide');
    const query = { range: RANGE };

    const [outcome, activity, spend] = await Promise.all([
      leadOutcome(ctx.workspace.id, query),
      leadActivity(ctx.workspace.id, query),
      leadSpend(ctx.workspace.id, query),
    ]);

    // The control. Without it a scope that narrowed to nothing would pass
    // every assertion above for the wrong reason.
    expect(outcome.totals.attemptedLeads).toBe(2);
    expect(activity.totals.avgTalkSecs).toBe(200);
    expect(activity.callerIds).toHaveLength(2);
    expect(spend.totalSpend).toBe('6');
    expect(spend.costPerConnectedLead).toBe('3');
  });
});
