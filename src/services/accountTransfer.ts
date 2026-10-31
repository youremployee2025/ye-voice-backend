import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { toDisplayCredits } from '../lib/credits.js';

/**
 * Moving an entire book of business from one account to another.
 *
 * `Workspace.ownerAccountId` is the hinge. Campaigns, contacts, agents, DIDs
 * and call attempts move because they were never attached to the account in
 * the first place — they hang off the workspace, and the workspace changed
 * hands. Only four things need writing: the ownership, the membership, the
 * balance, and the tier entitlements.
 */

export class SameAccountError extends Error {
  constructor() {
    super('The source and destination must be different accounts.');
    this.name = 'SameAccountError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(readonly side: 'source' | 'destination') {
    super(`The ${side} account does not exist.`);
    this.name = 'AccountNotFoundError';
  }
}

export class NoWorkspacesError extends Error {
  constructor() {
    super('That account owns no workspaces, so there is nothing to transfer.');
    this.name = 'NoWorkspacesError';
  }
}

/** Something the plan described changed between the read and the write.
 *  Reported rather than applied: a transfer of the wrong thing is worse than a
 *  transfer refused, and the plan the operator confirmed must be the plan that
 *  ran. */
export class ConcurrentModificationError extends Error {
  constructor(readonly what: 'balance' | 'workspaces') {
    super(
      what === 'balance'
        ? 'The source balance changed while the transfer was running. Nothing was moved.'
        : 'A workspace changed hands while the transfer was running. Nothing was moved.',
    );
    this.name = 'ConcurrentModificationError';
  }
}

export interface TransferPreview {
  source: { id: string; email: string };
  destination: { id: string; email: string };
  workspaces: Array<{ id: string; name: string; slug: string }>;
  counts: {
    workspaces: number;
    agents: number;
    phoneNumbers: number;
    campaigns: number;
    contacts: number;
    members: number;
  };
  /** Display credits, as a decimal string. */
  credits: string;
  /**
   * The same balance, as the internal `bigint` the ledger stores. This is the
   * value the commit compares-and-sets on, so the number the plan reports and
   * the number that moves are ONE read. Never serialized: `JSON.stringify`
   * throws on a bigint, which is the point — a route that forgot to pick fields
   * would fail loudly rather than leak the raw unit.
   */
  balanceInternal: bigint;
  tiersMoving: string[];
  /** Tiers the destination already holds. These stay on the source rather than
   *  overwriting a rate the destination already agreed to. */
  tiersStaying: string[];
}

export type TransferResult = TransferPreview;

/** The narrowest client this reads through, so the preview and the commit can
 *  share one implementation — the commit passes its own transaction. */
type Reader = Prisma.TransactionClient | typeof prisma;

/**
 * What a transfer would do.
 *
 * The commit calls this **inside its own transaction** and writes from what it
 * returns. Two code paths would let the confirm step promise something the
 * write does not do, and on an operation with no undo the confirm step is the
 * only protection there is.
 */
