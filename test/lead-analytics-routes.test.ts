import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Campaign, Workspace } from '@prisma/client';

// No test may reach the real partner API. `createApp()` mounts every router,
// and a mock missing an export the app imports fails the whole file at load.
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

const app = createApp();

const PATH = (workspaceId: string) => `/api/workspaces/${workspaceId}/analytics/leads/outcome`;
const RANGE = 'from=2026-08-01&to=2026-08-31';

let counter = 0;

interface Fx {
  owner: Account;
  workspace: Workspace;
  campaign: Campaign;
}

async function seed(handle: string): Promise<Fx> {
  const owner = await makeAccount(handle);
  const workspace = await makeWorkspace(owner, handle);
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: `${handle} campaign` },
  });

  return { owner, workspace, campaign };
}

/** One lead, reached once inside the range. */
async function reachedLead(fx: Fx, campaign?: Campaign) {
  counter += 1;
  const target = campaign ?? fx.campaign;

  const contact = await prisma.contact.create({
    data: {
      workspaceId: target.workspaceId,
      phone: `+1415777${String(counter).padStart(4, '0')}`,
    },
  });
  const lead = await prisma.campaignContact.create({
    data: {
      campaignId: target.id,
      contactId: contact.id,
      attempts: 1,
      status: 'COMPLETED',
      goalAchieved: true,
      lastAttemptAt: new Date('2026-08-10T11:59:00.000Z'),
    },
  });

  await prisma.callAttempt.create({
    data: {
      campaignId: target.id,
      campaignContactId: lead.id,
      workspaceId: target.workspaceId,
      accountId: fx.owner.id,
      attemptNo: 1,
      upstreamCallId: `lead_route_${counter}`,
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

describe('GET /analytics/leads/outcome', () => {
  it('answers a member with the lead payload', async () => {
    const fx = await seed('leadroute');
    await reachedLead(fx);

    const res = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totals.attemptedLeads).toBe(1);
    expect(res.body.data.totals.connectedLeads).toBe(1);
    expect(res.body.data.population).toBe(1);
    expect(res.body.data.goal).toEqual({ yes: 1, no: 0, notEvaluated: 0 });
    expect(res.body.data.interest.distinctKeys).toBe(0);
    // The resolved window rides back, so a caller never has to infer which
    // days it was actually answered over.
    expect(res.body.data.range).toBeTruthy();
  });

  it('is open to a MEMBER, like every other read on this router', async () => {
    const fx = await seed('leadroutemember');
    const member = await makeAccount('leadroutemember2');
    await addMember(fx.workspace, member, 'MEMBER');
    await reachedLead(fx);

    const res = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}`)
      .set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(200);
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const mine = await seed('leadroutemine');
    const theirs = await seed('leadroutetheirs');
    await reachedLead(theirs);

    const res = await request(app)
      .get(`${PATH(theirs.workspace.id)}?${RANGE}`)
      .set(...as(mine.owner.clerkUserId, mine.owner.email));

    // The membership middleware's answer, and it must not carry any figure
    // from the workspace it refused.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('attemptedLeads');
  });

  it('rejects a malformed range rather than defaulting past it', async () => {
    const fx = await seed('leadrouterange');

    const res = await request(app)
      .get(`${PATH(fx.workspace.id)}?from=2026-08-31&to=2026-08-01`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(400);
  });

  it('narrows to a named campaign', async () => {
    const fx = await seed('leadroutefilter');
    const other = await prisma.campaign.create({
      data: { workspaceId: fx.workspace.id, name: 'Other' },
    });
    await reachedLead(fx);
    await reachedLead(fx, other);

    const res = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}&campaignId=${fx.campaign.id}`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.totals.attemptedLeads).toBe(1);
  });

  it('404s a campaign id from another workspace rather than ignoring it', async () => {
    const mine = await seed('leadroutescopemine');
    const theirs = await seed('leadroutescopetheirs');
    await reachedLead(mine);

    const res = await request(app)
      .get(`${PATH(mine.workspace.id)}?${RANGE}&campaignId=${theirs.campaign.id}`)
      .set(...as(mine.owner.clerkUserId, mine.owner.email));

    // Not an empty result: silently widening to the whole workspace would
    // answer a question the caller did not ask, and answering 200 with zeros
    // would make the filter an existence oracle over other workspaces' ids.
    expect(res.status).toBe(404);
  });
});

describe('GET /analytics/leads/activity', () => {
  const ACTIVITY = (id: string) => `/api/workspaces/${id}/analytics/leads/activity`;

  it('answers with the activity payload and echoes the zone', async () => {
    const fx = await seed('actroute');
    await reachedLead(fx);

    const res = await request(app)
      .get(`${ACTIVITY(fx.workspace.id)}?${RANGE}&tz=America/New_York`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.timeZone).toBe('America/New_York');
    expect(res.body.data.totals.connectedLeads).toBe(1);
    expect(res.body.data.callerIds).toHaveLength(1);
    expect(res.body.data.weekly).toHaveLength(1);
  });

  it('defaults the zone to UTC', async () => {
    const fx = await seed('actrouteutc');
    await reachedLead(fx);

    const res = await request(app)
      .get(`${ACTIVITY(fx.workspace.id)}?${RANGE}`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.timeZone).toBe('UTC');
  });

  it('answers 400 on an unresolvable zone, not 500', async () => {
    const fx = await seed('actroutebadtz');

    const res = await request(app)
      .get(`${ACTIVITY(fx.workspace.id)}?${RANGE}&tz=Mars/Olympus`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(400);
    // The caller's own string is not echoed back into the body.
    expect(JSON.stringify(res.body)).not.toContain('Mars/Olympus');
  });
});

describe('GET /analytics/leads/spend', () => {
  const SPEND = (id: string) => `/api/workspaces/${id}/analytics/leads/spend`;

  it('answers with the spend payload', async () => {
    const fx = await seed('spendroute');
    await reachedLead(fx);

    const res = await request(app)
      .get(`${SPEND(fx.workspace.id)}?${RANGE}`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.metered).toBe(true);
    // Nothing was charged, so null rather than "0" — the page prints a
    // dash, never a figure nobody was billed.
    expect(res.body.data.totalSpend).toBeNull();
    expect(res.body.data.timeline.length).toBeGreaterThan(0);
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const mine = await seed('spendroutemine');
    const theirs = await seed('spendroutetheirs');

    const res = await request(app)
      .get(`${SPEND(theirs.workspace.id)}?${RANGE}`)
      .set(...as(mine.owner.clerkUserId, mine.owner.email));

    expect(res.status).toBe(403);
  });
});

describe('shared lead filters on the routes', () => {
  it('narrows by campaign status and lead state', async () => {
    const fx = await seed('routefilters');
    const stopped = await prisma.campaign.create({
      data: { workspaceId: fx.workspace.id, name: 'Stopped', status: 'STOPPED' },
    });
    await reachedLead(fx);
    await reachedLead(fx, stopped);

    const res = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}&campaignStatus=STOPPED`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.population).toBe(1);
  });

  it('rejects an unknown filter value rather than dropping it', async () => {
    const fx = await seed('routefiltersbad');

    const status = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}&campaignStatus=NONSENSE`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));
    const state = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}&leadState=NONSENSE`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    // Dropped silently, a request naming three states answered over two —
    // under a control still showing three — is wrong invisibly.
    expect(status.status).toBe(400);
    expect(state.status).toBe(400);
  });

  it('rejects a backwards lead-creation window', async () => {
    const fx = await seed('routefiltersorder');

    const res = await request(app)
      .get(
        `${PATH(fx.workspace.id)}?${RANGE}` +
          '&leadCreatedFrom=2026-08-31&leadCreatedUntil=2026-08-01',
      )
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    expect(res.status).toBe(400);
  });

  it('includes leads created on the day leadCreatedUntil names', async () => {
    const fx = await seed('routecreateduntil');
    const lead = await reachedLead(fx);
    await prisma.campaignContact.update({
      where: { id: lead.id },
      data: { createdAt: new Date('2026-07-15T14:30:00.000Z') },
    });

    const res = await request(app)
      .get(`${PATH(fx.workspace.id)}?${RANGE}&leadCreatedUntil=2026-07-15`)
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    // A bare date is a whole UTC DAY, and which whole day depends on which
    // end it is — the rule `parseAnalyticsRange` already holds for the range
    // beside this one. Read as midnight, "until 15 July" excludes every lead
    // created on 15 July, and the dashboard's <input type="date"> can send
    // nothing else, so the buggy reading was the only reachable one.
    expect(res.status).toBe(200);
    expect(res.body.data.totals.attemptedLeads).toBe(1);
  });

  it('answers a single-day lead-creation window with that day', async () => {
    const fx = await seed('routecreatedsingle');
    const lead = await reachedLead(fx);
    await prisma.campaignContact.update({
      where: { id: lead.id },
      data: { createdAt: new Date('2026-07-15T09:00:00.000Z') },
    });

    const res = await request(app)
      .get(
        `${PATH(fx.workspace.id)}?${RANGE}` +
          '&leadCreatedFrom=2026-07-15&leadCreatedUntil=2026-07-15',
      )
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    // The obvious "leads that came in on Monday" query. With both bounds at
    // midnight it matched only a lead created at exactly 00:00:00.000, so
    // every tile, ring and table on all four tabs read zero — and the
    // ordering guard passed, so there was no 400 to hint at it.
    expect(res.status).toBe(200);
    expect(res.body.data.totals.attemptedLeads).toBe(1);
  });

  it('applies the same filters on activity and spend', async () => {
    const fx = await seed('routefiltersall');
    const stopped = await prisma.campaign.create({
      data: { workspaceId: fx.workspace.id, name: 'Stopped', status: 'STOPPED' },
    });
    await reachedLead(fx);
    await reachedLead(fx, stopped);

    const activity = await request(app)
      .get(
        `/api/workspaces/${fx.workspace.id}/analytics/leads/activity?${RANGE}` +
          '&campaignStatus=STOPPED',
      )
      .set(...as(fx.owner.clerkUserId, fx.owner.email));
    const spend = await request(app)
      .get(
        `/api/workspaces/${fx.workspace.id}/analytics/leads/spend?${RANGE}` +
          '&campaignStatus=NONSENSE',
      )
      .set(...as(fx.owner.clerkUserId, fx.owner.email));

    // One filter bar sits above all four tabs, so a filter honoured on one
    // and ignored on another means two tabs describing different populations
    // under one set of controls.
    expect(activity.status).toBe(200);
    expect(activity.body.data.totals.connectedLeads).toBe(1);
    expect(spend.status).toBe(400);
  });
});
