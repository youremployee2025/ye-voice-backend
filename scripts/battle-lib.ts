/**
 * Shared plumbing for the battle-test driver (`scripts/battle-test.ts`).
 *
 * Plain and readable on purpose: this is a test driver, not a product. It
 * spawns real backend processes and the mock voice platform as children, seeds
 * the sim database through Prisma, and drives campaigns over HTTP exactly the
 * way the dashboard would.
 *
 * What it grades is what a conformance run cannot: the engine on a **real
 * clock, at load, across more than one process**. The conformance suite drives
 * ticks by hand on a virtual clock, which is what makes it a precise regression
 * gate and also what makes it blind to everything here — whether the queues
 * keep the pool full, whether two instances double-dial, whether a killed
 * process strands the contacts it was holding.
 *
 * Every run is parameterised by its ports and its Redis database, so two runs
 * cannot reach each other's queues, and the run's database is flushed before it
 * starts.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(__dirname, '..');
export const LOG_DIR = path.join(__dirname, 'battle-logs');

/**
 * The mock lives beside this repo in the main checkout and one level further
 * out from a worktree — the same two candidates the conformance boot resolves.
 */
export const MOCK_DIR = (() => {
  const candidates = [
    path.resolve(BACKEND_DIR, '..', 'vocobase-mock'),
    path.resolve(BACKEND_DIR, '..', '..', '..', 'YE-Voice-AI', 'ye-voice-agent', 'vocobase-mock'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`battle: vocobase-mock not found at ${candidates.join(' or ')}`);
})();

/**
 * Ports and databases, pinned away from everything else on this machine.
 *
 * The dev server is on 3951, the conformance driver on 3941/4021 and Redis 13.
 * A battle run that collided with either would be a run whose failures belong
 * to somebody else's process.
 */
export const MOCK_PORT = 4041;
export const BACKEND_PORTS = [3961, 3962] as const;
export const DB_NAME = 'ye_voice_battle';
/** Reserved for battle runs. Both instances of a run share one — that is the point. */
export const REDIS_DB_INDEXES = [11, 12] as const;

export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
export const WEBHOOK_SECRET = 'battle-test-shared-secret-0123456789abcdef';

export const TEST_USER = 'user_battle|battle@ezo.test';
export const TEST_USER_2 = 'user_battle2|battle2@ezo.test';

// ---------------------------------------------------------------- preflight

function envLine(name: string): string {
  const file = fs.readFileSync(path.join(BACKEND_DIR, '.env'), 'utf8');
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`battle: .env has no ${name}.`);
  return line.slice(name.length + 1).trim();
}

/**
 * The run's database and Redis, pinned here rather than taken from `.env`.
 *
 * Only the credentials and the host are trusted; the database name and the
 * Redis index are fixed in this file. A battle run truncates every table it
 * can see and flushes the Redis database it is given, so a mis-edited `.env`
 * must not be able to point either at anything that matters.
 */
export function resolveDatabaseUrl(): string {
  const url = new URL(envLine('DATABASE_URL'));
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`battle: DATABASE_URL host is ${url.hostname}; refusing anything non-local.`);
  }
  const pinned = `postgresql://${url.username}:${url.password}@localhost:5436/${DB_NAME}`;
  if (pinned.includes('neon.tech')) throw new Error('battle: refusing a neon.tech URL.');
  return pinned;
}

export function resolveRedisUrl(dbIndex: number): string {
  if (!REDIS_DB_INDEXES.includes(dbIndex as (typeof REDIS_DB_INDEXES)[number])) {
    throw new Error(`battle: Redis database ${dbIndex} is not reserved for battle runs.`);
  }
  const url = new URL(envLine('REDIS_URL'));
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`battle: REDIS_URL host is ${url.hostname}; refusing anything non-local.`);
  }
  url.pathname = `/${dbIndex}`;
  return url.toString();
}

export function portsInUse(ports: readonly number[]): number[] {
  return ports.filter((port) => {
    try {
      return execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: 'pipe' })
        .trim().length > 0;
    } catch {
      return false;
    }
  });
}

export function preflight(ports: readonly number[]): void {
  const busy = portsInUse(ports);
  if (busy.length > 0) {
    throw new Error(
      `battle: port(s) ${busy.join(', ')} already in use. This driver spawns its own servers; ` +
        'stop the foreign process first and re-run.',
    );
  }
}

