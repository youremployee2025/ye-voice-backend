import { Router } from 'express';
import {
  createConnectLink,
  deleteCustomerConnection,
  listConnectors,
  listCustomerConnections,
} from '../adapter/vocobase.js';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { env } from '../lib/env.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import {
  CONNECT_LINK_TTL_SECONDS,
  consumeConnectNonce,
  mintConnectNonce,
} from '../lib/oauthNonce.js';
import { ensurePartnerCustomer } from '../lib/partnerCustomer.js';
import { prisma } from '../lib/prisma.js';
import { readString } from '../lib/upstream.js';
import { claimResource, resourceInWorkspace, unmapResource } from '../lib/workspaceResource.js';
import { writeLimiter } from '../lib/writeLimiter.js';

/**
 * Connecting a workspace's Google account to the voice platform.
 *
 * The platform's OAuth connections are **partner-wide** — one account, every
 * workspace's tokens in one pool — so the isolation here is not a filter over
 * a shared list but a customer per workspace upstream: a connection minted
 * through `Workspace.partnerCustomerId` belongs to that workspace's customer,
 * and `GET /customers/:id/connections` is then an authoritative answer to
 * "is this theirs". `WorkspaceResource(kind=CONNECTION)` stays the gate every
 * bind and hook passes through; what changes is that it is now filled by the
 * customer who consented rather than by staff. Design §2–§3.
 *
 * **Connecting and disconnecting are ADMIN.** It is the act that authorises
 * call content to leave for a mailbox or a spreadsheet of somebody's choosing.
 * Reading the page is open to any member, like every other listing here.
 */
export const integrationRoutes: Router = Router();

/**
 * The three connectors this surface offers, in the order the page shows them.
 *
 * An allow-list rather than "every connector the partner account has": the
 * catalogue is partner-wide and grows, and a connector appearing on this page
 * because somebody enabled it upstream for a different integration is a
 * feature nobody designed. The order is ours, not upstream's, so the page does
 * not re-order itself when the platform re-orders its catalogue.
 */
export const GOOGLE_SLUGS = ['google_sheets', 'google_calendar', 'gmail'] as const;

type GoogleSlug = (typeof GOOGLE_SLUGS)[number];

export function isGoogleSlug(value: string): value is GoogleSlug {
  return (GOOGLE_SLUGS as readonly string[]).includes(value);
}

interface SerializedConnection {
  id: string;
  providerEmail: string | null;
  status: string | null;
  createdAt: string | null;
}

/**
 * Every connection this workspace's customer holds, mapped and grouped by tool.
 *
 * It **reconciles as it reads**. The return leg can be lost — a browser closed
 * on the consent redirect, a tab killed mid-flight — and the connection then
 * exists upstream with no `WorkspaceResource` row, which makes it invisible to
 * every bind that would use it while the customer is billed for the token. The
 * platform has already told us whose customer holds it, so claiming it here is
 * not a guess; it is the same fact the return leg would have recorded.
 *
 * A row that cannot be claimed because some *other* workspace already holds
 * that id is skipped rather than moved or listed. Nothing legitimate produces
 * it — the connection is upstream-owned by this customer — so it is a
 * contradiction, and both alternatives are worse: moving it takes another
 * workspace's connection away with every mapping row still saying otherwise,
 * and listing it offers a connection this workspace can never bind.
 */
async function ownedConnections(
  partnerCustomerId: string,
  workspaceId: string,
): Promise<Map<GoogleSlug, SerializedConnection[]>> {
  const { connections } = await listCustomerConnections(partnerCustomerId);
  const grouped = new Map<GoogleSlug, SerializedConnection[]>();

  for (const row of Array.isArray(connections) ? connections : []) {
    const id = readString(row, ['id']);
    const slug = readString(row, ['tool_slug', 'toolSlug']);
    if (!id || !slug || !isGoogleSlug(slug)) continue;

    const providerEmail = readString(row, ['provider_email', 'providerEmail']);

    try {
      await claimResource('CONNECTION', id, workspaceId, providerEmail);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        console.error(
          `Connection ${id} is held by the voice platform customer of workspace ${workspaceId} ` +
            'but is mapped to another workspace here. Not listed.',
        );
        continue;
      }
      throw err;
    }

    const list = grouped.get(slug) ?? [];
    list.push({
      id,
      providerEmail,
      status: readString(row, ['status']),
      createdAt: readString(row, ['created_at', 'createdAt']),
    });
    grouped.set(slug, list);
  }

  return grouped;
}

