import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listPurchasedDids: vi.fn(),
  listVoices: vi.fn(),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

let owner: Account;
let workspace: Workspace;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  owner = await makeAccount('owner');
  workspace = await makeWorkspace(owner, 'Owner Co');
});

async function makeTier(
  slug: string,
  options: { price?: bigint | null;
    increment?: number | null; isDefault?: boolean; status?: 'ACTIVE' | 'REMOVED' } = {},
) {
  return prisma.tier.create({
    data: {
      slug,
      name: slug.toUpperCase(),
      status: options.status ?? 'ACTIVE',
      defaultPriceCreditsPerMin: options.price ?? null,
      billingIncrementSecs: options.increment ?? null,
      isDefault: options.isDefault ?? false,
    },
  });
}

const plan = (account: Account) =>
  request(app)
    .get(`/api/workspaces/${workspace.id}/billing/plan`)
    .set(...as(account.clerkUserId, account.email));

describe('GET /api/workspaces/:id/billing/plan', () => {
  it("reports the owner's tiers with the rate each resolves to", async () => {
    const basic = await makeTier('va-1', { price: 10_000n });
    const pro = await makeTier('va-1-pro', { price: 25_000n });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: basic.id } });
    await prisma.accountTier.create({
      data: { accountId: owner.id, tierId: pro.id, priceCreditsPerMin: 20_000n },
    });

    const res = await plan(owner);

    expect(res.status).toBe(200);
    expect(res.body.data.tiers).toEqual([
      { slug: 'va-1', name: 'VA-1', status: 'active', rate_credits_per_min: '1' , billing_increment_secs: 1 },
      { slug: 'va-1-pro', name: 'VA-1-PRO', status: 'active', rate_credits_per_min: '2' , billing_increment_secs: 1 },
    ]);
  });

  /**
   * A per-account price is the customer's rate and nothing else. No badge, no
   * list price beside it, no field a UI could render as "special". What
   * anybody else pays is not on this page, and a "discounted" label invites
   * the question of what the undiscounted number is.
   */
  it('emits nothing that distinguishes a custom rate from a list price', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });
    await prisma.accountTier.create({
      data: { accountId: owner.id, tierId: tier.id, priceCreditsPerMin: 2_500n },
    });

    const res = await plan(owner);

    expect(res.body.data.tiers[0]).toEqual({
      slug: 'va-1',
      name: 'VA-1',
      status: 'active',
      rate_credits_per_min: '0.25',
      billing_increment_secs: 1,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/default_price|custom|discount|list_price/i);
  });

  it('shows the default tier to an account with no assignments, unmarked as a default', async () => {
    await makeTier('va-1', { price: 10_000n, isDefault: true });
    await makeTier('va-1-pro', { price: 25_000n });

    const res = await plan(owner);

    expect(res.body.data.tiers).toEqual([
      { slug: 'va-1', name: 'VA-1', status: 'active', rate_credits_per_min: '1' , billing_increment_secs: 1 },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/default|fallback/i);
  });

  it('lists a retired tier the account still holds rather than dropping the line', async () => {
    const gone = await makeTier('va-old', { price: 10_000n, status: 'REMOVED' });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: gone.id } });

    const res = await plan(owner);

    expect(res.body.data.tiers).toEqual([
      { slug: 'va-old', name: 'VA-OLD', status: 'removed', rate_credits_per_min: '1' , billing_increment_secs: 1 },
    ]);
  });

  /**
   * Unknown is not zero. A tier nobody has priced has no rate, and printing
   * "0" would tell a customer their calls are free.
   */
  it('reports an unpriceable tier as null, never as zero', async () => {
    const tier = await makeTier('va-1');
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: tier.id } });

    const res = await plan(owner);

    expect(res.body.data.tiers[0].rate_credits_per_min).toBeNull();
  });

  it('reports a deliberate zero as a rate, because zero is a price', async () => {
    const tier = await makeTier('va-free', { price: 0n });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: tier.id } });

    const res = await plan(owner);

    expect(res.body.data.tiers[0].rate_credits_per_min).toBe('0');
  });

  it('is empty when there is no assignment and no default tier', async () => {
    await makeTier('va-1', { price: 10_000n });

    const res = await plan(owner);

    expect(res.status).toBe(200);
    expect(res.body.data.tiers).toEqual([]);
  });

  it("shows an ADMIN the owner's plan, not their own", async () => {
    const ownersTier = await makeTier('va-1', { price: 10_000n });
    const adminsTier = await makeTier('va-2', { price: 50_000n });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: ownersTier.id } });

    const admin = await makeAccount('admin');
    await addMember(workspace, admin, 'ADMIN');
    await prisma.accountTier.create({ data: { accountId: admin.id, tierId: adminsTier.id } });

    const res = await plan(admin);

    expect(res.body.data.tiers.map((tier: { slug: string }) => tier.slug)).toEqual(['va-1']);
  });

  it('refuses a MEMBER, like every other billing route', async () => {
    const member = await makeAccount('member');
    await addMember(workspace, member, 'MEMBER');

    expect((await plan(member)).status).toBe(403);
  });

  it('refuses a non-member', async () => {
    const stranger = await makeAccount('stranger');

    expect((await plan(stranger)).status).toBe(403);
  });

  /**
   * Minutes ARE billed now — the dialer prices every call it places. The flag
   * said otherwise while a rate card was the only thing this surface had, and
   * leaving it would print "calling is not billed yet" over a history that
   * lists the charges.
   */
  it('says that calling is billed, because it is', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: tier.id } });

    const res = await plan(owner);

    // A flag rather than a sentence: the wording belongs to the dashboard, the
    // fact belongs to the backend that does the charging.
    expect(res.body.data.metered).toBe(true);
  });

  it('reports the increment each tier is billed in', async () => {
    const tier = await makeTier('va-1', { price: 10_000n, increment: 30 });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: tier.id } });

    const res = await plan(owner);

    expect(res.body.data.tiers[0].billing_increment_secs).toBe(30);
  });

  /**
   * Never null on the wire, unlike the rate beside it. Per-second billing is
   * the increment of one, not the absence of an increment — a null here would
   * leave the dashboard to invent a sentence about it.
   */
  it('reports per-second billing as 1 rather than as nothing', async () => {
    const tier = await makeTier('va-1', { price: 10_000n });
    await prisma.accountTier.create({ data: { accountId: owner.id, tierId: tier.id } });

    expect((await plan(owner)).body.data.tiers[0].billing_increment_secs).toBe(1);
  });

  it("prefers the account's own increment over the tier's", async () => {
    const tier = await makeTier('va-1', { price: 10_000n, increment: 60 });
    await prisma.accountTier.create({
      data: { accountId: owner.id, tierId: tier.id, billingIncrementSecs: 15 },
    });

    expect((await plan(owner)).body.data.tiers[0].billing_increment_secs).toBe(15);
  });
});
