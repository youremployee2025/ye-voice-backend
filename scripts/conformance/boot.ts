import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment bootstrap for the conformance driver.
 *
 * `src/lib/env.ts` reads the environment once at import, so everything here
 * must run before the first `src/` import anywhere in the driver — which is
 * why this module has side effects and every other conformance module
 * `await import()`s the backend only after loading this one.
 *
 * Safety comes first: by default the driver runs against exactly one
 * database — `ye_voice_conformance` on localhost:5436 — and aborts on
 * anything else. The password is the only thing taken from `.env`; the host,
 * port and database name are pinned here, so a mis-edited `.env` cannot
 * point a run at a real database.
 *
 * Four values are *defaulted* rather than pinned outright: the database
 * name, the Redis index and the two ports, each overridable through a
 * `HARNESS_*` variable that is honoured when set and non-empty (unset or
 * empty means the default). A second harness built on this same machinery
 * (the campaign simulator) needs its own database and Redis index for
 * exactly the reason this one does — two processes each running a real
 * placement worker on one queue would consume each other's dials, and two
 * drivers truncating one database would corrupt each other's runs — and it
 * needs its own ports so both can boot side by side. A conformance run
 * honours `HARNESS_*` from the shell; the simulator sets its own before
 * importing this module and ignores the shell's.
 *
 * The overrides are allowlists, not shapes. The driver truncates every table
 * it can see, so the one thing a database name must never be is a database
 * anyone else uses — and a dev or test `.env` names its database
 * `ye_voice_<feature>` / `ye_test_<feature>`, which is why a harness
 * database is `ye_harness_<name>` and nothing else is accepted. Redis
 * indexes are allocated by hand and listed below; an index not on the list
 * is refused rather than trusted. The host and port of both stores stay
 * pinned regardless. Nothing an override can say points a run at a
 * database that is not a harness's own.
 */

/**
 * Reads one `HARNESS_*` override, or the default when it is unset or empty.
 * Every override is validated, not trusted: a typo in an env var is exactly
 * the kind of mis-edit the rest of this file refuses to act on.
 */
function harnessOverride<T>(
  name: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
  expectation: string,
): T {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = parse(raw);
  if (value === undefined) {
    throw new Error(`harness: ${name}=${JSON.stringify(raw)} is invalid; expected ${expectation}.`);
  }
  return value;
}

function parseIntegerBetween(min: number, max: number): (raw: string) => number | undefined {
  return (raw) => {
    if (!/^\d+$/.test(raw)) return undefined;
    const n = Number(raw);
    return n >= min && n <= max ? n : undefined;
  };
}

/** Ports below 1024 need privileges no harness should have. */
const parsePort = parseIntegerBetween(1024, 65535);

export const BACKEND_PORT = harnessOverride(
  'HARNESS_BACKEND_PORT',
  3941,
  parsePort,
  'an integer port in 1024-65535',
);
export const MOCK_PORT = harnessOverride('HARNESS_MOCK_PORT', 4021, parsePort, 'an integer port in 1024-65535');
export const WEBHOOK_SECRET = 'conformance-suite-webhook-secret-0123456789abcdef';
/**
 * The conformance database keeps its historical name; every other harness
 * database carries the `ye_harness_` prefix, which no dev or test `.env`
 * convention produces — so a harness can never be handed the database a
 * worktree's dev server is running against. The character class also rules
 * out anything that could carry a host, a port or a query string past the
 * pinning below.
 */
export const DB_NAME = harnessOverride(
  'HARNESS_DB_NAME',
  'ye_voice_conformance',
  (raw) => (raw === 'ye_voice_conformance' || /^ye_harness_[a-z_]+$/.test(raw) ? raw : undefined),
  '`ye_voice_conformance` or a name matching /^ye_harness_[a-z_]+$/',
);
/**
 * The suite's own Redis database, pinned here exactly as the Postgres one is.
 *
 * The driver now runs a **real** `call-placement` worker, so this process both
 * publishes and consumes. Sharing a database index with a dev server would let
 * this suite's worker pick up a real deployment's dial and place it against the
 * live partner account — the one failure this whole file exists to make
 * impossible. Only the host and port are taken from `.env`; the index comes
 * from an explicit allocation, and only the harness entries of it are
 * accepted here:
 *
 *   9   dev servers
 *   10  vitest suites
 *   11  battle harness
 *   12  battle harness
 *   13  conformance suite (the default)
 *   14  goal-verdict worktree tests
 *   15  campaign simulator
 *
 * A new harness gets a new row, not a wider range.
 */
