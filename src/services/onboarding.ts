import { Prisma, type Account } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { colorForSlug, uniqueSlug } from '../lib/slug.js';
import { toInternalCredits } from '../lib/credits.js';
import { addOneMonth } from '../lib/billingCycle.js';
import { priceOf } from './didRental.js';
import { findOrCreateClerkUser } from '../lib/clerkUsers.js';
import { detachForeignResources } from './agentHandover.js';

/**
 * Turning an email address into a customer who can dial.
 *
 * Assembled by hand out of the endpoints that already exist, this is six writes
 * with no transaction around them, and every half-finished state is silent. A
 * workspace whose owner has no membership row cannot be opened by its owner. An
 * agent assigned to a workspace whose account was never credited cannot place a
 * call. Nothing in the console says either is wrong, which is the whole reason
 * this is one endpoint and one transaction.
 */

export class InvalidCreditAmountError extends Error {
  constructor() {
    super('The opening credit must be greater than zero.');
    this.name = 'InvalidCreditAmountError';
  }
}

export class AgentNotAvailableError extends Error {
  constructor() {
    super('One of those agents is not in the unassigned pool.');
    this.name = 'AgentNotAvailableError';
  }
}

export class PhoneNumberNotAvailableError extends Error {
  constructor() {
    super('One of those numbers is not in the shared pool.');
    this.name = 'PhoneNumberNotAvailableError';
  }
}

export class TierNotAssignableError extends Error {
  constructor(readonly reason: 'missing' | 'retired') {
    super(
      reason === 'retired'
        ? 'That tier is no longer offered by the platform, so it cannot be assigned.'
        : 'That tier does not exist.',
    );
    this.name = 'TierNotAssignableError';
  }
}

export class WorkspaceSlugTakenError extends Error {
  constructor() {
    super('A workspace claimed that address while this request was running.');
    this.name = 'WorkspaceSlugTakenError';
  }
}

export interface OnboardInput {
  email: string;
  workspaceName: string;
  agentIds: string[];
  phoneNumberIds: string[];
  /** Display credits, as a decimal string. Never a float — this is money. */
  credits: string;
  tierId?: string | null;
}

export interface OnboardResult {
  account: { id: string; email: string; created: boolean; clerkUserCreated: boolean };
  workspace: { id: string; name: string; slug: string };
  assigned: {
    agents: number;
    phoneNumbers: number;
    tier: string | null;
    credits: string;
  };
}

/**
 * The Account for this address, provisioning the Clerk identity if there is
 * none.
 *
 * Runs **before** the transaction. A Clerk round trip inside `$transaction`
 * would hold `Account` row locks for the length of a third-party HTTP request,
 * and every concurrent call charge against that account would queue behind it.
 */
async function resolveAccount(
  email: string,
): Promise<{ account: Account; created: boolean; clerkUserCreated: boolean }> {
  // Case-insensitively, because staff type an address by hand and a second
  // Account for `Ops@` beside `ops@` is a customer with their credits in two
  // places.
  const existing = await prisma.account.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });

  if (existing) {
    return { account: existing, created: false, clerkUserCreated: false };
  }

  const clerk = await findOrCreateClerkUser(email);

  // A Clerk user may already have an Account under a different address — they
  // changed the address on their own profile. Keying on the Clerk id rather
  // than the email is what stops that becoming a second Account.
  const byClerkId = await prisma.account.findUnique({
    where: { clerkUserId: clerk.clerkUserId },
  });

  if (byClerkId) {
    return { account: byClerkId, created: false, clerkUserCreated: clerk.created };
  }

  try {
    const account = await prisma.account.create({
      data: {
        clerkUserId: clerk.clerkUserId,
        email: clerk.email || email,
        name: clerk.name,
        imageUrl: clerk.imageUrl,
      },
    });

    return { account, created: true, clerkUserCreated: clerk.created };
  } catch (err) {
    // Two staff onboarding the same address at once. The row the other one
    // wrote is the right answer, not an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await prisma.account.findUnique({
        where: { clerkUserId: clerk.clerkUserId },
      });
      if (raced) return { account: raced, created: false, clerkUserCreated: clerk.created };
    }

    throw err;
  }
}

/**
 * A pool agent is not a clean agent.
 *
 * The customer-side removal route nulls `workspaceId` without stripping, so an
 * agent in the pool routinely still carries the previous tenant's dictionaries,
 * function URLs and documents — and handed over as-is it goes on answering the
 * new customer's calls out of them. Staff reassignment runs
 * `detachForeignResources` before it moves an agent; this is the same rule for
 * the same reason, and it is fail-closed for the same reason too: an agent that
 * stays in the pool can be onboarded again in a minute, one that moved with the
 * previous tenant's knowledge base attached cannot be un-moved.
 *
 * Runs **before** the transaction, because the strip is a round of platform
 * HTTP calls, and before `resolveAccount`, because the strip is idempotent on a
 * pool agent and a Clerk user is not — when the strip fails, nothing at all has
 * happened.
 *
 * The read here is not the availability test. An agent somebody holds is
 * refused so that THEIR resources are not detached from an agent still
 * answering their calls; the claim itself is the conditional `updateMany`
 * inside the transaction, which is what decides availability at the moment it
 * matters.
 */
