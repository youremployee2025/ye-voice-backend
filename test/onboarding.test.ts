import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';

/**
 * Clerk is the one dependency here that cannot be exercised without a network,
 * so it is the one thing mocked. Everything else — the transaction, the
 * conditional writes, the ledger — runs for real against the test database,
 * because those are what this service exists to get right.
 */
const findOrCreateClerkUser = vi.fn();
vi.mock('../src/lib/clerkUsers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/clerkUsers.js')>()),
  findOrCreateClerkUser: (email: string) => findOrCreateClerkUser(email),
}));

/**
 * The strip an agent gets before it changes hands talks to the platform, so it
 * is mocked at the service boundary. What is under test here is that
 * onboarding calls it, calls it first, and refuses to go on when it fails.
 */
const detachForeignResources = vi.fn();
vi.mock('../src/services/agentHandover.js', () => ({
  detachForeignResources: (...args: unknown[]) => detachForeignResources(...args),
}));

const {
  onboardCustomer,
  AgentNotAvailableError,
  PhoneNumberNotAvailableError,
  TierNotAssignableError,
} = await import('../src/services/onboarding.js');

beforeEach(async () => {
  await truncateAll();
  detachForeignResources.mockReset();
  detachForeignResources.mockResolvedValue(undefined);
  findOrCreateClerkUser.mockReset();
  findOrCreateClerkUser.mockImplementation(async (email: string) => ({
    clerkUserId: `user_${email.replace(/[^a-z0-9]/gi, '_')}`,
    email,
    name: null,
    imageUrl: null,
    created: true,
  }));
});

const base = {
  email: 'ops@moomba.test',
  workspaceName: 'Moomba Foods',
  agentIds: [] as string[],
  phoneNumberIds: [] as string[],
  credits: '500',
  tierId: null as string | null,
};

async function activeTier(slug = 'va-1', price = 10_000n) {
  return prisma.tier.create({
    data: { slug, name: slug.toUpperCase(), defaultPriceCreditsPerMin: price },
  });
}

describe('onboardCustomer — the account', () => {
  it('creates the account, workspace, ADMIN membership and opening balance', async () => {
    const result = await onboardCustomer(base);

    const account = await prisma.account.findUniqueOrThrow({
      where: { id: result.account.id },
    });
    expect(account.email).toBe('ops@moomba.test');
    // 500 display credits at the 10000x multiplier.
    expect(account.credits).toBe(5_000_000n);

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: result.workspace.id },
      include: { members: true },
    });
    expect(workspace.name).toBe('Moomba Foods');
    expect(workspace.slug).toBe('moomba-foods');
    expect(workspace.ownerAccountId).toBe(account.id);

    // The row whose absence is invisible: the workspace exists and the account
    // owns it, and without this the owner's own dashboard shows them nothing.
    expect(workspace.members).toHaveLength(1);
    expect(workspace.members[0]!.accountId).toBe(account.id);
    expect(workspace.members[0]!.role).toBe('ADMIN');
  });

  it('writes exactly one ONBOARDING_TOPUP row for the opening balance', async () => {
    const result = await onboardCustomer(base);

    const ledger = await prisma.creditTransaction.findMany({
      where: { accountId: result.account.id },
    });

    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.type).toBe('ONBOARDING_TOPUP');
    expect(ledger[0]!.amount).toBe(5_000_000n);
    expect(ledger[0]!.workspaceId).toBe(result.workspace.id);
  });

  it('reuses an existing account and never calls Clerk for it', async () => {
    const existing = await makeAccount('alice');

    const result = await onboardCustomer({ ...base, email: existing.email });

    expect(result.account.id).toBe(existing.id);
    expect(result.account.created).toBe(false);
    expect(findOrCreateClerkUser).not.toHaveBeenCalled();
    expect(await prisma.account.count()).toBe(1);
  });

  it('matches an existing account case-insensitively', async () => {
    const existing = await makeAccount('alice');

    const result = await onboardCustomer({ ...base, email: existing.email.toUpperCase() });

    expect(result.account.id).toBe(existing.id);
    expect(findOrCreateClerkUser).not.toHaveBeenCalled();
  });

  it('adopts a Clerk user that already exists rather than creating a second account', async () => {
    const existing = await makeAccount('alice');
    findOrCreateClerkUser.mockResolvedValue({
      clerkUserId: existing.clerkUserId,
      email: 'new-address@ezo.test',
      name: null,
      imageUrl: null,
      created: false,
    });

    const result = await onboardCustomer({ ...base, email: 'new-address@ezo.test' });

    expect(result.account.id).toBe(existing.id);
    expect(await prisma.account.count()).toBe(1);
  });

  it('gives a second workspace of the same name a distinct slug', async () => {
    await onboardCustomer(base);
    const second = await onboardCustomer({ ...base, email: 'other@moomba.test' });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: second.workspace.id },
    });
    expect(workspace.slug).toBe('moomba-foods-2');
  });

  it('leaves nothing behind when Clerk fails', async () => {
    const { ClerkProvisioningError } = await import('../src/lib/clerkUsers.js');
    findOrCreateClerkUser.mockRejectedValue(
      new ClerkProvisioningError('ops@moomba.test', new Error('down')),
    );

    await expect(onboardCustomer(base)).rejects.toThrow(ClerkProvisioningError);

    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.workspace.count()).toBe(0);
  });
});

