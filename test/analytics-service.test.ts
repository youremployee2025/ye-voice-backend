import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { REACHED_DISPOSITIONS } from '../src/lib/campaignOutcomes.js';
import { campaignAnalytics, workspaceOverview } from '../src/services/analytics.js';
import {
  ALL_TIME,
  inboundCredits,
  inboundOutcomeBreakdown,
  inboundRepeatCallers,
  inboundSeries,
} from '../src/lib/campaignInboundStats.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The aggregates, over both sources.
 *
 * Everything here runs in SQL. Nothing loads a workspace's calls into Node to
 * count them, and nothing calls the voice platform.
 *
 * **The split under test.** `CallAttempt` is the dialer's record of campaign
 * calls; `CallRecord` is the ingest's record of everything else on the shared
 * account. The overview reads both — reading only the first would make it
 * silently campaign-only — and a campaign report reads only the first, because
 * the ingest never stores a campaign call.
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
 * An inbound-facing campaign and one call it received.
 *
 * `CampaignInboundCall`, never `CallAttempt`: an attempt row exists only for a
 * call the dialer PLACED, and `attemptNo` is the dial mutual-exclusion token.
 * The schema comment on the model says why at length. Nothing in these fixtures
 * may write an inbound call into the attempts table.
 */
async function seedInboundCampaign(
  ctx: Ctx,
  name: string,
  type: 'INBOUND' | 'BOTH' = 'INBOUND',
): Promise<Campaign> {
  return prisma.campaign.create({ data: { workspaceId: ctx.workspace.id, name, type } });
}

async function seedInboundCall(
  ctx: Ctx,
  campaign: Campaign,
  fields: {
    arrivedAt: Date;
    endedAt?: Date | null;
    durationSecs?: number | null;
    fromNumber?: string;
    disposition?: string | null;
    extraction?: object | null;
    costCredits?: bigint | null;
  },
) {
  counter += 1;
  const did =
    (await prisma.phoneNumber.findFirst({ where: { workspaceId: campaign.workspaceId } })) ??
    (await prisma.phoneNumber.create({
      data: {
        did: `+9194${String(counter).padStart(8, '0')}`,
        workspaceId: campaign.workspaceId,
        status: 'ASSIGNED',
      },
    }));

  return prisma.campaignInboundCall.create({
    data: {
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      phoneNumberId: did.id,
      fromNumber: fields.fromNumber ?? `+9198765${String(counter).padStart(5, '0')}`,
      arrivedAt: fields.arrivedAt,
      endedAt: fields.endedAt === undefined ? fields.arrivedAt : fields.endedAt,
      durationSecs: fields.durationSecs === undefined ? 60 : fields.durationSecs,
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      extraction: fields.extraction ?? undefined,
      costCredits: fields.costCredits ?? null,
    },
  });
}

/** What the LEDGER says was taken — the only evidence of spend. */
async function seedCallUsage(ctx: Ctx, inboundCallId: string, amount: bigint) {
  return prisma.creditTransaction.create({
    data: {
      accountId: ctx.account.id,
      workspaceId: ctx.workspace.id,
      reference: inboundCallId,
      amount: -amount,
      type: 'CALL_USAGE',
    },
  });
}

/** A campaign contact, with the attempt count the dialer would have left. */
async function seedContact(
  campaign: Campaign,
  attempts = 0,
  status = 'PENDING',
  /** The other two dial counters, for the contacts `attempts` alone cannot
   *  describe — a booked callback and a goal follow-up both move a different
   *  one and leave this at zero. */
  counters: {
    callbackCount?: number;
    followUpCount?: number;
    /** Why this contact's clock is set — what its NEXT dial will be. Only
     *  meaningful while it waits, which is exactly when the ladder reads it. */
    armKind?: 'FRESH' | 'RETRY' | 'FOLLOW_UP' | 'RESUME' | 'CALLBACK';
  } = {},
) {
  counter += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: `+1415555${String(counter).padStart(4, '0')}`,
    },
  });

  /**
   * `lastAttemptAt` is derived rather than passed, because the dialer does not
   * leave a choice about it: the claim stamps it in the **same `UPDATE`** that
   * flips a contact `PENDING → QUEUED` (`dialerClaim.ts`), and nothing ever
   * clears it. So a fixture carrying a spent counter, or a status only a
   * resolution can write, and a null `lastAttemptAt` beside it is a row no
   * dial could have produced — and a funnel tested against impossible rows is
   * a funnel tested against nothing.
   */
  const dialed =
    attempts > 0 ||
    (counters.callbackCount ?? 0) > 0 ||
    (counters.followUpCount ?? 0) > 0 ||
    status === 'COMPLETED' ||
    status === 'FAILED';

  return prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      attempts,
      status: status as never,
      callbackCount: counters.callbackCount ?? 0,
      followUpCount: counters.followUpCount ?? 0,
      armKind: (counters.armKind ?? 'FRESH') as never,
      lastAttemptAt: dialed ? new Date('2026-08-10T11:59:00.000Z') : null,
    },
  });
}

/** One dial the dialer placed — a CAMPAIGN call. */
async function attempt(
  ctx: Ctx,
  campaign: Campaign,
  fields: {
    startedAt?: string;
    disposition?: string | null;
    upstreamStatus?: string | null;
    status?: string;
    durationSecs?: number | null;
    answeredBy?: string | null;
  } = {},
) {
  counter += 1;
  const link = await seedContact(campaign, 1);

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      attemptNo: 1,
      upstreamCallId: `att_${counter}`,
      status: (fields.status ?? 'COMPLETED') as never,
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      upstreamStatus: fields.upstreamStatus ?? null,
      startedAt: new Date(fields.startedAt ?? '2026-08-10T12:00:00.000Z'),
      durationSecs: fields.durationSecs === undefined ? 60 : fields.durationSecs,
      answeredBy: fields.answeredBy ?? null,
    },
  });
}

/**
 * One dial on a contact that ALREADY EXISTS.
 *
 * `attempt()` seeds a contact of its own per call, which is the right shape for
 * the funnel's call counts and the wrong one for every claim about a contact's
 * history — a lead that was rung four times is four contacts to it. Reaching
 * somebody is now a fact about the attempts a contact accumulated, so the
 * fixtures need the shape where several dials hang off one lead.
 */
async function dial(
  ctx: Ctx,
  campaign: Campaign,
  contactId: string,
  fields: { disposition?: string | null; durationSecs?: number | null; answeredBy?: string | null } = {},
) {
  counter += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: contactId,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      // Unique per contact by construction — the schema holds
      // `@@unique([campaignContactId, attemptNo])`, and a fixture that reused
      // a number would fail the insert rather than the assertion.
      attemptNo: counter,
      upstreamCallId: `dial_${counter}`,
      status: 'COMPLETED' as never,
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
      durationSecs: fields.durationSecs === undefined ? 60 : fields.durationSecs,
      answeredBy: fields.answeredBy ?? null,
    },
  });
}

/**
 * The platform has said Q.850 cause 16 will map to `no_answer`. Real
 * conversations end with cause 16, so unless that mapping is gated on the
 * call having connected, answered calls arrive labelled as silences. Every
 * read surface below therefore trusts the platform's answer detection over a
 * never-connected label: a human on the line is a connection.
 */
describe('a human on the line beats a never-connected label', () => {
  it('counts a mislabelled conversation as connected in the overview totals', async () => {
    const ctx = await seedWorkspace('mislabelled-overview');
    const campaign = await seedCampaign(ctx, 'Cause 16');

    await attempt(ctx, campaign, { disposition: 'no_answer', answeredBy: 'human' });
    await attempt(ctx, campaign, { disposition: 'no_answer', answeredBy: 'not_answered' });

    const overview = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(overview.totals.connected).toBe(1);
    expect(overview.outcomes.find((o) => o.outcome === 'answered')?.count).toBe(1);
    expect(overview.outcomes.find((o) => o.outcome === 'no_answer')?.count).toBe(1);
    // The daily series is classified off the same evidence.
    expect(overview.series.reduce((sum, day) => sum + day.connected, 0)).toBe(1);
    expect(overview.campaigns[0]?.connected).toBe(1);
  });

  it('counts a mislabelled conversation as reached on the campaign report', async () => {
    const ctx = await seedWorkspace('mislabelled-reached');
    const campaign = await seedCampaign(ctx, 'Cause 16');

    const spoke = await seedContact(campaign, 1);
    const silent = await seedContact(campaign, 1);
    await dial(ctx, campaign, spoke.id, { disposition: 'no_answer', answeredBy: 'human' });
    await dial(ctx, campaign, silent.id, { disposition: 'no_answer', answeredBy: 'not_answered' });

    const report = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(report.lifetime.reached).toBe(1);
    expect(report.funnel.connected).toBe(1);
    expect(report.series.reduce((sum, day) => sum + day.connected, 0)).toBe(1);
  });
});

/** One NON-campaign call, as the ingest stores it. */
async function record(fields: {
  workspaceId?: string | null;
  startedAt?: string;
  disposition?: string | null;
  status?: string | null;
  durationSecs?: number | null;
}) {
  counter += 1;

  return prisma.callRecord.create({
    data: {
      upstreamCallId: `rec_${counter}`,
      workspaceId: fields.workspaceId ?? null,
      status: fields.status ?? 'completed',
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      startedAt: new Date(fields.startedAt ?? '2026-08-10T12:00:00.000Z'),
      durationSecs: fields.durationSecs === undefined ? 60 : fields.durationSecs,
    },
  });
}

/** A CALL_USAGE ledger row — what the workspace was actually charged. */
async function charge(ctx: Ctx, attemptId: string, internalUnits: bigint) {
  return prisma.creditTransaction.create({
    data: {
      accountId: ctx.account.id,
      workspaceId: ctx.workspace.id,
      callAttemptId: attemptId,
      // Signed: a charge is negative.
      amount: -internalUnits,
      type: 'CALL_USAGE',
    },
  });
}

beforeEach(truncateAll);

