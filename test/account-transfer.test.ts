import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import {
  addMember,
  interposeBeforeTx,
  makeAccount,
  makeAgent,
  makePhoneNumber,
  makeWorkspace,
} from './helpers.js';
import {
  AccountNotFoundError,
  ConcurrentModificationError,
  NoWorkspacesError,
  SameAccountError,
  describeTransfer,
  transferAccount,
} from '../src/services/accountTransfer.js';

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function pair() {
  const source = await makeAccount('source');
  const destination = await makeAccount('destination');
  return { source, destination };
}

describe('describeTransfer', () => {
  it('counts what would move', async () => {
    const { source, destination } = await pair();
    const one = await makeWorkspace(source, 'One');
    const two = await makeWorkspace(source, 'Two');
    await makeAgent(one, 'receptionist');
    await makeAgent(two, 'closer');
    await makePhoneNumber(one, '+912221', 'ASSIGNED');
    await prisma.account.update({ where: { id: source.id }, data: { credits: 5_000_000n } });

    const preview = await describeTransfer(source.id, destination.id);

    expect(preview.source.email).toBe(source.email);
    expect(preview.destination.email).toBe(destination.email);
    expect(preview.workspaces.map((w) => w.name).sort()).toEqual(['One', 'Two']);
    expect(preview.counts).toMatchObject({ workspaces: 2, agents: 2, phoneNumbers: 1 });
    expect(preview.credits).toBe('500');
  });

  it('counts only workspaces the source OWNS, not ones it is a member of', async () => {
    const { source, destination } = await pair();
    const outsider = await makeAccount('outsider');
    const theirs = await makeWorkspace(outsider, 'Theirs');
    await addMember(theirs, source, 'MEMBER');
    await makeWorkspace(source, 'Mine');

    const preview = await describeTransfer(source.id, destination.id);

    expect(preview.workspaces.map((w) => w.name)).toEqual(['Mine']);
  });

  it('names the tiers that will stay behind', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    const moving = await prisma.tier.create({ data: { slug: 'moving', name: 'Moving' } });
    const clashing = await prisma.tier.create({ data: { slug: 'clash', name: 'Clash' } });
    await prisma.accountTier.createMany({
      data: [
        { accountId: source.id, tierId: moving.id },
        { accountId: source.id, tierId: clashing.id },
        { accountId: destination.id, tierId: clashing.id },
      ],
    });

    const preview = await describeTransfer(source.id, destination.id);

    expect(preview.tiersMoving).toEqual(['Moving']);
    expect(preview.tiersStaying).toEqual(['Clash']);
  });

  it('refuses a source and destination that are the same account', async () => {
    const { source } = await pair();
    await expect(describeTransfer(source.id, source.id)).rejects.toThrow(SameAccountError);
  });

  it('refuses an account that does not exist', async () => {
    const { source } = await pair();
    await expect(describeTransfer(source.id, 'nobody')).rejects.toThrow(AccountNotFoundError);
    await expect(describeTransfer('nobody', source.id)).rejects.toThrow(AccountNotFoundError);
  });
});

describe('transferAccount — workspaces', () => {
  it('moves ownership of every workspace the source owns', async () => {
    const { source, destination } = await pair();
    const one = await makeWorkspace(source, 'One');
    const two = await makeWorkspace(source, 'Two');

    await transferAccount(source.id, destination.id);

    for (const workspace of [one, two]) {
      const moved = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
      expect(moved.ownerAccountId).toBe(destination.id);
    }
  });

  it('carries campaigns, contacts, agents and numbers with the workspace', async () => {
    const { source, destination } = await pair();
    const workspace = await makeWorkspace(source, 'One');
    const agent = await makeAgent(workspace, 'receptionist');
    const did = await makePhoneNumber(workspace, '+912222', 'ASSIGNED');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Autumn', status: 'DRAFT' },
    });

    await transferAccount(source.id, destination.id);

    // Read back through the destination's own ownership, which is the only
    // thing that changed — everything below hangs off the workspace and was
    // never attached to the account.
    const owned = await prisma.workspace.findMany({
      where: { ownerAccountId: destination.id },
      include: { agents: true, phoneNumbers: true, campaigns: true },
    });

    expect(owned).toHaveLength(1);
    expect(owned[0]!.agents.map((a) => a.id)).toEqual([agent.id]);
    expect(owned[0]!.phoneNumbers.map((p) => p.id)).toEqual([did.id]);
    expect(owned[0]!.campaigns.map((c) => c.id)).toEqual([campaign.id]);
  });

  it('leaves a workspace the source was only a member of', async () => {
    const { source, destination } = await pair();
    const outsider = await makeAccount('outsider');
    const theirs = await makeWorkspace(outsider, 'Theirs');
    await addMember(theirs, source, 'MEMBER');
    await makeWorkspace(source, 'Mine');

    await transferAccount(source.id, destination.id);

    const untouched = await prisma.workspace.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched.ownerAccountId).toBe(outsider.id);
    // And the source keeps that membership: it was never part of the transfer.
    expect(
      await prisma.workspaceMember.count({
        where: { workspaceId: theirs.id, accountId: source.id },
      }),
    ).toBe(1);
  });

  /**
   * Two staff submit the same transfer, or one clicks twice. The second run's
   * plan still lists every workspace, but by the time it writes, the first has
   * moved them. An `updateMany` guarded on `ownerAccountId` quietly matches
   * nothing — and the code after it would then have made the second
   * destination an ADMIN on workspaces the first destination now owns, and
   * answered 200 with a plan describing a transfer that did not happen.
   */
  it('refuses when a workspace changes hands after the plan is read, and writes no membership', async () => {
    const { source, destination } = await pair();
    const third = await makeAccount('third');
    const one = await makeWorkspace(source, 'One');
    const two = await makeWorkspace(source, 'Two');

    // Another transfer commits between this one's read and its write.
    interposeBeforeTx('workspace', 'updateMany', async () => {
      await prisma.workspace.update({
        where: { id: two.id },
        data: { ownerAccountId: third.id },
      });
    });

    await expect(transferAccount(source.id, destination.id)).rejects.toThrow(
      ConcurrentModificationError,
    );

    // The whole transaction, not just the offending row.
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: one.id } })).ownerAccountId,
    ).toBe(source.id);
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: two.id } })).ownerAccountId,
    ).toBe(third.id);
    expect(
      await prisma.workspaceMember.count({ where: { accountId: destination.id } }),
    ).toBe(0);
    expect(await prisma.workspaceMember.count({ where: { accountId: source.id } })).toBe(2);
  });

  it('refuses a source with no workspaces', async () => {
    const { source, destination } = await pair();
    await expect(transferAccount(source.id, destination.id)).rejects.toThrow(
      NoWorkspacesError,
    );
  });
});

