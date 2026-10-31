import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { leadActivity } from '../src/services/leadAnalytics.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The activity tab: how the dialling itself went.
 *
 * Two things here are easy to get subtly wrong and neither shows up as an
 * error — an average talk time that folds in dials nobody answered, and a
 * weekly pattern bucketed in UTC on a page whose whole point is what hour of
 * the local day people pick up.
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

async function seedLead(campaign: Campaign) {
  counter += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: `+1415666${String(counter).padStart(4, '0')}`,
    },
  });

  return prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      attempts: 1,
      status: 'COMPLETED',
      lastAttemptAt: new Date('2026-08-10T11:59:00.000Z'),
    },
  });
}

async function dial(
  ctx: Ctx,
  campaign: Campaign,
  campaignContactId: string,
  fields: {
    attemptNo?: number;
    disposition?: string | null;
    answeredBy?: string | null;
    durationSecs?: number | null;
    startedAt?: string;
    fromNumber?: string | null;
  } = {},
) {
  counter += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      attemptNo: fields.attemptNo ?? 1,
      upstreamCallId: `act_att_${counter}`,
      status: 'COMPLETED',
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      answeredBy: fields.answeredBy ?? null,
      durationSecs: fields.durationSecs === undefined ? 60 : fields.durationSecs,
      startedAt: new Date(fields.startedAt ?? '2026-08-10T12:00:00.000Z'),
      fromNumber: fields.fromNumber === undefined ? '+14155550001' : fields.fromNumber,
    },
  });
}

/** One lead, one dial, in one call. */
async function oneDial(
  ctx: Ctx,
  campaign: Campaign,
  fields: Parameters<typeof dial>[3] = {},
) {
  const lead = await seedLead(campaign);
  return dial(ctx, campaign, lead.id, fields);
}

beforeEach(async () => {
  await truncateAll();
});

describe('the caller-id table', () => {
  it('leaves out a dial the platform refused before it rang', async () => {
    const ctx = await seedWorkspace('actlaunch');
    const campaign = await seedCampaign(ctx, 'Rotation');

    await oneDial(ctx, campaign, { disposition: 'completed', fromNumber: '+14155550001' });

    // A launch the platform refused writes an attempt row with the DID
    // already stamped and no disposition — no telephone ever rang. Counted in
    // `attempted` and in none of the three outcome columns, it dragged
    // `connectivity` down for whichever number happened to be next in the
    // rotation, which is a wrong ACTION and not merely a wrong number: the
    // table exists to prompt a rotation change.
    const lead = await seedLead(campaign);
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: lead.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        upstreamCallId: `act_refused_${Date.now()}`,
        status: 'FAILED',
        disposition: null,
        durationSecs: null,
        startedAt: new Date('2026-08-10T12:00:00.000Z'),
        fromNumber: '+14155550001',
        launchError: 'UPSTREAM_ERROR',
      },
    });

    const result = await leadActivity(ctx.workspace.id, { range: RANGE });

    expect(result.callerIds).toHaveLength(1);
    expect(result.callerIds[0]).toMatchObject({
      fromNumber: '+14155550001',
      attempted: 1,
      connected: 1,
      connectivity: 1,
    });
  });
});

describe('average talk time', () => {
  it('averages over reached attempts only', async () => {
    const ctx = await seedWorkspace('acttalk');
    const campaign = await seedCampaign(ctx, 'Talk');

    await oneDial(ctx, campaign, { disposition: 'completed', durationSecs: 100 });
    await oneDial(ctx, campaign, { disposition: 'completed', durationSecs: 200 });
    // Three dials nobody picked up. They ran for zero seconds and are not
    // short conversations — folding them in drags the average toward zero
    // and reports a campaign that talks for two minutes as talking for one.
    await oneDial(ctx, campaign, { disposition: 'no_answer', durationSecs: 0 });
    await oneDial(ctx, campaign, { disposition: 'busy', durationSecs: 0 });
    await oneDial(ctx, campaign, { disposition: 'failed', durationSecs: 0 });

    const result = await leadActivity(ctx.workspace.id, { range: RANGE });

    expect(result.totals.avgTalkSecs).toBe(150);
  });

  it('reports null, never zero, when nothing was reached', async () => {
    const ctx = await seedWorkspace('acttalkempty');
    const campaign = await seedCampaign(ctx, 'Quiet');
    await oneDial(ctx, campaign, { disposition: 'no_answer', durationSecs: 0 });

    const result = await leadActivity(ctx.workspace.id, { range: RANGE });

    // Zero seconds is a measurement — every call ran and none lasted. No
    // conversation to measure is the absence of one.
    expect(result.totals.avgTalkSecs).toBeNull();
  });
});

