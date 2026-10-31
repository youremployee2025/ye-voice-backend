import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import { toInternalCredits } from '../../lib/credits.js';
import { ClerkProvisioningError } from '../../lib/clerkUsers.js';
import {
  AgentNotAvailableError,
  InvalidCreditAmountError,
  PhoneNumberNotAvailableError,
  TierNotAssignableError,
  WorkspaceSlugTakenError,
  onboardCustomer,
  type OnboardResult,
} from '../../services/onboarding.js';
import {
  AccountNotFoundError,
  ConcurrentModificationError,
  NoWorkspacesError,
  SameAccountError,
  describeTransfer,
  transferAccount,
  type TransferPreview,
} from '../../services/accountTransfer.js';

/**
 * The two staff operations that write across the whole tenancy graph.
 *
 * Both are single calls because assembled by hand out of the endpoints beside
 * them they are six writes with no transaction around them, and the
 * half-finished states are silent — a workspace whose owner has no membership
 * row cannot be opened by its owner, and nothing in the console says so.
 *
 * The services own the rules; this file owns the HTTP. A typed error from
 * either service maps to one status and one sentence here, so a rule is never
 * expressed twice.
 */
export const adminCustomerRoutes: Router = Router();

adminCustomerRoutes.use(requireStaffToken);

/**
 * `min(1)` on every id, and `.refine` for uniqueness rather than a `Set`.
 *
 * Naming one agent twice is a mistake worth reporting: deduped silently it is
 * indistinguishable from naming an agent somebody else holds, and the operator
 * would see a count that does not match the list they submitted.
 */
const idList = (what: string) =>
  z
    .array(z.string().min(1))
    .max(50)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, `each ${what} may appear only once`);

const onboardSchema = z.object({
  // `z.email().trim()` validates first and trims second, so an address pasted
  // with a trailing space is a 400. Trim, then validate.
  email: z.string().trim().pipe(z.email()),
  workspaceName: z.string().trim().min(1, 'a workspace name is required').max(64),
  agentIds: idList('agent'),
  phoneNumberIds: idList('phone number'),
  /** A decimal string, never a number: this is money and a float loses the
   *  hundredths on exactly the value that becomes a billing dispute. */
  credits: z.string().trim().min(1, 'an opening credit is required'),
  tierId: z.string().min(1).nullish(),
});

const transferSchema = z.object({
  sourceAccountId: z.string().min(1),
  destinationAccountId: z.string().min(1),
});

const serializeOnboard = (result: OnboardResult) => ({
  account: {
    id: result.account.id,
    email: result.account.email,
    // Which of the two happened is worth saying: "we made this person an
    // account" and "they already had one" read very differently to whoever is
    // about to email them.
    created: result.account.created,
    clerk_user_created: result.account.clerkUserCreated,
  },
  workspace: result.workspace,
  assigned: {
    agents: result.assigned.agents,
    phone_numbers: result.assigned.phoneNumbers,
    tier: result.assigned.tier,
    credits: result.assigned.credits,
  },
});

const serializeTransfer = (plan: TransferPreview) => ({
  source: plan.source,
  destination: plan.destination,
  workspaces: plan.workspaces,
  counts: {
    workspaces: plan.counts.workspaces,
    agents: plan.counts.agents,
    phone_numbers: plan.counts.phoneNumbers,
    campaigns: plan.counts.campaigns,
    contacts: plan.counts.contacts,
    members: plan.counts.members,
  },
  credits: plan.credits,
  tiers_moving: plan.tiersMoving,
  // Named rather than silently left behind. An operator who is not told about
  // them will later find an entitlement on an account they thought was empty.
  tiers_staying: plan.tiersStaying,
});

/** Translates a service's typed refusal into a status and a sentence. Shared,
 *  so the preview and the commit cannot answer the same refusal differently. */