describe('onboardCustomer — agents', () => {
  it('assigns unassigned agents to the new workspace', async () => {
    const one = await makeAgent(null, 'receptionist');
    const two = await makeAgent(null, 'closer');

    const result = await onboardCustomer({ ...base, agentIds: [one.id, two.id] });

    const assigned = await prisma.agent.findMany({
      where: { workspaceId: result.workspace.id },
      orderBy: { name: 'asc' },
    });
    expect(assigned.map((a) => a.name)).toEqual(['closer', 'receptionist']);
    expect(result.assigned.agents).toBe(2);
  });

  it('refuses an agent another workspace already holds, and writes nothing', async () => {
    const owner = await makeAccount('alice');
    const theirs = await makeWorkspace(owner, 'Theirs');
    const taken = await makeAgent(theirs, 'taken');
    const free = await makeAgent(null, 'free');

    await expect(
      onboardCustomer({ ...base, agentIds: [free.id, taken.id] }),
    ).rejects.toThrow(AgentNotAvailableError);

    // The whole request, not just the offending row.
    expect(await prisma.workspace.count({ where: { name: 'Moomba Foods' } })).toBe(0);
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: free.id } })).workspaceId,
    ).toBeNull();
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: taken.id } })).workspaceId,
    ).toBe(theirs.id);
  });

  it('refuses an agent id that names nothing', async () => {
    await expect(
      onboardCustomer({ ...base, agentIds: ['no-such-agent'] }),
    ).rejects.toThrow(AgentNotAvailableError);
  });

  /**
   * A pool agent is not a clean agent. The customer-side removal route nulls
   * `workspaceId` without stripping, so an agent in the pool routinely still
   * carries the previous tenant's dictionaries, function URLs and documents.
   * Staff reassignment strips before it moves an agent; onboarding must too.
   */
  it('strips each agent of the previous tenant’s resources before claiming it', async () => {
    const one = await makeAgent(null, 'receptionist');
    const two = await makeAgent(null, 'closer');

    await onboardCustomer({ ...base, agentIds: [one.id, two.id] });

    expect(detachForeignResources).toHaveBeenCalledTimes(2);
    // `null` incoming workspace: nothing is owned, so everything is detached.
    expect(detachForeignResources).toHaveBeenCalledWith(
      expect.objectContaining({ id: one.id, workspaceId: null }),
      null,
    );
    expect(detachForeignResources).toHaveBeenCalledWith(
      expect.objectContaining({ id: two.id, workspaceId: null }),
      null,
    );
  });

  it('writes nothing — and creates no Clerk user — when the strip cannot be completed', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    const agent = await makeAgent(null, 'receptionist');
    detachForeignResources.mockRejectedValue(
      new ApiError(502, 'HANDOVER_INCOMPLETE', 'could not detach'),
    );

    await expect(onboardCustomer({ ...base, agentIds: [agent.id] })).rejects.toMatchObject({
      code: 'HANDOVER_INCOMPLETE',
    });

    // Fail-closed, and before the one irreversible side-effect: the strip is
    // idempotent on a pool agent, a Clerk user is not.
    expect(findOrCreateClerkUser).not.toHaveBeenCalled();
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.workspace.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId,
    ).toBeNull();
  });

  it('refuses an agent another workspace holds before stripping anything', async () => {
    const owner = await makeAccount('alice');
    const theirs = await makeWorkspace(owner, 'Theirs');
    const taken = await makeAgent(theirs, 'taken');

    await expect(
      onboardCustomer({ ...base, agentIds: [taken.id] }),
    ).rejects.toThrow(AgentNotAvailableError);

    // Stripping an agent somebody else holds would detach THEIR resources from
    // an agent still answering their calls.
    expect(detachForeignResources).not.toHaveBeenCalled();
    expect(findOrCreateClerkUser).not.toHaveBeenCalled();
  });
});