describe('workspaceOverview totals', () => {
  it('counts both sources, and nobody else’s calls', async () => {
    const mine = await seedWorkspace('mine');
    const theirs = await seedWorkspace('theirs');
    const campaign = await seedCampaign(mine, 'Mine');
    const theirCampaign = await seedCampaign(theirs, 'Theirs');

    await attempt(mine, campaign);
    await record({ workspaceId: mine.workspace.id });
    await attempt(theirs, theirCampaign);
    await record({ workspaceId: theirs.workspace.id });
    // Quarantined — attributed to nobody, so counted by nobody.
    await record({ workspaceId: null });

    const overview = await workspaceOverview(mine.workspace.id, RANGE);

    expect(overview.totals.calls).toBe(2);
    // Named separately, because the two halves have different freshness.
    expect(overview.sources).toEqual({ campaignCalls: 1, otherCalls: 1 });
  });

  it('reports connected as a count and the rate as its fraction', async () => {
    const ctx = await seedWorkspace('rate');
    const campaign = await seedCampaign(ctx, 'Rate');

    await attempt(ctx, campaign, { disposition: 'completed' });
    await attempt(ctx, campaign, { disposition: 'voicemail' });
    await attempt(ctx, campaign, { disposition: 'no_answer' });
    await attempt(ctx, campaign, { disposition: 'busy' });

    const { totals } = await workspaceOverview(ctx.workspace.id, RANGE);

    // Connected is answered + voicemail: the call reached the far end.
    expect(totals.connected).toBe(2);
    expect(totals.calls).toBe(4);
    expect(totals.answerRate).toBe(0.5);
  });

  it('reports no rate at all when no calls were placed', async () => {
    // `0%` asserts that calls were placed and none connected, which is a
    // different and false claim.
    const ctx = await seedWorkspace('norate');

    const { totals } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(totals.calls).toBe(0);
    expect(totals.answerRate).toBeNull();
  });

  it('counts the calls whose outcome it could not read', async () => {
    // These sit in the rate's denominator. A page printing "50% answered" over
    // a set that is a third unreadable overstates how much it knows, and only
    // this number lets the reader see that.
    const ctx = await seedWorkspace('unresolved');
    const campaign = await seedCampaign(ctx, 'Unresolved');

    await attempt(ctx, campaign, { disposition: 'completed' });
    await attempt(ctx, campaign, { disposition: null, status: 'ABANDONED' });
    await attempt(ctx, campaign, { disposition: 'carrier_congestion' });

    const { totals, outcomes } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(totals.unresolved).toBe(2);
    expect(outcomes.find((o) => o.outcome === 'abandoned')?.count).toBe(1);
    expect(outcomes.find((o) => o.outcome === 'other')?.count).toBe(1);
  });

  it('averages duration across both sources, over calls that have one', async () => {
    const ctx = await seedWorkspace('duration');
    const campaign = await seedCampaign(ctx, 'Duration');

    await attempt(ctx, campaign, { durationSecs: 30 });
    await record({ workspaceId: ctx.workspace.id, durationSecs: 90 });
    // An unknown duration is not a zero-second call, so it is not in the mean.
    await record({ workspaceId: ctx.workspace.id, durationSecs: null });

    const { totals } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(totals.totalDurationSecs).toBe(120);
    expect(totals.avgDurationSecs).toBe(60);
  });

  it('echoes the range it was answered over', async () => {
    const ctx = await seedWorkspace('echo');

    const overview = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(overview.range.from).toEqual(RANGE.from);
    expect(overview.range.to).toEqual(RANGE.to);
  });
});

describe('credits', () => {
  it('says calling is metered', async () => {
    const ctx = await seedWorkspace('metered');

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).metered).toBe(true);
  });

  it('sums what was charged, from the ledger', async () => {
    const ctx = await seedWorkspace('spend');
    const campaign = await seedCampaign(ctx, 'Spend');

    const one = await attempt(ctx, campaign);
    const two = await attempt(ctx, campaign);
    // 1.5 and 2.5 display credits, in internal units.
    await charge(ctx, one.id, 15_000n);
    await charge(ctx, two.id, 25_000n);

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).totals.creditsSpent).toBe('4');
  });

  it('never counts a shortfall, which was owed and not taken', async () => {
    // `CallAttempt.costCredits` records what was owed on a call that completed
    // against a balance too small to cover it. Nothing was debited, so adding
    // it in would show a workspace spending credits it still has.
    const ctx = await seedWorkspace('shortfall');
    const campaign = await seedCampaign(ctx, 'Shortfall');

    const paid = await attempt(ctx, campaign);
    const unpaid = await attempt(ctx, campaign);
    await charge(ctx, paid.id, 10_000n);
    await prisma.creditTransaction.create({
      data: {
        accountId: ctx.account.id,
        workspaceId: ctx.workspace.id,
        callAttemptId: unpaid.id,
        amount: 0n,
        type: 'CALL_USAGE_SHORTFALL',
      },
    });

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).totals.creditsSpent).toBe('1');
  });

  it('is null rather than zero when nothing was charged', async () => {
    // A zero under a credits heading reads as "these calls were free".
    const ctx = await seedWorkspace('nocharge');
    const campaign = await seedCampaign(ctx, 'No charge');
    await attempt(ctx, campaign);

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).totals.creditsSpent).toBeNull();
  });

  it('counts a charge by the call it was for, not by when it landed', async () => {
    // A charge lands minutes after its call. Filtering on the ledger row's own
    // timestamp would drop the last day's calls out of the money column while
    // leaving them in the call count.
    const ctx = await seedWorkspace('lateCharge');
    const campaign = await seedCampaign(ctx, 'Late');

    const call = await attempt(ctx, campaign, { startedAt: RANGE.to.toISOString() });
    const ledger = await charge(ctx, call.id, 20_000n);
    // Written after the range closed.
    await prisma.creditTransaction.update({
      where: { id: ledger.id },
      data: { createdAt: new Date('2026-09-01T02:00:00.000Z') },
    });

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).totals.creditsSpent).toBe('2');
  });

  it('never counts another workspace’s charges', async () => {
    const mine = await seedWorkspace('creditsmine');
    const theirs = await seedWorkspace('creditstheirs');
    const theirCampaign = await seedCampaign(theirs, 'Theirs');

    const call = await attempt(theirs, theirCampaign);
    await charge(theirs, call.id, 50_000n);

    expect((await workspaceOverview(mine.workspace.id, RANGE)).totals.creditsSpent).toBeNull();
  });
});

describe('the range edges', () => {
  it('includes a call at exactly each bound and excludes one outside', async () => {
    const ctx = await seedWorkspace('edges');
    const campaign = await seedCampaign(ctx, 'Edges');

    await attempt(ctx, campaign, { startedAt: RANGE.from.toISOString() });
    await attempt(ctx, campaign, { startedAt: RANGE.to.toISOString() });
    await attempt(ctx, campaign, { startedAt: '2026-07-31T23:59:59.999Z' });
    await record({ workspaceId: ctx.workspace.id, startedAt: '2026-09-01T00:00:00.000Z' });

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).totals.calls).toBe(2);
  });

  it('excludes a record with no start time, which cannot be shown to be in range', async () => {
    const ctx = await seedWorkspace('undated');
    await prisma.callRecord.create({
      data: { upstreamCallId: 'undated', workspaceId: ctx.workspace.id, startedAt: null },
    });

    expect((await workspaceOverview(ctx.workspace.id, RANGE)).totals.calls).toBe(0);
  });
});

describe('the daily series', () => {
  it('emits one point per UTC day of the range, gaps filled with zero', async () => {
    // A sparse series drawn as a line silently connects across the gap and
    // reports a week of nothing as a smooth decline.
    const ctx = await seedWorkspace('series');
    const campaign = await seedCampaign(ctx, 'Series');
    const range = {
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-05T23:59:59.999Z'),
    };

    await attempt(ctx, campaign, { startedAt: '2026-08-01T09:00:00.000Z' });
    await record({ workspaceId: ctx.workspace.id, startedAt: '2026-08-01T21:00:00.000Z' });
    await attempt(ctx, campaign, { startedAt: '2026-08-04T09:00:00.000Z' });

    const { series, timezone, bucket } = await workspaceOverview(ctx.workspace.id, range);

    expect(series.map((point) => point.date)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    // Both sources land in the same bucket.
    expect(series.map((point) => point.calls)).toEqual([2, 0, 0, 1, 0]);
    // The bars sum to the figure printed above them. Stated as its own
    // assertion because the two are computed by different queries — the tile
    // from a `groupBy`, the chart from a `$queryRaw` union — and nothing but
    // this holds them together.
    const { totals } = await workspaceOverview(ctx.workspace.id, range);
    expect(series.reduce((sum, point) => sum + point.calls, 0)).toBe(totals.calls);
    // Stated rather than implied — a chart whose buckets depend on who is
    // looking at it cannot be compared with the one beside it.
    expect(timezone).toBe('UTC');
    expect(bucket).toBe('day');
  });

  it('classifies each source by its own rule', async () => {
    // An attempt carries three fields and a record carries two; the series
    // groups them together and must not read the wrong one.
    const ctx = await seedWorkspace('seriesmix');
    const campaign = await seedCampaign(ctx, 'Mix');
    const range = {
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-01T23:59:59.999Z'),
    };

    await attempt(ctx, campaign, {
      startedAt: '2026-08-01T09:00:00.000Z',
      disposition: null,
      upstreamStatus: 'ringing',
      status: 'ABANDONED',
    });
    await record({
      workspaceId: ctx.workspace.id,
      startedAt: '2026-08-01T10:00:00.000Z',
      disposition: 'completed',
    });

    // The abandoned attempt is not connected; the completed record is.
    expect((await workspaceOverview(ctx.workspace.id, range)).series[0]).toMatchObject({
      calls: 2,
      connected: 1,
    });
  });

  it('truncates a day in UTC whatever the database session zone is', async () => {
    // `date_trunc('day', "startedAt" AT TIME ZONE 'UTC')` reads like it forces
    // UTC and does the opposite: `startedAt` is a naive timestamp, so the
    // operator converts it to a `timestamptz` and truncation then follows the
    // session's own `TimeZone` — which nothing here sets and Prisma does not
    // pin. The payload asserts UTC and `densify` walks UTC calendar days, so
    // off a UTC database the buckets shift out from under both, and a row whose
    // key shifts before the range's first day is dropped from the series
    // altogether — leaving the chart and the tile above it disagreeing about
    // the same calls.
    //
    // Asserted against the SQL rather than against seeded rows, and under
    // `SET LOCAL` inside a transaction: the session zone is connection state on
    // a pool this suite shares, so setting it for the length of a query would
    // reach whatever else is running.
    for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC']) {
      const { fixed, broken } = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
        const [row] = await tx.$queryRawUnsafe<{ fixed: Date; broken: Date }[]>(
          `SELECT date_trunc('day', TIMESTAMP '2026-08-01 02:00:00') AS fixed,
                  date_trunc('day', TIMESTAMP '2026-08-01 02:00:00' AT TIME ZONE 'UTC') AS broken`,
        );
        return row;
      });

      expect(fixed.toISOString().slice(0, 10)).toBe('2026-08-01');

      // The form this replaced, kept as the reason: in Kolkata it reads the
      // same instant as the 31st of July, and in New York as the 31st too —
      // both before a range starting on the 1st, so both simply vanish.
      if (zone !== 'UTC') {
        expect(broken.toISOString().slice(0, 10)).not.toBe('2026-08-01');
      }
    }
  });
});

