import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Campaign, Workspace } from '@prisma/client';

/**
 * The non-negotiable file.
 *
 * The voice platform holds ONE partner account and every workspace's calls sit
 * in one undifferentiated pool. A mistake anywhere on this surface does not
 * lose data — it renders one customer's traffic on another customer's screen,
 * as a number, which is the form a reader is least likely to question.
 *
 * So: every route, every leak shape, one file.
 */
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
const { formatCorrelationId } = await import('../src/lib/callCorrelation.js');
const { resolveAttribution } = await import('../src/services/analyticsIngest.js');
const { truncateAll } = await import('./setup.js');
const { as, makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const app = createApp();

const RANGE = '?from=2026-08-01&to=2026-08-31';

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

interface Side {
  account: Account;
  workspace: Workspace;
  campaign: Campaign;
}

/**
 * One dial the dialer placed — a CAMPAIGN call.
 *
 * Campaign figures come from `CallAttempt`; the ingest never stores a campaign
 * call. Both sources are exercised here because the overview reads both, and a
 * leak in either is the same leak.
 */
async function attempt(who: Side, fields: { disposition?: string | null } = {}) {
  counter += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: who.workspace.id,
      phone: `+1415555${String(counter).padStart(4, '0')}`,
    },
  });
  const link = await prisma.campaignContact.create({
    data: { campaignId: who.campaign.id, contactId: contact.id, attempts: 1 },
  });

  return prisma.callAttempt.create({
    data: {
      campaignId: who.campaign.id,
      campaignContactId: link.id,
      workspaceId: who.workspace.id,
      accountId: who.account.id,
      attemptNo: 1,
      upstreamCallId: `att_${counter}`,
      status: 'COMPLETED',
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
      durationSecs: 60,
    } as never,
  });
}

async function side(handle: string): Promise<Side> {
  const account = await makeAccount(handle);
  const workspace = await makeWorkspace(account, handle);
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: `${handle} campaign` },
  });

  return { account, workspace, campaign };
}

let alice: Side;
let bob: Side;

beforeEach(async () => {
  await truncateAll();
  alice = await side('alice');
  bob = await side('bob');
});

const ROUTES = (workspaceId: string, campaignId: string) => [
  { method: 'get' as const, path: `/api/workspaces/${workspaceId}/analytics/overview` },
  { method: 'get' as const, path: `/api/workspaces/${workspaceId}/analytics/export` },
  {
    method: 'get' as const,
    path: `/api/workspaces/${workspaceId}/campaigns/${campaignId}/analytics`,
  },
  { method: 'post' as const, path: `/api/workspaces/${workspaceId}/analytics/refresh` },
];

describe('a stranger', () => {
  it('is refused on every route', async () => {
    const stranger = await makeAccount('stranger');

    for (const route of ROUTES(alice.workspace.id, alice.campaign.id)) {
      const res = await request(app)
        [route.method](route.path)
        .set(...as(stranger.clerkUserId, stranger.email));

      // 403 from the membership middleware, not 404: which workspace ids exist
      // is withheld by the same guard on every route in this service.
      expect(res.status, route.path).toBe(403);
    }
  });

  it('is refused without any identity at all', async () => {
    for (const route of ROUTES(alice.workspace.id, alice.campaign.id)) {
      const res = await request(app)[route.method](route.path);
      expect(res.status, route.path).toBe(401);
    }
  });
});

describe('the overview', () => {
  it("counts none of the other workspace's calls, from either source", async () => {
    await fact({ workspaceId: alice.workspace.id });
    await attempt(alice);
    await fact({ workspaceId: bob.workspace.id });
    await attempt(bob);
    await attempt(bob);

    const res = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/analytics/overview${RANGE}`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    expect(res.body.data.totals.calls).toBe(2);
    expect(res.body.data.sources).toEqual({ campaignCalls: 1, otherCalls: 1 });
  });

  it("counts none of the other workspace's charges", async () => {
    const theirs = await attempt(bob);
    await prisma.creditTransaction.create({
      data: {
        accountId: bob.account.id,
        workspaceId: bob.workspace.id,
        callAttemptId: theirs.id,
        amount: -50_000n,
        type: 'CALL_USAGE',
      },
    });

    const res = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/analytics/overview${RANGE}`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    expect(res.body.data.totals.creditsSpent).toBeNull();
  });

  it('counts no quarantined call, in either workspace', async () => {
    // `workspaceId IS NULL` is a real state — a call another integrator placed
    // on the shared account, or one on an agent nobody holds. It belongs to
    // nobody, so it is counted by nobody. Splitting it between the two, or
    // showing it to whoever asks first, is the failure this column exists to
    // avoid.
    await fact({ workspaceId: null });

    for (const who of [alice, bob]) {
      const res = await request(app)
        .get(`/api/workspaces/${who.workspace.id}/analytics/overview${RANGE}`)
        .set(...as(who.account.clerkUserId, who.account.email));

      expect(res.body.data.totals.calls).toBe(0);
    }
  });

  it("draws none of the other workspace's calls on the daily series", async () => {
    // The series is its own query — a `$queryRaw` union that scopes each half
    // by hand — so it does not inherit the scoping the totals get from
    // `attemptScope`/`recordScope`. Every other assertion in this file reads
    // `totals`, `sources` or `campaigns`, all of which come from `groupBy`
    // calls; deleting the `workspaceId` predicate from either half of that
    // union left the whole suite green. The series is the chart the dashboard
    // actually draws, so this is the one leak shape a reader would take at
    // face value.
    await fact({ workspaceId: alice.workspace.id });
    await attempt(alice);
    await fact({ workspaceId: bob.workspace.id });
    await attempt(bob);
    await attempt(bob);

    const res = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/analytics/overview${RANGE}`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    const drawn = res.body.data.series.reduce(
      (sum: number, point: { calls: number }) => sum + point.calls,
      0,
    );
    expect(drawn).toBe(2);
    // And it agrees with the figure printed above it. A chart that disagrees
    // with its own tile is how a leak here would first be noticed.
    expect(drawn).toBe(res.body.data.totals.calls);
  });

  it("never names the other workspace's campaign", async () => {
    await attempt(bob);

    const res = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/analytics/overview${RANGE}`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    expect(res.body.data.campaigns).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(bob.campaign.name);
  });
});

