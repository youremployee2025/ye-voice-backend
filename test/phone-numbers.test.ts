import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

// No test may reach the real partner API.
vi.mock('../src/adapter/vocobase.js', () => ({
  listPurchasedDids: vi.fn(),
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

const DEFAULT_PRICE = 5_000_000n;

let owner: Account;
let member: Account;
let outsider: Account;
let workspace: Workspace;

const asOwner = () => as(owner.clerkUserId, owner.email);
const asMember = () => as(member.clerkUserId, member.email);
const asOutsider = () => as(outsider.clerkUserId, outsider.email);

async function fund(account: Account, credits: bigint): Promise<void> {
  await prisma.account.update({ where: { id: account.id }, data: { credits } });
}

const balanceOf = async (account: Account) =>
  (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;

async function makeDid(did: string, overrides: Record<string, unknown> = {}) {
  return prisma.phoneNumber.create({ data: { did, provider: 'voicelink', ...overrides } });
}

beforeEach(async () => {
  await truncateAll();
  owner = await makeAccount('owner');
  member = await makeAccount('member');
  outsider = await makeAccount('outsider');
  workspace = await makeWorkspace(owner, 'Acme');
  await addMember(workspace, member, 'MEMBER');
});

describe('GET /api/workspaces/:id/phone-numbers', () => {
  it("lists only this workspace's numbers", async () => {
    const other = await makeWorkspace(await makeAccount('rival'), 'Rival');
    await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: workspace.id });
    await makeDid('+919429390404', { status: 'ASSIGNED', workspaceId: other.id });
    await makeDid('+919429390405');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/phone-numbers`)
      .set(...asMember());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      did: '+919429390403',
      status: 'ASSIGNED',
      monthly_price_credits: '500',
    });
  });

  it('answers 403 to a caller who is not a member', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/phone-numbers`)
      .set(...asOutsider());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/workspaces/:id/phone-numbers/available', () => {
  it('lists the unowned pool to any member, including released-for-nonpayment', async () => {
    await makeDid('+919429390403');
    await makeDid('+919429390404', { status: 'RELEASED_NONPAYMENT' });
    await makeDid('+919429390405', { status: 'ASSIGNED', workspaceId: workspace.id });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/phone-numbers/available`)
      .set(...asMember());

    expect(res.status).toBe(200);
    expect(res.body.data.map((n: { did: string }) => n.did)).toEqual([
      '+919429390403',
      '+919429390404',
    ]);
    expect(res.body.data[1].released_for_nonpayment).toBe(true);
    expect(res.body.data[0].released_for_nonpayment).toBe(false);
  });

  it("never exposes another workspace's id through the pool", async () => {
    await makeDid('+919429390403');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/phone-numbers/available`)
      .set(...asMember());

    expect(Object.keys(res.body.data[0])).toEqual([
      'id',
      'did',
      'country_code',
      'number_type',
      'monthly_price_credits',
      'released_for_nonpayment',
    ]);
  });

  it('shows a per-DID price when staff set one', async () => {
    await makeDid('+919429390403', { monthlyPriceCredits: 123_400n });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/phone-numbers/available`)
      .set(...asMember());

    expect(res.body.data[0].monthly_price_credits).toBe('12.34');
  });
});

describe('POST .../phone-numbers/:didId/rent', () => {
  it('rents a number as ADMIN and returns the updated row', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asOwner());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ did: '+919429390403', status: 'ASSIGNED' });
    expect(res.body.data.next_renewal_at).not.toBeNull();
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: owner.id } })).credits,
    ).toBe(5_000_000n);
  });

  it('refuses a rental from a MEMBER and changes nothing', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asMember());

    expect(res.status).toBe(403);
    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).workspaceId)
      .toBeNull();
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('returns 409 PHONE_NUMBER_TAKEN when the number is already rented', async () => {
    const other = await makeWorkspace(await makeAccount('rival'), 'Rival');
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: other.id });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asOwner());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'PHONE_NUMBER_TAKEN', message: expect.any(String) },
    });
  });

  it('returns 402 INSUFFICIENT_CREDITS when the owner is short', async () => {
    await fund(owner, DEFAULT_PRICE - 1n);
    const did = await makeDid('+919429390403');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asOwner());

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: owner.id } })).credits)
      .toBe(DEFAULT_PRICE - 1n);
  });

  it('returns 409 for a DID that does not exist', async () => {
    await fund(owner, 10_000_000n);

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/nope/rent`)
      .set(...asOwner());

    expect(res.status).toBe(409);
  });
});

describe('POST .../phone-numbers/:didId/release', () => {
  it('releases a number as ADMIN, with no refund', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');
    await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asOwner());

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/release`)
      .set(...asOwner());

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('UNASSIGNED');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: owner.id } })).credits)
      .toBe(5_000_000n);
  });

  it('refuses a release from a MEMBER', async () => {
    const did = await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: workspace.id });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/release`)
      .set(...asMember());

    expect(res.status).toBe(403);
  });

  it('returns 404 releasing a number this workspace does not hold', async () => {
    const other = await makeWorkspace(await makeAccount('rival'), 'Rival');
    const did = await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: other.id });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/release`)
      .set(...asOwner());

    // Not 403: a 403 would confirm the id names something real.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/workspaces/:id/billing', () => {
  it("returns the owner's balance and this workspace's ledger to an ADMIN", async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');
    await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asOwner());

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asOwner());

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe('500');
    expect(res.body.data.ledger).toHaveLength(1);
    expect(res.body.data.ledger[0]).toMatchObject({
      amount: '-500',
      type: 'DID_PURCHASE',
      phone_number: { did: '+919429390403' },
    });
  });

  it('shows the OWNER balance to a non-owner ADMIN, not their own', async () => {
    const admin = await makeAccount('admin');
    await addMember(workspace, admin, 'ADMIN');
    await fund(owner, 10_000_000n);
    await fund(admin, 30_000_000n);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...as(admin.clerkUserId, admin.email));

    expect(res.body.data.balance).toBe('1000');
  });

  it('refuses billing to a MEMBER', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asMember());

    expect(res.status).toBe(403);
  });

  it("keeps a released number's ledger rows on the workspace's billing", async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');
    await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/rent`)
      .set(...asOwner());
    await request(app)
      .post(`/api/workspaces/${workspace.id}/phone-numbers/${did.id}/release`)
      .set(...asOwner());

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asOwner());

    // The DID no longer belongs to this workspace; the history does. This is
    // why CreditTransaction carries its own workspaceId.
    expect(res.body.data.ledger.map((r: { type: string }) => r.type)).toEqual([
      'DID_RELEASE',
      'DID_PURCHASE',
    ]);
  });

  it("never shows another workspace's ledger", async () => {
    const other = await makeWorkspace(owner, 'Other');
    await prisma.creditTransaction.create({
      data: { accountId: owner.id, workspaceId: other.id, amount: -1n, type: 'DID_PURCHASE' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asOwner());

    expect(res.body.data.ledger).toEqual([]);
  });

  it('paginates the ledger by cursor', async () => {
    await prisma.creditTransaction.createMany({
      data: Array.from({ length: 3 }, () => ({
        accountId: owner.id,
        workspaceId: workspace.id,
        amount: -1n,
        type: 'DID_PURCHASE' as const,
      })),
    });

    const first = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing?limit=2`)
      .set(...asOwner());

    expect(first.body.data.ledger).toHaveLength(2);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing?limit=2&cursor=${first.body.data.nextCursor}`)
      .set(...asOwner());

    expect(second.body.data.ledger).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();
  });

  it('rejects a malformed limit rather than ignoring it', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing?limit=nope`)
      .set(...asOwner());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

/**
 * The guards, stated as tests.
 *
 * Every one of these passed before it was written — the middleware was right.
 * That is exactly why they are worth having: an authorisation rule nothing
 * asserts is a convention, and the next person to add a route to this file
 * gets no warning when they copy the wrong `requireMembership` line.
 */
describe('authorisation on the phone number surface', () => {
  const rentPath = (didId: string) =>
    `/api/workspaces/${workspace.id}/phone-numbers/${didId}/rent`;
  const releasePath = (didId: string) =>
    `/api/workspaces/${workspace.id}/phone-numbers/${didId}/release`;

  it('refuses an unauthenticated caller on every route', async () => {
    const did = await makeDid('+919429390403');

    const responses = await Promise.all([
      request(app).get(`/api/workspaces/${workspace.id}/phone-numbers`),
      request(app).get(`/api/workspaces/${workspace.id}/phone-numbers/available`),
      request(app).get(`/api/workspaces/${workspace.id}/billing`),
      request(app).post(rentPath(did.id)),
      request(app).post(releasePath(did.id)),
    ]);

    for (const res of responses) expect(res.status).toBe(401);
  });

  it('refuses a non-member on the shared pool', async () => {
    // The one deliberate cross-workspace read in this slice, and the only
    // route that had no negative case at all.
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/phone-numbers/available`)
      .set(...asOutsider());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a non-member on rent, release and billing', async () => {
    const did = await makeDid('+919429390403');

    const responses = await Promise.all([
      request(app).post(rentPath(did.id)).set(...asOutsider()),
      request(app).post(releasePath(did.id)).set(...asOutsider()),
      request(app).get(`/api/workspaces/${workspace.id}/billing`).set(...asOutsider()),
    ]);

    for (const res of responses) expect(res.status).toBe(403);

    // A refused call must not have moved anything.
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).workspaceId)
      .toBeNull();
  });

  it('refuses a MEMBER on rent and release without touching the number', async () => {
    const did = await makeDid('+919429390403');
    await fund(owner, 10_000_000n);

    expect((await request(app).post(rentPath(did.id)).set(...asMember())).status).toBe(403);
    expect((await request(app).post(releasePath(did.id)).set(...asMember())).status).toBe(403);

    expect(await balanceOf(owner)).toBe(10_000_000n);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('keeps a Clerk-authenticated customer out of the staff surface', async () => {
    // The cross-surface confusion the mount order exists to prevent. A
    // customer holding a perfectly good session must not reach /api/admin/*
    // just because they are authenticated somewhere.
    const responses = await Promise.all([
      request(app).get('/api/admin/phone-numbers').set(...asOwner()),
      request(app).post('/api/admin/phone-numbers/sync').set(...asOwner()),
    ]);

    for (const res of responses) expect(res.status).toBe(401);
  });
});