describe('the per-campaign rollup', () => {
  it('lists campaigns that have calls, with their names and spend', async () => {
    const ctx = await seedWorkspace('rollup');
    const one = await seedCampaign(ctx, 'Spring');
    const two = await seedCampaign(ctx, 'Summer');
    // A campaign with no calls is absent rather than a row of zeros.
    await seedCampaign(ctx, 'Never dialled');

    const first = await attempt(ctx, one, { disposition: 'completed' });
    await attempt(ctx, one, { disposition: 'busy' });
    await attempt(ctx, two, { disposition: 'completed' });
    await charge(ctx, first.id, 30_000n);

    const { campaigns } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(campaigns).toHaveLength(2);
    expect(campaigns.find((c) => c.id === one.id)).toMatchObject({
      name: 'Spring',
      calls: 2,
      connected: 1,
      answerRate: 0.5,
      creditsSpent: '3',
    });
    expect(campaigns.find((c) => c.id === two.id)).toMatchObject({
      name: 'Summer',
      creditsSpent: null,
    });
  });

  it('never names another workspace’s campaign', async () => {
    const mine = await seedWorkspace('rollupmine');
    const theirs = await seedWorkspace('rolluptheirs');
    const theirCampaign = await seedCampaign(theirs, 'Not yours');

    await attempt(theirs, theirCampaign);

    expect((await workspaceOverview(mine.workspace.id, RANGE)).campaigns).toEqual([]);
  });
});

/**
 * A campaign that ANSWERS, in the workspace-wide rollup.
 *
 * The rollup existed before inbound campaigns did, and was built entirely on
 * `CallAttempt` — so a campaign whose calls are all `CampaignInboundCall` rows
 * produced no tally, fell out of the id list, and vanished from the table
 * altogether. Not a row of zeros a reader could argue with: no row at all,
 * while the filter chip above still said the campaign was selected.
 */
describe('the per-campaign rollup, on a campaign that answers', () => {
  it('lists an inbound campaign with the calls it received', async () => {
    const ctx = await seedWorkspace('rollupinbound');
    const inbound = await seedInboundCampaign(ctx, 'Support line');

    const first = await seedInboundCall(ctx, inbound, {
      arrivedAt: new Date('2026-08-10T10:00:00.000Z'),
    });
    await seedInboundCall(ctx, inbound, { arrivedAt: new Date('2026-08-11T10:00:00.000Z') });
    await seedCallUsage(ctx, first.id, 20_000n);

    const { campaigns } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(campaigns.find((c) => c.id === inbound.id)).toMatchObject({
      name: 'Support line',
      type: 'INBOUND',
      inboundCalls: 2,
      // Dials placed, and a received call is not one. Zero here is the true
      // count of something else, not a stand-in for the two calls above.
      calls: 0,
      connected: 0,
      // Never `0%`: nothing was dialled, so there is no rate to state.
      answerRate: null,
      creditsSpent: '2',
    });
  });

  it('counts both halves of a BOTH campaign without mixing them', async () => {
    const ctx = await seedWorkspace('rollupboth');
    const both = await seedInboundCampaign(ctx, 'Renewals', 'BOTH');

    await attempt(ctx, both, { disposition: 'completed' });
    await attempt(ctx, both, { disposition: 'busy' });
    await seedInboundCall(ctx, both, { arrivedAt: new Date('2026-08-12T10:00:00.000Z') });

    const { campaigns } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(campaigns.find((c) => c.id === both.id)).toMatchObject({
      type: 'BOTH',
      // The dial figures stay about dials: one of two dials connected. Folding
      // the received call into either number would make the rate a fraction
      // over two different populations.
      calls: 2,
      connected: 1,
      answerRate: 0.5,
      inboundCalls: 1,
    });
  });

  /**
   * **No single workspace scope on this path is observable on its own**, and
   * that is worth stating rather than discovering.
   *
   * A received call reaches the table through two of them — `inboundScope`'s
   * `workspaceId` and the `workspaceId` on `campaign.findMany` — and its spend
   * reaches the tile through two more — the ledger join's `t."workspaceId"`
   * and the raw query's own `WHERE`. Each pair masks its partner: remove any
   * ONE and every assertion in this file still passes, which was checked by
   * removing each of the four in turn.
   *
   * So this test cannot prove any one of them. What it does is fail if a path
   * loses them *together* — the shape a refactor that "simplifies away the
   * redundancy" actually takes. The one scope that IS individually observable
   * has its own test below, on a state production can reach.
   *
   * The version this replaces seeded `mine` with nothing at all and asserted an
   * empty table; it could not fail under any mutation, because an empty
   * workspace has an empty table for reasons that have nothing to do with
   * scoping.
   */
  it('never counts another workspace’s inbound calls', async () => {
    const mine = await seedWorkspace('inboundmine');
    const theirs = await seedWorkspace('inboundtheirs');
    const myCampaign = await seedInboundCampaign(mine, 'Mine');
    const theirCampaign = await seedInboundCampaign(theirs, 'Not yours');

    await seedInboundCall(mine, myCampaign, { arrivedAt: new Date('2026-08-10T10:00:00.000Z') });
    const theirCall = await seedInboundCall(theirs, theirCampaign, {
      arrivedAt: new Date('2026-08-10T10:00:00.000Z'),
    });
    await seedCallUsage(theirs, theirCall.id, 50_000n);

    const { campaigns, totals } = await workspaceOverview(mine.workspace.id, RANGE);

    // Exactly one row, and exactly one call on it. Without the workspace scope
    // the foreign call lands on this tally too.
    expect(campaigns.map((c) => c.id)).toEqual([myCampaign.id]);
    expect(campaigns[0]?.inboundCalls).toBe(1);
    // And their charge is not in my money. This is the assertion that fails if
    // the ledger join loses its own workspace pin.
    expect(campaigns[0]?.creditsSpent).toBeNull();
    expect(totals.creditsSpent).toBeNull();
  });

  /**
   * A call whose own `workspaceId` disagrees with its campaign's — and the one
   * place `inboundScope`'s workspace filter is load-bearing by itself.
   *
   * Production reaches this: the inbound writer stamps the row with the
   * workspace of the NUMBER the call arrived on (`campaignInbound.ts`) while
   * taking the campaign from the claim, so a DID reassigned to another
   * workspace while a claim still points at the old campaign leaves rows whose
   * two sides disagree. The call belongs to whoever owns the number it came in
   * on, so it must not be counted for the campaign's workspace — and there
   * `campaign.findMany` cannot help, because the campaign genuinely is that
   * workspace's and resolves a name.
   */
  it('goes by the call’s own workspace, not its campaign’s', async () => {
    const mine = await seedWorkspace('inboundstale');
    const theirs = await seedWorkspace('inboundstaleother');
    const myCampaign = await seedInboundCampaign(mine, 'Support line');

    const stale = await seedInboundCall(mine, myCampaign, {
      arrivedAt: new Date('2026-08-10T10:00:00.000Z'),
    });
    // The number moved; the claim did not. The row now names my campaign while
    // belonging to their workspace.
    await prisma.campaignInboundCall.update({
      where: { id: stale.id },
      data: { workspaceId: theirs.workspace.id },
    });

    const { campaigns } = await workspaceOverview(mine.workspace.id, RANGE);

    expect(campaigns).toEqual([]);
  });

  it('keeps an inbound campaign when the filter names it, and only it', async () => {
    const ctx = await seedWorkspace('inboundfilter');
    const inbound = await seedInboundCampaign(ctx, 'Support line');
    const other = await seedInboundCampaign(ctx, 'Other line');
    const outbound = await seedCampaign(ctx, 'Spring');

    await seedInboundCall(ctx, inbound, { arrivedAt: new Date('2026-08-10T10:00:00.000Z') });
    // A second INBOUND campaign the filter does not name. Without it, dropping
    // the campaign predicate from either the tally or the ledger join changes
    // nothing and this test still passes.
    await seedInboundCall(ctx, other, { arrivedAt: new Date('2026-08-10T10:00:00.000Z') });
    await attempt(ctx, outbound, { disposition: 'completed' });

    const { campaigns } = await workspaceOverview(ctx.workspace.id, RANGE, [inbound.id]);

    // The filter selected one campaign and the table shows exactly it. Before
    // this, selecting an inbound campaign narrowed the page to nothing at all.
    expect(campaigns.map((c) => c.id)).toEqual([inbound.id]);
    expect(campaigns[0]?.inboundCalls).toBe(1);
  });

  /**
   * The busiest campaign is the one that did the most, whichever direction it
   * did it in. Ranking on dials alone buried a campaign that answered hundreds
   * of calls below one that placed a single dial.
   */
  it('ranks a campaign by everything it did, not by its dials', async () => {
    const ctx = await seedWorkspace('inboundsort');
    const busy = await seedInboundCampaign(ctx, 'Support line');
    const quiet = await seedCampaign(ctx, 'Spring');

    for (const day of ['10', '11', '12']) {
      await seedInboundCall(ctx, busy, { arrivedAt: new Date(`2026-08-${day}T10:00:00.000Z`) });
    }
    await attempt(ctx, quiet, { disposition: 'completed' });

    const { campaigns } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(campaigns.map((c) => c.id)).toEqual([busy.id, quiet.id]);
  });

  /**
   * The money tile and the money column, over the same calls.
   *
   * `creditsSpent` reaches the ledger through the `callAttempt` relation, and
   * an inbound charge carries `callAttemptId = null` — so the tile could not
   * see this spend however it was scoped, and read "no charges in this range"
   * above a column that said otherwise.
   */
  it('counts inbound spend in the workspace total, not only in the column', async () => {
    const ctx = await seedWorkspace('inboundtile');
    const inbound = await seedInboundCampaign(ctx, 'Support line');
    const outbound = await seedCampaign(ctx, 'Spring');

    const call = await seedInboundCall(ctx, inbound, {
      arrivedAt: new Date('2026-08-10T10:00:00.000Z'),
    });
    await seedCallUsage(ctx, call.id, 30_000n);
    await charge(ctx, (await attempt(ctx, outbound, { disposition: 'completed' })).id, 10_000n);

    const { campaigns, totals } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(campaigns.find((c) => c.id === inbound.id)?.creditsSpent).toBe('3');
    expect(campaigns.find((c) => c.id === outbound.id)?.creditsSpent).toBe('1');
    // The column sums to the tile. It could not before.
    expect(totals.creditsSpent).toBe('4');
  });

  it('leaves an outbound campaign reporting no inbound calls', async () => {
    const ctx = await seedWorkspace('rollupoutbound');
    const outbound = await seedCampaign(ctx, 'Spring');

    await attempt(ctx, outbound, { disposition: 'completed' });

    const { campaigns } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(campaigns.find((c) => c.id === outbound.id)).toMatchObject({
      type: 'OUTBOUND',
      calls: 1,
      inboundCalls: 0,
    });
  });
});

