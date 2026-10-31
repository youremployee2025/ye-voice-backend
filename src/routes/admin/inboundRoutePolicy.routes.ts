import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler, ApiError } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import { env } from '../../lib/env.js';
import {
  createInboundRoutePolicy,
  listInboundRoutePolicies,
  updateInboundRoutePolicy,
  type InboundRoutePolicyRecord,
} from '../../adapter/vocobase.js';

/**
 * Registering the account-wide inbound routing policy.
 *
 * A staff action, not a campaign start: there is one partner account behind
 * every YE customer, so this configures the platform rather than anybody's
 * workspace, and doing it per start would write to that shared account on every
 * click. One PARTNER-scope policy fires for every inbound call on the account;
 * the claim table decides which campaign owns each DID, so a per-DID policy
 * would be a second lifecycle to keep in step with the first.
 *
 * The signing secret is OURS (INBOUND_ROUTE_POLICY_SECRET), unlike the outcome
 * webhook whose secret upstream generates — the routing verifier reads the same
 * value — so it is sent on write and never echoed back.
 */
export const adminInboundRoutePolicyRoutes: Router = Router();

adminInboundRoutePolicyRoutes.use(requireStaffToken);

/** The label this policy carries on the shared account — there is no id of ours
 *  to store, so it is found by the name we gave it, as the webhook config is. */
const POLICY_NAME = 'EZO inbound route policy';

const MASK = '****';

function serializePolicy(policy: InboundRoutePolicyRecord) {
  return {
    id: policy.id ?? null,
    scope: policy.scope ?? null,
    name: policy.name ?? null,
    enabled: policy.enabled ?? null,
    webhook_url: policy.webhook_url ?? null,
    timeout_ms: policy.timeout_ms ?? null,
    failure_action: policy.failure_action ?? null,
    allowed_actions: policy.allowed_actions ?? [],
    // Never the value: the secret is ours and stays off every response.
    secret: MASK,
  };
}

function ourPolicyIn(policies: InboundRoutePolicyRecord[] | undefined): InboundRoutePolicyRecord | null {
  // By name, never by scope alone: the partner account is shared, and another
  // integrator's PARTNER-scope policy is not ours to overwrite.
  return policies?.find((p) => p.name === POLICY_NAME) ?? null;
}

const httpsUrl = z.string().superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
    return;
  }
  if (parsed.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'must use https' });
});

const configSchema = z.object({ url: httpsUrl });

adminInboundRoutePolicyRoutes.get(
  '/inbound-route-policy',
  asyncHandler(async (_req, res) => {
    const listed = await listInboundRoutePolicies();
    const ours = ourPolicyIn(listed.policies);
    res.json({
      success: true,
      data: {
        name: POLICY_NAME,
        configured: ours !== null,
        policy: ours ? serializePolicy(ours) : null,
      },
    });
  }),
);

/**
 * Registers the policy or moves its URL — create-or-update, because there is
 * exactly one policy this account can have and an operator does not know or
 * care whether it exists. The secret's floor is checked here so a
 * misconfigured deployment fails loudly rather than registering a policy the
 * verifier will then reject every callback for.
 */
adminInboundRoutePolicyRoutes.put(
  '/inbound-route-policy',
  asyncHandler(async (req, res) => {
    const body = parseBody(configSchema, req.body);

    if (!env.inboundRoutePolicySecret) {
      throw new ApiError(
        409,
        'INBOUND_DISABLED',
        'Set INBOUND_ROUTE_POLICY_SECRET before registering the routing policy, or every ' +
          'callback it makes will fail verification.',
      );
    }

    const fields = {
      scope: 'PARTNER',
      name: POLICY_NAME,
      enabled: true,
      webhook_url: body.url,
      webhook_secret: env.inboundRoutePolicySecret,
      timeout_ms: 2000,
      // ANSWER_WITH_AI only: a deploy blip must degrade to an agent answering
      // without variables, never a dropped call, and TRANSFER is refused for
      // VoiceLink upstream anyway.
      failure_action: 'ANSWER_WITH_AI',
      allowed_actions: ['ANSWER_WITH_AI'],
    };

    const listed = await listInboundRoutePolicies();
    const ours = ourPolicyIn(listed.policies);

    if (!ours?.id) {
      const created = await createInboundRoutePolicy(fields);
      res.status(201).json({ success: true, data: { policy: serializePolicy(created) } });
      return;
    }

    const updated = await updateInboundRoutePolicy(ours.id, fields);
    res.json({ success: true, data: { policy: serializePolicy(updated) } });
  }),
);
