import { clerkClient } from '@clerk/express';

/**
 * Finding or creating the Clerk identity behind an Account.
 *
 * `Account.clerkUserId` is unique and not nullable, so an Account cannot exist
 * before a Clerk user does. Every other path into this service creates the
 * Account from a request the person made themselves — `ensureAccount` runs off
 * their own JWT — which is exactly what staff onboarding does not have: the
 * customer has not signed in yet and may never have heard of the product.
 *
 * This is that one seam, and it is deliberately the whole of it. Nothing else
 * in this service creates a Clerk user, and this creates one only from a
 * staff-authenticated request.
 */

export interface ProvisionedClerkUser {
  clerkUserId: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  /** True when this call created the user, false when it found one. Reported
   *  so the onboarding response can say which happened — "we made this person
   *  an account" and "they already had one" read very differently to whoever
   *  is about to email them. */
  created: boolean;
}

/** Clerk refused, or could not be reached. Distinguished from every local
 *  failure so the route answers 502 with a sentence rather than a stack. */
export class ClerkProvisioningError extends Error {
  constructor(
    readonly email: string,
    readonly cause: unknown,
  ) {
    super(`Could not find or create a Clerk user for ${email}.`);
    this.name = 'ClerkProvisioningError';
  }
}

function identityOf(user: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string;
  primaryEmailAddress?: { emailAddress: string } | null;
  emailAddresses: Array<{ emailAddress: string }>;
}): Omit<ProvisionedClerkUser, 'created'> {
  // The same resolution `readClerkIdentity` performs in the auth middleware,
  // so an Account provisioned here carries the fields it would have carried
  // had the person signed in first.
  const email =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;

  return { clerkUserId: user.id, email, name: name || null, imageUrl: user.imageUrl || null };
}

/**
 * The Clerk user for `email`, created if there is none.
 *
 * Called **outside** the onboarding transaction, on purpose. A Clerk round trip
 * is an HTTP request to a third party that can take a second or time out; run
 * inside `$transaction` it would hold row locks on `Account` for its whole
 * duration, and every concurrent call charge against that account would queue
 * behind it.
 *
 * The consequence of doing it first is a Clerk user with no workspace if the
 * transaction then fails. That is recoverable and quiet: the next attempt with
 * the same address finds this user rather than making a second one, which is
 * why the lookup comes before the create rather than the create being retried.
 */
export async function findOrCreateClerkUser(email: string): Promise<ProvisionedClerkUser> {
  try {
    const existing = await clerkClient.users.getUserList({ emailAddress: [email] });
    const found = existing.data[0];

    if (found) {
      return { ...identityOf(found), created: false };
    }

    const created = await clerkClient.users.createUser({
      emailAddress: [email],
      // Staff are provisioning an account for somebody who is not present.
      // There is no password to set, and the person signs in with whatever
      // method the Clerk instance offers on that address.
      skipPasswordRequirement: true,
    });

    return { ...identityOf(created), created: true };
  } catch (err) {
    throw new ClerkProvisioningError(email, err);
  }
}