integrationRoutes.get(
  '/:workspaceId/integrations',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);

    // No customer means nothing has ever been connected, so there is nothing
    // to ask upstream about — and a read must not mint one. An admin opening
    // the page has not asked for a customer, and if it did every workspace
    // that ever looked at this page would have one.
    const connections = workspace.partnerCustomerId
      ? await ownedConnections(workspace.partnerCustomerId, workspace.id)
      : new Map<GoogleSlug, SerializedConnection[]>();

    const { connectors } = await listConnectors();
    const catalogue = new Map<string, string>();
    for (const row of Array.isArray(connectors) ? connectors : []) {
      const slug = readString(row, ['slug']);
      if (slug) catalogue.set(slug, readString(row, ['name']) ?? slug);
    }

    res.json({
      success: true,
      data: {
        tools: GOOGLE_SLUGS.map((slug) => ({
          slug,
          name: catalogue.get(slug) ?? slug,
          connections: connections.get(slug) ?? [],
        })),
      },
    });
  }),
);

/**
 * The connect-link refusals, translated.
 *
 * Every one of them is an upstream 400 that the admin who clicked *Connect*
 * supplied nothing towards and can do nothing about, so none of them may reach
 * them as `VALIDATION_ERROR` — "the voice platform rejected those values" said
 * to somebody who entered no values. They are 503s: the integration is not
 * usable right now for a reason on our side of the product.
 *
 * `INVALID_REDIRECT_URI` is the one that will actually happen, and it means
 * one thing in practice: this environment's API host is not on the partner
 * user's `allowedRedirectHosts` upstream. That is an ops step per environment
 * — see `docs/deploy.md` — and the message says so without naming the
 * supplier, the rule every customer-facing string here follows.
 */
const CONNECT_LINK_FAILURES: Record<string, { code: 'INTEGRATIONS_NOT_CONFIGURED' | 'INTEGRATION_UNAVAILABLE'; message: string }> = {
  INVALID_REDIRECT_URI: {
    code: 'INTEGRATIONS_NOT_CONFIGURED',
    message:
      'Connecting Google is not set up for this environment yet. Contact support — there is nothing to fix on your side.',
  },
  CUSTOMER_ARCHIVED: {
    code: 'INTEGRATIONS_NOT_CONFIGURED',
    message:
      'This workspace cannot connect an account on the voice platform right now. Contact support.',
  },
  PARTNER_MISMATCH: {
    code: 'INTEGRATIONS_NOT_CONFIGURED',
    message:
      'This workspace cannot connect an account on the voice platform right now. Contact support.',
  },
  TOOL_NOT_FOUND: {
    code: 'INTEGRATION_UNAVAILABLE',
    message: 'That integration is not available on the voice platform right now.',
  },
  TOOL_INACTIVE: {
    code: 'INTEGRATION_UNAVAILABLE',
    message: 'That integration is not available on the voice platform right now.',
  },
};