export async function waitPortsFree(ports: readonly number[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (portsInUse(ports).length === 0) return;
    await sleep(200);
  }
  throw new Error(`battle: ports ${ports.join(', ')} did not free after killing servers`);
}

// ------------------------------------------------------------------ servers

const live: ChildProcess[] = [];

/**
 * Kills the whole process group. `npx` spawns `tsx` which spawns the server:
 * killing only the npx pid strands grandchildren holding the ports, so every
 * child is spawned detached (its own group) and killed by group id.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.exitCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}

function killAll(): void {
  for (const child of live) killTree(child);
  live.length = 0;
}

process.on('exit', killAll);
process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});

function pipeToLog(child: ChildProcess, file: string): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.createWriteStream(path.join(LOG_DIR, file), { flags: 'a' });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
}

export interface RunOpts {
  databaseUrl: string;
  redisUrl: string;
  seed: number;
  /** Upstream concurrency the mock will enforce — the shared platform pool. */
  poolLimit: number;
  /** Log-file prefix, e.g. "s1-run2". */
  tag: string;
}

/**
 * `node <local tsx>`, never `npx tsx`.
 *
 * `npx` resolves its own copy when it feels like it, and a copy installed
 * under `~/.npm/_npx` cannot see the project's `node_modules` — so a respawn
 * mid-scenario died on `Cannot find package 'express'` while the identical
 * first spawn had worked. Naming the local binary makes every spawn resolve
 * the same way.
 */
function tsxIn(dir: string): string {
  return path.join(dir, 'node_modules', '.bin', 'tsx');
}

export function spawnMock(opts: RunOpts): ChildProcess {
  const child = spawn(process.execPath, [tsxIn(MOCK_DIR), 'src/server.ts'], {
    cwd: MOCK_DIR,
    env: {
      ...process.env,
      MOCK_PORT: String(MOCK_PORT),
      CONCURRENCY_LIMIT: String(opts.poolLimit),
      RATE_LIMIT_PER_MIN: '100000',
      // Every instance's dials come back to one endpoint, which is the honest
      // shape: a load balancer picks one, and the outcome of a call instance B
      // placed is applied by instance A. That is exactly the cross-instance
      // path worth exercising.
      WEBHOOK_URL: `http://127.0.0.1:${BACKEND_PORTS[0]}/webhooks/vocobase`,
      WEBHOOK_SECRET,
      SIM_SEED: String(opts.seed),
      /**
       * Real clock, sped up — but not past the point where the run stops
       * measuring the engine.
       *
       * A call's whole life is compressed by this factor, so a run finishes in
       * minutes rather than in the length of the calls. Compress it too far and
       * utilisation becomes a measurement of the sweep interval instead: with a
       * two-second tick and calls that last one second, a freed slot sits idle
       * for most of its life however well the dialer behaves. At three, an
       * unscripted call runs about nine seconds and the tick is a small part of
       * it, which is the ratio a real deployment has.
       */
      SIM_TIME_SCALE: '3',
      SIM_CHAOS: '0',
      SIM_MANUAL_CLOCK: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  pipeToLog(child, `${opts.tag}-mock.log`);
  live.push(child);
  return child;
}

/**
 * One backend instance.
 *
 * Four settings are what make this a *queue* harness rather than the timer one
 * it was ported from:
 *
 * - `NODE_ENV=test` for the `X-Test-Clerk-User` header path, as before.
 * - `WORKERS_ENABLED=true`, because `NODE_ENV=test` now defaults the workers
 *   **off**. Without this the instance would serve HTTP and dial nothing, and
 *   the run would report a dialer that had stopped working.
 * - `REDIS_URL` on the run's own database, so two runs cannot see each other's
 *   jobs and a flush between runs is a flush of this run only.
 * - `DIALER_SWEEP_MS=2000`. The production default is 60 000 and was floored
 *   there; the floor is 1 000 now precisely so a harness can drive a fast
 *   tick. Two seconds is fast enough to watch a pool fill and slow enough that
 *   the tick is not the thing under test.
 */
export function spawnBackend(opts: RunOpts & { port: number; instance: string }): ChildProcess {
  const child = spawn(process.execPath, [tsxIn(BACKEND_DIR), 'src/server.ts'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WORKERS_ENABLED: 'true',
      PORT: String(opts.port),
      DATABASE_URL: opts.databaseUrl,
      REDIS_URL: opts.redisUrl,
      VOCOBASE_API_URL: `${MOCK_URL}/api/v2`,
      VOCOBASE_API_KEY: 'mockkey',
      VOCOBASE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      DIALER_ENABLED: 'true',
      DIALER_SWEEP_MS: '2000',
      DIALER_MAX_CALLS_PER_SWEEP: '50',
      DIALER_ATTEMPT_TIMEOUT_MINS: '2',
      CAMPAIGN_CLEANUP_MS: '10000',
      SCHEDULE_SCAN_MS: '30000',
      // Nothing in these scenarios is about a DID renewal, and an hourly sweep
      // that fires once at boot is noise in every log this run writes.
      DID_RENEWAL_SWEEP_MS: '3600000',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  pipeToLog(child, `${opts.tag}-backend-${opts.instance}.log`);
  live.push(child);
  return child;
}

export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`battle: timed out waiting for ${url}`);
    await sleep(300);
  }
}

export interface Servers {
  mock: ChildProcess;
  backends: ChildProcess[];
  ports: number[];
  kill(): void;
}

export async function startServers(opts: RunOpts & { instances: number }): Promise<Servers> {
  const mock = spawnMock(opts);
  const ports = BACKEND_PORTS.slice(0, opts.instances);
  const backends = ports.map((port, i) =>
    spawnBackend({ ...opts, port, instance: String.fromCharCode(97 + i) }),
  );

  await waitForHttp(`${MOCK_URL}/_sim/state`);
  await Promise.all(ports.map((port) => waitForHttp(`http://127.0.0.1:${port}/health`)));

  return {
    mock,
    backends,
    ports: [...ports],
    kill() {
      for (const backend of backends) killTree(backend);
      killTree(mock);
    },
  };
}

// ----------------------------------------------------------------- database

export function makePrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/** Children before parents, mirroring `test/setup.ts`. */
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

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(TABLES.map((t) => prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)));
}

