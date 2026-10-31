import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { addMember, as, makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const app = createApp();
const AUTH = as('user_alice', 'alice@ezo.test');

async function seed() {
  const alice = await makeAccount('alice');
  await prisma.account.update({
    where: { id: alice.id },
    data: { credits: toInternalCredits('100'), concurrencyLimit: 6 },
  });

  const ws = await makeWorkspace(alice, 'A Co');
  const agent = await makeAgent(ws, 'Sales');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id, status: 'RUNNING', concurrencyLimit: 3 },
  });

  const link = async (phone: string, status: 'PENDING' | 'COMPLETED' | 'FAILED' = 'PENDING') => {
    const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone } });
    return prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status },
    });
  };

  return { alice, ws, campaign, link };
}

const attempt = (over: Record<string, unknown>) => ({
  attemptNo: 1,
  status: 'QUEUED' as const,
  ...over,
});

beforeEach(truncateAll);
afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

describe('the stats payload', () => {
  /**
   * The Stats tab shipped against `total` and `byStatus`. Widening a payload
   * must not move what is already in it.
   */
  it('keeps the counts it already had, in the same shape', async () => {
    const { ws, campaign, link } = await seed();
    await link('+919876500001');
    await link('+919876500002', 'COMPLETED');

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.byStatus).toMatchObject({
      PENDING: 1,
      QUEUED: 0,
      CALLING: 0,
      COMPLETED: 1,
      FAILED: 0,
      EXCLUDED: 0,
    });
  });

  it('reports lines in use against both the campaign and the account limits', async () => {
    const { alice, ws, campaign, link } = await seed();
    const one = await link('+919876500001');

    await prisma.callAttempt.create({
      data: attempt({
        campaignId: campaign.id,
        campaignContactId: one.id,
        workspaceId: ws.id,
        accountId: alice.id,
        status: 'IN_PROGRESS',
      }),
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    expect(res.body.data.dialer).toMatchObject({
      inFlight: 1,
      campaignConcurrency: 3,
      accountInFlight: 1,
      accountConcurrency: 6,
      enabled: true,
    });
  });

  /**
   * A campaign with two hundred pending contacts and two calls out looks
   * broken. Saying "2 of 3 lines in use" turns a suspected fault into a
   * visible limit.
   */
  it('says the dialer is off when it is off', async () => {
    vi.resetModules();
    process.env.DIALER_ENABLED = 'false';
    const { createApp: build } = await import('../src/app.js');
    const off = build();

    const { ws, campaign } = await seed();

    const res = await request(off)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    expect(res.body.data.dialer.enabled).toBe(false);

    vi.resetModules();
    process.env.DIALER_ENABLED = 'true';
  });

  it('reports a closed window with the time it next opens', async () => {
    const { ws, campaign } = await seed();
    await prisma.campaign.update({
      where: { id: campaign.id },
      // A one-minute window, so it is closed at essentially every instant.
      data: { fromTime: '03:00', toTime: '03:01', timezone: 'Asia/Kolkata' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    expect(['open', 'closed']).toContain(res.body.data.dialer.window.state);
    if (res.body.data.dialer.window.state === 'closed') {
      expect(res.body.data.dialer.window.opensAt).toBeTruthy();
    }
  });

  it('names an incomplete window as incomplete rather than as closed', async () => {
    const { ws, campaign } = await seed();
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { fromTime: '09:00', timezone: 'Asia/Kolkata' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    expect(res.body.data.dialer.window.state).toBe('incomplete');
  });
});

describe('spend so far', () => {
  /**
   * Summed from the ledger, not from the attempts. `CallAttempt.costCredits`
   * also records what was *owed* on a shortfall and never charged, and adding
   * those in would show a workspace spending credits it still holds.
   */
  it('sums the ledger rather than the attempts', async () => {
    const { alice, ws, campaign, link } = await seed();
    const one = await link('+919876500001');
    const two = await link('+919876500002');

    const charged = await prisma.callAttempt.create({
      data: attempt({
        campaignId: campaign.id,
        campaignContactId: one.id,
        workspaceId: ws.id,
        accountId: alice.id,
        status: 'COMPLETED',
        costCredits: toInternalCredits('2.00'),
        chargedAt: new Date(),
      }),
    });
    const owed = await prisma.callAttempt.create({
      data: attempt({
        campaignId: campaign.id,
        campaignContactId: two.id,
        workspaceId: ws.id,
        accountId: alice.id,
        status: 'COMPLETED',
        // Owed and never taken.
        costCredits: toInternalCredits('5.00'),
        shortfall: true,
        chargedAt: new Date(),
      }),
    });

    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        workspaceId: ws.id,
        callAttemptId: charged.id,
        reference: charged.id,
        amount: -toInternalCredits('2.00'),
        type: 'CALL_USAGE',
      },
    });
    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        workspaceId: ws.id,
        callAttemptId: owed.id,
        reference: owed.id,
        amount: 0n,
        type: 'CALL_USAGE_SHORTFALL',
      },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    // 2, not 7: the shortfall was never charged. (`toDisplayCredits` trims
    // trailing zeros, as it does everywhere else on the wire.)
    expect(res.body.data.dialer.spendCredits).toBe('2');
  });

  it('is zero for a campaign that has not been charged for anything', async () => {
    const { ws, campaign } = await seed();

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...AUTH);

    expect(res.body.data.dialer.spendCredits).toBe('0');
  });
});