describe('caller id activity', () => {
  it('groups dials by the number they went out on', async () => {
    const ctx = await seedWorkspace('actcaller');
    const campaign = await seedCampaign(ctx, 'Caller');

    await oneDial(ctx, campaign, { fromNumber: '+14155550001', disposition: 'completed' });
    await oneDial(ctx, campaign, { fromNumber: '+14155550001', disposition: 'no_answer' });
    await oneDial(ctx, campaign, { fromNumber: '+14155550002', disposition: 'completed' });
    await oneDial(ctx, campaign, { fromNumber: '+14155550002', disposition: 'completed' });

    const result = await leadActivity(ctx.workspace.id, { range: RANGE });

    // Ordered by connectivity descending: the question this table answers is
    // which of my numbers is still getting picked up.
    expect(result.callerIds).toEqual([
      {
        fromNumber: '+14155550002',
        attempted: 2,
        connected: 2,
        noAnswer: 0,
        failed: 0,
        connectivity: 1,
      },
      {
        fromNumber: '+14155550001',
        attempted: 2,
        connected: 1,
        noAnswer: 1,
        failed: 0,
        connectivity: 0.5,
      },
    ]);
  });

  it('keeps dials with no recorded caller id under one unknown row', async () => {
    const ctx = await seedWorkspace('actcallernull');
    const campaign = await seedCampaign(ctx, 'Null');

    await oneDial(ctx, campaign, { fromNumber: null, disposition: 'completed' });
    await oneDial(ctx, campaign, { fromNumber: null, disposition: 'no_answer' });

    const result = await leadActivity(ctx.workspace.id, { range: RANGE });

    // `fromNumber` is nullable and every attempt before the rotation shipped
    // carries null. Dropping them would make the table's dials disagree with
    // the tile above it, with nothing saying why.
    expect(result.callerIds).toHaveLength(1);
    expect(result.callerIds[0]).toMatchObject({ fromNumber: null, attempted: 2, connected: 1 });
  });
});

describe('weekly pattern', () => {
  it('buckets by the local hour, not the UTC one', async () => {
    const ctx = await seedWorkspace('actweekly');
    const campaign = await seedCampaign(ctx, 'Weekly');

    // 2026-08-10 is a Monday. 23:30 UTC is 19:30 on Monday in New York, and
    // 05:00 on TUESDAY in Kolkata — so the same instant lands in a different
    // day AND hour depending on the zone. A page bucketing in UTC tells an
    // operator to call at an hour nobody is awake for.
    await oneDial(ctx, campaign, {
      startedAt: '2026-08-10T23:30:00.000Z',
      disposition: 'completed',
    });

    const ny = await leadActivity(ctx.workspace.id, {
      range: RANGE,
      timeZone: 'America/New_York',
    });
    const kolkata = await leadActivity(ctx.workspace.id, {
      range: RANGE,
      timeZone: 'Asia/Kolkata',
    });

    expect(ny.timeZone).toBe('America/New_York');
    expect(ny.weekly).toEqual([
      { weekday: 1, hour: 19, attempted: 1, connected: 1 },
    ]);
    expect(kolkata.weekly).toEqual([
      { weekday: 2, hour: 5, attempted: 1, connected: 1 },
    ]);
  });

  it('defaults to UTC and says so', async () => {
    const ctx = await seedWorkspace('actweeklyutc');
    const campaign = await seedCampaign(ctx, 'Utc');
    await oneDial(ctx, campaign, {
      startedAt: '2026-08-10T23:30:00.000Z',
      disposition: 'completed',
    });

    const result = await leadActivity(ctx.workspace.id, { range: RANGE });

    // Emitted rather than assumed, the rule the overview's `timezone` keeps.
    expect(result.timeZone).toBe('UTC');
    expect(result.weekly).toEqual([{ weekday: 1, hour: 23, attempted: 1, connected: 1 }]);
  });

  it('refuses a timezone the database cannot resolve', async () => {
    const ctx = await seedWorkspace('actweeklybad');

    // Fail loudly rather than silently falling back to UTC: a heatmap
    // labelled with a zone it was not computed in is worse than an error.
    await expect(
      leadActivity(ctx.workspace.id, { range: RANGE, timeZone: 'Mars/Olympus' }),
    ).rejects.toThrow();
  });
});