describe('onboardCustomer — phone numbers', () => {
  it('rents a pool number to the workspace with a price and a renewal date', async () => {
    const did = await makePhoneNumber(null, '+911111', 'UNASSIGNED');
    await prisma.phoneNumber.update({
      where: { id: did.id },
      data: { monthlyPriceCredits: 4_000_000n },
    });

    const result = await onboardCustomer({ ...base, phoneNumberIds: [did.id] });

    const rented = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(rented.workspaceId).toBe(result.workspace.id);
    expect(rented.status).toBe('ASSIGNED');
    // The renewal sweep charges this snapshot, never the catalog price. Without
    // it the customer holds a number that is never renewed and never billed.
    expect(rented.rentedPriceCredits).toBe(4_000_000n);
    expect(rented.rentedAt).not.toBeNull();
    expect(rented.nextRenewalAt).not.toBeNull();
    expect(result.assigned.phoneNumbers).toBe(1);
  });

  it('falls back to the catalog default when the number has no price of its own', async () => {
    const did = await makePhoneNumber(null, '+911112', 'UNASSIGNED');

    await onboardCustomer({ ...base, phoneNumberIds: [did.id] });

    const rented = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(rented.rentedPriceCredits).not.toBeNull();
    expect(rented.rentedPriceCredits).toBeGreaterThan(0n);
  });

  it('assigns a number released for non-payment, which is back in the pool', async () => {
    const did = await makePhoneNumber(null, '+911113', 'RELEASED_NONPAYMENT');

    const result = await onboardCustomer({ ...base, phoneNumberIds: [did.id] });

    const rented = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(rented.workspaceId).toBe(result.workspace.id);
    expect(rented.status).toBe('ASSIGNED');
  });

  it('refuses a number another workspace rents, and writes nothing', async () => {
    const owner = await makeAccount('alice');
    const theirs = await makeWorkspace(owner, 'Theirs');
    const rented = await makePhoneNumber(theirs, '+911114', 'ASSIGNED');

    await expect(
      onboardCustomer({ ...base, phoneNumberIds: [rented.id] }),
    ).rejects.toThrow(PhoneNumberNotAvailableError);

    expect(await prisma.workspace.count({ where: { name: 'Moomba Foods' } })).toBe(0);
    expect(
      (await prisma.phoneNumber.findUniqueOrThrow({ where: { id: rented.id } })).workspaceId,
    ).toBe(theirs.id);
  });

  it('refuses a PAST_DUE number — it still belongs to the workspace holding it', async () => {
    const owner = await makeAccount('alice');
    const theirs = await makeWorkspace(owner, 'Theirs');
    const overdue = await makePhoneNumber(theirs, '+911115', 'PAST_DUE');

    await expect(
      onboardCustomer({ ...base, phoneNumberIds: [overdue.id] }),
    ).rejects.toThrow(PhoneNumberNotAvailableError);
  });
});

describe('onboardCustomer — tier', () => {
  it('puts the account on the chosen tier at the list price', async () => {
    const tier = await activeTier();

    const result = await onboardCustomer({ ...base, tierId: tier.id });

    const assignment = await prisma.accountTier.findUniqueOrThrow({
      where: { accountId_tierId: { accountId: result.account.id, tierId: tier.id } },
    });
    // No per-account override: they pay the list price until somebody says
    // otherwise, and inventing a rate here would be inventing a discount.
    expect(assignment.priceCreditsPerMin).toBeNull();
    expect(result.assigned.tier).toBe(tier.name);
  });

  it('refuses a retired tier, and writes nothing', async () => {
    const tier = await prisma.tier.create({
      data: { slug: 'gone', name: 'Gone', status: 'REMOVED' },
    });

    await expect(onboardCustomer({ ...base, tierId: tier.id })).rejects.toThrow(
      TierNotAssignableError,
    );

    expect(await prisma.workspace.count({ where: { name: 'Moomba Foods' } })).toBe(0);
  });

  it('refuses a tier id that names nothing', async () => {
    await expect(
      onboardCustomer({ ...base, tierId: 'no-such-tier' }),
    ).rejects.toThrow(TierNotAssignableError);
  });

  it('keeps an existing assignment rather than resetting its rate', async () => {
    const existing = await makeAccount('alice');
    const tier = await activeTier();
    await prisma.accountTier.create({
      data: { accountId: existing.id, tierId: tier.id, priceCreditsPerMin: 1n },
    });

    await onboardCustomer({ ...base, email: existing.email, tierId: tier.id });

    const assignment = await prisma.accountTier.findUniqueOrThrow({
      where: { accountId_tierId: { accountId: existing.id, tierId: tier.id } },
    });
    // An onboarding must not re-price a customer who already has a rate.
    expect(assignment.priceCreditsPerMin).toBe(1n);
  });
});

describe('onboardCustomer — everything at once', () => {
  it('assigns agents, numbers, credits and a tier in one call', async () => {
    const agent = await makeAgent(null, 'receptionist');
    const did = await makePhoneNumber(null, '+911116', 'UNASSIGNED');
    const tier = await activeTier();

    const result = await onboardCustomer({
      ...base,
      agentIds: [agent.id],
      phoneNumberIds: [did.id],
      tierId: tier.id,
    });

    expect(result.assigned).toMatchObject({ agents: 1, phoneNumbers: 1, tier: tier.name });
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).workspaceId,
    ).toBe(result.workspace.id);
    expect(
      (await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).workspaceId,
    ).toBe(result.workspace.id);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: result.account.id } })).credits,
    ).toBe(5_000_000n);
  });
});
