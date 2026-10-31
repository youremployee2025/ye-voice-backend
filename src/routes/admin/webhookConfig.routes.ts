import { Router } from 'express';
import { z } from 'zod';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler, ApiError } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import {
  createWebhookEndpoint,
  getPartnerConfig,
  listWebhookEndpoints,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  type WebhookEndpointRecord,
} from '../../adapter/vocobase.js';

/**
 * Registering the endpoint this backend receives call outcomes on.
 *
 * Until now that registration was done by hand against the partner API, and
 * the secret it issues was pasted into `.env` from a terminal — which is fine
 * exactly once and terrible the day it has to be rotated in a hurry.
 *
 * Staff-only, for the same reason the DID inventory and the tier catalogue
 * are: there is **one** partner account behind every YE customer, so this
 * configures the platform rather than anybody's workspace, and a customer
 * pointing it at a URL of their own would receive every other customer's call
 * outcomes.
 *
 * ## The secret
 *
 * Upstream generates it, returns it in full **exactly once** — on create and
 * on rotation — and can never show it again. So:
 *
 * - It is passed straight from the adapter into one response body and nowhere
 *   else. Not logged, not notified, not stored. A secret in a log sink signs
 *   completions and charges credits, and a log sink is read by more people and
 *   for longer than the operator who rotated it.
 * - Every read masks it with a placeholder of **our own** rather than echoing
 *   upstream's, because a mask this service prints cannot stop being a mask
 *   when upstream changes its mind about what it emits.
 * - The response says what to do with the value while it is still on screen.
 *   There is no second chance to read it, so a response that merely hands it
 *   over is a response that loses it.
 */

/**
 * The label this backend's endpoint carries on the shared account.
 *
 * There is no id of ours to store — the same problem the extraction-set
 * ensure has — so the endpoint is found by the name we gave it, which is why
 * the name is a constant and not a setting. Within upstream's rules:
 * lowercase alnum and hyphens, and never `default`, which is reserved.
 */
const YE_WEBHOOK_LABEL = 'ezo-backend';

/**
 * What this service actually handles, and therefore what it subscribes to.
 *
 * An **empty** allowlist upstream means *every* event, including ones the
 * platform adds later — so leaving it empty would quietly enrol this endpoint
 * in the next event type somebody ships, on an account shared with every other
 * integrator. Named explicitly instead: `call.status.updated` frees the line
 * and `session.completed` is the charging event.
 */
const YE_WEBHOOK_EVENTS = ['session.completed', 'call.status.updated'];

/** What a read prints where the secret is. Never the value, never empty. */
const MASK = '****';

const NOTE =
  `Copy this into VOCOBASE_WEBHOOK_SECRET and restart. It is shown once and cannot be read again. ` +
  `Move the value it replaces into VOCOBASE_WEBHOOK_SECRET_PREVIOUS first, so deliveries already ` +
  `signed with it still verify, and clear that line once none can be in flight.`;

export const adminWebhookConfigRoutes: Router = Router();

adminWebhookConfigRoutes.use(requireStaffToken);

/**
 * The projection, and it is an allow-list rather than a redaction.
 *
 * These rows come off an account every integrator on the platform shares, so
 * the same rule the calls surface holds applies: emit what this product needs
 * and nothing else. `agent_id`/`agent_name` are dropped because this endpoint
 * is account-wide and printing them would only ever be misleading.
 */
function serializeEndpoint(endpoint: WebhookEndpointRecord) {
  return {
    id: endpoint.id ?? null,
    label: endpoint.label ?? null,
    url: endpoint.url ?? null,
    enabled: endpoint.enabled ?? null,
    events: endpoint.events ?? [],
    last_delivery_at: endpoint.last_delivery_at ?? null,
    last_delivery_status: endpoint.last_delivery_status ?? null,
    created_at: endpoint.created_at ?? null,
    updated_at: endpoint.updated_at ?? null,
  };
}

/**
 * Ours, out of everything registered on the account.
 *
 * Every other row belongs to another integrator — their URLs are addresses on
 * their own networks — so nothing here ever returns or logs one. Upstream
 * makes the label unique per account, so at most one row can match.
 */
function ourEndpointIn(endpoints: WebhookEndpointRecord[] | undefined): WebhookEndpointRecord | null {
  return endpoints?.find((endpoint) => endpoint.label === YE_WEBHOOK_LABEL) ?? null;
}

/** Resolves ours, or refuses in a way that names the fix. */
async function requireOurEndpointId(): Promise<string> {
  const listed = await listWebhookEndpoints();
  const ours = ourEndpointIn(listed.endpoints);

  if (!ours?.id) {
    throw new ApiError(
      404,
      'WEBHOOK_ENDPOINT_NOT_CONFIGURED',
      'No webhook endpoint is registered for this backend yet. Set its URL first.',
    );
  }

  return ours.id;
}