describe('activity scope', () => {
  it('counts only this workspace', async () => {
    const mine = await seedWorkspace('actmine');
    const theirs = await seedWorkspace('acttheirs');
    const ours = await seedCampaign(mine, 'Ours');
    const yours = await seedCampaign(theirs, 'Yours');

    await oneDial(mine, ours, { disposition: 'completed' });
    await oneDial(theirs, yours, { disposition: 'completed' });

    const result = await leadActivity(mine.workspace.id, { range: RANGE });

    expect(result.totals.attemptedLeads).toBe(1);
    expect(result.callerIds).toHaveLength(1);
  });
});

describe('time zones the database and the browser disagree about', () => {
  /*
    The bug this block exists for, found by opening the page rather than by
    any test: a browser in India reports `Asia/Calcutta`, the legacy alias.
    `Intl` accepts it — so a validator built on `Intl` passes it — and
    Postgres does not know it at all, so the statement threw and the tab 500d
    for every reader in YE's largest market.

    Canonicalising through `Intl` cannot fix it either, because `Intl` maps
    the pair the OTHER way: `Asia/Kolkata` resolves to `Asia/Calcutta`. The
    two libraries disagree about which name is primary, so the database's own
    catalogue has to be the authority.
  */
  it('accepts a legacy alias the database does not carry', async () => {
    const ctx = await seedWorkspace('actalias');
    const campaign = await seedCampaign(ctx, 'Alias');
    await oneDial(ctx, campaign, {
      startedAt: '2026-08-10T23:30:00.000Z',
      disposition: 'completed',
    });

    const result = await leadActivity(ctx.workspace.id, {
      range: RANGE,
      timeZone: 'Asia/Calcutta',
    });

    // Resolved to the name Postgres knows, and the payload reports the zone
    // actually used rather than the one asked for — a heatmap labelled with
    // a zone it was not computed in is the failure the label exists to stop.
    expect(result.timeZone).toBe('Asia/Kolkata');
    expect(result.weekly).toEqual([{ weekday: 2, hour: 5, attempted: 1, connected: 1 }]);
  });

  it('accepts a legacy US alias the same way', async () => {
    const ctx = await seedWorkspace('actaliasus');
    const campaign = await seedCampaign(ctx, 'AliasUS');
    await oneDial(ctx, campaign, {
      startedAt: '2026-08-10T23:30:00.000Z',
      disposition: 'completed',
    });

    const result = await leadActivity(ctx.workspace.id, {
      range: RANGE,
      timeZone: 'US/Eastern',
    });

    expect(result.timeZone).toBe('America/New_York');
    expect(result.weekly).toEqual([{ weekday: 1, hour: 19, attempted: 1, connected: 1 }]);
  });

  it('still refuses a zone that is not a zone', async () => {
    const ctx = await seedWorkspace('actaliasbad');

    await expect(
      leadActivity(ctx.workspace.id, { range: RANGE, timeZone: 'Mars/Olympus' }),
    ).rejects.toThrow();
  });
});