describe('the outcome breakdown', () => {
  it('reports every bucket in the classifier’s order, zeros included', async () => {
    const ctx = await seedWorkspace('breakdown');
    const campaign = await seedCampaign(ctx, 'Breakdown');

    await attempt(ctx, campaign, { disposition: 'completed' });
    await attempt(ctx, campaign, { disposition: 'voicemail' });

    const { outcomes } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(outcomes.map((o) => o.outcome)).toEqual([
      'answered',
      'voicemail',
      'no_answer',
      'busy',
      'failed',
      'abandoned',
      'other',
    ]);
    expect(outcomes.find((o) => o.outcome === 'answered')?.count).toBe(1);
    expect(outcomes.find((o) => o.outcome === 'busy')?.count).toBe(0);
  });

  it('files an unrecognised disposition under `other` and names it verbatim', async () => {
    // The published sets grow without this service deploying. Folding an
    // unknown value into `failed` would report a carrier's new outcome as a
    // failure; dropping it would shrink the denominator of every rate.
    const ctx = await seedWorkspace('unknown');
    const campaign = await seedCampaign(ctx, 'Unknown');
    await attempt(ctx, campaign, { disposition: 'carrier_congestion' });

    const { outcomes, dispositions } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(outcomes.find((o) => o.outcome === 'other')?.count).toBe(1);
    expect(dispositions).toContainEqual({ disposition: 'carrier_congestion', count: 1 });
  });
});

describe('firstCallAt', () => {
  it('is null for a workspace that has never placed a call', async () => {
    const ctx = await seedWorkspace('first-none');

    const { firstCallAt } = await workspaceOverview(ctx.workspace.id, RANGE);

    // The page turns this into "Analytics appear after your first calls", a
    // claim about the workspace. `coverage` cannot answer it — it is
    // platform-wide, so it says the same thing on everybody's page.
    expect(firstCallAt).toBeNull();
  });

  it('reaches outside the range, and takes the earlier of the two sources', async () => {
    // The whole point: a workspace whose calls are all older than the window
    // must not be told it has never placed one. It is looking at the wrong
    // thirty days, and those are different sentences with different remedies.
    const ctx = await seedWorkspace('first-old');
    const campaign = await seedCampaign(ctx, 'Old');

    await attempt(ctx, campaign, { startedAt: '2026-03-02T09:00:00.000Z' });
    await record({ workspaceId: ctx.workspace.id, startedAt: '2026-03-01T09:00:00.000Z' });

    const { firstCallAt, totals } = await workspaceOverview(ctx.workspace.id, RANGE);

    expect(firstCallAt).toEqual(new Date('2026-03-01T09:00:00.000Z'));
    // And the range still reports honestly on itself.
    expect(totals.calls).toBe(0);
  });

  it("does not see another workspace's calls", async () => {
    const mine = await seedWorkspace('first-mine');
    const theirs = await seedWorkspace('first-theirs');
    const campaign = await seedCampaign(theirs, 'Theirs');

    await attempt(theirs, campaign, { startedAt: '2026-03-01T09:00:00.000Z' });

    expect((await workspaceOverview(mine.workspace.id, RANGE)).firstCallAt).toBeNull();
  });
});

/**
 * The campaign-to-date block the analytics strip reads.
 *
 * Lifetime on purpose: two of the three are per-contact counts and
 * `CampaignContact` holds only a contact's current state, so a range-scoped
 * talk-time sum over a lifetime contact count would be a ratio of two
 * different spans.
 */
describe('campaignAnalytics lifetime', () => {
  /**
   * Reaching somebody is a fact about a contact's DIALS, not about the state
   * its row happens to be in.
   *
   * `CampaignContact.disposition` is the LAST dial's outcome, copied onto the
   * join row by every resolution — so a lead that had a real conversation and
   * was later followed up into a voicemail stops carrying `completed`, and a
   * count off that column reports the campaign as having un-spoken to them.
   * Pairing it with a status gate made it worse again, dropping every contact
   * the goal follow-up had re-armed to PENDING. On a live touchbase campaign
   * the two filters together reported 158 conversations where 323 leads had
   * actually picked up.
   *
   * So `reached` counts CampaignContact rows with **at least one** attempt
   * whose own disposition is in `REACHED_DISPOSITIONS`. Contacts, not calls —
   * a lead rung four times counts once — and monotonic, which the old figure
   * was not: nothing a later dial does can un-hold a conversation that
   * happened.
   */
  const settle = (id: string, disposition: string, goalAchieved?: boolean) =>
    prisma.campaignContact.update({
      where: { id },
      data: { status: 'COMPLETED', disposition, ...(goalAchieved === undefined ? {} : { goalAchieved }) },
    });

  it('counts contacts spoken to, not the calls that reached them', async () => {
    const ctx = await seedWorkspace('lifetime-reached');
    const campaign = await seedCampaign(ctx, 'Reached');

    const spoke = await seedContact(campaign, 1);
    const transferred = await seedContact(campaign, 1);
    const machine = await seedContact(campaign, 1);
    await seedContact(campaign, 0);

    // Three conversations with ONE lead is one lead reached.
    await dial(ctx, campaign, spoke.id, { disposition: 'completed' });
    await dial(ctx, campaign, spoke.id, { disposition: 'completed' });
    await dial(ctx, campaign, spoke.id, { disposition: 'completed' });
    await dial(ctx, campaign, transferred.id, { disposition: 'transferred' });
    await dial(ctx, campaign, machine.id, { disposition: 'voicemail' });

    await settle(spoke.id, 'completed');
    await settle(transferred.id, 'transferred');
    await settle(machine.id, 'voicemail');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.reached).toBe(2);
  });

  /** The whole reason `reached` is not `settled`: a campaign that met nothing
   *  but answering machines spoke to nobody, and must not read as healthy. */
  it('does not count a voicemail as a person', async () => {
    const ctx = await seedWorkspace('lifetime-voicemail');
    const campaign = await seedCampaign(ctx, 'All machines');

    const one = await seedContact(campaign, 3);
    const two = await seedContact(campaign, 3);
    await dial(ctx, campaign, one.id, { disposition: 'voicemail' });
    await dial(ctx, campaign, two.id, { disposition: 'no_answer' });
    await settle(one.id, 'voicemail');
    await settle(two.id, 'no_answer');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.reached).toBe(0);
  });

  /**
   * The regression this figure was rebuilt for, half one.
   *
   * A lead picks up, the extraction books a follow-up, the follow-up lands in
   * their voicemail. The join row's `disposition` is now `voicemail` and the
   * conversation is nowhere in it — but it happened, and a report that says
   * otherwise is telling the operator they never spoke to somebody they spoke
   * to.
   */
  it('counts a lead whose LAST dial reached nobody but who spoke earlier', async () => {
    const ctx = await seedWorkspace('lifetime-followed-up');
    const campaign = await seedCampaign(ctx, 'Touchbase');

    const lead = await seedContact(campaign, 1);
    await dial(ctx, campaign, lead.id, { disposition: 'completed' });
    await dial(ctx, campaign, lead.id, { disposition: 'voicemail' });
    await settle(lead.id, 'voicemail');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.reached).toBe(1);
  });

  /**
   * The regression this figure was rebuilt for, half two.
   *
   * A contact mid-journey is exactly the contact a running campaign is full
   * of: the goal follow-up and the callback booking both re-arm `CALLING →
   * PENDING`. Gating on `SETTLED_STATUSES` dropped all of them, so the tile
   * counted only the leads the campaign had finished with — which on a paused
   * campaign mid-run is a minority of the people it had talked to.
   */
  it('counts a lead re-armed to PENDING after it spoke', async () => {
    const ctx = await seedWorkspace('lifetime-inflight');
    const campaign = await seedCampaign(ctx, 'Callbacks');

    const booked = await seedContact(campaign, 1);
    await dial(ctx, campaign, booked.id, { disposition: 'completed' });
    await prisma.campaignContact.update({
      where: { id: booked.id },
      data: { status: 'PENDING', disposition: 'completed', armKind: 'CALLBACK' },
    });

    const settled = await seedContact(campaign, 1);
    await dial(ctx, campaign, settled.id, { disposition: 'completed' });
    await settle(settled.id, 'completed');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.reached).toBe(2);
  });

  /**
   * An excluded lead is still a lead this campaign talked to.
   *
   * It is counted, and the arithmetic stays sound because the denominator on
   * the page is the funnel's `contacts` — `CampaignContact` rows for the
   * campaign, EXCLUDED ones included. It is `Campaign.totalContacts` that an
   * operator's removal decrements, and nothing on this tile divides by that.
   */
  it('counts a lead an operator excluded after speaking to them', async () => {
    const ctx = await seedWorkspace('lifetime-excluded');
    const campaign = await seedCampaign(ctx, 'Pruned');

    const removed = await seedContact(campaign, 1);
    await dial(ctx, campaign, removed.id, { disposition: 'completed' });
    await prisma.campaignContact.update({
      where: { id: removed.id },
      data: { status: 'EXCLUDED', disposition: 'completed' },
    });

    const report = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(report.lifetime.reached).toBe(1);
    // The pin that keeps the rate at or below 100%.
    expect(report.funnel.contacts).toBe(1);
  });

  /**
   * A row carrying a reached `disposition` and no attempt to have earned it.
   *
   * Reachable in the wild only through a backfill or a hand-edited row, and
   * pinned because it is the exact shape the old count believed and this one
   * does not: the claim is now evidenced by a dial, not asserted by a column.
   */
  it('does not count a contact whose disposition no dial supports', async () => {
    const ctx = await seedWorkspace('lifetime-unevidenced');
    const campaign = await seedCampaign(ctx, 'Backfilled');

    const asserted = await seedContact(campaign, 1);
    await settle(asserted.id, 'completed');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.reached).toBe(0);
  });

  it('counts the contacts the extraction judged done', async () => {
    const ctx = await seedWorkspace('lifetime-goal');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ctx.workspace.id, name: 'Goal', goalEnabled: true },
    });

    const done = await seedContact(campaign, 1);
    const notDone = await seedContact(campaign, 1);
    await dial(ctx, campaign, done.id, { disposition: 'completed' });
    await dial(ctx, campaign, notDone.id, { disposition: 'completed' });
    await settle(done.id, 'completed', true);
    await settle(notDone.id, 'completed', false);

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.goalCompleted).toBe(1);
    expect(lifetime.reached).toBe(2);
  });

  /**
   * Zero, never null, since 2026-09-06.
   *
   * The null used to mean "this campaign was never asked for a verdict",
   * which was a real state while a campaign could have the goal switch off.
   * Every campaign is asked now, so a settle that left `goalAchieved` null is
   * a contact whose call reported no outcome — counted as nobody complete,
   * because that is what it is.
   */
  it('reports a zero verdict count on a campaign whose stored switch is off', async () => {
    const ctx = await seedWorkspace('lifetime-nogoal');
    const campaign = await seedCampaign(ctx, 'No goal');

    const one = await seedContact(campaign, 1);
    await dial(ctx, campaign, one.id, { disposition: 'completed' });
    await settle(one.id, 'completed');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.goalCompleted).toBe(0);
  });

  it('sums every recorded second over the campaign, not over the range', async () => {
    const ctx = await seedWorkspace('lifetime-talk');
    const campaign = await seedCampaign(ctx, 'Talk');

    await attempt(ctx, campaign, { durationSecs: 300 });
    await attempt(ctx, campaign, { durationSecs: 300 });

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.talkSecs).toBe(600);
  });

  it('keeps the lifetime talk sum outside the range the picker sets', async () => {
    const ctx = await seedWorkspace('lifetime-span');
    const campaign = await seedCampaign(ctx, 'Old');

    await attempt(ctx, campaign, { startedAt: '2026-01-02T12:00:00.000Z', durationSecs: 300 });

    const { lifetime, totals } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.talkSecs).toBe(300);
    // Outside the window, so the range-scoped half of the payload cannot see it —
    // asymmetry the lifetime block is here to keep out of one ratio.
    expect(totals.calls).toBe(0);
  });

  /**
   * The list pinned by name, which is the whole drift protection.
   *
   * `REACHED_DISPOSITIONS` is restated on the dashboard as
   * `DISPOSITION_TIERS.reached` — one is a Prisma `where`, the other groups a
   * payload already sent, so no module can be shared. Each side pins it in its
   * own suite instead.
   */
  it('pins the reached dispositions the dashboard restates', () => {
    expect([...REACHED_DISPOSITIONS]).toEqual(['completed', 'transferred']);
  });

  /**
   * The numerator an average talk time has to use.
   *
   * `talkSecs` is every second the campaign recorded, answering machines
   * included; `reachedTalkSecs` is the seconds of the calls a person actually
   * took. Dividing the first by a count of PEOPLE rendered five real
   * conversations among ninety-five voicemails as ten minutes "per contact".
   *
   * Narrowed to the reached ATTEMPTS and not to every attempt of a reached
   * contact: the four voicemails left for a lead before they picked up are not
   * time spent talking to them, and rolling them in would put the average back
   * above what any conversation lasted.
   */
  it('separates the seconds spent talking to people from the seconds spent overall', async () => {
    const ctx = await seedWorkspace('lifetime-reached-talk');
    const campaign = await seedCampaign(ctx, 'Machines mostly');

    const spoke = await seedContact(campaign, 2);
    await dial(ctx, campaign, spoke.id, { disposition: 'voicemail', durationSecs: 20 });
    await dial(ctx, campaign, spoke.id, { disposition: 'completed', durationSecs: 300 });
    await settle(spoke.id, 'completed');

    const machine = await seedContact(campaign, 1);
    await dial(ctx, campaign, machine.id, { disposition: 'voicemail', durationSecs: 30 });
    await settle(machine.id, 'voicemail');

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.talkSecs).toBe(350);
    expect(lifetime.reachedTalkSecs).toBe(300);
    expect(lifetime.reached).toBe(1);
  });

  /**
   * `goalCompleted` is a subset of `reached` in every case the platform can
   * actually produce, and that is what makes the completion rate divide by it.
   *
   * The verdict is written by the post-call extraction, which needs a call
   * somebody took — so a contact carrying one has a reached attempt in its
   * history however its last dial went. Under the old count it was NOT a
   * subset, because that count could lose the conversation to a later
   * voicemail; the rate therefore divided by the roster and read a campaign
   * that had talked to two thirds of its list as having completed a quarter.
   */
  it('keeps a goal met on a lead whose last dial reached nobody inside reached', async () => {
    const ctx = await seedWorkspace('lifetime-goal-voicemail');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ctx.workspace.id, name: 'Goal', goalEnabled: true },
    });

    const one = await seedContact(campaign, 2);
    await dial(ctx, campaign, one.id, { disposition: 'completed' });
    await dial(ctx, campaign, one.id, { disposition: 'voicemail' });
    await settle(one.id, 'voicemail', true);

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime.goalCompleted).toBe(1);
    expect(lifetime.reached).toBe(1);
  });

  /** `goalEnabled` is read to decide the null above; it must not ride out on
   *  the payload beside the name, which is spread onto the response verbatim. */
  it('does not put the goal switch on the wire', async () => {
    const ctx = await seedWorkspace('lifetime-campaign-shape');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ctx.workspace.id, name: 'Goal', goalEnabled: true },
    });

    const report = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(Object.keys(report.campaign).sort()).toEqual(['id', 'name']);
  });

  it('reports a campaign nobody has dialled as zero, not as absent', async () => {
    const ctx = await seedWorkspace('lifetime-empty');
    const campaign = await seedCampaign(ctx, 'Fresh');
    await seedContact(campaign, 0);

    const { lifetime } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(lifetime).toMatchObject({ reached: 0, talkSecs: 0, reachedTalkSecs: 0 });
  });
});