/** Empties the run's Redis database, so no run inherits another's jobs. */
export async function flushRedis(redisUrl: string): Promise<void> {
  const { Redis } = await import('ioredis');
  const client = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await client.flushdb();
  await client.quit();
}

// ------------------------------------------------------------------ seeding

export interface SeededWorkspace {
  accountId: string;
  identity: string;
  workspaceId: string;
  agentId: string;
  /**
   * The id the platform knows this agent by — the one every upstream call
   * uses, and therefore the key the mock files its prompts under.
   *
   * Returned so a goal scenario can read what YE wrote into the agent's
   * prompt, and can plant a prompt of its own before a campaign starts. The
   * local row id above is no use for either: nothing upstream has ever heard
   * of it.
   */
  agentExternalId: string;
  phoneNumberIds: string[];
}

let didSeq = 0;
let tierSeeded = false;

/**
 * Account, workspace, active agent, priced tier, and assigned DIDs.
 *
 * Through Prisma rather than over HTTP, exactly as the conformance harness
 * seeds: what these scenarios grade is the dial engine under load, and putting
 * a CSV parser and six routes between the driver and the fixture only adds
 * ways for a run to fail that have nothing to do with the queue.
 */
export async function seedWorkspace(
  prisma: PrismaClient,
  identity: string,
  name: string,
  options: { accountConcurrency: number; dids?: number; credits?: string } = {
    accountConcurrency: 10,
  },
): Promise<SeededWorkspace> {
  const [clerkUserId, email] = identity.split('|') as [string, string];
  const account = await prisma.account.create({
    data: {
      clerkUserId,
      email,
      name: clerkUserId,
      // 1 000 display credits, in internal units (10 000x).
      credits: BigInt(options.credits ?? '10000000'),
      concurrencyLimit: options.accountConcurrency,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
      color: '#6366f1',
      ownerAccountId: account.id,
      members: { create: { accountId: account.id, role: 'ADMIN' } },
    },
  });
  const agent = await prisma.agent.create({
    data: {
      externalId: `ext_battle_${Math.random().toString(36).slice(2, 10)}`,
      workspaceId: workspace.id,
      name: `${name} agent`,
      status: 'active',
      voiceTierSlug: 'va-battle',
    },
  });

  if (!tierSeeded) {
    await prisma.tier.upsert({
      where: { slug: 'va-battle' },
      update: {},
      create: {
        slug: 'va-battle',
        name: 'Battle',
        defaultPriceCreditsPerMin: 10_000n,
        isDefault: true,
      },
    });
    tierSeeded = true;
  }

  const phoneNumberIds: string[] = [];
  for (let i = 0; i < (options.dids ?? 1); i += 1) {
    didSeq += 1;
    const row = await prisma.phoneNumber.create({
      data: {
        did: `+9180440${String(didSeq).padStart(5, '0')}`,
        workspaceId: workspace.id,
        status: 'ASSIGNED',
      },
    });
    phoneNumberIds.push(row.id);
  }

  return {
    accountId: account.id,
    identity,
    workspaceId: workspace.id,
    agentId: agent.id,
    agentExternalId: agent.externalId,
    phoneNumberIds,
  };
}