describe('transferAccount — membership', () => {
  it('replaces the source’s membership with an ADMIN row for the destination', async () => {
    const { source, destination } = await pair();
    const workspace = await makeWorkspace(source, 'One');

    await transferAccount(source.id, destination.id);

    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
    });
    expect(members).toHaveLength(1);
    expect(members[0]!.accountId).toBe(destination.id);
    expect(members[0]!.role).toBe('ADMIN');
  });

  it('promotes a destination that was already a MEMBER rather than failing', async () => {
    const { source, destination } = await pair();
    const workspace = await makeWorkspace(source, 'One');
    await addMember(workspace, destination, 'MEMBER');

    await transferAccount(source.id, destination.id);

    const member = await prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: workspace.id, accountId: destination.id },
    });
    expect(member.role).toBe('ADMIN');
    expect(
      await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
    ).toBe(1);
  });

  it('keeps every other member of a transferred workspace, with their role', async () => {
    const { source, destination } = await pair();
    const workspace = await makeWorkspace(source, 'One');
    const colleague = await makeAccount('colleague');
    const helper = await makeAccount('helper');
    await addMember(workspace, colleague, 'ADMIN');
    await addMember(workspace, helper, 'MEMBER');

    await transferAccount(source.id, destination.id);

    const roles = Object.fromEntries(
      (
        await prisma.workspaceMember.findMany({ where: { workspaceId: workspace.id } })
      ).map((m) => [m.accountId, m.role]),
    );
    expect(roles[colleague.id]).toBe('ADMIN');
    expect(roles[helper.id]).toBe('MEMBER');
    expect(roles[destination.id]).toBe('ADMIN');
    expect(roles[source.id]).toBeUndefined();
  });
});