describe('the funnel counts leads, never calls', () => {
  /**
   * The bug on the September Touchbase report: **Connected calls 3026, 202% of
   * contacts**, drawn as a full bar under two stages that read 1500.
   *
   * Every other stage of the funnel counts `CampaignContact` rows, so a stage
   * counting attempt rows is not a stage of the same funnel — it is a different
   * measurement sharing an axis, and a reader subtracting one stage from the
   * next got nonsense. Worse, the number it produced was unbounded above: on a
   * campaign with a retry ladder most leads connect more than once, so the row
   * crossed 100% of the roster on any campaign that was working.
   *
   * It is now the same count `lifetime.reached` publishes, from the same
   * filter — one definition of "connected" across the list's ring, the
   * Overview strip and this report, rather than three.
   */
  it('counts a lead reached on three of its four dials once', async () => {
    const ctx = await seedWorkspace('funnel-unique');
    const campaign = await seedCampaign(ctx, 'Touchbase');

    const link = await seedContact(campaign, 3, 'PENDING');
    for (const no of [1, 2, 3, 4]) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.workspace.id,
          accountId: ctx.account.id,
          attemptNo: no,
          status: 'COMPLETED',
          disposition: no === 2 ? 'no_answer' : 'completed',
        },
      });
    }

    const report = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(report.funnel.connected).toBe(1);
    // One definition, published twice rather than measured twice.
    expect(report.funnel.connected).toBe(report.lifetime.reached);
  });

  /** The property the bar depends on: a share of the roster is a share. */
  it('never reports more connected than there are contacts', async () => {
    const ctx = await seedWorkspace('funnel-bounded');
    const campaign = await seedCampaign(ctx, 'Bounded');

    for (let i = 0; i < 3; i += 1) {
      const link = await seedContact(campaign, 2, 'COMPLETED');
      for (const no of [1, 2, 3]) {
        await prisma.callAttempt.create({
          data: {
            campaignId: campaign.id,
            campaignContactId: link.id,
            workspaceId: ctx.workspace.id,
            accountId: ctx.account.id,
            attemptNo: no,
            status: 'COMPLETED',
            disposition: 'completed',
          },
        });
      }
    }

    const { funnel } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(funnel.connected).toBe(3);
    expect(funnel.connected).toBeLessThanOrEqual(funnel.contacts);
    expect(funnel.attempted).toBeGreaterThanOrEqual(funnel.connected);
  });
});

/**
 * How each rung of the retry ladder actually did.
 *
 * The panel this replaces counted how far up the ladder each contact had gone
 * and said nothing about what happened there — so a campaign could show 558
 * contacts on their first retry with no way to tell whether that retry was
 * worth placing. The question an operator has is whether the second dial picks
 * anybody up, and that is one row per dial ordinal, split two ways.
 *
 * **Unique by construction.** `unique(campaignContactId, attemptNo)` means a
 * contact contributes at most one row to each ordinal, so no count here can
 * exceed the contacts that reached that rung — the property `funnel.connected`
 * had to be rewritten to get.
 */
describe('outcomes by dial ordinal', () => {
  it('splits each dial ordinal into connected and not connected', async () => {
    const ctx = await seedWorkspace('ordinals');
    const campaign = await seedCampaign(ctx, 'Ladder');

    const dials = async (dispositions: (string | null)[]) => {
      const link = await seedContact(campaign, dispositions.length - 1, 'PENDING');
      for (const [index, disposition] of dispositions.entries()) {
        await prisma.callAttempt.create({
          data: {
            campaignId: campaign.id,
            campaignContactId: link.id,
            workspaceId: ctx.workspace.id,
            accountId: ctx.account.id,
            attemptNo: index + 1,
            status: 'COMPLETED',
            disposition,
          },
        });
      }
    };

    await dials(['no_answer', 'completed']);
    await dials(['no_answer', 'no_answer']);
    await dials(['completed']);

    const { attemptOutcomes } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(attemptOutcomes).toEqual([
      { attemptNo: 1, connected: 1, notConnected: 2 },
      { attemptNo: 2, connected: 1, notConnected: 1 },
    ]);
  });

  /**
   * A claim the platform refused is not a telephone that rang, so it is neither
   * connected nor a lead who did not pick up. Counting it as the second files
   * our own outage under the lead refusing — the rule the list's ring holds.
   */
  it('leaves a launch that never reached the platform out of both counts', async () => {
    const ctx = await seedWorkspace('ordinals-launch');
    const campaign = await seedCampaign(ctx, 'Refused');
    const link = await seedContact(campaign, 0, 'PENDING');

    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        status: 'FAILED',
        launchError: 'platform refused the call',
      },
    });

    const { attemptOutcomes } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(attemptOutcomes).toEqual([]);
  });

  /**
   * The same override every other reader applies: the platform's detector
   * hearing a human outranks a label asserting the call never landed. A
   * cause-16 conversation arriving as `no_answer` is connected here or it is
   * connected nowhere.
   */
  it('counts a conversation the carrier labelled no_answer as connected', async () => {
    const ctx = await seedWorkspace('ordinals-human');
    const campaign = await seedCampaign(ctx, 'Cause 16');
    const link = await seedContact(campaign, 0, 'PENDING');

    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        status: 'COMPLETED',
        disposition: 'no_answer',
        answeredBy: 'human',
      },
    });

    const { attemptOutcomes } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(attemptOutcomes).toEqual([{ attemptNo: 1, connected: 1, notConnected: 0 }]);
  });

  it('never counts an attempt belonging to another campaign', async () => {
    const ctx = await seedWorkspace('ordinals-isolation');
    const mine = await seedCampaign(ctx, 'Mine');
    const theirs = await seedCampaign(ctx, 'Theirs');

    for (const campaign of [mine, theirs]) {
      const link = await seedContact(campaign, 0, 'PENDING');
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.workspace.id,
          accountId: ctx.account.id,
          attemptNo: 1,
          status: 'COMPLETED',
          disposition: 'completed',
        },
      });
    }

    const { attemptOutcomes } = (await campaignAnalytics(ctx.workspace.id, mine.id, RANGE))!;

    expect(attemptOutcomes).toEqual([{ attemptNo: 1, connected: 1, notConnected: 0 }]);
  });
});