integrationRoutes.post(
  '/:workspaceId/integrations/:slug/connect',
  requireAuth,
  requireMembership('ADMIN'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const { slug } = req.params;

    if (!isGoogleSlug(slug)) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Unknown integration. Choose one of: ${GOOGLE_SLUGS.join(', ')}.`,
      );
    }

    /**
     * Checked before the customer is created, not after.
     *
     * A link built on an empty origin redirects to a path with no host, which
     * the platform cannot honour — and minting the customer first would leave
     * a row upstream for a flow that was never going to complete.
     */
    if (!env.publicApiUrl) {
      console.error('PUBLIC_API_URL is unset; refusing to mint a connect link.');
      throw new ApiError(
        503,
        'INTEGRATIONS_NOT_CONFIGURED',
        'Connecting Google is not set up for this environment yet. Contact support — there is nothing to fix on your side.',
      );
    }

    const workspace = workspaceOf(req);
    const partnerCustomerId = await ensurePartnerCustomer(workspace);

    /**
     * The nonce is minted BEFORE the link, and is what the return leg
     * authenticates on: that request arrives from a browser with no session of
     * ours and no header it can set. Minting it first costs an unused Redis
     * key for forty minutes when the link fails, which is the cheaper of the
     * two orderings — the other loses the context of a link already handed out.
     */
    const nonce = await mintConnectNonce({
      workspaceId: workspace.id,
      slug,
      accountId: accountOf(req).id,
    });

    try {
      const link = await createConnectLink(partnerCustomerId, {
        tool_slug: slug,
        redirect_uri: `${env.publicApiUrl}/integrations/google/return/${nonce}`,
        // Sent rather than left to the platform's default, so the link's life
        // is tied to the nonce's: see `CONNECT_LINK_TTL_SECONDS`.
        expires_in_seconds: CONNECT_LINK_TTL_SECONDS,
      });

      res.json({ success: true, data: { url: link.url, expires_at: link.expires_at } });
    } catch (err) {
      const mapped = err instanceof ApiError ? CONNECT_LINK_FAILURES[err.code] : undefined;
      if (!mapped) throw err;

      console.error(
        `Connect link refused for workspace ${workspace.id}: ${(err as ApiError).code}`,
      );
      throw new ApiError(503, mapped.code, mapped.message);
    }
  }),
);

/**
 * Disconnects a Google account: revoked upstream, then unmapped.
 *
 * That order, not the reverse — the rule the dictionary delete already writes
 * down. Unmapping first and then failing the revoke leaves a live Google
 * connection that no workspace can see and therefore nobody can ever revoke,
 * while the tokens go on working.
 *
 * ADMIN, symmetrically with connecting: withdrawing the authorisation is the
 * same decision as granting it.
 */
integrationRoutes.delete(
  '/:workspaceId/integrations/connections/:connectionId',
  requireAuth,
  requireMembership('ADMIN'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const { connectionId } = req.params;

    // Ownership first, so a workspace cannot revoke another's Google account
    // by guessing an id. A foreign id, an unmapped one and one that never
    // existed all answer the same 404.
    await resourceInWorkspace('CONNECTION', connectionId, workspace.id);

    /**
     * A connection mapped by staff under the older flow has no customer behind
     * it, so there is nothing this surface can revoke. Refused rather than
     * unmapped: unmapping alone would tell the admin their Google access had
     * been withdrawn while the token went on working, which is the one wrong
     * answer a disconnect button may not give.
     */
    if (!workspace.partnerCustomerId) {
      console.error(
        `Connection ${connectionId} is mapped to workspace ${workspace.id}, which has no ` +
          'partner customer; it was not minted through this flow and cannot be revoked here.',
      );
      throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
    }

    try {
      await deleteCustomerConnection(workspace.partnerCustomerId, connectionId);
    } catch (err) {
      // Already gone upstream: drop the mapping rather than leave a row
      // holding the unique slot for something that does not exist.
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      console.error(`Connection ${connectionId} was already absent upstream; dropping the mapping.`);
    }

    await unmapResource('CONNECTION', connectionId);

    res.status(204).end();
  }),
);

/**
 * Where the browser is sent when the round trip is over, either way.
 *
 * `error` is one of five values and no more — `expired`, `denied`, `not_ours`,
 * `unavailable`, `failed` — because the dashboard's integrations page renders a sentence per
 * value and a fifth one it has never heard of renders as nothing at all. The
 * platform's own vocabulary is wider than that and grows, so it is mapped in
 * rather than forwarded.
 */
function backToDashboard(outcome: { connected: string } | { error: ReturnError }): string {
  const query =
    'connected' in outcome
      ? `connected=${encodeURIComponent(outcome.connected)}`
      : `error=${outcome.error}`;

  return `${env.dashboardUrl}/settings/integrations?${query}`;
}

type ReturnError = 'expired' | 'denied' | 'not_ours' | 'unavailable' | 'failed';

/**
 * The one platform failure that means **the person said no**, as opposed to
 * something going wrong. The platform reports a Google denial to the partner
 * `redirect_uri` as `?error=oauth_denied` with no `status`; it never forwards
 * Google's own `access_denied`.
 *
 * An allow-list rather than a pass-through: everything else the platform can
 * send back — `invalid_state`, `connection_failed`, `tool_not_found`,
 * `missing_code` — is a fault rather than a decision, and they all want the
 * same sentence and the same button. Reporting a fault as a refusal would tell
 * an admin they cancelled something they did not.
 */
const DENIAL_CODES = new Set(['oauth_denied']);

/**
 * The platform failures that trying again will not fix, because the thing that
 * is missing is on the platform's side: the connector is switched off there
 * (`tool_not_available`, `connect.routes.ts`, before OAuth starts) or this
 * workspace's customer is archived there (`customer_archived`, sent both before
 * and after OAuth). "Something went wrong, try again" would send the admin
 * round the same loop; `unavailable` tells them it needs support.
 */
const UNAVAILABLE_CODES = new Set(['tool_not_available', 'customer_archived']);

/**
 * The public half of the connect flow: where the platform sends the browser
 * once consent is done with.
 *
 * Mounted outside `/api` and ahead of the Clerk middleware, like `/webhooks`,
 * and for the same reason — the caller is not carrying a session of ours. The
 * nonce is the authentication, and it is single-use, so a link out of a
 * browser history is spent rather than replayable.
 *
 * **It always redirects**, never renders and never returns JSON. The reader is
 * a person who clicked a button on the dashboard two minutes ago, and every
 * outcome including every failure has to put them back on the page they left.
 */
export const integrationReturnRoutes: Router = Router();

integrationReturnRoutes.get(
  '/google/return/:nonce',
  asyncHandler(async (req, res) => {
    const context = await consumeConnectNonce(req.params.nonce);

    // Expired, already used, or never real — one answer, because the caller is
    // unauthenticated and telling those apart says whether a nonce was ever
    // minted. Nothing is asked upstream and nothing is written.
    if (!context) {
      res.redirect(backToDashboard({ error: 'expired' }));
      return;
    }

    const status = readQuery(req.query.status);
    const connectionId = readQuery(req.query.connection_id);

    if (status !== 'ok') {
      const code = readQuery(req.query.error)?.toLowerCase() ?? '';
      const error: ReturnError = DENIAL_CODES.has(code)
        ? 'denied'
        : UNAVAILABLE_CODES.has(code)
          ? 'unavailable'
          : 'failed';

      console.error(
        `Google connect returned ${code || 'no status'} for workspace ${context.workspaceId}.`,
      );
      res.redirect(backToDashboard({ error }));
      return;
    }

    if (!connectionId) {
      console.error(`Google connect reported success with no connection for ${context.workspaceId}.`);
      res.redirect(backToDashboard({ error: 'failed' }));
      return;
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: context.workspaceId },
      select: { id: true, deletedAt: true, partnerCustomerId: true },
    });

    // The workspace was deleted, or its customer went, while the admin was on
    // the consent screen. There is nowhere to put the connection.
    if (!workspace || workspace.deletedAt || !workspace.partnerCustomerId) {
      console.error(`Google connect returned for an unusable workspace ${context.workspaceId}.`);
      res.redirect(backToDashboard({ error: 'failed' }));
      return;
    }

    /**
     * The isolation check, and the reason a customer per workspace exists at
     * all. The connection id arrives on a query string from an unauthenticated
     * redirect; the only thing that makes it this workspace's is the
     * platform's own listing for this workspace's customer.
     */
    let held: boolean;
    let providerEmail: string | null = null;
    let toolSlug: string | null = null;
    try {
      const { connections } = await listCustomerConnections(workspace.partnerCustomerId);
      const row = (Array.isArray(connections) ? connections : []).find(
        (candidate) => readString(candidate, ['id']) === connectionId,
      );
      held = row !== undefined;
      providerEmail = row ? readString(row, ['provider_email', 'providerEmail']) : null;
      toolSlug = row ? readString(row, ['tool_slug', 'toolSlug']) : null;
    } catch (err) {
      // Unreadable is not "not theirs" and certainly not "connected": both of
      // those are claims about the customer's data that an outage cannot
      // support, and the connection is upstream either way for the listing to
      // reconcile later.
      console.error('Could not read the connections for a returning connect flow.', err);
      res.redirect(backToDashboard({ error: 'failed' }));
      return;
    }

    if (!held) {
      console.error(
        `Google connect named connection ${connectionId}, which workspace ${workspace.id}'s ` +
          'customer does not hold. Nothing claimed.',
      );
      res.redirect(backToDashboard({ error: 'not_ours' }));
      return;
    }

    /**
     * The nonce carries the tool the admin set out to connect, and the
     * success redirect ends by announcing that tool as connected. The listing
     * is the only word on which tool the named connection is actually for, so
     * a row that disagrees is announced as a failure rather than as that tool.
     *
     * The harm being avoided is the announcement, not the mapping.
     * `claimResource` stores the connection id and nothing about its tool, and
     * the listing reconciler would claim this same row under its real slug on
     * the next read anyway. What claiming it here and redirecting with
     * `connected=<nonce slug>` would do is tell the admin "Sheets connected"
     * about a Calendar consent. Leaving the claim to the reconciler keeps this
     * branch to one answer.
     */
    if (toolSlug !== context.slug) {
      console.error(
        `Google connect for ${context.slug} named connection ${connectionId}, which the ` +
          `listing reports as ${toolSlug ?? 'no tool'}. Nothing claimed.`,
      );
      res.redirect(backToDashboard({ error: 'failed' }));
      return;
    }

    try {
      await claimResource('CONNECTION', connectionId, workspace.id, providerEmail);
    } catch (err) {
      /**
       * A 409 means the id is already mapped to a DIFFERENT workspace —
       * `claimResource` is silent when the mapping is already this one, which
       * is the ordinary case of a listing that reconciled while the consent
       * screen was open.
       *
       * Reported as `not_ours` rather than as success. The plan called for
       * treating it as connected, and that is right for the same-workspace
       * case, which never reaches here: for a cross-workspace one it would
       * show this admin "Connected" for a connection every later bind refuses,
       * because `resourceInWorkspace` will go on answering 404.
       */
      if (err instanceof ApiError && err.status === 409) {
        res.redirect(backToDashboard({ error: 'not_ours' }));
        return;
      }

      console.error(`Could not record connection ${connectionId} for ${workspace.id}.`, err);
      res.redirect(backToDashboard({ error: 'failed' }));
      return;
    }

    res.redirect(backToDashboard({ connected: context.slug }));
  }),
);

/** A query parameter is `string | string[] | ParsedQs`; anything but a plain
 *  non-blank string is treated as absent. */
function readQuery(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