/** Reset between runs: the tier is recreated with the rest of the fixtures. */
export function resetSeedState(): void {
  tierSeeded = false;
}

export interface CampaignSpec {
  name: string;
  concurrencyLimit: number;
  retryConcurrency?: number;
  retryCount?: number;
  cooldownMinutes?: number;
  /**
   * There is no goal switch, and there are TWO lane budgets.
   *
   * A contact nobody has answered walks the retry ladder: `retryCount` dials
   * after the first, waiting `cooldownMinutes` (and the ladder, when one is
   * set). A contact somebody HAS answered is in the follow-up lane for good,
   * its retries forfeited, and gets `maxGoalFollowUps` more calls
   * `followUpDelayHours` apart. A dropped call resumes after a fixed three
   * minutes. The absolute ceiling is their sum plus one.
   *
   * What a scenario scripts is therefore the CALL NOTE each call comes back
   * with, plus the two budgets and their two clocks. What YE writes into the
   * agent's prompt at start is the note block — identical for every campaign
   * — and the only variable it adds to a dial is the previous call's note.
   */
  /** The follow-up lane's budget. Default 1, so a scenario that says nothing
   *  about follow-ups gets one conversation and one follow-up — the shape
   *  every scenario in this harness was written against. */
  maxGoalFollowUps?: number;
  /** The follow-up lane's wait, in hours. The harness never waits it out for
   *  real: `elapseFollowUpDelay` moves the arm into the past. */
  followUpDelayHours?: number;
  /** The per-contact daily cap. Default 10, the ceiling, so nothing here is
   *  ever held by it — a battle run is minutes long and must not depend on
   *  which side of local midnight it starts. */
  maxDialsPerDay?: number;
  callbackEnabled?: boolean;
  contacts: number;
  /** Which digit block this campaign's numbers live in, so they never collide. */
  block: number;
  /** Explicit numbers instead of the block's, for a campaign that must share
   *  a contact with another (the do-not-call scenarios). Length must match
   *  `contacts`. */
  phones?: string[];
  /**
   * How many of the contacts start life as a retry already due.
   *
   * The reserved lane only means anything when a campaign has retries *and*
   * fresh work at the same moment, and waiting for that to arise naturally
   * takes a cooldown — a minute at the shortest this engine allows — by which
   * time a fast campaign's fresh list is gone. Seeding a due retry is how the
   * conformance suite reaches the same state, and it is the same state: the
   * counter and a closed attempt row both say this contact has been dialed.
   */
  retriesDue?: number;
}

export interface SeededCampaign {
  id: string;
  name: string;
  workspaceId: string;
  identity: string;
  concurrencyLimit: number;
  phones: string[];
}