/**
 * The ladder an operator actually reads: one row per dial ordinal, with what
 * that ordinal has left to place.
 *
 * **A rung counts dials, not arms.** An earlier cut split these rows by the arm
 * the dial came out of — a retry ladder beside a follow-up ladder beside a
 * callback ladder — and it answered a question nobody asks. An operator counts
 * a contact's dials: attempt 4 is the fourth time that telephone rang, whatever
 * chose to ring it. The lane split also leaned on `CallAttempt.kind`, nullable
 * on everything dialled before it existed, so a campaign's follow-ups were
 * filed as retries on exactly the campaigns that had the most of them.
 *
 * **A rung that has not finished says so**, which is the one thing
 * `attemptOutcomes` beside it cannot: that panel counts dials that happened, so
 * a rung half-placed and a rung finished look identical.
 *
 * `due` is what is *waiting*: contacts still PENDING, counted one past however
 * many dials they already have. A dial in flight is not due — its attempt row
 * exists, so it is already counted where it was placed — and a contact the
 * campaign has settled is owed nothing at all.
 */
describe('the dial ladder', () => {
  it('numbers every dial a contact got, whatever arm placed it', async () => {
    const ctx = await seedWorkspace('ladder-ordinals');
    const campaign = await seedCampaign(ctx, 'Ordinals');
    const link = await seedContact(campaign, 2, 'COMPLETED', { followUpCount: 1 });

    // One contact, four dials: the first call, two retries nobody answered,
    // and a follow-up to the conversation the second retry finally had. Four
    // rungs, because the contact's telephone rang four times.
    const dials: Array<{ kind: string; disposition: string }> = [
      { kind: 'fresh', disposition: 'no_answer' },
      { kind: 'retry', disposition: 'no_answer' },
      { kind: 'retry', disposition: 'completed' },
      { kind: 'follow_up', disposition: 'completed' },
    ];

    for (const [index, dial] of dials.entries()) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.workspace.id,
          accountId: ctx.account.id,
          attemptNo: index + 1,
          status: 'COMPLETED',
          // Settled, so it carries the stamp a settled dial carries: the schema
          // makes `resolvedAt` null ONLY while a dial is in flight.
          resolvedAt: new Date(),
          kind: dial.kind,
          disposition: dial.disposition,
        },
      });
    }

    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 1, due: 0 },
      { attemptNo: 2, connected: 0, notConnected: 1, due: 0 },
      { attemptNo: 3, connected: 1, notConnected: 0, due: 0 },
      { attemptNo: 4, connected: 1, notConnected: 0, due: 0 },
    ]);
  });

  /**
   * The stamp is not consulted at all, which is the point of counting rows: a
   * campaign that ran before `kind` existed reads exactly as one that ran
   * yesterday, instead of having every dial past the first called a retry.
   */
  it('reads an unstamped campaign the same as a stamped one', async () => {
    const ctx = await seedWorkspace('ladder-legacy');
    const campaign = await seedCampaign(ctx, 'Legacy');
    const link = await seedContact(campaign, 1, 'COMPLETED');

    for (const attemptNo of [1, 2]) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.workspace.id,
          accountId: ctx.account.id,
          attemptNo,
          status: 'COMPLETED',
          // Settled, so it carries the stamp a settled dial carries: the schema
          // makes `resolvedAt` null ONLY while a dial is in flight.
          resolvedAt: new Date(),
          disposition: attemptNo === 1 ? 'no_answer' : 'completed',
        },
      });
    }

    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 1, due: 0 },
      { attemptNo: 2, connected: 1, notConnected: 0, due: 0 },
    ]);
  });

  it('counts a waiting contact one rung past the dials it already has', async () => {
    const ctx = await seedWorkspace('ladder-due');
    const campaign = await seedCampaign(ctx, 'Due');

    /** A pending contact with `placed` settled dials behind it. */
    const waiting = async (placed: number) => {
      const link = await seedContact(campaign, placed, 'PENDING', { armKind: 'RETRY' });

      for (let attemptNo = 1; attemptNo <= placed; attemptNo += 1) {
        await prisma.callAttempt.create({
          data: {
            campaignId: campaign.id,
            campaignContactId: link.id,
            workspaceId: ctx.workspace.id,
            accountId: ctx.account.id,
            attemptNo,
            status: 'COMPLETED',
            resolvedAt: new Date(),
            disposition: 'no_answer',
          },
        });
      }
    };

    // Nobody has rung this one: it is owed its first call, which is what makes
    // an untouched campaign draw a first rung of waiting rather than nothing.
    await seedContact(campaign, 0, 'PENDING');
    await waiting(2);
    await waiting(2);
    // Settled, however its arm reads: a finished contact is owed nothing.
    await seedContact(campaign, 3, 'COMPLETED', { armKind: 'RETRY' });

    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 2, due: 1 },
      { attemptNo: 2, connected: 0, notConnected: 2, due: 0 },
      { attemptNo: 3, connected: 0, notConnected: 0, due: 2 },
    ]);
  });

  it('leaves a launch the platform refused out of both counts, as the ordinals do', async () => {
    const ctx = await seedWorkspace('ladder-launch');
    const campaign = await seedCampaign(ctx, 'Refused');
    const link = await seedContact(campaign, 0, 'PENDING');

    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        status: 'FAILED',
        // Settled, so it carries the stamp a settled dial carries: the schema
        // makes `resolvedAt` null ONLY while a dial is in flight.
        resolvedAt: new Date(),
        kind: 'fresh',
        launchError: 'platform refused the call',
      },
    });

    // Still owed its first call: nothing rang, so the rung is unplaced rather
    // than placed and failed — and the refused row does not consume ordinal 1,
    // which is why the ladder renumbers over the dials that happened.
    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 0, due: 1 },
    ]);
  });

  it('counts a platform fault as the dial it never was, so the next claim keeps the rung', async () => {
    const ctx = await seedWorkspace('ladder-error-code');
    const campaign = await seedCampaign(ctx, 'Fault');
    const link = await seedContact(campaign, 1, 'PENDING', { armKind: 'FRESH' });

    /*
     * The shape `launchError IS NULL` cannot see: the platform refused the
     * claim with a code and no failure reason, so no `launchError` was ever
     * written. Nothing rang, so the contact is still owed its first dial —
     * counting this row would report the first call placed and failed, and
     * push the dial that does happen down to rung 2.
     */
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        status: 'FAILED',
        resolvedAt: new Date(),
        kind: 'fresh',
        errorCode: 'TELEPHONY_ACCOUNT_DRY',
      },
    });

    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 0, due: 1 },
    ]);
  });

  it('counts a dial the reaper abandoned, which rang before it went unanswered for', async () => {
    const ctx = await seedWorkspace('ladder-reaped');
    const campaign = await seedCampaign(ctx, 'Reaped');
    const link = await seedContact(campaign, 1, 'PENDING', { armKind: 'RETRY' });

    /*
     * The mirror of the case above, and the other half of what a bare
     * `launchError` check gets wrong: the reaper stamps a launch error on a
     * call that DID ring and re-arms the ordinary retry for it. Dropping it
     * would report the second dial owed on a first call nobody ever placed.
     */
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        status: 'ABANDONED',
        resolvedAt: new Date(),
        kind: 'fresh',
        upstreamCallId: 'upstream-reaped-1',
        launchError: 'REAPER_NO_OUTCOME',
      },
    });

    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 1, due: 0 },
      { attemptNo: 2, connected: 0, notConnected: 0, due: 1 },
    ]);
  });

  it('leaves a dial still ringing out of both counts rather than filing it as a refusal', async () => {
    const ctx = await seedWorkspace('ladder-in-flight');
    const campaign = await seedCampaign(ctx, 'Ringing');
    const link = await seedContact(campaign, 0, 'CALLING');

    // No disposition and no `resolvedAt`: `reached` would coalesce to false and
    // report our own live dial as a lead who did not pick up.
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        kind: 'fresh',
        upstreamCallId: 'upstream-live-1',
      },
    });

    expect((await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!.dialLadder).toEqual([]);
  });

  it('never counts a dial or a waiting contact from another campaign', async () => {
    const ctx = await seedWorkspace('ladder-isolation');
    const mine = await seedCampaign(ctx, 'Mine');
    const theirs = await seedCampaign(ctx, 'Theirs');

    for (const campaign of [mine, theirs]) {
      const link = await seedContact(campaign, 0, 'COMPLETED');
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.workspace.id,
          accountId: ctx.account.id,
          attemptNo: 1,
          status: 'COMPLETED',
          // Settled, so it carries the stamp a settled dial carries: the schema
          // makes `resolvedAt` null ONLY while a dial is in flight.
          resolvedAt: new Date(),
          kind: 'fresh',
          disposition: 'completed',
        },
      });
      await seedContact(campaign, 1, 'PENDING', { armKind: 'RETRY' });
    }

    expect((await campaignAnalytics(ctx.workspace.id, mine.id, RANGE))!.dialLadder).toEqual([
      { attemptNo: 1, connected: 1, notConnected: 0, due: 1 },
    ]);
  });
});