describe('transferAccount — credits', () => {
  it('moves the whole balance and writes a ledger row on each side', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    await prisma.account.update({ where: { id: source.id }, data: { credits: 5_000_000n } });
    await prisma.account.update({
      where: { id: destination.id },
      data: { credits: 1_000_000n },
    });

    const result = await transferAccount(source.id, destination.id);

    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: source.id } })).credits,
    ).toBe(0n);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: destination.id } })).credits,
    ).toBe(6_000_000n);
    expect(result.credits).toBe('500');

    const out = await prisma.creditTransaction.findFirstOrThrow({
      where: { accountId: source.id, type: 'ACCOUNT_TRANSFER_OUT' },
    });
    const into = await prisma.creditTransaction.findFirstOrThrow({
      where: { accountId: destination.id, type: 'ACCOUNT_TRANSFER_IN' },
    });

    expect(out.amount).toBe(-5_000_000n);
    expect(into.amount).toBe(5_000_000n);
    // Each note names the other account: with the history split across two
    // accounts, this is the only thing connecting the halves.
    expect(out.note).toContain(destination.email);
    expect(into.note).toContain(source.email);
  });

  /**
   * The plan the operator confirmed says "500". If a call settles between that
   * read and the write, the transfer must not quietly move 400 and report 500:
   * the number the plan reports and the number that moves must be one read.
   */
  it('refuses when the balance changes after the plan is read, rather than moving a number the plan did not report', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    await prisma.account.update({ where: { id: source.id }, data: { credits: 5_000_000n } });

    // A call settles on another connection after describeTransfer has read.
    interposeBeforeTx('workspace', 'updateMany', async () => {
      await prisma.account.update({
        where: { id: source.id },
        data: { credits: { decrement: 1_000_000n } },
      });
    });

    await expect(transferAccount(source.id, destination.id)).rejects.toThrow(
      ConcurrentModificationError,
    );

    // Nothing moved: the source keeps what it has now, the destination gets
    // nothing, and no ledger row claims otherwise.
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: source.id } })).credits,
    ).toBe(4_000_000n);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: destination.id } })).credits,
    ).toBe(0n);
    expect(
      await prisma.creditTransaction.count({
        where: { type: { in: ['ACCOUNT_TRANSFER_OUT', 'ACCOUNT_TRANSFER_IN'] } },
      }),
    ).toBe(0);
    expect(
      (await prisma.workspace.findFirstOrThrow({ where: { name: 'One' } })).ownerAccountId,
    ).toBe(source.id);
  });

  it('writes no ledger rows when the source balance is zero', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');

    await transferAccount(source.id, destination.id);

    expect(
      await prisma.creditTransaction.count({
        where: { type: { in: ['ACCOUNT_TRANSFER_OUT', 'ACCOUNT_TRANSFER_IN'] } },
      }),
    ).toBe(0);
  });

  it('leaves the source’s existing ledger history on the source', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    const old = await prisma.creditTransaction.create({
      data: { accountId: source.id, amount: 100n, type: 'ADJUSTMENT', note: 'earlier' },
    });

    await transferAccount(source.id, destination.id);

    // An append-only ledger exists to survive exactly this. Rewriting it would
    // make a charge appear to have been incurred by an account that did not
    // incur it.
    expect(
      (await prisma.creditTransaction.findUniqueOrThrow({ where: { id: old.id } })).accountId,
    ).toBe(source.id);
  });
});

describe('transferAccount — tiers and allotments', () => {
  it('moves tier assignments the destination does not already hold', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    const tier = await prisma.tier.create({
      data: { slug: 'moving', name: 'Moving', defaultPriceCreditsPerMin: 10_000n },
    });
    await prisma.accountTier.create({
      data: { accountId: source.id, tierId: tier.id, priceCreditsPerMin: 7n },
    });

    await transferAccount(source.id, destination.id);

    const moved = await prisma.accountTier.findUniqueOrThrow({
      where: { accountId_tierId: { accountId: destination.id, tierId: tier.id } },
    });
    // The negotiated rate travels with the assignment. Dropping it would move
    // the customer onto the list price without anybody deciding to.
    expect(moved.priceCreditsPerMin).toBe(7n);
    expect(
      await prisma.accountTier.count({ where: { accountId: source.id } }),
    ).toBe(0);
  });

  it('keeps the destination’s own rate on a tier both accounts hold', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    const tier = await prisma.tier.create({ data: { slug: 'clash', name: 'Clash' } });
    await prisma.accountTier.create({
      data: { accountId: source.id, tierId: tier.id, priceCreditsPerMin: 7n },
    });
    await prisma.accountTier.create({
      data: { accountId: destination.id, tierId: tier.id, priceCreditsPerMin: 9n },
    });

    const result = await transferAccount(source.id, destination.id);

    expect(
      (
        await prisma.accountTier.findUniqueOrThrow({
          where: { accountId_tierId: { accountId: destination.id, tierId: tier.id } },
        })
      ).priceCreditsPerMin,
    ).toBe(9n);
    // Nothing is destroyed: the source's row stays and the result says so, so
    // an operator can see what did not move rather than discovering later that
    // an entitlement was deleted.
    expect(
      await prisma.accountTier.count({ where: { accountId: source.id, tierId: tier.id } }),
    ).toBe(1);
    expect(result.tiersStaying).toEqual(['Clash']);
  });

  it('does not move the account’s concurrency allotment', async () => {
    const { source, destination } = await pair();
    await makeWorkspace(source, 'One');
    await prisma.account.update({
      where: { id: source.id },
      data: { concurrencyLimit: 11 },
    });
    await prisma.account.update({
      where: { id: destination.id },
      data: { concurrencyLimit: 3 },
    });

    await transferAccount(source.id, destination.id);

    // An allotment is YE's commercial arrangement with an account, not a
    // property of the workspaces. The destination keeps its own.
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: destination.id } }))
        .concurrencyLimit,
    ).toBe(3);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: source.id } })).concurrencyLimit,
    ).toBe(11);
  });
});

describe('transferAccount — refusals', () => {
  it('refuses source and destination being the same account', async () => {
    const { source } = await pair();
    await makeWorkspace(source, 'One');
    await expect(transferAccount(source.id, source.id)).rejects.toThrow(SameAccountError);
  });

  it('refuses an account that does not exist, and writes nothing', async () => {
    const { source } = await pair();
    await makeWorkspace(source, 'One');

    await expect(transferAccount(source.id, 'nobody')).rejects.toThrow(AccountNotFoundError);

    expect(
      await prisma.workspace.count({ where: { ownerAccountId: source.id } }),
    ).toBe(1);
  });
});
