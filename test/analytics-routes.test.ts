import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Campaign, Workspace } from '@prisma/client';

// No test may reach the real partner API. `createApp()` mounts every router, and
// a mock missing an export the app imports fails the whole file at load.
vi.mock('../src/adapter/vocobase.js', () => ({
  listCalls: vi.fn(async () => ({ calls: [] })),
  getCall: vi.fn(),
  getCallRecordingUrl: vi.fn(),
  fetchRecording: vi.fn(),
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  listPurchasedDids: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { createApp } = await import('../src/app.js');
const { truncateAll } = await import('./setup.js');
const { addMember, as, makeAccount, makeWorkspace } = await import('./helpers.js');
const { resetAnalyticsSyncState } = await import('../src/services/analyticsIngest.js');

const app = createApp();

let counter = 0;

async function fact(fields: Record<string, unknown>) {
  counter += 1;
  return prisma.callRecord.create({
    data: {
      upstreamCallId: `call_${counter}`,
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
      status: 'completed',
      disposition: 'completed',
      durationSecs: 60,
      ...fields,
    } as never,
  });
}


/**
 * One dial the dialer placed — a CAMPAIGN call.
 *
 * Campaign figures come from `CallAttempt` now: the analytics ingest never
 * stores a campaign call, because the dialer already recorded it.
 */
async function attempt(
  fx: { owner: Account; workspace: Workspace; campaign: Campaign },
  fields: { disposition?: string | null; startedAt?: Date } = {},
) {
  counter += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: fx.workspace.id,
      phone: `+1415555${String(counter).padStart(4, '0')}`,
    },
  });
  const link = await prisma.campaignContact.create({
    // `lastAttemptAt` beside the spent retry, because the claim writes the two
    // together and the funnel's `attempted` stage reads the timestamp.
    data: {
      campaignId: fx.campaign.id,
      contactId: contact.id,
      attempts: 1,
      lastAttemptAt: new Date('2026-08-10T11:59:00.000Z'),
    },
  });

  return prisma.callAttempt.create({
    data: {
      campaignId: fx.campaign.id,
      campaignContactId: link.id,
      workspaceId: fx.workspace.id,
      accountId: fx.owner.id,
      attemptNo: 1,
      upstreamCallId: `att_${counter}`,
      status: 'COMPLETED',
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      startedAt: fields.startedAt ?? new Date('2026-08-10T12:00:00.000Z'),
      durationSecs: 60,
    } as never,
  });
}

interface Fixture {
  owner: Account;
  member: Account;
  workspace: Workspace;
  campaign: Campaign;
}

async function fixture(handle: string): Promise<Fixture> {
  const owner = await makeAccount(`${handle}-owner`);
  const member = await makeAccount(`${handle}-member`);
  const workspace = await makeWorkspace(owner, handle);
  await addMember(workspace, member, 'MEMBER');

  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: `${handle} campaign` },
  });

  return { owner, member, workspace, campaign };
}

const RANGE = '?from=2026-08-01&to=2026-08-31';

beforeEach(async () => {
  await truncateAll();
  resetAnalyticsSyncState();
});