async function stripPoolAgents(agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.workspaceId !== null) throw new AgentNotAvailableError();

    await detachForeignResources(agent, null);
  }
}

export async function onboardCustomer(input: OnboardInput): Promise<OnboardResult> {
  const topUp = toInternalCredits(input.credits);
  if (topUp <= 0n) throw new InvalidCreditAmountError();

  // Deduped before the count assertions below, or naming one agent twice looks
  // exactly like naming an agent somebody else holds.
  const agentIds = [...new Set(input.agentIds)];
  const phoneNumberIds = [...new Set(input.phoneNumberIds)];

  await stripPoolAgents(agentIds);

  const { account, created, clerkUserCreated } = await resolveAccount(input.email.trim());

  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      // Read through `tx`, so a workspace this transaction is about to write is
      // visible to a second call on the same connection. See `uniqueSlug`.
      const slug = await uniqueSlug(input.workspaceName, tx);

      const workspace = await tx.workspace.create({
        data: {
          name: input.workspaceName,
          slug,
          color: colorForSlug(slug),
          ownerAccountId: account.id,
          // The owner is also an ADMIN member, so every permission check
          // downstream is a plain membership lookup. Its absence is the one
          // failure nothing in the console shows.
          members: { create: { accountId: account.id, role: 'ADMIN' } },
        },
      });

      if (agentIds.length) {
        // The `where` clause IS the availability test. Reading the agents first
        // and checking they are unassigned tests a value that is already stale
        // by the time it is used — the discipline `accounts.routes.ts` sets out
        // for balances, and the same reasoning applies to any contended row.
        const claimed = await tx.agent.updateMany({
          where: { id: { in: agentIds }, workspaceId: null },
          data: { workspaceId: workspace.id },
        });

        if (claimed.count !== agentIds.length) throw new AgentNotAvailableError();
      }

      for (const phoneNumberId of phoneNumberIds) {
        // Read for the price only. Availability is decided by the write below.
        const number = await tx.phoneNumber.findUnique({ where: { id: phoneNumberId } });
        if (!number) throw new PhoneNumberNotAvailableError();

        const claimed = await tx.phoneNumber.updateMany({
          // `workspaceId: null` is the pool: UNASSIGNED and
          // RELEASED_NONPAYMENT are in it, ASSIGNED and PAST_DUE are not — a
          // number whose renewal was declined still belongs to whoever holds
          // it and still rings for them.
          where: { id: phoneNumberId, workspaceId: null },
          data: {
            workspaceId: workspace.id,
            status: 'ASSIGNED',
            // The snapshot the renewal sweep charges. Without it the customer
            // holds a number that is never renewed and never billed.
            rentedPriceCredits: priceOf(number),
            rentedAt: now,
            nextRenewalAt: addOneMonth(now),
            pastDueSince: null,
          },
        });

        if (claimed.count !== 1) throw new PhoneNumberNotAvailableError();
      }

      // A grant needs no floor, so this is an unconditional increment — but it
      // is still an increment rather than a computed total, because two writes
      // against one balance must compose.
      await tx.account.update({
        where: { id: account.id },
        data: { credits: { increment: topUp } },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: account.id,
          workspaceId: workspace.id,
          amount: topUp,
          type: 'ONBOARDING_TOPUP',
          note: 'Onboarding credit',
        },
      });

      let tierName: string | null = null;

      if (input.tierId) {
        const tier = await tx.tier.findUnique({ where: { id: input.tierId } });
        if (!tier) throw new TierNotAssignableError('missing');
        if (tier.status !== 'ACTIVE') throw new TierNotAssignableError('retired');

        // `update: {}` on purpose. An account already on this tier keeps the
        // rate and the `createdAt` it has; onboarding must not re-price a
        // customer, and when they were put on a tier is a fact.
        await tx.accountTier.upsert({
          where: { accountId_tierId: { accountId: account.id, tierId: tier.id } },
          create: { accountId: account.id, tierId: tier.id },
          update: {},
        });

        tierName = tier.name;
      }

      return {
        account: { id: account.id, email: account.email, created, clerkUserCreated },
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        assigned: {
          agents: agentIds.length,
          phoneNumbers: phoneNumberIds.length,
          tier: tierName,
          credits: input.credits,
        },
      };
    });
  } catch (err) {
    // The slug was free when it was chosen and taken by the time it was
    // written. Retrying is the remedy, so it is reported as its own thing
    // rather than as a constraint violation dressed up as a 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      String(err.meta?.target ?? '').includes('slug')
    ) {
      throw new WorkspaceSlugTakenError();
    }

    throw err;
  }
}