export async function seedCampaign(
  prisma: PrismaClient,
  ws: SeededWorkspace,
  spec: CampaignSpec,
): Promise<SeededCampaign> {
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.workspaceId,
      name: spec.name,
      agentId: ws.agentId,
      phoneNumberId: ws.phoneNumberIds[0] ?? null,
      status: 'DRAFT',
      concurrencyLimit: spec.concurrencyLimit,
      retryConcurrency: spec.retryConcurrency ?? 0,
      retryCount: spec.retryCount ?? 1,
      cooldownMinutes: spec.cooldownMinutes ?? 1,
      maxGoalFollowUps: spec.maxGoalFollowUps ?? 1,
      followUpDelayHours: spec.followUpDelayHours ?? 24,
      maxDialsPerDay: spec.maxDialsPerDay ?? 10,
      callbackEnabled: spec.callbackEnabled ?? false,
      totalContacts: spec.contacts,
      // Round the clock: a battle run must not depend on the hour it is run at.
      fromTime: null,
      toTime: null,
      timezone: null,
    },
  });

  const phones = spec.phones ?? makePhones(spec.contacts, spec.block);
  const retriesDue = spec.retriesDue ?? 0;

  for (const [index, phone] of phones.entries()) {
    // Upsert: one Contact per (workspace, phone), however many campaigns list
    // it — what an import into a second campaign does.
    const contact = await prisma.contact.upsert({
      where: { workspaceId_phone: { workspaceId: ws.workspaceId, phone } },
      update: {},
      create: { workspaceId: ws.workspaceId, phone, name: `c-${spec.block}` },
    });
    const link = await prisma.campaignContact.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        ...(index < retriesDue ? { attempts: 1 } : {}),
      },
    });

    // The attempt row that consumed the retry, closed. Without it the contact's
    // counter and its history would disagree, and the next dial would be
    // numbered 1 — which is not what a retry is.
    if (index < retriesDue) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: ws.workspaceId,
          accountId: ws.accountId,
          attemptNo: 1,
          status: 'FAILED',
          endedAt: new Date(),
          resolvedAt: new Date(),
        },
      });
    }
  }

  return {
    id: campaign.id,
    name: spec.name,
    workspaceId: ws.workspaceId,
    identity: ws.identity,
    concurrencyLimit: spec.concurrencyLimit,
    phones,
  };
}

/** Valid, unique Indian mobile numbers: +91 98 <block:2> <i:6>. */
export function makePhones(count: number, block: number): string[] {
  const b = String(block).padStart(2, '0').slice(-2);
  return Array.from({ length: count }, (_, i) => `+9198${b}${String(i).padStart(6, '0')}`);
}

// --------------------------------------------------------------------- http

export interface ApiResult {
  status: number;
  body: { success?: boolean; data?: unknown; error?: { code?: string } } & Record<string, unknown>;
}

export async function api(
  port: number,
  method: string,
  urlPath: string,
  opts: { as?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'X-Test-Clerk-User': opts.as ?? TEST_USER };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers, body: payload });
  const text = await res.text();
  let body: ApiResult['body'];
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

