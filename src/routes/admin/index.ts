import { Router } from 'express';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { adminAgentRoutes } from './agents.routes.js';
import { adminResourceRoutes } from './resources.routes.js';
import { adminPhoneNumberRoutes } from './phoneNumbers.routes.js';
import { adminAccountRoutes } from './accounts.routes.js';
import { adminWorkspaceRoutes } from './workspaces.routes.js';
import { adminOverviewRoutes } from './overview.routes.js';
import { adminTierRoutes } from './tiers.routes.js';
import { adminConcurrencyRoutes } from './concurrency.routes.js';
import { adminWebhookConfigRoutes } from './webhookConfig.routes.js';
import { adminInboundRoutePolicyRoutes } from './inboundRoutePolicy.routes.js';
import { adminQueueRoutes } from './queues.routes.js';
import { adminWalletRoutes } from './wallet.routes.js';
import { adminCustomerRoutes } from './customers.routes.js';
import { adminCampaignRoutes } from './campaigns.routes.js';
import { adminSuperAdminActionRoutes } from './superAdminActions.routes.js';

/**
 * The whole staff surface, as one router.
 *
 * `app.ts` mounts this once, behind the rate limiter, so there is a single
 * place that says "everything under `/api/admin` is staff-only" — and adding a
 * staff router is adding a line here rather than remembering to repeat a mount
 * and a guard in the app.
 *
 * The guard is applied here AND kept on each sub-router. That is deliberate
 * redundancy: a router that guards itself cannot be mounted somewhere else and
 * arrive open, and this one cannot be composed of something that forgot. The
 * repeat costs nothing — the guard remembers its own answer for the life of
 * the request.
 */
export const adminRoutes: Router = Router();

adminRoutes.use(requireStaffToken);

adminRoutes.use(adminAgentRoutes);
adminRoutes.use(adminResourceRoutes);
adminRoutes.use(adminPhoneNumberRoutes);
adminRoutes.use(adminAccountRoutes);
adminRoutes.use(adminWorkspaceRoutes);
adminRoutes.use(adminOverviewRoutes);
adminRoutes.use(adminTierRoutes);
adminRoutes.use(adminConcurrencyRoutes);
adminRoutes.use(adminWebhookConfigRoutes);
adminRoutes.use(adminInboundRoutePolicyRoutes);
adminRoutes.use(adminQueueRoutes);
adminRoutes.use(adminWalletRoutes);
adminRoutes.use(adminCustomerRoutes);
adminRoutes.use(adminCampaignRoutes);
adminRoutes.use(adminSuperAdminActionRoutes);
