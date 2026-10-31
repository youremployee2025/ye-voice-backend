import type {
  Account,
  Agent,
  PhoneNumber,
  PhoneNumberStatus,
  Workspace,
  WorkspaceRole,
} from '@prisma/client';
import { vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';

/** Identity header understood by requireAuth when NODE_ENV=test. */
export function as(clerkUserId: string, email: string): [string, string] {
  return ['X-Test-Clerk-User', `${clerkUserId}|${email}`];
}

export async function makeAccount(handle: string): Promise<Account> {
  return prisma.account.create({
    data: {
      clerkUserId: `user_${handle}`,
      email: `${handle}@ezo.test`,
      name: handle,
    },
  });
}

/** Creates a workspace plus the owner's ADMIN member row, as the API does. */
export async function makeWorkspace(owner: Account, name: string): Promise<Workspace> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;

  return prisma.workspace.create({
    data: {
      name,
      slug,
      color: '#6366f1',
      ownerAccountId: owner.id,
      members: { create: { accountId: owner.id, role: 'ADMIN' } },
    },
  });
}

export async function addMember(
  workspace: Workspace,
  account: Account,
  role: WorkspaceRole,
): Promise<void> {
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, accountId: account.id, role },
  });
}

/**
 * An agent in the mirror. `workspace` may be null — an unassigned agent sits in
 * the pool, visible to no workspace, which several cases here depend on.
 */
export async function makeAgent(
  workspace: Workspace | null,
  name: string,
  status = 'active',
): Promise<Agent> {
  return prisma.agent.create({
    data: {
      externalId: `ext_${name}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: workspace?.id ?? null,
      name,
      status,
    },
  });
}

/**
 * A DID in the mirror. `workspace` may be null — a number in the shared pool is
 * held by nobody, which several cases here depend on.
 *
 * The DID is suffixed with a random tail because `PhoneNumber.did` is globally
 * unique: two cases naming the same number would otherwise fail on whichever
 * ran second, in a way that reads as a bug in the code under test.
 */
export async function makePhoneNumber(
  workspace: Workspace | null,
  did: string,
  status: PhoneNumberStatus = 'ASSIGNED',
): Promise<PhoneNumber> {
  return prisma.phoneNumber.create({
    data: {
      did: `${did}${Math.floor(Math.random() * 1e6)
        .toString()
        .padStart(6, '0')}`,
      workspaceId: workspace?.id ?? null,
      status,
    },
  });
}

/**
 * Everything a campaign needs before `start` will let it dial.
 *
 * `start` stopped being a pure state transition when the dialer landed: it now
 * requires a usable caller number, a resolvable per-minute rate, and a balance
 * above the float. Every test that starts or resumes a campaign needs all
 * three, and assembling them by hand in each file is how those files drift
 * apart from what `assertCampaignDialable` actually checks.
 *
 * The upstream readiness call is a separate concern — mock
 * `voicelinkCallReady` in the file that needs it.
 */
export async function makeDialable(
  workspace: Workspace,
  campaign: { id: string },
  agent?: Agent,
): Promise<PhoneNumber> {
  const did = await makePhoneNumber(workspace, '+918011220000', 'ASSIGNED');

  // A priced default tier, so `resolveCallRate` resolves for any agent.
  // `upsert` because a file may set several campaigns up in one case.
  await prisma.tier.upsert({
    where: { slug: 'va-test' },
    update: {},
    create: {
      slug: 'va-test',
      name: 'Test',
      defaultPriceCreditsPerMin: 10_000n,
      isDefault: true,
    },
  });

  if (agent) {
    await prisma.agent.update({ where: { id: agent.id }, data: { voiceTierSlug: 'va-test' } });
  }

  await prisma.account.update({
    where: { id: workspace.ownerAccountId },
    data: { credits: 10_000_000n },
  });

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { phoneNumberId: did.id },
  });

  return did;
}

/**
 * Runs `sideEffect` on another connection the moment the next interactive
 * transaction first calls `tx[model][method]` — after whatever the transaction
 * read before that point, before the write it is about to make.
 *
 * This is how a READ COMMITTED race is made deterministic in a test: a second
 * transaction commits between the read and the write, and the code under test
 * either notices or moves a number nobody read. The wrapper is installed on
 * `prisma.$transaction` with `vi.spyOn`, so `vi.restoreAllMocks()` in an
 * `afterEach` takes it back off.
 */
export function interposeBeforeTx(
  model: 'account' | 'workspace' | 'workspaceMember' | 'accountTier',
  method: string,
  sideEffect: () => Promise<void>,
): void {
  const real = prisma.$transaction.bind(prisma) as (
    fn: (tx: unknown) => Promise<unknown>,
    options?: unknown,
  ) => Promise<unknown>;

  vi.spyOn(prisma, '$transaction').mockImplementation(((
    fn: (tx: unknown) => Promise<unknown>,
    options?: unknown,
  ) =>
    real(async (tx) => {
      let fired = false;

      const wrapped = new Proxy(tx as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== model) return value;

          return new Proxy(value as object, {
            get(delegate, name) {
              const member = Reflect.get(delegate, name);
              if (name !== method || typeof member !== 'function') return member;

              return async (...args: unknown[]) => {
                if (!fired) {
                  fired = true;
                  await sideEffect();
                }
                return (member as (...a: unknown[]) => unknown).apply(delegate, args);
              };
            },
          });
        },
      });

      return fn(wrapped);
    }, options)) as typeof prisma.$transaction);
}

/** A staff account carrying the flag, and a member of nothing. */
export async function makeSuperAdmin(handle: string): Promise<Account> {
  return prisma.account.create({
    data: {
      clerkUserId: `user_${handle}`,
      email: `${handle}@ezo.test`,
      name: handle,
      isSuperAdmin: true,
    },
  });
}
