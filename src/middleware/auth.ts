import type { NextFunction, Request, Response } from 'express';
import { clerkClient, getAuth } from '@clerk/express';
import { ensureAccount, type ClerkIdentity } from '../lib/account.js';
import { fail } from '../lib/errors.js';

const TEST_IDENTITY_HEADER = 'x-test-clerk-user';

/**
 * Tests need to act as a given Clerk user without minting real JWTs, so in
 * NODE_ENV=test only, identity may come from a header instead. createApp()
 * refuses to boot if this is ever reachable in production.
 */
export function isTestAuthEnabled(): boolean {
  return process.env.NODE_ENV === 'test';
}

function readTestIdentity(req: Request): ClerkIdentity | null {
  const header = req.header(TEST_IDENTITY_HEADER);
  if (!header) return null;

  const [clerkUserId, email] = header.split('|');
  if (!clerkUserId || !email) return null;

  return { clerkUserId, email };
}

async function readClerkIdentity(req: Request): Promise<ClerkIdentity | null> {
  const { userId } = getAuth(req);
  if (!userId) return null;

  const user = await clerkClient.users.getUser(userId);
  const email =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;

  if (!email) return null;

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;

  return { clerkUserId: userId, email, name, imageUrl: user.imageUrl };
}

/** Verifies the caller and attaches the provisioned Account to the request. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const identity = isTestAuthEnabled()
      ? readTestIdentity(req)
      : await readClerkIdentity(req);

    if (!identity) {
      fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
      return;
    }

    req.account = await ensureAccount(identity);
    next();
  } catch (err) {
    next(err);
  }
}

/** Narrowing helper — requireAuth guarantees this is set on downstream handlers. */
export function accountOf(req: Request) {
  const account = req.account;
  if (!account) throw new Error('requireAuth must run before this handler');
  return account;
}
