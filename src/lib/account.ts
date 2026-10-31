import type { Account } from '@prisma/client';
import { prisma } from './prisma.js';

export interface ClerkIdentity {
  clerkUserId: string;
  email: string;
  name?: string | null;
  imageUrl?: string | null;
}

/**
 * Upserts the Account for a Clerk user. Called on every authenticated request,
 * so the first request a person ever makes provisions their Account.
 */
export async function ensureAccount(identity: ClerkIdentity): Promise<Account> {
  const { clerkUserId, email, name, imageUrl } = identity;

  return prisma.account.upsert({
    where: { clerkUserId },
    create: { clerkUserId, email, name: name ?? null, imageUrl: imageUrl ?? null },
    update: { email, ...(name ? { name } : {}), ...(imageUrl ? { imageUrl } : {}) },
  });
}