function asApiError(err: unknown): ApiError | null {
  if (err instanceof SameAccountError) {
    return new ApiError(422, 'SAME_ACCOUNT', err.message);
  }
  if (err instanceof AccountNotFoundError) {
    return new ApiError(404, 'NOT_FOUND', err.message);
  }
  if (err instanceof NoWorkspacesError) {
    return new ApiError(422, 'NO_WORKSPACES', err.message);
  }
  if (err instanceof ConcurrentModificationError) {
    return new ApiError(409, 'CONCURRENT_MODIFICATION', err.message);
  }
  if (err instanceof AgentNotAvailableError) {
    return new ApiError(
      409,
      'AGENT_NOT_AVAILABLE',
      `${err.message} Nothing was created — refresh the pool and try again.`,
    );
  }
  if (err instanceof PhoneNumberNotAvailableError) {
    return new ApiError(
      409,
      'PHONE_NUMBER_NOT_AVAILABLE',
      `${err.message} Nothing was created — refresh the inventory and try again.`,
    );
  }
  if (err instanceof TierNotAssignableError) {
    // Two different facts. A tier that does not exist is a wrong id; a retired
    // one is a real tier the platform no longer offers, and only the second is
    // something the operator might argue with.
    return err.reason === 'missing'
      ? new ApiError(404, 'NOT_FOUND', err.message)
      : new ApiError(409, 'TIER_NOT_ASSIGNABLE', err.message);
  }
  if (err instanceof WorkspaceSlugTakenError) {
    return new ApiError(409, 'WORKSPACE_SLUG_TAKEN', `${err.message} Try again.`);
  }
  if (err instanceof InvalidCreditAmountError) {
    return new ApiError(400, 'VALIDATION_ERROR', err.message);
  }
  if (err instanceof ClerkProvisioningError) {
    // The cause is logged, never returned: Clerk's own wording can quote a
    // request, and the operator acts on the code either way.
    console.error('[admin.onboard] Clerk provisioning failed', err.cause, {
      email: err.email,
    });
    return new ApiError(
      502,
      'CLERK_ERROR',
      'The identity provider could not be reached, so no account was created. Try again.',
    );
  }

  return null;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const mapped = asApiError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

adminCustomerRoutes.post(
  '/customers/onboard',
  asyncHandler(async (req, res) => {
    const body = parseBody(onboardSchema, req.body);

    // Parsed here rather than in the service, so a malformed amount is a 400
    // before a Clerk user is created for it. `toInternalCredits` refuses a
    // negative; zero parses and is refused on the next line.
    let opening: bigint;
    try {
      opening = toInternalCredits(body.credits);
    } catch {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'credits must be a positive amount with at most 4 decimal places, e.g. "500" or "12.5".',
      );
    }

    if (opening <= 0n) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'credits must be greater than zero — an onboarding with no opening balance cannot place a call.',
      );
    }

    const result = await run(() =>
      onboardCustomer({
        email: body.email,
        workspaceName: body.workspaceName,
        agentIds: body.agentIds,
        phoneNumberIds: body.phoneNumberIds,
        credits: body.credits,
        tierId: body.tierId ?? null,
      }),
    );

    res.status(201).json({ success: true, data: serializeOnboard(result) });
  }),
);

// Registered before `/account-transfers`, so nothing has to depend on Express
// matching a literal path ahead of a parameterised one.
adminCustomerRoutes.get(
  '/account-transfers/preview',
  asyncHandler(async (req, res) => {
    const { sourceAccountId, destinationAccountId } = parseBody(transferSchema, req.query);

    const plan = await run(() => describeTransfer(sourceAccountId, destinationAccountId));

    res.json({ success: true, data: serializeTransfer(plan) });
  }),
);

adminCustomerRoutes.post(
  '/account-transfers',
  asyncHandler(async (req, res) => {
    const { sourceAccountId, destinationAccountId } = parseBody(transferSchema, req.body);

    const result = await run(() => transferAccount(sourceAccountId, destinationAccountId));

    res.json({ success: true, data: serializeTransfer(result) });
  }),
);