describe('campaign analytics', () => {
  it("answers 404 for the other workspace's campaign", async () => {
    await attempt(bob);

    const res = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/campaigns/${bob.campaign.id}/analytics${RANGE}`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    expect(res.status).toBe(404);
  });

  it('answers a real foreign id exactly as it answers nonsense', async () => {
    // Identical status, identical body. Anything that distinguished the two
    // would let a caller sort ids into real and unreal by watching the response.
    const foreign = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/campaigns/${bob.campaign.id}/analytics`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    const nonsense = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/campaigns/does-not-exist/analytics`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    expect(foreign.status).toBe(nonsense.status);
    expect(foreign.body).toEqual(nonsense.body);
    expect(JSON.stringify(foreign.body)).not.toContain(bob.campaign.name);
  });
});

describe('the export', () => {
  it("contains none of the other workspace's rows", async () => {
    await fact({ workspaceId: alice.workspace.id, phone: '+10000000001' });
    await fact({ workspaceId: bob.workspace.id, phone: '+10000000002' });
    await fact({ workspaceId: null, phone: '+10000000003' });
    // And the campaign half of the file, which merges into the same stream.
    await attempt(bob);

    const res = await request(app)
      .get(`/api/workspaces/${alice.workspace.id}/analytics/export${RANGE}`)
      .set(...as(alice.account.clerkUserId, alice.account.email));

    expect(res.text).toContain('10000000001');
    expect(res.text).not.toContain('10000000002');
    expect(res.text).not.toContain('10000000003');
    expect(res.text).not.toContain(bob.campaign.name);
  });
});

describe('a forged correlation key', () => {
  it('is quarantined rather than credited to the campaign it names', async () => {
    // The attack this surface has to survive. `client_reference_id` is free
    // text on an account every customer of the platform shares, and a campaign
    // id is an ordinary identifier every member of a workspace can read — so
    // anyone able to place a call on that account can write one into a call of
    // their own. The second factor is the contact id, which names a row they
    // cannot see and cannot guess.
    const contactOfAlice = await prisma.contact.create({
      data: { workspaceId: alice.workspace.id, phone: '+14155550111' },
    });
    const aliceContact = await prisma.campaignContact.create({
      data: { campaignId: alice.campaign.id, contactId: contactOfAlice.id },
    });

    const [forged] = await resolveAttribution([
      {
        call_id: 'forged',
        // Bob's campaign, Alice's contact. Each half is real; together they are
        // not a key this platform ever stamped.
        client_reference_id: formatCorrelationId(bob.campaign.id, aliceContact.id),
      },
    ]);

    // Not treated as a campaign call — so not skipped as one either — and with
    // no agent to catch it, attributed to nobody.
    expect(forged.campaignCall).toBe(false);
    expect(forged.workspaceId).toBeNull();
  });

  it('does not reach anybody\u2019s chart even when it is stored', async () => {
    // Belt to the braces above: a quarantined row is invisible everywhere, and
    // a campaign report cannot see CallRecord rows at all.
    await fact({ workspaceId: null });

    for (const who of [alice, bob]) {
      const overview = await request(app)
        .get(`/api/workspaces/${who.workspace.id}/analytics/overview${RANGE}`)
        .set(...as(who.account.clerkUserId, who.account.email));

      expect(overview.body.data.totals.calls).toBe(0);
    }

    const report = await request(app)
      .get(`/api/workspaces/${bob.workspace.id}/campaigns/${bob.campaign.id}/analytics${RANGE}`)
      .set(...as(bob.account.clerkUserId, bob.account.email));

    expect(report.body.data.totals.calls).toBe(0);
  });
});

describe('an agent that has moved', () => {
  it('does not carry its old calls onto its new workspace', async () => {
    // Staff reassignment is an UPDATE no constraint can see. The fact rows were
    // attributed when the calls happened, and attribution does not move.
    const agent = await makeAgent(alice.workspace, 'Travelling');
    await fact({ workspaceId: alice.workspace.id, agentId: agent.id });

    await prisma.agent.update({
      where: { id: agent.id },
      data: { workspaceId: bob.workspace.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${bob.workspace.id}/analytics/overview${RANGE}`)
      .set(...as(bob.account.clerkUserId, bob.account.email));

    expect(res.body.data.totals.calls).toBe(0);
  });
});