const HARNESS_REDIS_INDEXES = new Set([13, 15]);
export const REDIS_DB_INDEX = harnessOverride(
  'HARNESS_REDIS_DB_INDEX',
  13,
  (raw) => {
    const n = parseIntegerBetween(0, 15)(raw);
    return n !== undefined && HARNESS_REDIS_INDEXES.has(n) ? n : undefined;
  },
  'one of 13 (conformance) or 15 (campaign simulator)',
);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = repoRoot;

/** The upstream mock lives beside this repo (main checkout) or under the project root (worktrees). */
function resolveMockRoot(): string {
  const candidates = [
    path.resolve(repoRoot, '..', 'vocobase-mock'),
    path.resolve(repoRoot, '..', '..', '..', 'YE-Voice-AI', 'ye-voice-agent', 'vocobase-mock'),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`conformance: vocobase-mock not found at ${candidates.join(' or ')}`);
}

export const MOCK_ROOT = resolveMockRoot();

function resolveDatabaseUrl(): string {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, '.env'), 'utf8');
  } catch {
    throw new Error('conformance: no .env found next to package.json; need it for the local DB password.');
  }
  const line = raw.split('\n').find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('conformance: .env has no DATABASE_URL.');
  const url = new URL(line.slice('DATABASE_URL='.length).trim());
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`conformance: .env DATABASE_URL host is ${url.hostname}; refusing anything non-local.`);
  }
  // Only the credentials are trusted; everything else is pinned.
  const pinned = `postgresql://${url.username}:${url.password}@localhost:5436/${DB_NAME}`;
  if (pinned.includes('neon.tech')) throw new Error('conformance: refusing a neon.tech URL.');
  return pinned;
}

export const DATABASE_URL = resolveDatabaseUrl();

function resolveRedisUrl(): string {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, '.env'), 'utf8');
  } catch {
    throw new Error('conformance: no .env found next to package.json; need it for the local Redis.');
  }
  const line = raw.split('\n').find((l) => l.startsWith('REDIS_URL='));
  if (!line) throw new Error('conformance: .env has no REDIS_URL.');
  const url = new URL(line.slice('REDIS_URL='.length).trim());
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`conformance: .env REDIS_URL host is ${url.hostname}; refusing anything non-local.`);
  }
  url.pathname = `/${REDIS_DB_INDEX}`;
  return url.toString();
}

export const REDIS_URL = resolveRedisUrl();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = DATABASE_URL;
process.env.CLERK_SECRET_KEY = 'sk_test_conformance_dummy';
process.env.VOCOBASE_API_URL = `http://127.0.0.1:${MOCK_PORT}/api/v2`;
process.env.VOCOBASE_API_KEY = 'mockkey';
process.env.VOCOBASE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.DIALER_ENABLED = 'true';
process.env.REDIS_URL = REDIS_URL;
/**
 * The bootstrap stays off, and the placement worker is started by hand.
 *
 * `startWorkers()` would also register the repeatable schedules, and a dispatch
 * tick firing on its own clock is the one thing a virtual-clock harness cannot
 * have: the driver decides when a pass happens. What it does want is the
 * *placement* half running for real, so a tick that posts dials is observed the
 * way a tick that dialed inline was — see `startServers`.
 */
process.env.WORKERS_ENABLED = 'false';

/** Backend modules, importable only after the env above is installed. */
export async function loadBackend() {
  const [
    { createApp },
    { prisma },
    dialer,
    reaper,
    notify,
    credits,
    correlation,
    queues,
    placement,
    webhook,
    connection,
  ] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/lib/prisma.js'),
      import('../../src/services/dialer.js'),
      import('../../src/services/dialerReaper.js'),
      import('../../src/lib/notify.js'),
      import('../../src/lib/credits.js'),
      import('../../src/lib/callCorrelation.js'),
      import('../../src/lib/queue/queues.js'),
      import('../../src/lib/queue/workers/call-placement.worker.js'),
      import('../../src/lib/queue/workers/webhook-processing.worker.js'),
      import('../../src/lib/queue/connection.js'),
    ]);
  return {
    createApp,
    prisma,
    runDialerSweep: dialer.runDialerSweep,
    closeStaleAttempts: reaper.closeStaleAttempts,
    flushNotifications: notify.flushNotifications,
    toInternalCredits: credits.toInternalCredits,
    parseCorrelationId: correlation.parseCorrelationId,
    callPlacementQueue: queues.callPlacementQueue,
    createCallPlacementWorker: placement.createCallPlacementWorker,
    webhookProcessingQueue: queues.webhookProcessingQueue,
    createWebhookProcessingWorker: webhook.createWebhookProcessingWorker,
    closeQueues: queues.closeQueues,
    closeWorkerConnections: connection.closeWorkerConnections,
    closeQueueConnection: connection.closeQueueConnection,
  };
}

export type Backend = Awaited<ReturnType<typeof loadBackend>>;