describe('campaignAnalytics', () => {
  it('builds the funnel from contacts and attempts', async () => {
    const ctx = await seedWorkspace('funnel');
    const campaign = await seedCampaign(ctx, 'Funnel');

    await seedContact(campaign, 0);
    await seedContact(campaign, 2, 'COMPLETED');
    await seedContact(campaign, 3, 'FAILED');

    // `attempt()` seeds a contact of its own with attempts = 1.
    await attempt(ctx, campaign, { disposition: 'completed' });
    await attempt(ctx, campaign, { disposition: 'no_answer' });

    const { funnel } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(funnel).toMatchObject({
      scope: 'campaign_to_date',
      contacts: 5,
      attempted: 4,
      connected: 1,
      completed: 1,
    });
  });

  /**
   * `attempts` is retries CONSUMED, not dials made — the schema is emphatic —
   * so a funnel counting it alone reports as never dialled every contact whose
   * dial did not spend a retry. That is the booked callback and, on a goal
   * campaign, every conversation that went well: the follow-up re-arm moves
   * `followUpCount` and leaves the other two where they were.
   */
  it('counts a contact dialled without spending a retry as attempted', async () => {
    const ctx = await seedWorkspace('funnel-counters');
    const campaign = await seedCampaign(ctx, 'Goal campaign');

    // Nobody has called this one.
    await seedContact(campaign, 0);
    // Connected on the first dial and booked a callback: no retry spent.
    await seedContact(campaign, 0, 'PENDING', { callbackCount: 1 });
    // Had a real conversation and was re-armed for a goal follow-up.
    await seedContact(campaign, 0, 'PENDING', { followUpCount: 1 });

    const { funnel } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(funnel).toMatchObject({ contacts: 3, attempted: 2 });
  });

  /**
   * The funnel's own arithmetic, asserted as a property rather than as four
   * numbers: **no stage may be narrower than the stage after it.**
   *
   * The population that breaks it is the ordinary one — a contact that answered
   * on its first dial and settled. `attempts` counts retries CONSUMED and the
   * settle path never increments it; `callbackCount` moves only on a booked
   * callback and `followUpCount` only on a goal re-arm. So all three dial
   * counters are zero on a plain campaign that went well, and any `attempted`
   * read off them reports `completed` contacts as never dialled — a funnel
   * whose third stage exceeds its second by the width of its own success.
   *
   * The evidence that survives it is `lastAttemptAt`, stamped by the claim in
   * the same `UPDATE` as `status = 'QUEUED'` and never cleared, so it is
   * present on every contact any settle could have reached.
   */
  it('never reports fewer contacts attempted than completed', async () => {
    const ctx = await seedWorkspace('funnel-monotonic');
    const campaign = await seedCampaign(ctx, 'Answered first time');

    // Eight answered on the first ring and settled. No retry, no callback, no
    // follow-up: every dial counter still reads zero.
    for (let i = 0; i < 8; i += 1) await seedContact(campaign, 0, 'COMPLETED');
    // Two nobody has called yet.
    await seedContact(campaign, 0);
    await seedContact(campaign, 0);

    const { funnel } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(funnel.attempted).toBeGreaterThanOrEqual(funnel.completed);
    expect(funnel.contacts).toBeGreaterThanOrEqual(funnel.attempted);
    expect(funnel).toMatchObject({ contacts: 10, attempted: 8, completed: 8 });
  });

  it('counts every funnel stage over the campaign, not over the range', async () => {
    // The four stages are numbers a reader subtracts from each other, so the
    // one thing the funnel cannot survive is two of them counting different
    // spans. `connected` was the odd one out: range-scoped while the other
    // three were counted off `CampaignContact`, which has no notion of a range
    // at all. A campaign that finished in June, opened in August under the
    // default window, then read "attempted 950, connected 0, completed 900".
    const ctx = await seedWorkspace('funnel-span');
    const campaign = await seedCampaign(ctx, 'Finished in June');

    await seedContact(campaign, 2, 'COMPLETED');
    await attempt(ctx, campaign, {
      startedAt: '2026-06-10T12:00:00.000Z',
      disposition: 'completed',
    });

    const { funnel, totals } = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    // Every stage describes the campaign, and says so.
    expect(funnel).toMatchObject({
      scope: 'campaign_to_date',
      contacts: 2,
      attempted: 2,
      connected: 1,
      completed: 1,
    });
    // The range-scoped reading is `totals`, beside it in the same payload, and
    // it correctly reports that August was quiet.
    expect(totals.calls).toBe(0);
  });

  /**
   * The retry distribution this replaced counted how far up the ladder each
   * contact had gone — `CampaignContact.attempts`, retries CONSUMED — and said
   * nothing about what happened on any of those dials. It is gone rather than
   * kept beside the new panel: two ladder-shaped lists on one tab, one counting
   * contacts by rung reached and one counting dials by rung placed, is a pair
   * a reader compares and cannot reconcile.
   */
  it('reports outcomes by dial ordinal in place of the retry distribution', async () => {
    const ctx = await seedWorkspace('attempts');
    const campaign = await seedCampaign(ctx, 'Attempts');
    const link = await seedContact(campaign, 1);

    for (const no of [1, 2]) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.workspace.id,
          accountId: ctx.account.id,
          attemptNo: no,
          status: 'COMPLETED',
          disposition: no === 1 ? 'no_answer' : 'completed',
        },
      });
    }

    const report = (await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE))!;

    expect(report.attemptOutcomes).toEqual([
      { attemptNo: 1, connected: 0, notConnected: 1 },
      { attemptNo: 2, connected: 1, notConnected: 0 },
    ]);
    expect('attempts' in report).toBe(false);
  });

  it('counts only this campaign’s attempts, and no CallRecords at all', async () => {
    // A campaign report reads the dialer's record and nothing else: the ingest
    // never stores a campaign call, so anything in CallRecord is by definition
    // not this campaign's.
    const ctx = await seedWorkspace('campscope');
    const mine = await seedCampaign(ctx, 'Mine');
    const other = await seedCampaign(ctx, 'Other');

    await attempt(ctx, mine);
    await attempt(ctx, other);
    await record({ workspaceId: ctx.workspace.id });

    expect((await campaignAnalytics(ctx.workspace.id, mine.id, RANGE))!.totals.calls).toBe(1);
  });

  it('sums only this campaign’s charges', async () => {
    const ctx = await seedWorkspace('campspend');
    const mine = await seedCampaign(ctx, 'Mine');
    const other = await seedCampaign(ctx, 'Other');

    const a = await attempt(ctx, mine);
    const b = await attempt(ctx, other);
    await charge(ctx, a.id, 10_000n);
    await charge(ctx, b.id, 90_000n);

    expect((await campaignAnalytics(ctx.workspace.id, mine.id, RANGE))!.totals.creditsSpent).toBe(
      '1',
    );
  });

  it('is empty rather than absent for a campaign that has never dialled', async () => {
    const ctx = await seedWorkspace('nevercalled');
    const campaign = await seedCampaign(ctx, 'Idle');
    await seedContact(campaign, 0);

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, RANGE);

    expect(report!.totals.calls).toBe(0);
    expect(report!.totals.answerRate).toBeNull();
    expect(report!.funnel.contacts).toBe(1);
  });

  it('returns null for a campaign in another workspace', async () => {
    // The route turns this into a 404 identical to a nonexistent id, so the
    // endpoint cannot be used to sort ids into real and unreal.
    const mine = await seedWorkspace('cross-a');
    const theirs = await seedWorkspace('cross-b');
    const theirCampaign = await seedCampaign(theirs, 'Theirs');

    expect(await campaignAnalytics(mine.workspace.id, theirCampaign.id, RANGE)).toBeNull();
  });

  it('returns null for a campaign that does not exist', async () => {
    const ctx = await seedWorkspace('missing');

    expect(await campaignAnalytics(ctx.workspace.id, 'nope', RANGE)).toBeNull();
  });
});


/**
 * What an inbound-facing campaign RECEIVED, over a range.
 *
 * Every query here ranges on `arrivedAt`. The rest of this service ranges on
 * `startedAt`, and `CampaignInboundCall` has no such column — `arrivedAt` is
 * stamped when the carrier's routing callback lands, which is the moment the
 * phone rang, and is the reading an operator wants of a daily bar.
 */
describe('inboundSeries', () => {
  it('groups by the day the call ARRIVED, not the day it ended', async () => {
    const ctx = await seedWorkspace('series');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    // Rings 23:58 UTC on the 1st, hangs up 00:04 on the 2nd.
    await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-03-01T23:58:00Z'),
      endedAt: new Date('2026-03-02T00:04:00Z'),
      durationSecs: 360,
    });

    const rows = await inboundSeries(campaign.workspaceId, campaign.id, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-03T00:00:00Z'),
    });

    expect(rows.find((r) => r.date === '2026-03-01')).toEqual({
      date: '2026-03-01',
      calls: 1,
      talkSecs: 360,
    });
    expect(rows.find((r) => r.date === '2026-03-02')).toEqual({
      date: '2026-03-02',
      calls: 0,
      talkSecs: 0,
    });
  });

  it('densifies every day in the range, including days with no calls', async () => {
    const ctx = await seedWorkspace('dense');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, { arrivedAt: new Date('2026-03-02T10:00:00Z') });

    const rows = await inboundSeries(campaign.workspaceId, campaign.id, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-03T23:59:59Z'),
    });

    expect(rows.map((r) => r.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('counts an open call and gives it no talk time', async () => {
    // A call still on the line has arrived and has no duration. It is one call
    // and zero seconds — not a call that lasted no time.
    const ctx = await seedWorkspace('open');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-03-02T10:00:00Z'),
      endedAt: null,
      durationSecs: null,
    });

    const [day] = await inboundSeries(campaign.workspaceId, campaign.id, {
      from: new Date('2026-03-02T00:00:00Z'),
      to: new Date('2026-03-02T23:59:59Z'),
    });

    expect(day).toEqual({ date: '2026-03-02', calls: 1, talkSecs: 0 });
  });

  /** The redundant workspace filter every neighbouring query here carries: the
   *  route has already checked ownership, and two independent filters mean a
   *  later refactor of that lookup cannot silently widen this one. */
  it('reports nothing for a campaign read under the wrong workspace', async () => {
    const ctx = await seedWorkspace('scoped');
    const other = await seedWorkspace('intruder');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, { arrivedAt: new Date('2026-03-02T10:00:00Z') });

    const rows = await inboundSeries(other.workspace.id, campaign.id, {
      from: new Date('2026-03-02T00:00:00Z'),
      to: new Date('2026-03-02T23:59:59Z'),
    });

    expect(rows).toEqual([{ date: '2026-03-02', calls: 0, talkSecs: 0 }]);
  });
});

/**
 * How the conversations went, by the bot's own verdict off the call note.
 *
 * Not the carrier's disposition, which answers a different question — a call
 * can complete perfectly and leave the caller's business unfinished.
 */
