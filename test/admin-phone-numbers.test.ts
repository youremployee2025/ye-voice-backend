import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listPurchasedDids: vi.fn(),
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
}));

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

let workspace: Workspace;

async function makeDid(did: string, overrides: Record<string, unknown> = {}) {
  return prisma.phoneNumber.create({ data: { did, provider: 'voicelink', ...overrides } });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  workspace = await makeWorkspace(await makeAccount('owner'), 'Acme');
});

describe('staff authentication', () => {
  it('refuses every phone-number route without the staff token', async () => {
    const did = await makeDid('+919429390403');

    const responses = await Promise.all([
      request(app).get('/api/admin/phone-numbers'),
      request(app).post('/api/admin/phone-numbers/sync'),
      request(app).post(`/api/admin/phone-numbers/${did.id}/assign`).send({ workspaceId: null }),
      request(app).patch(`/api/admin/phone-numbers/${did.id}`).send({ monthlyPriceCredits: '1' }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('GET /api/admin/phone-numbers', () => {
  it('lists every number with its workspace and renewal state', async () => {
    await makeDid('+919429390403', {
      externalId: '2027',
      status: 'ASSIGNED',
      workspaceId: workspace.id,
      nextRenewalAt: new Date('2026-09-15T00:00:00.000Z'),
    });
    await makeDid('+919429390404', { externalId: '2028' });

    const res = await request(app).get('/api/admin/phone-numbers').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      did: '+919429390403',
      external_id: '2027',
      status: 'ASSIGNED',
      price_is_default: true,
      workspace: { id: workspace.id, name: 'Acme' },
    });
    expect(res.body.data[1].workspace).toBeNull();
  });

  it('filters by ?assigned=', async () => {
    await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: workspace.id });
    await makeDid('+919429390404');

    const assigned = await request(app)
      .get('/api/admin/phone-numbers?assigned=true')
      .set(...staff());
    const free = await request(app)
      .get('/api/admin/phone-numbers?assigned=false')
      .set(...staff());

    expect(assigned.body.data.map((n: { did: string }) => n.did)).toEqual(['+919429390403']);
    expect(free.body.data.map((n: { did: string }) => n.did)).toEqual(['+919429390404']);
  });

  it('filters by ?status=', async () => {
    await makeDid('+919429390403', { status: 'RELEASED_NONPAYMENT' });
    await makeDid('+919429390404');

    const res = await request(app)
      .get('/api/admin/phone-numbers?status=RELEASED_NONPAYMENT')
      .set(...staff());

    expect(res.body.data.map((n: { did: string }) => n.did)).toEqual(['+919429390403']);
  });

  it('rejects a malformed filter rather than returning the wrong list', async () => {
    const res = await request(app)
      .get('/api/admin/phone-numbers?status=NOPE')
      .set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/admin/phone-numbers/sync', () => {
  it('pulls the purchased listing and reports the outcome', async () => {
    vi.mocked(client.listPurchasedDids).mockResolvedValue({
      rows: [{ id: 2027, did_number: 919429390403, country_code: 91, type_label: 'Mobile' }],
      lastPage: 1,
    });

    const res = await request(app).post('/api/admin/phone-numbers/sync').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 1, updated: 0, skipped: 0, conflicts: 0 });
    expect(await prisma.phoneNumber.count()).toBe(1);
  });

  it('is not shadowed by the :didId route', async () => {
    vi.mocked(client.listPurchasedDids).mockResolvedValue({ rows: [], lastPage: 1 });

    const res = await request(app).post('/api/admin/phone-numbers/sync').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('imported');
  });
});

describe('POST /api/admin/phone-numbers/:didId/assign', () => {
  it('assigns a number to a workspace with NO charge', async () => {
    const owner = await prisma.account.findFirstOrThrow();
    await prisma.account.update({ where: { id: owner.id }, data: { credits: 10_000_000n } });
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .post(`/api/admin/phone-numbers/${did.id}/assign`)
      .set(...staff())
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ASSIGNED', workspace: { id: workspace.id } });
    expect(res.body.data.next_renewal_at).not.toBeNull();

    // An operational override is not a sale: no charge, and no ledger row
    // manufacturing a credit movement that did not happen.
    expect((await prisma.account.findUniqueOrThrow({ where: { id: owner.id } })).credits)
      .toBe(10_000_000n);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('unassigns a rented number with an explicit null and force', async () => {
    const did = await makeDid('+919429390403', {
      status: 'ASSIGNED',
      workspaceId: workspace.id,
      rentedAt: new Date(),
      nextRenewalAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/admin/phone-numbers/${did.id}/assign`)
      .set(...staff())
      .send({ workspaceId: null, force: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'UNASSIGNED',
      workspace: null,
      rented_at: null,
      next_renewal_at: null,
    });
  });

  it('refuses to take a rented number away without force', async () => {
    const did = await makeDid('+919429390403', {
      status: 'ASSIGNED',
      workspaceId: workspace.id,
      rentedAt: new Date(),
      nextRenewalAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/admin/phone-numbers/${did.id}/assign`)
      .set(...staff())
      .send({ workspaceId: null });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_NUMBER_IN_USE');

    // Nothing moved: the rental is exactly as it was.
    const after = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(after.workspaceId).toBe(workspace.id);
    expect(after.status).toBe('ASSIGNED');
  });

  it('records a release on the losing workspace when a rented number is forced away', async () => {
    const did = await makeDid('+919429390403', {
      status: 'ASSIGNED',
      workspaceId: workspace.id,
      rentedPriceCredits: 5_000_000n,
      rentedAt: new Date(),
      nextRenewalAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/admin/phone-numbers/${did.id}/assign`)
      .set(...staff())
      .send({ workspaceId: null, force: true });

    expect(res.status).toBe(200);

    // The ledger that recorded the number arriving records it leaving. No
    // credits move — a staff override is not a sale, and not a refund either.
    const rows = await prisma.creditTransaction.findMany({ where: { workspaceId: workspace.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'DID_RELEASE', amount: 0n, phoneNumberId: did.id });
  });

  it('leaves the catalog price editable on a rented number without touching the rental', async () => {
    const did = await makeDid('+919429390403', {
      status: 'ASSIGNED',
      workspaceId: workspace.id,
      monthlyPriceCredits: 5_000_000n,
      rentedPriceCredits: 5_000_000n,
      rentedAt: new Date(),
      nextRenewalAt: new Date(),
    });

    const res = await request(app)
      .patch(`/api/admin/phone-numbers/${did.id}`)
      .set(...staff())
      .send({ monthlyPriceCredits: '900' });

    expect(res.status).toBe(200);
    // The catalog moved; what this workspace pays did not.
    expect(res.body.data.monthly_price_credits).toBe('900');
    expect(res.body.data.rented_price_credits).toBe('500');

    const after = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(after.rentedPriceCredits).toBe(5_000_000n);
  });

  it('rejects a price too large for the credits column with 400, not 500', async () => {
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .patch(`/api/admin/phone-numbers/${did.id}`)
      .set(...staff())
      .send({ monthlyPriceCredits: '999999999999999' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an omitted workspaceId with 400', async () => {
    const did = await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: workspace.id });

    const res = await request(app)
      .post(`/api/admin/phone-numbers/${did.id}/assign`)
      .set(...staff())
      .send({});

    // An omitted field must never silently take a number away from a customer.
    expect(res.status).toBe(400);
    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).workspaceId)
      .toBe(workspace.id);
  });

  it('404s assigning to a workspace that does not exist', async () => {
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .post(`/api/admin/phone-numbers/${did.id}/assign`)
      .set(...staff())
      .send({ workspaceId: 'no-such-workspace' });

    // Checked before the write, so a typo is a clean 404 rather than a
    // foreign-key violation surfacing as a 500.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s for a DID that does not exist', async () => {
    const res = await request(app)
      .post('/api/admin/phone-numbers/nope/assign')
      .set(...staff())
      .send({ workspaceId: workspace.id });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/phone-numbers/:didId', () => {
  it('sets a per-DID monthly price', async () => {
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .patch(`/api/admin/phone-numbers/${did.id}`)
      .set(...staff())
      .send({ monthlyPriceCredits: '12.34' });

    expect(res.status).toBe(200);
    expect(res.body.data.monthly_price_credits).toBe('12.34');
    expect(res.body.data.price_is_default).toBe(false);
    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).monthlyPriceCredits)
      .toBe(123_400n);
  });

  it('restores the global default with an explicit null', async () => {
    const did = await makeDid('+919429390403', { monthlyPriceCredits: 123_400n });

    const res = await request(app)
      .patch(`/api/admin/phone-numbers/${did.id}`)
      .set(...staff())
      .send({ monthlyPriceCredits: null });

    expect(res.body.data.monthly_price_credits).toBe('500');
    expect(res.body.data.price_is_default).toBe(true);
  });

  it('accepts a free number as an explicit zero', async () => {
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .patch(`/api/admin/phone-numbers/${did.id}`)
      .set(...staff())
      .send({ monthlyPriceCredits: '0' });

    expect(res.body.data.monthly_price_credits).toBe('0');
    expect(res.body.data.price_is_default).toBe(false);
  });

  it('rejects a negative or malformed price with 400', async () => {
    const did = await makeDid('+919429390403');

    for (const bad of ['-1', 'free', '1e3', '0.00001']) {
      const res = await request(app)
        .patch(`/api/admin/phone-numbers/${did.id}`)
        .set(...staff())
        .send({ monthlyPriceCredits: bad });

      expect(res.status, bad).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).monthlyPriceCredits)
      .toBeNull();
  });

  it('rejects an omitted price rather than treating it as the default', async () => {
    const did = await makeDid('+919429390403', { monthlyPriceCredits: 123_400n });

    const res = await request(app)
      .patch(`/api/admin/phone-numbers/${did.id}`)
      .set(...staff())
      .send({});

    expect(res.status).toBe(400);
    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).monthlyPriceCredits)
      .toBe(123_400n);
  });
});
