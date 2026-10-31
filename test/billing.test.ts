import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';
import { toInternalCredits } from '../src/lib/credits.js';

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

const DAY = 24 * 60 * 60 * 1000;

let owner: Account;
let admin: Account;
let member: Account;
let workspace: Workspace;
let sequence = 0;

const asOwner = () => as(owner.clerkUserId, owner.email);
const asAdmin = () => as(admin.clerkUserId, admin.email);
const asMember = () => as(member.clerkUserId, member.email);

async function fund(account: Account, credits: string) {
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits(credits) },
  });
}

async function makeDid(workspaceId: string | null, overrides: Record<string, unknown> = {}) {
  sequence += 1;

  return prisma.phoneNumber.create({
    data: {
      did: `+1415555${String(1000 + sequence)}`,
      provider: 'voicelink',
      status: workspaceId ? 'ASSIGNED' : 'UNASSIGNED',
      workspaceId,
      rentedPriceCredits: toInternalCredits('500'),
      nextRenewalAt: new Date(Date.now() + 10 * DAY),
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  owner = await makeAccount('owner');
  admin = await makeAccount('admin');
  member = await makeAccount('member');
  workspace = await makeWorkspace(owner, 'Acme');
  await addMember(workspace, admin, 'ADMIN');
  await addMember(workspace, member, 'MEMBER');
});

describe('GET /api/workspaces/:id/billing', () => {
  // Credits belong to an Account. An ADMIN who is not the owner reading their
  // own balance beside charges that will never touch it is the expensive
  // confusion, so the payload names whose number it is.
  it("answers the owner's balance to an ADMIN who is not the owner", async () => {
    await fund(owner, '1000');
    await fund(admin, '5');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe('1000');
    expect(res.body.data.owner_account_id).toBe(owner.id);
  });

  it('reports the upcoming window and that the balance covers it', async () => {
    await fund(owner, '2000');
    await makeDid(workspace.id);
    await makeDid(workspace.id);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asOwner());

    expect(res.body.data.upcoming).toEqual({
      account_total_credits: '1000',
      window_days: 30,
      renewal_count: 2,
      unscheduled_count: 0,
      total_credits: '1000',
      covers: true,
      shortfall_credits: null,
    });
  });

  it('names the shortfall when the balance will not cover the window', async () => {
    await fund(owner, '800');
    await makeDid(workspace.id);
    await makeDid(workspace.id);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asOwner());

    expect(res.body.data.upcoming.covers).toBe(false);
    expect(res.body.data.upcoming.shortfall_credits).toBe('200');
  });

  it('counts a number with no renewal date rather than pricing it', async () => {
    await makeDid(workspace.id, { nextRenewalAt: null });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asOwner());

    expect(res.body.data.upcoming.unscheduled_count).toBe(1);
    expect(res.body.data.upcoming.total_credits).toBe('0');
  });

  // The phone-numbers page calls this with `?limit=1` for the balance alone.
  // Growing the payload must not disturb that call.
  it('keeps answering the ledger fields the phone-numbers page reads', async () => {
    await prisma.creditTransaction.create({
      data: {
        accountId: owner.id,
        workspaceId: workspace.id,
        amount: -toInternalCredits('500'),
        type: 'DID_PURCHASE',
      },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing?limit=1`)
      .set(...asOwner());

    expect(res.status).toBe(200);
    expect(res.body.data.ledger).toHaveLength(1);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('refuses a MEMBER', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...asMember());

    expect(res.status).toBe(403);
  });

  it('refuses somebody who is not a member at all', async () => {
    const outsider = await makeAccount('outsider');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/billing`)
      .set(...as(outsider.clerkUserId, outsider.email));

    expect(res.status).toBe(403);
  });
});