describe('inboundOutcomeBreakdown', () => {
  it('counts every outcome the note can carry, zeros included, plus the notes that carry none', async () => {
    const ctx = await seedWorkspace('outcomes');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const at = new Date('2026-03-02T10:00:00Z');
    await seedInboundCall(ctx, campaign, { arrivedAt: at, extraction: { call_outcome_vocobaseplatform: 'completed' } });
    await seedInboundCall(ctx, campaign, { arrivedAt: at, extraction: { call_outcome_vocobaseplatform: 'completed' } });
    await seedInboundCall(ctx, campaign, { arrivedAt: at, extraction: { call_outcome_vocobaseplatform: 'stop' } });
    // No extraction at all: the call ended before the bot wrote a note.
    await seedInboundCall(ctx, campaign, { arrivedAt: at, extraction: null });
    // An outcome the enum does not know. The platform's value set can grow
    // without either side deploying.
    await seedInboundCall(ctx, campaign, { arrivedAt: at, extraction: { call_outcome_vocobaseplatform: 'banana' } });

    const rows = await inboundOutcomeBreakdown(campaign.workspaceId, campaign.id, ALL_TIME);

    expect(rows).toEqual([
      { outcome: 'incomplete', count: 0 },
      { outcome: 'stop', count: 1 },
      { outcome: 'completed', count: 2 },
      // Unreadable and absent land together: in both cases we do not know how
      // the conversation went, and splitting them would put a bar on the chart
      // about our JSON rather than about the calls.
      { outcome: null, count: 2 },
    ]);
  });

  it('reports every bucket at zero on a campaign nobody has rung', async () => {
    const ctx = await seedWorkspace('outcomes-empty');
    const campaign = await seedInboundCampaign(ctx, 'Support');

    expect(await inboundOutcomeBreakdown(campaign.workspaceId, campaign.id, ALL_TIME)).toEqual([
      { outcome: 'incomplete', count: 0 },
      { outcome: 'stop', count: 0 },
      { outcome: 'completed', count: 0 },
      { outcome: null, count: 0 },
    ]);
  });

  it('counts only calls that arrived in the range', async () => {
    const ctx = await seedWorkspace('outcomes-range');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-03-02T10:00:00Z'),
      extraction: { call_outcome_vocobaseplatform: 'completed' },
    });
    await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-02-02T10:00:00Z'),
      extraction: { call_outcome_vocobaseplatform: 'completed' },
    });

    const rows = await inboundOutcomeBreakdown(campaign.workspaceId, campaign.id, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-31T23:59:59Z'),
    });

    expect(rows.find((r) => r.outcome === 'completed')).toEqual({ outcome: 'completed', count: 1 });
  });
});

describe('inboundRepeatCallers', () => {
  it('buckets callers by how many times they rang', async () => {
    const ctx = await seedWorkspace('repeat');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const at = new Date('2026-03-02T10:00:00Z');
    for (const from of [
      '+911111111111',
      '+912222222222',
      '+912222222222',
      '+913333333333',
      '+913333333333',
      '+913333333333',
    ]) {
      await seedInboundCall(ctx, campaign, { arrivedAt: at, fromNumber: from });
    }

    expect(await inboundRepeatCallers(campaign.workspaceId, campaign.id, ALL_TIME)).toEqual({
      callers: 3,
      repeatCallers: 2,
      histogram: [
        { calls: 1, callers: 1 },
        { calls: 2, callers: 1 },
        { calls: 3, callers: 1 },
      ],
    });
  });

  it('is empty rather than zero-filled when nobody has rung', async () => {
    const ctx = await seedWorkspace('repeat-empty');
    const campaign = await seedInboundCampaign(ctx, 'Support');

    expect(await inboundRepeatCallers(campaign.workspaceId, campaign.id, ALL_TIME)).toEqual({
      callers: 0,
      repeatCallers: 0,
      histogram: [],
    });
  });

  /** Keyed on `fromNumber`, not `contactId`: a stranger has no contact row
   *  until a settle enrols them, and three calls from one unknown number must
   *  be one repeat caller rather than three anonymous calls and no caller. */
  it('counts a stranger who rang twice as one repeat caller', async () => {
    const ctx = await seedWorkspace('stranger');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const at = new Date('2026-03-02T10:00:00Z');
    await seedInboundCall(ctx, campaign, { arrivedAt: at, fromNumber: '+914444444444' });
    await seedInboundCall(ctx, campaign, { arrivedAt: at, fromNumber: '+914444444444' });

    expect(await inboundRepeatCallers(campaign.workspaceId, campaign.id, ALL_TIME)).toMatchObject({
      callers: 1,
      repeatCallers: 1,
    });
  });
});

/**
 * Spend, from the LEDGER — never from `CampaignInboundCall.costCredits`.
 *
 * That column records what a call OWED. A shortfall — a call that completed
 * against a balance too small to cover it — writes it and debits nothing, so
 * summing the column would show a workspace spending credits it still has.
 */
describe('inboundCredits over a range', () => {
  it('counts only charges for calls that ARRIVED in the range', async () => {
    const ctx = await seedWorkspace('credits-range');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const inRange = await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-03-02T10:00:00Z'),
    });
    const before = await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-02-01T10:00:00Z'),
    });
    await seedCallUsage(ctx, inRange.id, 30_000n);
    await seedCallUsage(ctx, before.id, 90_000n);

    const march = await inboundCredits(campaign.workspaceId, campaign.id, ctx.account.id, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-31T23:59:59Z'),
    });

    expect(march).toEqual({ credits: 30_000n, billedCalls: 1 });
  });

  /** The scope is the CALL's arrival, not the ledger row's own timestamp. A
   *  charge lands after its call, so filtering on the ledger's clock would drop
   *  the last day's calls out of the money column while leaving them in the
   *  call count beside it. */
  it('keeps a charge written after the range closed, for a call inside it', async () => {
    const ctx = await seedWorkspace('credits-late');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const call = await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-03-31T23:58:00Z'),
    });
    // Written minutes later, in April.
    await seedCallUsage(ctx, call.id, 12_000n);

    const march = await inboundCredits(campaign.workspaceId, campaign.id, ctx.account.id, {
      from: new Date('2026-03-01T00:00:00Z'),
      to: new Date('2026-03-31T23:59:59Z'),
    });

    expect(march.credits).toBe(12_000n);
  });

  it('ignores a shortfall — a call that owed credits and was never debited', async () => {
    const ctx = await seedWorkspace('credits-shortfall');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const call = await seedInboundCall(ctx, campaign, {
      arrivedAt: new Date('2026-03-02T10:00:00Z'),
      costCredits: 50_000n,
    });
    await prisma.creditTransaction.create({
      data: {
        accountId: ctx.account.id,
        workspaceId: ctx.workspace.id,
        reference: call.id,
        amount: 0n,
        type: 'CALL_USAGE_SHORTFALL',
      },
    });

    expect(await inboundCredits(campaign.workspaceId, campaign.id, ctx.account.id, ALL_TIME)).toEqual(
      { credits: 0n, billedCalls: 0 },
    );
  });

  it('reads the whole campaign under ALL_TIME', async () => {
    const ctx = await seedWorkspace('credits-lifetime');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const old = await seedInboundCall(ctx, campaign, { arrivedAt: new Date('2020-01-01T00:00:00Z') });
    await seedCallUsage(ctx, old.id, 7_000n);

    expect(await inboundCredits(campaign.workspaceId, campaign.id, ctx.account.id, ALL_TIME)).toEqual(
      { credits: 7_000n, billedCalls: 1 },
    );
  });
});

/**
 * The `inbound` block on the campaign report.
 *
 * Everything else in `campaignAnalytics` is built on `CallAttempt`, which
 * exists only for a call the dialer PLACED. So on an INBOUND campaign every
 * figure in the rest of the report is a truthful zero about dialing that says
 * nothing about the calls the campaign actually took — which is why the tab was
 * hidden, and what this block replaces.
 */
describe('campaign analytics for an inbound campaign', () => {
  const MARCH = {
    from: new Date('2026-03-01T00:00:00.000Z'),
    to: new Date('2026-03-31T23:59:59.999Z'),
  };
  const MARCH_2 = new Date('2026-03-02T10:00:00.000Z');

  it('carries an inbound block with the calls received', async () => {
    const ctx = await seedWorkspace('report-in');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, { arrivedAt: MARCH_2, durationSecs: 120 });

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound).toMatchObject({
      calls: 1,
      callers: 1,
      talkSecs: 120,
      avgTalkSecs: 120,
    });
    expect(report?.inbound?.series.some((p) => p.date === '2026-03-02' && p.calls === 1)).toBe(true);
  });

  it('carries it on a BOTH campaign too, beside the dialing figures', async () => {
    const ctx = await seedWorkspace('report-both');
    const campaign = await seedInboundCampaign(ctx, 'Support', 'BOTH');

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound).toBeDefined();
    expect(report?.dialLadder).toBeDefined();
  });

  it('omits it entirely on an OUTBOUND campaign', async () => {
    // Absent, not zeroed: a zero would assert this campaign answers calls and
    // took none, which is a different claim and a false one.
    const ctx = await seedWorkspace('report-out');
    const campaign = await seedCampaign(ctx, 'Dialer');

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound).toBeUndefined();
    // Not merely undefined — ABSENT. A spread `undefined` key survives `in`
    // while `JSON.stringify` drops it, so the two differ exactly where a
    // consumer checking for the field would be misled.
    expect('inbound' in (report ?? {})).toBe(false);
  });

  it('reports avgTalkSecs as null when no call has a duration yet', async () => {
    const ctx = await seedWorkspace('report-nodur');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, { arrivedAt: MARCH_2, durationSecs: null, endedAt: null });

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    // Not 0. Zero seconds is a call that ended instantly; this is a call whose
    // length we do not know.
    expect(report?.inbound?.avgTalkSecs).toBeNull();
  });

  it('reports creditsSpent as null when nothing was charged in the range', async () => {
    // A zero under a credits heading reads as "these calls were free".
    const ctx = await seedWorkspace('report-nocredit');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, { arrivedAt: MARCH_2 });

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound?.creditsSpent).toBeNull();
  });

  it('carries the charge as a decimal string when there was one', async () => {
    const ctx = await seedWorkspace('report-credit');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    const call = await seedInboundCall(ctx, campaign, { arrivedAt: MARCH_2 });
    await seedCallUsage(ctx, call.id, 25_000n);

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound?.creditsSpent).toBe('2.5');
  });

  it('carries the verdict breakdown and the repeat-caller histogram', async () => {
    const ctx = await seedWorkspace('report-breakdowns');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, {
      arrivedAt: MARCH_2,
      fromNumber: '+915555555555',
      extraction: { call_outcome_vocobaseplatform: 'completed' },
    });
    await seedInboundCall(ctx, campaign, { arrivedAt: MARCH_2, fromNumber: '+915555555555' });

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound?.outcomes).toContainEqual({ outcome: 'completed', count: 1 });
    expect(report?.inbound?.callerHistogram).toEqual([{ calls: 2, callers: 1 }]);
    expect(report?.inbound?.repeatCallers).toBe(1);
    expect(report?.inbound?.dispositions).toContainEqual({ disposition: 'completed', count: 2 });
  });

  /** Calls outside the range are not this report's. */
  it('ranges the block on arrival like every other figure on the report', async () => {
    const ctx = await seedWorkspace('report-range');
    const campaign = await seedInboundCampaign(ctx, 'Support');
    await seedInboundCall(ctx, campaign, { arrivedAt: MARCH_2 });
    await seedInboundCall(ctx, campaign, { arrivedAt: new Date('2026-01-02T10:00:00Z') });

    const report = await campaignAnalytics(ctx.workspace.id, campaign.id, MARCH);

    expect(report?.inbound?.calls).toBe(1);
  });
});