describe('the attempts feed', () => {
  async function withAttempts(count: number) {
    const { alice, ws, campaign, link } = await seed();
    const one = await link('+919876500001');

    for (let i = 0; i < count; i += 1) {
      await prisma.callAttempt.create({
        data: attempt({
          campaignId: campaign.id,
          campaignContactId: one.id,
          workspaceId: ws.id,
          accountId: alice.id,
          attemptNo: i + 1,
          status: 'COMPLETED',
          disposition: 'voicemail',
          durationSecs: 30,
          costCredits: toInternalCredits('0.50'),
          chargedAt: new Date(),
          startedAt: new Date(Date.now() - i * 1000),
          upstreamCallId: `c_${i}`,
          upstreamSessionId: `s_${i}`,
          rateCreditsPerMin: toInternalCredits('1.00'),
        }),
      });
    }

    return { ws, campaign };
  }

  it('lists attempts newest first with the contact on each', async () => {
    const { ws, campaign } = await withAttempts(3);

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/attempts`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.items[0].attempt_no).toBe(1);
    expect(res.body.data.items[0].contact.phone).toBe('+919876500001');
    expect(res.body.data.items[0].disposition).toBe('voicemail');
    expect(res.body.data.items[0].cost_credits).toBe('0.5');
  });

  it('names the platform’s own reason when it ended the dial', async () => {
    const { ws, campaign } = await withAttempts(1);
    await prisma.callAttempt.updateMany({
      where: { campaignId: campaign.id },
      data: { errorCode: 'DIAL_TRANSPORT_FAILURE', errorMessage: 'Could not reach the carrier' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/attempts`)
      .set(...AUTH);

    expect(res.body.data.items[0].error_code).toBe('DIAL_TRANSPORT_FAILURE');
    expect(res.body.data.items[0].error_message).toBe('Could not reach the carrier');
    // The sentence beside them, which is what the feed prints.
    expect(res.body.data.items[0].failure_reason).toContain('could not reach the carrier');
    expect(res.body.data.items[0].failure_reason).not.toContain('DIAL_TRANSPORT_FAILURE');
  });

  it('carries a null failure reason on a dial whose outcome speaks for itself', async () => {
    const { ws, campaign } = await withAttempts(1);

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/attempts`)
      .set(...AUTH);

    expect(res.body.data.items[0]).toHaveProperty('failure_reason', null);
  });

  /**
   * The same allow-list rule the calls surface holds. These handles are worth
   * nothing to a customer and a good deal to anybody mapping a shared partner
   * account.
   */
  it('never puts the platform’s own call handles on the wire', async () => {
    const { ws, campaign } = await withAttempts(1);

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/attempts`)
      .set(...AUTH);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('c_0');
    expect(body).not.toContain('s_0');
    expect(body).not.toContain('upstreamCallId');
    // Nor what YE charges per minute, which belongs on the plan card.
    expect(body).not.toContain('rateCreditsPerMin');
    expect(body).not.toContain('tierId');
  });

  it('paginates', async () => {
    const { ws, campaign } = await withAttempts(5);

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/attempts?page=2&limit=2`)
      .set(...AUTH);

    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.total).toBe(5);
  });

  it('is readable by a MEMBER', async () => {
    const { ws, campaign } = await withAttempts(1);
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/attempts`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(200);
  });
});

describe('isolation', () => {
  it('404s a campaign belonging to another workspace', async () => {
    const { ws } = await seed();
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'B Co');
    const foreign = await prisma.campaign.create({
      data: { workspaceId: theirs.id, name: 'Theirs' },
    });

    for (const path of ['stats', 'attempts']) {
      const res = await request(app)
        .get(`/api/workspaces/${ws.id}/campaigns/${foreign.id}/${path}`)
        .set(...AUTH);

      // Not a 403 — that would confirm the id names something real.
      expect(res.status).toBe(404);
    }
  });

  it('403s a workspace the caller is not a member of', async () => {
    const { campaign } = await seed();
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'B Co');

    const res = await request(app)
      .get(`/api/workspaces/${theirs.id}/campaigns/${campaign.id}/attempts`)
      .set(...AUTH);

    expect(res.status).toBe(403);
  });
});