export async function describeTransfer(
  sourceAccountId: string,
  destinationAccountId: string,
  client: Reader = prisma,
): Promise<TransferPreview> {
  if (sourceAccountId === destinationAccountId) throw new SameAccountError();

  const source = await client.account.findUnique({ where: { id: sourceAccountId } });
  if (!source) throw new AccountNotFoundError('source');

  const destination = await client.account.findUnique({
    where: { id: destinationAccountId },
  });
  if (!destination) throw new AccountNotFoundError('destination');

  // Owned, not joined. A workspace the source is merely a member of belongs to
  // somebody else and is not the source's to hand over.
  const workspaces = await client.workspace.findMany({
    where: { ownerAccountId: source.id },
    select: {
      id: true,
      name: true,
      slug: true,
      _count: { select: { agents: true, phoneNumbers: true, campaigns: true, members: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const workspaceIds = workspaces.map((workspace) => workspace.id);

  // Contacts have no `_count` on the workspace include used above, so they are
  // counted here rather than loaded.
  const contacts = workspaceIds.length
    ? await client.contact.count({ where: { workspaceId: { in: workspaceIds } } })
    : 0;

  const sourceTiers = await client.accountTier.findMany({
    where: { accountId: source.id },
    include: { tier: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const destinationTierIds = new Set(
    (
      await client.accountTier.findMany({
        where: { accountId: destination.id },
        select: { tierId: true },
      })
    ).map((row) => row.tierId),
  );

  const sum = (pick: (w: (typeof workspaces)[number]) => number) =>
    workspaces.reduce((total, workspace) => total + pick(workspace), 0);

  return {
    source: { id: source.id, email: source.email },
    destination: { id: destination.id, email: destination.email },
    workspaces: workspaces.map(({ id, name, slug }) => ({ id, name, slug })),
    counts: {
      workspaces: workspaces.length,
      agents: sum((w) => w._count.agents),
      phoneNumbers: sum((w) => w._count.phoneNumbers),
      campaigns: sum((w) => w._count.campaigns),
      contacts,
      members: sum((w) => w._count.members),
    },
    credits: toDisplayCredits(source.credits),
    balanceInternal: source.credits,
    tiersMoving: sourceTiers
      .filter((row) => !destinationTierIds.has(row.tierId))
      .map((row) => row.tier.name),
    tiersStaying: sourceTiers
      .filter((row) => destinationTierIds.has(row.tierId))
      .map((row) => row.tier.name),
  };
}

export async function transferAccount(
  sourceAccountId: string,
  destinationAccountId: string,
): Promise<TransferResult> {
  return prisma.$transaction(async (tx) => {
    // Re-derived inside the transaction rather than trusted from the preview
    // the operator saw: minutes may have passed, and the write must describe
    // the accounts as they are now.
    const plan = await describeTransfer(sourceAccountId, destinationAccountId, tx);

    if (!plan.workspaces.length) throw new NoWorkspacesError();

    const workspaceIds = plan.workspaces.map((workspace) => workspace.id);

    // `ownerAccountId: sourceAccountId` is the guard, and the count is the
    // assertion that it held for every row. Two staff submitting the same
    // transfer — or one clicking twice — both read a plan listing every
    // workspace; the second write matches whatever the first left behind, and
    // without the assertion it would go on to seat its destination as ADMIN on
    // workspaces the first destination now owns, then answer 200 with a plan
    // describing a transfer that did not happen.
    const reowned = await tx.workspace.updateMany({
      where: { id: { in: workspaceIds }, ownerAccountId: sourceAccountId },
      data: { ownerAccountId: destinationAccountId },
    });

    if (reowned.count !== workspaceIds.length) throw new ConcurrentModificationError('workspaces');

    // The source's own rows go; everybody else's stay exactly as they are. A
    // colleague's ADMIN seat is not the owner's to revoke by changing hands.
    await tx.workspaceMember.deleteMany({
      where: { workspaceId: { in: workspaceIds }, accountId: sourceAccountId },
    });

    for (const workspaceId of workspaceIds) {
      // Upsert, not create: the destination may already be a MEMBER of a
      // workspace it is about to own, and `create` would fail the composite
      // unique. This promotes instead.
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_accountId: { workspaceId, accountId: destinationAccountId },
        },
        create: { workspaceId, accountId: destinationAccountId, role: 'ADMIN' },
        update: { role: 'ADMIN' },
      });
    }

    // The balance the plan reports, not a second read. Postgres runs READ
    // COMMITTED, so each statement sees its own snapshot and a re-read here
    // could return a different number from the one `plan.credits` carries —
    // and the CAS would then move that number while the response reported the
    // other.
    const balance = plan.balanceInternal;

    if (balance > 0n) {
      // Compare-and-set on the exact balance the plan read. A `count` of 0
      // means it moved in between — a call settled, a top-up landed — and that
      // is a refusal rather than a transfer of a number nobody read.
      const moved = await tx.account.updateMany({
        where: { id: sourceAccountId, credits: balance },
        data: { credits: { decrement: balance } },
      });

      if (moved.count !== 1) throw new ConcurrentModificationError('balance');

      await tx.account.update({
        where: { id: destinationAccountId },
        data: { credits: { increment: balance } },
      });

      await tx.creditTransaction.createMany({
        data: [
          {
            accountId: sourceAccountId,
            amount: -balance,
            type: 'ACCOUNT_TRANSFER_OUT',
            note: `Transfer to ${plan.destination.email}`,
          },
          {
            accountId: destinationAccountId,
            amount: balance,
            type: 'ACCOUNT_TRANSFER_IN',
            note: `Transfer from ${plan.source.email}`,
          },
        ],
      });
    }

    // Only the tiers the destination does not already hold. A row for a tier
    // it holds would collide on `unique(accountId, tierId)`, and resolving that
    // by overwriting would replace a rate the destination agreed to with one
    // agreed by somebody else. Those rows stay on the source, reported rather
    // than deleted — an entitlement nobody asked to destroy.
    const clashing = new Set(
      (
        await tx.accountTier.findMany({
          where: { accountId: destinationAccountId },
          select: { tierId: true },
        })
      ).map((row) => row.tierId),
    );

    const movable = (
      await tx.accountTier.findMany({
        where: { accountId: sourceAccountId },
        select: { id: true, tierId: true },
      })
    ).filter((row) => !clashing.has(row.tierId));

    if (movable.length) {
      await tx.accountTier.updateMany({
        where: { id: { in: movable.map((row) => row.id) } },
        data: { accountId: destinationAccountId },
      });
    }

    return plan;
  });
}