describe('GET /analytics/overview', () => {
  it('answers any member with totals, series and campaigns, across both sources', async () => {
    const fx = await fixture('overview');
    await attempt(fx);
    await fact({ workspaceId: fx.workspace.id, disposition: 'no_answer' });

    const res = await request(app)
      .get(`/api/workspaces/${fx.workspace.id}/analytics/overview${RANGE}`)
      .set(...as(fx.member.clerkUserId, fx.member.email));

    expect(res.status).toBe(200);
    expect(res.body.data.totals).toMatchObject({ calls: 2, connected: 1, answerRate: 0.5 });
    // One campaign call and one of everything else, named apart because the
    // two halves have different freshness.
    expect(res.body.data.sources).toEqual({ campaignCalls: 1, otherCalls: 1 });
    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.series.length).toBe(31);
    // Minutes are billed on this platform.
    expect(res.body.data.metered).toBe(true);
  });

  it('echoes the range it answered over', async () => {
    const { owner, workspace } = await fixture('echo');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/overview${RANGE}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data.range).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    });
  });

  it('defaults the range and still says what it used', async () => {
    const { owner, workspace } = await fixture('default');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/overview`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(typeof res.body.data.range.from).toBe('string');
    expect(typeof res.body.data.range.to).toBe('string');
  });

  it('reports how far back the data goes, and whether the last pass truncated', async () => {
    // A workspace with calls from March, looking at a table seeded in August,
    // is not a workspace with no calls in March. Saying where the data begins
    // is the only thing that stops the page asserting otherwise.
    const { owner, workspace } = await fixture('coverage');
    await prisma.analyticsCursor.create({
      data: {
        id: 'singleton',
        coverageFrom: new Date('2026-08-05T00:00:00.000Z'),
        lastRunAt: new Date('2026-08-31T00:00:00.000Z'),
        lastRunTruncated: true,
      },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/overview${RANGE}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data.coverage).toMatchObject({
      from: '2026-08-05T00:00:00.000Z',
      truncated: true,
    });
  });

  it('reports coverage as unknown before the first pass, not as complete', async () => {
    const { owner, workspace } = await fixture('nocoverage');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/overview${RANGE}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data.coverage).toMatchObject({ from: null, lastRunAt: null });
  });

  it('refuses a malformed range rather than answering over a different one', async () => {
    const { owner, workspace } = await fixture('badrange');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/overview?from=2026-08-31&to=2026-08-01`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /campaigns/:cid/analytics', () => {
  it('answers any member with the funnel and the breakdown', async () => {
    const { owner, member, workspace, campaign } = await fixture('campaign');
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+14155550101' },
    });
    await prisma.campaignContact.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        attempts: 1,
        lastAttemptAt: new Date('2026-08-10T11:59:00.000Z'),
      },
    });
    await attempt({ owner, workspace, campaign });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/analytics${RANGE}`)
      .set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(200);
    // Two contacts: the one seeded above and the one the attempt brought.
    expect(res.body.data.funnel).toMatchObject({ contacts: 2, attempted: 2, connected: 1 });
    expect(res.body.data.campaign).toMatchObject({ id: campaign.id });
    expect(res.body.data.outcomes).toHaveLength(7);
  });

  /**
   * The block is a MEMBER read, like every other figure on this report.
   *
   * The route is `requireMembership()` with no role floor and must stay that
   * way: nothing in an aggregate over a workspace's own calls is sensitive to a
   * MEMBER that an ADMIN should see instead, and a MEMBER operating a campaign
   * is exactly the person who needs to know whether it is answering.
   */
  it('carries the inbound block for an INBOUND campaign, to any member', async () => {
    const { member, workspace } = await fixture('inbound-route');
    const did = await prisma.phoneNumber.create({
      data: { did: '+919400000077', workspaceId: workspace.id, status: 'ASSIGNED' },
    });
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Support', type: 'INBOUND' },
    });
    await prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id,
        workspaceId: workspace.id,
        phoneNumberId: did.id,
        fromNumber: '+919876500001',
        arrivedAt: new Date('2026-08-10T10:00:00.000Z'),
        endedAt: new Date('2026-08-10T10:01:00.000Z'),
        durationSecs: 60,
        disposition: 'completed',
      },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/analytics${RANGE}`)
      .set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(200);
    expect(res.body.data.inbound).toMatchObject({ calls: 1, callers: 1, talkSecs: 60 });
  });

  it('sends no inbound key at all on an OUTBOUND campaign', async () => {
    // On the WIRE, which is the check that matters: a spread `undefined` would
    // vanish here and still answer `'inbound' in report` on the service.
    const { owner, workspace, campaign } = await fixture('outbound-route');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/analytics${RANGE}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect('inbound' in res.body.data).toBe(false);
  });

  it('404s a campaign id that names nothing', async () => {
    const { owner, workspace } = await fixture('missing');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/campaigns/nope/analytics`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
  });
});

describe('GET /analytics/export', () => {
  it('streams a CSV with the right headers', async () => {
    const { member, workspace } = await fixture('export');
    await fact({ workspaceId: workspace.id, phone: '+14155550100' });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/export${RANGE}`)
      .set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.csv');
    // Never cached: this is one customer's call log leaving through a URL a
    // shared cache has no way to scope.
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.text).toContain('call_id,started_at');
    expect(res.text).toContain(`"'+14155550100"`);
  });

  it('narrows to one campaign when asked', async () => {
    const fx = await fixture('exportcampaign');
    await attempt(fx);
    await fact({ workspaceId: fx.workspace.id, phone: '+10000000002' });

    const res = await request(app)
      .get(
        `/api/workspaces/${fx.workspace.id}/analytics/export${RANGE}&campaignId=${fx.campaign.id}`,
      )
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.text).toContain(fx.campaign.name);
    // The non-campaign source is dropped entirely, not filtered.
    expect(res.text).not.toContain('10000000002');
  });

  it('404s a campaign filter naming another workspace, never exporting everything', async () => {
    // The failure mode this guard exists for: a reader who asked for one
    // campaign and silently received the whole workspace has no way to tell.
    const mine = await fixture('exportmine');
    const theirs = await fixture('exporttheirs');
    await fact({ workspaceId: mine.workspace.id, phone: '+10000000009' });

    const res = await request(app)
      .get(
        `/api/workspaces/${mine.workspace.id}/analytics/export${RANGE}&campaignId=${theirs.campaign.id}`,
      )
      .set(...as(mine.owner.clerkUserId, mine.owner.email));

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('10000000009');
  });

  it('refuses a malformed range before writing any of the body', async () => {
    // Once the header row is out there is no way left to report a failure, so
    // the range has to be parsed before the first byte.
    const { owner, workspace } = await fixture('exportbad');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/analytics/export?from=nonsense`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('json');
  });
});

describe('POST /analytics/refresh', () => {
  it('runs a pass for an ADMIN and reports what it did', async () => {
    const { owner, workspace } = await fixture('refresh');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/analytics/refresh`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    // A refresh that said only "done" teaches the reader nothing about why the
    // chart did not change.
    expect(res.body.data).toMatchObject({ created: 0, updated: 0, truncated: false });
  });

  it('refuses a MEMBER', async () => {
    // Everything else here is readable by any member, and this is not a read:
    // it spends the partner account's rate limit on behalf of every workspace,
    // from one workspace's page.
    const { member, workspace } = await fixture('refreshmember');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/analytics/refresh`)
      .set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(403);
  });

  it('is rate limited per workspace', async () => {
    const { owner, workspace } = await fixture('refreshlimit');

    const results: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app)
        .post(`/api/workspaces/${workspace.id}/analytics/refresh`)
        .set(...as(owner.clerkUserId, owner.email));
      results.push(res.status);
    }

    expect(results).toContain(429);
  });
});
