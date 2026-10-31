// First, before any module that logs: importing this installs the console
// override, so every existing console.* call in the codebase becomes a
// structured line rather than a bare string on stdout.
import { httpLogger } from './lib/logger.js';

import express, { type Express } from 'express';
import cors from 'cors';
import { clerkMiddleware } from '@clerk/express';
import { env } from './lib/env.js';
import { errorHandler } from './lib/errors.js';
import { isTestAuthEnabled } from './middleware/auth.js';
import { meRoutes } from './routes/me.routes.js';
import { superAdminRoutes } from './routes/superAdmin.routes.js';
import { workspaceRoutes } from './routes/workspaces.routes.js';
import { inviteRoutes, workspaceInviteRoutes } from './routes/invites.routes.js';
import { memberRoutes } from './routes/members.routes.js';
import { agentRoutes } from './routes/agents.routes.js';
import { agentActionRoutes } from './routes/agent-actions.routes.js';
import { agentDocumentRoutes } from './routes/agent-documents.routes.js';
import { dictionaryRoutes } from './routes/dictionaries.routes.js';
import { functionRoutes } from './routes/functions.routes.js';
import { adminRoutes } from './routes/admin/index.js';
import { campaignRoutes } from './routes/campaigns.routes.js';
import { contactRoutes } from './routes/contacts.routes.js';
import { doNotCallRoutes } from './routes/doNotCall.routes.js';
import { notificationRoutes } from './routes/notifications.routes.js';
import { callRoutes } from './routes/calls.routes.js';
import { testSessionRoutes } from './routes/testSessions.routes.js';
import { analyticsRoutes } from './routes/analytics.routes.js';
import { phoneNumberRoutes } from './routes/phoneNumbers.routes.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { webhookRoutes } from './routes/webhooks.routes.js';
import { inboundRouteRoutes } from './routes/inboundRoute.routes.js';
import { integrationRoutes, integrationReturnRoutes } from './routes/integrations.routes.js';

export function createApp(): Express {
  // Tripwire: the header-based test identity must never be reachable in production.
  if (env.nodeEnv === 'production' && isTestAuthEnabled()) {
    throw new Error('Test auth bypass is enabled in production — refusing to start.');
  }

  const app = express();

  // `req.ip` is what the admin limiter keys on, so how far to trust
  // `X-Forwarded-For` is a security setting, not a deployment detail. Express
  // defaults to trusting nothing; behind an ingress this must be the real hop
  // count. See `TRUST_PROXY_HOPS`.
  app.set('trust proxy', env.trustProxyHops);

  // Ahead of every router, so a request that is rejected by CORS, by the
  // webhook signature check or by the body parser is still one logged line
  // with a request id — those are the requests worth having a trace of.
  app.use(httpLogger);

  app.use(cors({ origin: env.corsOrigins, credentials: true }));

  /**
   * Sized to the largest field any route declares, not left at the 100kb
   * default.
   *
   * `agentPayload` allows a 120,000-character prompt and a knowledge source
   * allows 200,000 characters of pasted text; at the default limit both were
   * rejected by body-parser before reaching a route, as a 500. The cap still
   * exists — it is the ceiling on what one request can make this process hold
   * — it is simply set from what the routes actually accept. Multipart uploads
   * do not pass through here; `agent-documents.routes.ts` caps those itself.
   */
  /**
   * Before the JSON parser, deliberately.
   *
   * A webhook signature covers the exact bytes received, and a
   * parsed-and-restringified body is a different string — key order,
   * whitespace and number formatting all move. The router carries its own
   * `express.raw`, so mounting it here is what keeps the bytes intact.
   *
   * Outside `/api` and ahead of Clerk: the caller is the voice platform, and
   * the signature is the whole of the authentication.
   */
  app.use('/webhooks', webhookRoutes);

  // Before express.json, with its own express.raw inside: the routing policy's
  // signature is over the exact request bytes, so the body must reach it
  // unparsed. Mounted at its full path so it does not collide with the
  // outcome-webhook router above.
  app.use('/webhooks/vocobase/inbound-route', inboundRouteRoutes);

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ success: true, data: { ok: true } });
  });

  /**
   * The Google connect return leg, outside `/api` and ahead of Clerk for the
   * reason `/webhooks` is: the caller is a browser arriving from the voice
   * platform's consent screen with no session of ours, and the single-use
   * nonce in the path is the whole of the authentication.
   */
  app.use('/integrations', integrationReturnRoutes);

  // Clerk needs real keys; tests supply identity via header instead.
  if (!isTestAuthEnabled()) {
    app.use(clerkMiddleware());
  }

  app.use('/api', meRoutes);
  app.use('/api/super-admin', superAdminRoutes);
  app.use('/api/workspaces', workspaceRoutes);
  app.use('/api/workspaces', workspaceInviteRoutes);
  app.use('/api/workspaces', memberRoutes);
  app.use('/api/workspaces', agentRoutes);
  app.use('/api/workspaces', agentActionRoutes);
  // Before `agentRoutes`' own `/documents` reader would matter, and separate
  // only because the knowledge base carries multipart handling the rest of the
  // agent surface has no use for.
  app.use('/api/workspaces', agentDocumentRoutes);
  app.use('/api/workspaces', dictionaryRoutes);
  app.use('/api/workspaces', functionRoutes);
  app.use('/api/workspaces', campaignRoutes);
  app.use('/api/workspaces', contactRoutes);
  app.use('/api/workspaces', doNotCallRoutes);
  app.use('/api/workspaces', notificationRoutes);
  app.use('/api/workspaces', callRoutes);
  app.use('/api/workspaces', testSessionRoutes);
  app.use('/api/workspaces', analyticsRoutes);
  app.use('/api/workspaces', phoneNumberRoutes);
  app.use('/api/workspaces', integrationRoutes);
  app.use('/api/invites', inviteRoutes);
  // Ahead of the staff guard, so what is capped is how fast a caller can try
  // tokens — not how fast an already-authenticated one can work. Mounted on
  // its own rather than in front of one router, so every staff router added
  // later is behind it by construction instead of by falling through the
  // first one — and so no admin request spends a rate-limit token twice.

  app.use(
    '/api/admin',
    createRateLimiter({
      limit: env.adminRateLimitMax,
      failureLimit: env.adminAuthFailureMax,
      windowMs: env.adminRateLimitWindowMs,
    }),
  );
  app.use('/api/admin', adminRoutes);

  app.use(errorHandler);

  return app;
}