/**
 * What is registered today.
 *
 * One upstream request: the account config carries both the singular webhook
 * block and the full endpoint list, and this surface is read from a console
 * page whose every load spends against a rate limit every customer of the
 * platform shares.
 */
adminWebhookConfigRoutes.get(
  '/webhook-config',
  asyncHandler(async (_req, res) => {
    const config = await getPartnerConfig();
    const ours = ourEndpointIn(config.webhooks);

    res.json({
      success: true,
      data: {
        label: YE_WEBHOOK_LABEL,
        configured: ours !== null,
        endpoint: ours ? serializeEndpoint(ours) : null,
        /**
         * Masked, always, and with our own placeholder. Null when there is no
         * endpoint at all, which is a different fact from "there is one and
         * you may not read its secret".
         */
        secret: ours ? MASK : null,
      },
    });
  }),
);

/**
 * The URL, validated here only as far as it can be validated without drift.
 *
 * Absolute and `https:` are permanent properties of what upstream will accept,
 * and checking them locally saves a request against a shared rate limit on the
 * commonest typo. Everything else — the SSRF rules, the DNS resolution, the
 * private-address checks — is upstream's and is left there, because a copy of
 * a rule that grows is a copy that eventually refuses a URL the platform would
 * have taken. Upstream's 400 passes through with its own wording, which is the
 * one thing that tells the operator what to fix.
 */
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

const configSchema = z.object({
  /**
   * Required, not optional. A PUT that accepted an absent URL would silently
   * leave the old one standing while the operator believed they had changed
   * it — the rule the staff assignment and concurrency routes already hold
   * about an omitted field.
   */
  url: httpsUrl,
  /**
   * Optional, and the default is this service's own two events rather than
   * upstream's "empty means everything". The values are not enumerated here:
   * the catalogue is the platform's and it grows, so a copy would turn next
   * month's event into a 400 this service invented. Upstream validates them.
   */
  events: z.array(z.string().min(1)).max(20).optional(),
});

/**
 * Points the platform at this backend, creating the endpoint or moving it.
 *
 * Create-or-update rather than two routes, because there is exactly one
 * endpoint this service can have and an operator setting its URL does not know
 * or care whether one exists. The create is the only path that yields a
 * secret, and it answers 201 so the two outcomes are distinguishable without
 * reading the body.
 */
adminWebhookConfigRoutes.put(
  '/webhook-config',
  asyncHandler(async (req, res) => {
    const body = parseBody(configSchema, req.body);
    const events = body.events ?? YE_WEBHOOK_EVENTS;

    const listed = await listWebhookEndpoints();
    const ours = ourEndpointIn(listed.endpoints);

    if (!ours?.id) {
      const created = await createWebhookEndpoint({
        label: YE_WEBHOOK_LABEL,
        url: body.url,
        enabled: true,
        events,
      });

      res.status(201).json({
        success: true,
        data: {
          endpoint: serializeEndpoint(created),
          // Verbatim from upstream, once. Anything this layer did to it would
          // be a secret no signature verifies.
          secret: created.secret ?? null,
          note: NOTE,
        },
      });

      return;
    }

    /**
     * `enabled: true` alongside the URL, deliberately. An operator setting the
     * URL of the endpoint this deployment receives on has said they want it
     * receiving; leaving a disabled endpoint disabled here would look exactly
     * like a working configuration that silently delivers nothing.
     */
    const updated = await updateWebhookEndpoint(ours.id, { url: body.url, enabled: true, events });

    res.json({
      success: true,
      data: {
        endpoint: serializeEndpoint(updated),
        // Untouched by an update, and unreadable. Null says "not rotated",
        // which is not the same as an empty secret.
        secret: null,
        note: 'The existing signing secret is unchanged. Rotate it to issue a new one.',
      },
    });
  }),
);

/**
 * Issues a new signing secret and shows it, once.
 *
 * Deliveries already enqueued upstream keep signing with the value they
 * snapshotted, so a rotation is only zero-drop if the receiver accepts both
 * for a while. That is what `VOCOBASE_WEBHOOK_SECRET_PREVIOUS` is for, and why
 * the note says to fill it before restarting rather than after.
 */
adminWebhookConfigRoutes.post(
  '/webhook-config/rotate',
  asyncHandler(async (_req, res) => {
    const id = await requireOurEndpointId();
    const rotated = await rotateWebhookSecret(id);

    res.json({
      success: true,
      data: { id: rotated.id ?? id, secret: rotated.secret ?? null, note: NOTE },
    });
  }),
);
