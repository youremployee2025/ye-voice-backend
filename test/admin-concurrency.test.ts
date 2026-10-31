import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  getConcurrency: vi.fn(),
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getCall: vi.fn(),
}));

process.env.ADMIN_STAFF_TOKEN = 'staff-token-for-concurrency-tests';

const { getConcurrency } = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const mockedGetConcurrency = vi.mocked(getConcurrency);
const app = createApp();
const STAFF = ['X-Admin-Token', process.env.ADMIN_STAFF_TOKEN!] as const;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 3, remaining: 97 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

describe('GET /api/admin/concurrency', () => {
  it('reports the pool, the allotments and the headroom', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { concurrencyLimit: 10 } });
    await makeAccount('bob'); // no allotment: falls back to the default

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);

    expect(res.status).toBe(200);
    expect(res.body.data.pool).toMatchObject({ limit: 100, active: 3, remaining: 97 });
    // 10 for alice + the default for bob.
    expect(res.body.data.allotted).toBe(10 + res.body.data.default_concurrency);
    expect(res.body.data.headroom).toBe(100 - res.body.data.allotted);
    expect(res.body.data.overcommitted).toBe(0);
  });

  /**
   * The console must draw the same distinction the tier page does between an
   * account's own value and the platform default it is falling back to.
   */
  it('distinguishes a staff-set allotment from the default', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { concurrencyLimit: 10 } });
    await makeAccount('bob');

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);
    const rows: Array<Record<string, unknown>> = res.body.data.accounts;

    const set = rows.find((row) => row.email === 'alice@ezo.test');
    const unset = rows.find((row) => row.email === 'bob@ezo.test');

    expect(set).toMatchObject({ concurrency_limit: 10, resolved_concurrency: 10 });
    expect(unset).toMatchObject({
      concurrency_limit: null,
      resolved_concurrency: res.body.data.default_concurrency,
    });
  });

  /**
   * Zero is a value staff set, meaning this account may not dial. It must not
   * come back looking like an account with no allotment at all.
   */
  it('reports a deliberate zero as zero rather than as unset', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { concurrencyLimit: 0 } });

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);
    const row = res.body.data.accounts.find(
      (r: Record<string, unknown>) => r.email === 'alice@ezo.test',
    );

    expect(row.concurrency_limit).toBe(0);
    expect(row.resolved_concurrency).toBe(0);
  });

  it('counts what each account currently has in flight', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id, status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876500001' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    // Three dials of one contact, so three distinct attempt numbers: the
    // unique on (contact, attemptNo) is what makes one number one call.
    for (const [index, status] of (['QUEUED', 'IN_PROGRESS', 'COMPLETED'] as const).entries()) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ws.id,
          accountId: alice.id,
          attemptNo: index + 1,
          status,
        },
      });
    }

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);
    const row = res.body.data.accounts.find(
      (r: Record<string, unknown>) => r.email === 'alice@ezo.test',
    );

    // Two live, one settled.
    expect(row.in_flight).toBe(2);
  });

  /**
   * An allotment is YE's commercial decision and does not depend on the
   * supplier answering. Staff must still be able to see and change allotments
   * when the platform is unreachable.
   */
  it('serves the allotments with the pool marked unavailable when it cannot be read', async () => {
    mockedGetConcurrency.mockRejectedValue(new Error('platform down'));
    await makeAccount('alice');

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);

    expect(res.status).toBe(200);
    // Null, never 0 — zero would read as "the platform has no capacity".
    expect(res.body.data.pool).toBeNull();
    expect(res.body.data.headroom).toBeNull();
    expect(res.body.data.overcommitted).toBeNull();
    expect(res.body.data.accounts).toHaveLength(1);
  });

  it('reports an uncapped pool without inventing a headroom', async () => {
    mockedGetConcurrency.mockResolvedValue({
      limit: null,
      active: 4,
      remaining: null,
      limit_source: 'partner_unlimited',
    });
    await makeAccount('alice');

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);

    expect(res.body.data.pool.limit).toBeNull();
    expect(res.body.data.headroom).toBeNull();
    expect(res.body.data.overcommitted).toBeNull();
  });

  /**
   * Not every account dials at once, so overcommitting is how a shared
   * resource is normally sold. It is reported rather than refused.
   */
  it('reports an overcommit rather than hiding it', async () => {
    mockedGetConcurrency.mockResolvedValue({ limit: 5, active: 0, remaining: 5 });
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { concurrencyLimit: 20 } });

    const res = await request(app).get('/api/admin/concurrency').set(...STAFF);

    expect(res.body.data.overcommitted).toBe(15);
    expect(res.body.data.headroom).toBe(0);
  });

  it('is staff-only', async () => {
    await expect(request(app).get('/api/admin/concurrency')).resolves.toMatchObject({ status: 401 });
  });
});

describe('PATCH /api/admin/accounts/:id/concurrency', () => {
  it('sets an allotment', async () => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/concurrency`)
      .set(...STAFF)
      .send({ concurrencyLimit: 12 });

    expect(res.status).toBe(200);
    expect(res.body.data.concurrency_limit).toBe(12);

    const stored = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(stored.concurrencyLimit).toBe(12);
  });

  it('restores the default with an explicit null', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { concurrencyLimit: 12 } });

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/concurrency`)
      .set(...STAFF)
      .send({ concurrencyLimit: null });

    expect(res.status).toBe(200);
    expect(res.body.data.concurrency_limit).toBeNull();
    expect(res.body.data.resolved_concurrency).toBeGreaterThan(0);
  });

  it('accepts zero, which stops the account dialing', async () => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/concurrency`)
      .set(...STAFF)
      .send({ concurrencyLimit: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data.resolved_concurrency).toBe(0);
  });

  /**
   * Required rather than optional, so a malformed body cannot silently leave
   * an allotment where it was while the operator believes they changed it.
   */
  it('refuses a body that omits the field', async () => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/concurrency`)
      .set(...STAFF)
      .send({});

    expect(res.status).toBe(400);
  });

  it('refuses a negative or fractional allotment', async () => {
    const alice = await makeAccount('alice');

    for (const value of [-1, 1.5]) {
      const res = await request(app)
        .patch(`/api/admin/accounts/${alice.id}/concurrency`)
        .set(...STAFF)
        .send({ concurrencyLimit: value });

      expect(res.status).toBe(400);
    }
  });

  it('allots beyond the pool without refusing', async () => {
    mockedGetConcurrency.mockResolvedValue({ limit: 5, active: 0, remaining: 5 });
    const alice = await makeAccount('alice');

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/concurrency`)
      .set(...STAFF)
      .send({ concurrencyLimit: 500 });

    // Deliberate overcommit is an operator strategy, and refusing would make
    // this write depend on the platform being reachable.
    expect(res.status).toBe(200);
    expect(mockedGetConcurrency).not.toHaveBeenCalled();
  });

  it('404s an account that does not exist', async () => {
    const res = await request(app)
      .patch('/api/admin/accounts/acct_nope/concurrency')
      .set(...STAFF)
      .send({ concurrencyLimit: 5 });

    expect(res.status).toBe(404);
  });

  it('is staff-only', async () => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .patch(`/api/admin/accounts/${alice.id}/concurrency`)
      .send({ concurrencyLimit: 5 });

    expect(res.status).toBe(401);
  });
});
