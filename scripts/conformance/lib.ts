import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { Worker } from 'bullmq';
import {
  BACKEND_PORT,
  DATABASE_URL,
  DB_NAME,
  MOCK_PORT,
  MOCK_ROOT,
  REDIS_DB_INDEX,
  REDIS_URL,
  WEBHOOK_SECRET,
  type Backend,
} from './boot.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Hard-aborts unless the run can only touch disposable local infrastructure. */
export async function preflight(): Promise<void> {
  if (DATABASE_URL.includes('neon.tech')) throw new Error('preflight: neon.tech in DB URL.');
  const url = new URL(DATABASE_URL);
  // `DB_NAME` has already passed boot's own guard; this re-checks the URL that
  // was actually built from it, so a future edit to the pinning cannot drift
  // away from the name unnoticed.
  if (url.port !== '5436' || url.pathname !== `/${DB_NAME}`) {
    throw new Error(`preflight: DB must be localhost:5436/${DB_NAME}, got ${url.port}${url.pathname}`);
  }
  /**
   * The same check for Redis, and it is not a formality.
   *
   * This run starts a real placement worker. Pointed at a database index a dev
   * server also uses, that worker would consume that server's dial jobs and
   * place them — against the live partner account, from a suite whose entire
   * safety argument is that it cannot reach one.
   */
  const redis = new URL(REDIS_URL);
  if (redis.hostname !== 'localhost' && redis.hostname !== '127.0.0.1') {
    throw new Error(`preflight: Redis must be local, got ${redis.hostname}`);
  }
  if (redis.pathname !== `/${REDIS_DB_INDEX}`) {
    throw new Error(`preflight: Redis must be database ${REDIS_DB_INDEX}, got ${redis.pathname}`);
  }
  for (const port of [BACKEND_PORT, MOCK_PORT]) {
    if (!(await portFree(port))) {
      throw new Error(`preflight: port ${port} is already in use; refusing to run beside another server.`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

export interface Servers {
  mock: ChildProcess;
  backend: http.Server;
  placement: Worker;
  webhooks: Worker;
  stop(): Promise<void>;
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await sleep(150);
  }
}

/**
 * Boots the upstream mock (child process, manual clock, scripted), the backend
 * app in-process (webhook sink + lifecycle routes), and **one real
 * `call-placement` worker**.
 *
 * The worker is the half of a pass the driver does not drive. Ticks are still
 * called by hand — a repeatable firing on a wall clock is exactly what a
 * virtual-clock harness cannot have — but the dials those ticks post are
 * consumed by the production worker, at its production concurrency, through
 * BullMQ. That is the point: after the move to a queue, a pass is a tick plus
 * the placements it posted, and a harness that ran only the first half would
 * grade half an engine.
 *
 * `opts.mockEnv` lets a harness hand the mock extra variables — the campaign
 * simulator points it at a conversation module this way. It is spread
 * *before* the fixed entries, so a caller can add to the mock's environment
 * but never move its port, its webhook target or its clock off the values
 * this file's safety argument rests on.
 */
export async function startServers(
  backend: Backend,
  opts: { mockEnv?: Record<string, string> } = {},
): Promise<Servers> {
  const mock = spawn(
    process.execPath,
    [`${MOCK_ROOT}/node_modules/.bin/tsx`, 'src/server.ts'],
    {
    cwd: MOCK_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(opts.mockEnv ?? {}),
      MOCK_PORT: String(MOCK_PORT),
      CONCURRENCY_LIMIT: '50',
      RATE_LIMIT_PER_MIN: '100000',
      WEBHOOK_URL: `http://127.0.0.1:${BACKEND_PORT}/webhooks/vocobase`,
      WEBHOOK_SECRET,
      SIM_SEED: '1',
      SIM_MANUAL_CLOCK: '1',
      SIM_CHAOS: '0',
    },
    },
  );
  mock.stdout?.resume();
  mock.stderr?.pipe(process.stderr);

  const app = backend.createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(BACKEND_PORT, '127.0.0.1', resolve));

  // Anything a previous run left behind. A stale job would run against rows
  // this run has truncated and settle as `campaign-gone`, which is harmless and
  // still noise in a trace nobody should have to explain.
  await backend.callPlacementQueue.obliterate({ force: true });
  await backend.webhookProcessingQueue.obliterate({ force: true });

  const placement = backend.createCallPlacementWorker();
  const webhooks = backend.createWebhookProcessingWorker();
  await Promise.all([placement.waitUntilReady(), webhooks.waitUntilReady()]);

  await waitForHttp(`http://127.0.0.1:${MOCK_PORT}/_sim/state`);
  await waitForHttp(`http://127.0.0.1:${BACKEND_PORT}/health`);

  return {
    mock,
    backend: server,
    placement,
    webhooks,
    async stop() {
      try {
        if (mock.pid) process.kill(-mock.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      // Workers, then their connections, then queues, then the shared
      // connection — the shutdown order the service itself holds. The
      // dedicated worker connections need their own close: BullMQ leaves a
      // supplied instance open on worker.close(), and this harness relies on
      // a drained event loop to exit.
      await Promise.all([placement.close(), webhooks.close()]);
      await backend.closeWorkerConnections();
      await backend.closeQueues();
      await backend.closeQueueConnection();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Waits until the placement queue has nothing left to do.
 *
 * The tick posts and returns; the dials happen on the worker. So a snapshot
 * taken the instant a tick returns would show a world in which nothing had been
 * dialed yet — every scenario in this suite would read as a dialer that had
 * stopped working. Draining to quiescence puts the observation back where it
 * was: after the pass, not in the middle of it.
 *
 * `delayed` counts, because a placement retry is a delayed job and a pass with
 * a retry pending is not finished. `completed` does not: those are kept
 * deliberately, a hundred deep, for reading afterwards.
 */
export async function drainPlacementQueue(backend: Backend, timeoutMs = 30_000): Promise<void> {
  await drainQueue('placement', backend.callPlacementQueue, timeoutMs);
}

/**
 * The same, for the work a delivered webhook now asks for.
 *
 * The mock awaits every delivery before its `advance` returns, so by the time
 * an advance is done every event it fired is durable on this queue. Draining
 * here is therefore race-free, and it is what keeps the harness's contract
 * intact: after a tick, the world reflects everything that tick caused —
 * including the charge, the contact resolution and the callback that a
 * completion used to apply on the request thread.
 */
export async function drainWebhookQueue(backend: Backend, timeoutMs = 30_000): Promise<void> {
  await drainQueue('webhook', backend.webhookProcessingQueue, timeoutMs);
}

/**
 * `delayed` counts, because a retry is a delayed job and a pass with a retry
 * pending is not finished. `completed` does not: those are kept deliberately,
 * a hundred deep, for reading afterwards.
 */
async function drainQueue(
  label: string,
  queue: { getJobCounts: (...types: string[]) => Promise<Record<string, number>> },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'paused');
    const outstanding = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

    if (outstanding === 0) return;

    if (Date.now() > deadline) {
      throw new Error(
        `conformance: ${label} queue did not drain in ${timeoutMs}ms (${JSON.stringify(counts)})`,
      );
    }

    await sleep(5);
  }
}

/* ------------------------------------------------------------------ *
 * Mock client
 * ------------------------------------------------------------------ */

const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

export interface MockDialLogEntry {
  ref: string | null;
  callId: string;
  at: string;
  fromNumber: string;
  toNumber: string;
  /** The `variables` block the dial carried — how a scenario observes the
   *  goal overlay the placement rendered. Null when the dial sent none. */
  variables: Record<string, unknown> | null;
}

export interface MockState {
  calls: Array<Record<string, unknown>>;
  active: number;
  peak: number;
  limit: number;
  dialLog: MockDialLogEntry[];
  breaches: string[];
  refCounts: Record<string, number>;
  webhookFailures: string[];
  /** Conversations the mock's conversation module failed to play (campaign simulator only; absent under `script`). */
  conversationFailures?: string[];
  virtual_now_ms: number;
  pending_timeline: number;
}

async function mockPost(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${MOCK}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`mock ${pathname} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export const mockClient = {
  state: async (): Promise<MockState> => (await (await fetch(`${MOCK}/_sim/state`)).json()) as MockState,
  reset: (seed: number, nowMs: number) => mockPost('/_sim/reset', { seed, now_ms: nowMs }),
  script: (body: Record<string, unknown>) => mockPost('/_sim/script', body),
  advance: (nowMs: number) => mockPost('/_sim/advance', { now_ms: nowMs }),
};

/* ------------------------------------------------------------------ *
 * Backend API client (test-header identity)
 * ------------------------------------------------------------------ */

export interface ApiResponse {
  status: number;
  body: Record<string, unknown> & { success?: boolean; data?: unknown; error?: { code?: string } };
}

export function apiClient(identity: { clerkUserId: string; email: string }) {
  return async function api(method: string, pathname: string, body?: unknown): Promise<ApiResponse> {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-Test-Clerk-User': `${identity.clerkUserId}|${identity.email}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as ApiResponse['body'] };
  };
}

/* ------------------------------------------------------------------ *
 * Database reset + seeding
 * ------------------------------------------------------------------ */

// Children-first, mirroring the engine's own test harness ordering.
const TABLES = [
  'CallRecord',
  'AnalyticsCursor',
  'NotificationRead',
  'Notification',
  'CreditTransaction',
  'CallAttempt',
  'WebhookEvent',
  'CampaignContact',
  'CampaignPhoneNumber',
  'Campaign',
  'Contact',
  'PhoneNumber',
  'Agent',
  'WorkspaceResource',
  'WorkspaceInvite',
  'WorkspaceMember',
  'Workspace',
  'AccountTier',
  'Tier',
  'Account',
] as const;

export async function truncateAll(backend: Backend): Promise<void> {
  await backend.flushNotifications();
  await backend.prisma.$transaction(
    TABLES.map((table) => backend.prisma.$executeRawUnsafe(`DELETE FROM "${table}"`)),
  );
}

export interface SeededWorkspace {
  accountId: string;
  clerkUserId: string;
  email: string;
  workspaceId: string;
  agentId: string;
  phoneNumberIds: string[];
  dids: string[];
}

export interface SeedOptions {
  handle: string;
  credits?: string;
  accountConcurrency?: number | null;
  /** DIDs to create and attach to campaigns later; first one is the legacy pointer. */
  dids?: string[];
  tierSlug?: string;
  ratePerMinDisplay?: string;
  billingIncrementSecs?: number;
}

// PhoneNumber.did is globally unique; a fixed default would collide when a
// scenario seeds two workspaces.
let didSeq = 0;

/** Account + workspace + active agent + priced default tier + ASSIGNED DIDs. */
export async function seedWorkspace(backend: Backend, options: SeedOptions): Promise<SeededWorkspace> {
  const { prisma, toInternalCredits } = backend;
  const {
    handle,
    credits = '1000',
    accountConcurrency = 10,
    dids = [`+91801111${String(didSeq++ % 10000).padStart(4, '0')}`],
    tierSlug = 'va-conf',
    ratePerMinDisplay = '1.00',
    billingIncrementSecs,
  } = options;

  const account = await prisma.account.create({
    data: {
      clerkUserId: `user_${handle}`,
      email: `${handle}@ezo.test`,
      name: handle,
      credits: toInternalCredits(credits),
      concurrencyLimit: accountConcurrency,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: handle,
      slug: `${handle}-${Math.random().toString(36).slice(2, 8)}`,
      color: '#6366f1',
      ownerAccountId: account.id,
      members: { create: { accountId: account.id, role: 'ADMIN' } },
    },
  });
  const agent = await prisma.agent.create({
    data: {
      externalId: `ext_${handle}`,
      workspaceId: workspace.id,
      name: `${handle} agent`,
      status: 'active',
      voiceTierSlug: tierSlug,
    },
  });
  // Only one tier may be the platform default (unique on isDefault); rate
  // resolution matches the agent's own slug first, so later tiers don't need
  // the flag.
  const hasDefault = (await prisma.tier.count({ where: { isDefault: true } })) > 0;
  await prisma.tier.upsert({
    where: { slug: tierSlug },
    update: {},
    create: {
      slug: tierSlug,
      name: 'Conformance',
      defaultPriceCreditsPerMin: toInternalCredits(ratePerMinDisplay),
      ...(hasDefault ? {} : { isDefault: true }),
      ...(billingIncrementSecs !== undefined ? { billingIncrementSecs } : {}),
    },
  });

  const phoneNumberIds: string[] = [];
  for (const did of dids) {
    const row = await prisma.phoneNumber.create({
      data: { did, workspaceId: workspace.id, status: 'ASSIGNED' },
    });
    phoneNumberIds.push(row.id);
  }

  return {
    accountId: account.id,
    clerkUserId: `user_${handle}`,
    email: `${handle}@ezo.test`,
    workspaceId: workspace.id,
    agentId: agent.id,
    phoneNumberIds,
    dids,
  };
}

export interface CampaignSpec {
  name?: string;
  concurrencyLimit?: number;
  retryConcurrency?: number;
  retryCount?: number;
  cooldownMinutes?: number;
  retryDelaysMinutes?: number[];
  callbackEnabled?: boolean;
  /**
   * TWO LANES, and there is still no goal switch.
   *
   * A contact nobody has answered walks the retry ladder: `retryCount` dials
   * after the first, waiting `retryDelaysMinutes[attempts] ?? cooldownMinutes`.
   * A contact somebody HAS answered is in the follow-up lane for good — its
   * retries are forfeited — and gets `maxGoalFollowUps` more calls, each
   * `followUpDelayHours` apart and rolled into the window. A dropped call
   * still resumes after a fixed three minutes, when the resume switch is on.
   *
   * `maxDialsPerDay` caps placed dials against one contact inside a
   * campaign-local calendar day, and settles nothing: a capped contact simply
   * waits for the next local midnight.
   *
   * What a scenario scripts is therefore the call NOTE each call comes back
   * with, plus the two lane budgets and their two clocks. One seeded campaign
   * is told from another by `name`, which is what a trace prints anyway.
   */
  /** The follow-up lane's budget. Default 0, so a scenario that says nothing
   *  about follow-ups settles a reached-but-incomplete contact at once and
   *  reads exactly as it did before the lane existed. */
  maxGoalFollowUps?: number;
  /** The follow-up lane's wait, in hours. */
  followUpDelayHours?: number;
  /** The per-contact daily cap. Default 10, the ceiling, so a scenario that
   *  says nothing about it is never held by it. */
  maxDialsPerDay?: number;
  /**
   * The dialing window, including the weekdays it may dial on (`dialDays`,
   * 0 = Sunday). Spread straight onto the row, so a scenario that omits
   * `dialDays` gets the column default — every day — and reads exactly as it
   * did before the column existed.
   */
  window?: {
    fromTime: string | null;
    toTime: string | null;
    timezone: string | null;
    dialDays?: number[];
  };
  /** Indexes into the workspace's phoneNumberIds to attach for rotation. */
  attachNumbers?: number[];
  /** Contact phone numbers, in creation (= FIFO claim) order. */
  contacts: string[];
}

export interface SeededCampaign {
  campaignId: string;
  /** campaignContact id per contact phone, in spec order. */
  contactIds: string[];
  contactByPhone: Map<string, string>;
}

/** A DRAFT campaign with linked contacts, ready for POST /start. */
export async function seedCampaign(
  backend: Backend,
  ws: SeededWorkspace,
  spec: CampaignSpec,
): Promise<SeededCampaign> {
  const { prisma } = backend;
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.workspaceId,
      name: spec.name ?? 'Conformance',
      agentId: ws.agentId,
      phoneNumberId: ws.phoneNumberIds[0] ?? null,
      status: 'DRAFT',
      concurrencyLimit: spec.concurrencyLimit ?? 2,
      retryConcurrency: spec.retryConcurrency ?? 0,
      retryCount: spec.retryCount ?? 0,
      cooldownMinutes: spec.cooldownMinutes ?? 30,
      retryDelaysMinutes: spec.retryDelaysMinutes ?? [],
      callbackEnabled: spec.callbackEnabled ?? true,
      maxGoalFollowUps: spec.maxGoalFollowUps ?? 0,
      followUpDelayHours: spec.followUpDelayHours ?? 24,
      maxDialsPerDay: spec.maxDialsPerDay ?? 10,
      totalContacts: spec.contacts.length,
      ...(spec.window ?? {}),
    },
  });
  if (spec.attachNumbers) {
    await prisma.campaignPhoneNumber.createMany({
      data: spec.attachNumbers.map((idx, position) => ({
        campaignId: campaign.id,
        phoneNumberId: ws.phoneNumberIds[idx]!,
        position,
      })),
    });
  }
  const contactIds: string[] = [];
  const contactByPhone = new Map<string, string>();
  for (const [i, phone] of spec.contacts.entries()) {
    // Upsert: one Contact per (workspace, phone), however many campaigns list
    // it — exactly what an import into a second campaign does, and what the
    // do-not-call scenarios need.
    const contact = await prisma.contact.upsert({
      where: { workspaceId_phone: { workspaceId: ws.workspaceId, phone } },
      update: {},
      create: { workspaceId: ws.workspaceId, phone, name: `Contact ${i}` },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    contactIds.push(link.id);
    contactByPhone.set(phone, link.id);
  }
  return { campaignId: campaign.id, contactIds, contactByPhone };
}
