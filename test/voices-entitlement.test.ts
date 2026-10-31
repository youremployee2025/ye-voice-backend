import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * The voice picker is where a tier stops being a price and becomes a
 * capability. Everything here is about which voices a workspace is offered,
 * and the direction every rule fails in is closed.
 */

vi.mock('../src/adapter/vocobase.js', () => ({
  listVoices: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  getAvailableConnections: vi.fn(),
  setAgentTool: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
}));

const { listVoices } = await import('../src/adapter/vocobase.js');
const catalogue = vi.mocked(listVoices);

const { createApp } = await import('../src/app.js');
const app = createApp();

const CATALOGUE = [
  { id: 'v-basic', display_name: 'Anisha', language: 'en', gender: 'female', tier: 'va-1' },
  { id: 'v-pro', display_name: 'Rohan', language: 'en', gender: 'male', tier: 'va-1-pro' },
  { id: 'v-elite', display_name: 'Meera', language: 'en', gender: 'female', tier: 'va-2' },
  { id: 'v-free', display_name: 'Legacy', language: 'en', gender: 'female' },
];

let owner: Account;
let workspace: Workspace;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  catalogue.mockResolvedValue({ voices: CATALOGUE });

  owner = await makeAccount('owner');
  workspace = await makeWorkspace(owner, 'Owner Co');
});

async function makeTier(
  slug: string,
  options: { isDefault?: boolean; status?: 'ACTIVE' | 'REMOVED' } = {},
) {
  return prisma.tier.create({
    data: {
      slug,
      name: slug.toUpperCase(),
      status: options.status ?? 'ACTIVE',
      defaultPriceCreditsPerMin: 10_000n,
      isDefault: options.isDefault ?? false,
    },
  });
}

async function grant(account: Account, tierId: string) {
  await prisma.accountTier.create({ data: { accountId: account.id, tierId } });
}

async function voicesFor(account: Account) {
  const res = await request(app)
    .get(`/api/workspaces/${workspace.id}/voices`)
    .set(...as(account.clerkUserId, account.email));

  return res;
}

describe('GET /api/workspaces/:id/voices — entitlement', () => {
  it('offers the voices of the tiers the owner holds', async () => {
    const basic = await makeTier('va-1');
    await makeTier('va-1-pro');
    await grant(owner, basic.id);

    const res = await voicesFor(owner);

    expect(res.status).toBe(200);
    expect(res.body.data.map((voice: { id: string }) => voice.id).sort()).toEqual([
      'v-basic',
      'v-free',
    ]);
  });

  /**
   * An untiered voice is outside the tier system, and hiding it would remove
   * voices from a product that has been offering them.
   */
  it('offers a voice with no tier to everybody', async () => {
    const basic = await makeTier('va-1');
    await grant(owner, basic.id);

    const res = await voicesFor(owner);

    expect(res.body.data.map((voice: { id: string }) => voice.id)).toContain('v-free');
  });

  it('withholds a voice whose tier the account does not hold', async () => {
    const basic = await makeTier('va-1');
    await makeTier('va-2');
    await grant(owner, basic.id);

    const res = await voicesFor(owner);

    expect(res.body.data.map((voice: { id: string }) => voice.id)).not.toContain('v-elite');
  });

  /**
   * A voice whose tier has never been synced is not entitlement. The filter
   * tests against the mirror, and an unknown slug fails that test.
   */
  it('withholds a voice whose tier the mirror has never seen', async () => {
    const basic = await makeTier('va-1');
    await grant(owner, basic.id);

    const res = await voicesFor(owner);

    // 'va-1-pro' and 'va-2' are in the upstream catalogue but not in the mirror.
    expect(res.body.data.map((voice: { id: string }) => voice.id).sort()).toEqual([
      'v-basic',
      'v-free',
    ]);
  });

  /**
   * Entitlement follows the money. An ADMIN who is not the owner would
   * otherwise be offered voices out of their own plan and pick one the
   * workspace cannot afford.
   */
  it("reads the owner's tiers, not the caller's", async () => {
    const basic = await makeTier('va-1');
    const elite = await makeTier('va-2');
    await grant(owner, basic.id);

    const admin = await makeAccount('admin');
    await addMember(workspace, admin, 'ADMIN');
    await grant(admin, elite.id);

    const res = await voicesFor(admin);

    expect(res.body.data.map((voice: { id: string }) => voice.id).sort()).toEqual([
      'v-basic',
      'v-free',
    ]);
  });

  it('offers the default tier to an account with no assignments', async () => {
    await makeTier('va-1');
    await makeTier('va-1-pro', { isDefault: true });

    const res = await voicesFor(owner);

    expect(res.body.data.map((voice: { id: string }) => voice.id).sort()).toEqual([
      'v-free',
      'v-pro',
    ]);
  });

  it('offers only untiered voices when there is no default and no assignment', async () => {
    await makeTier('va-1');

    const res = await voicesFor(owner);

    expect(res.body.data.map((voice: { id: string }) => voice.id)).toEqual(['v-free']);
  });

  it('withholds the voices of a tier that has been retired', async () => {
    const gone = await makeTier('va-1', { status: 'REMOVED' });
    await grant(owner, gone.id);

    const res = await voicesFor(owner);

    expect(res.body.data.map((voice: { id: string }) => voice.id)).toEqual(['v-free']);
  });

  it('names each voice its tier, and leaves the name null for a slug the mirror lacks', async () => {
    const basic = await prisma.tier.create({
      data: { slug: 'va-1', name: 'VA 1', defaultPriceCreditsPerMin: 10_000n },
    });
    await grant(owner, basic.id);

    const res = await voicesFor(owner);

    expect(res.body.data).toEqual([
      expect.objectContaining({ id: 'v-basic', name: 'Anisha', tier: 'va-1', tier_name: 'VA 1' }),
      expect.objectContaining({ id: 'v-free', tier: null, tier_name: null }),
    ]);
  });

  /**
   * One upstream call however many tiers are held. `?tier=` would work and
   * would cost one shared-rate-limit request per tier to assemble a list one
   * request already contains.
   */
  it('makes exactly one upstream call however many tiers the account holds', async () => {
    const basic = await makeTier('va-1');
    const pro = await makeTier('va-1-pro');
    const elite = await makeTier('va-2');
    await grant(owner, basic.id);
    await grant(owner, pro.id);
    await grant(owner, elite.id);

    await voicesFor(owner);

    expect(catalogue).toHaveBeenCalledTimes(1);
    expect(catalogue).toHaveBeenCalledWith();
  });

  it('still answers 502 for an unreachable catalogue, never an empty list', async () => {
    const basic = await makeTier('va-1');
    await grant(owner, basic.id);
    catalogue.mockRejectedValue(
      Object.assign(new Error('down'), { status: 502, code: 'UPSTREAM_ERROR', name: 'ApiError' }),
    );

    const res = await voicesFor(owner);

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('answers a workspace whose caller is not a member with 403', async () => {
    const stranger = await makeAccount('stranger');

    const res = await voicesFor(stranger);

    expect(res.status).toBe(403);
  });
});