export async function apiOk(
  port: number,
  method: string,
  urlPath: string,
  opts: { as?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await api(port, method, urlPath, opts);
  if (res.status >= 300) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

export async function startCampaign(
  port: number,
  campaign: SeededCampaign,
): Promise<void> {
  await apiOk(port, 'POST', `/api/workspaces/${campaign.workspaceId}/campaigns/${campaign.id}/start`, {
    as: campaign.identity,
    body: { concurrencyLimit: campaign.concurrencyLimit },
  });
}

// ---------------------------------------------------------------------- sim

export interface DialLogEntry {
  ref: string | null;
  callId: string;
  at: string;
  fromNumber: string;
  toNumber: string;
  /** The `variables` block the dial carried — how a run observes the goal
   *  overlay the placement rendered. Null when the dial sent none. */
  variables: Record<string, unknown> | null;
}

export interface SimState {
  calls: Array<Record<string, unknown>>;
  active: number;
  peak: number;
  limit: number;
  dialLog: DialLogEntry[];
  breaches: string[];
  refCounts: Record<string, number>;
  webhookFailures: string[];
  /**
   * Every agent prompt the platform is holding, keyed by the agent id it knows
   * it by. The managed goal block YE writes at start is observable nowhere
   * else, and two of the scenarios below are entirely about it: that starting
   * a second goal campaign on the same agent leaves exactly one copy, and that
   * a block somebody edited by hand is put back.
   */
  agents: Record<string, { prompt: string }>;
}

export async function simState(): Promise<SimState> {
  const res = await fetch(`${MOCK_URL}/_sim/state`);
  return (await res.json()) as SimState;
}

/**
 * Writes an agent's prompt upstream, the way an operator editing their agent
 * in the platform's own console would.
 *
 * Used to plant a prompt BEFORE a campaign starts — a hand-edited managed
 * block, say — so that what the start does to it can be observed. Goes
 * through the same partial-update route YE's own writes use, so a scenario
 * cannot accidentally set up a state the product could not reach.
 */
export async function setAgentPrompt(agentExternalId: string, prompt: string): Promise<void> {
  const res = await fetch(`${MOCK_URL}/api/v2/agent/${encodeURIComponent(agentExternalId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(`battle: PUT /agent -> ${res.status} ${await res.text()}`);
}

export async function simScript(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${MOCK_URL}/_sim/script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`battle: /_sim/script -> ${res.status} ${await res.text()}`);
}

/** `ezo:<campaignId>:<campaignContactId>:<attemptId>`, as the dialer stamps it. */
export function parseRef(
  ref: string | null,
): { campaignId: string; contactId: string; attemptId: string | null } | null {
  if (!ref) return null;
  const parts = ref.split(':');
  if (parts.length < 3 || parts[0] !== 'ezo') return null;
  return { campaignId: parts[1]!, contactId: parts[2]!, attemptId: parts[3] ?? null };
}

// -------------------------------------------------------------------- utils

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function pollUntil<T>(
  fn: () => Promise<T | null | false>,
  timeoutMs: number,
  label: string,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`battle: timed out after ${timeoutMs}ms: ${label}`);
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------- report

export interface RunResult {
  scenario: string;
  run: number;
  seed: number;
  wallMs: number;
  violations: string[];
  notes: string[];
  metrics: Record<string, string | number>;
}

export class Report {
  results: RunResult[] = [];

  add(result: RunResult): void {
    this.results.push(result);
    const mark = result.violations.length === 0 ? 'PASS' : `FAIL (${result.violations.length})`;
    console.log(
      `[${result.scenario}] run ${result.run} seed=${result.seed} ${mark} ` +
        `wall=${(result.wallMs / 1000).toFixed(0)}s ` +
        Object.entries(result.metrics)
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
    );
    for (const v of result.violations) console.log(`    VIOLATION: ${v}`);
  }

  write(file: string): void {
    const scenarios = [...new Set(this.results.map((r) => r.scenario))];
    const lines: string[] = [
      '# Queue-worker battle-test report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '| Scenario | Runs | Failed | Wall time |',
      '|---|---|---|---|',
    ];
    for (const scenario of scenarios) {
      const runs = this.results.filter((r) => r.scenario === scenario);
      const failed = runs.filter((r) => r.violations.length > 0).length;
      const wall = runs.reduce((sum, r) => sum + r.wallMs, 0);
      lines.push(`| ${scenario} | ${runs.length} | ${failed} | ${(wall / 1000).toFixed(0)}s |`);
    }

    for (const scenario of scenarios) {
      lines.push('', `## ${scenario}`, '');
      lines.push('| Run | Seed | Result | Wall | Metrics |');
      lines.push('|---|---|---|---|---|');
      for (const r of this.results.filter((x) => x.scenario === scenario)) {
        const metrics = Object.entries(r.metrics)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        lines.push(
          `| ${r.run} | ${r.seed} | ${r.violations.length === 0 ? 'PASS' : 'FAIL'} | ` +
            `${(r.wallMs / 1000).toFixed(0)}s | ${metrics} |`,
        );
      }
      const notes = this.results.filter((x) => x.scenario === scenario).flatMap((x) => x.notes);
      if (notes.length > 0) {
        lines.push('', ...notes.map((n) => `- ${n}`));
      }
      const violations = this.results
        .filter((x) => x.scenario === scenario)
        .flatMap((x) => x.violations.map((v) => `run ${x.run}: ${v}`));
      if (violations.length > 0) {
        lines.push('', '### Violations', '', ...violations.map((v) => `- ${v}`));
      }
    }

    lines.push('');
    fs.writeFileSync(file, lines.join('\n'));
    console.log(`\nReport written to ${file}`);
  }
}
