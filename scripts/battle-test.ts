/**
 * Battle-test driver for the queue-worker wave.
 *
 *   npx tsx scripts/battle-test.ts [--scenario N] [--runs N] [--seed S] [--redis-db 11|12]
 *
 * Twelve scenarios, on a real clock, against real processes:
 *
 *   1. Multi-campaign concurrency, and **utilisation** — the question a
 *      conformance run cannot ask. Every cap this engine honours is a ceiling,
 *      and a dialer that stays far below its ceiling while contacts are waiting
 *      is broken in a way no correctness assertion notices.
 *   2. Two instances, one Redis, one Postgres — the property the whole wave
 *      exists to buy, including a SIGKILL mid-run.
 *   3. Queue-failure semantics — what a killed process does to work it was
 *      holding.
 *   4-12. Goal campaigns, one scenario per call outcome the bot can return
 *      and per thing that can happen around one: completed on the first call,
 *      the dial budget spent, "not interested", "call me next week", a voicemail
 *      between two conversations, no note at all, a duplicated completion,
 *      two goal campaigns sharing one agent, and a managed note block
 *      somebody edited by hand.
 *
 * Every run gets its own ports and its own Redis database, and that database is
 * flushed before the run starts.
 */
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { hasIntactGoalBlock, NOTE_BLOCK_START, NOTE_PROMPT_BLOCK } from '../src/lib/goalPromptBlock.js';
import { FOLLOW_UP_NOTE, GOAL_VARIABLE_NAMES } from '../src/lib/goalVariables.js';
import {
  YE_CONTEXT_VARIABLE_NAMES,
  isReservedVariableName,
} from '../src/lib/contextVariables.js';
import {
  api,
  apiOk,
  BACKEND_PORTS,
  flushRedis,
  killTree,
  makePrisma,
  MOCK_PORT,
  pollUntil,
  preflight,
  Report,
  resetSeedState,
  resolveDatabaseUrl,
  resolveRedisUrl,
  type RunResult,
  seedCampaign,
  seedWorkspace,
  type SeededCampaign,
  type SeededWorkspace,
  makePhones,
  setAgentPrompt,
  simScript,
  simState,
  sleep,
  spawnBackend,
  startCampaign,
  startServers,
  TEST_USER,
  TEST_USER_2,
  truncateAll,
  waitForHttp,
  waitPortsFree,
  WEBHOOK_SECRET,
} from './battle-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTLE_TIMEOUT = 10 * 60_000;

interface Ctx {
  prisma: PrismaClient;
  databaseUrl: string;
  redisUrl: string;
  seed: number;
  tag: string;
  violations: string[];
  notes: string[];
  metrics: Record<string, string | number>;
}

/* ------------------------------------------------------------------ *
 * Sampling: what the engine was actually doing, twice a second
 * ------------------------------------------------------------------ */

interface Sample {
  atMs: number;
  /** Live attempts per campaign — exactly what `campaignInFlight` counts. */
  inFlight: Map<string, number>;
  /** Contacts a claim could take right now, per campaign. */
  eligible: Map<string, number>;
  /** Live attempts whose contact has already been dialed before. */
  retryInFlight: Map<string, number>;
  poolActive: number;
  poolLimit: number;
}

async function takeSample(prisma: PrismaClient, campaignIds: string[]): Promise<Sample> {
  const now = new Date();
  const [flight, eligible, retries, mock] = await Promise.all([
    prisma.callAttempt.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: campaignIds }, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
      _count: { _all: true },
    }),
    prisma.campaignContact.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: campaignIds },
        status: 'PENDING',
        OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: now } }],
      },
      _count: { _all: true },
    }),
    prisma.callAttempt.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: campaignIds },
        status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] },
        attemptNo: { gt: 1 },
      },
      _count: { _all: true },
    }),
    simState(),
  ]);

  const toMap = (rows: Array<{ campaignId: string | null; _count: { _all: number } }>) =>
    new Map(rows.filter((r) => r.campaignId).map((r) => [r.campaignId!, r._count._all]));

  return {
    atMs: Date.now(),
    inFlight: toMap(flight),
    eligible: toMap(eligible),
    retryInFlight: toMap(retries),
    poolActive: mock.active,
    poolLimit: mock.limit,
  };
}

interface CampaignShape {
  id: string;
  name: string;
  accountId: string;
  concurrencyLimit: number;
  retryConcurrency: number;
}

/**
 * What the engine *could* have had in flight at this instant.
 *
 * The binding cap, computed the way the engine computes it: a campaign cannot
 * exceed its own limit or the work it actually has; an account cannot exceed
 * its allotment across its campaigns; and nobody exceeds the shared platform
 * pool. Utilisation measured against anything looser would fail a dialer for
 * not dialing contacts that do not exist.
 */
function achievable(sample: Sample, shapes: CampaignShape[], accountLimits: Map<string, number>): number {
  const perAccount = new Map<string, number>();

  for (const shape of shapes) {
    const live = sample.inFlight.get(shape.id) ?? 0;
    const waiting = sample.eligible.get(shape.id) ?? 0;
    const want = Math.min(shape.concurrencyLimit, live + waiting);
    perAccount.set(shape.accountId, (perAccount.get(shape.accountId) ?? 0) + want);
  }

  let total = 0;
  for (const [accountId, want] of perAccount) {
    total += Math.min(want, accountLimits.get(accountId) ?? want);
  }

  return Math.min(total, sample.poolLimit);
}

function actualInFlight(sample: Sample): number {
  let total = 0;
  for (const n of sample.inFlight.values()) total += n;
  return total;
}

/** Every cap, checked at every sample. A ceiling breached once is breached. */
function checkCeilings(
  sample: Sample,
  shapes: CampaignShape[],
  accountLimits: Map<string, number>,
  violations: string[],
): void {
  const perAccount = new Map<string, number>();

  for (const shape of shapes) {
    const live = sample.inFlight.get(shape.id) ?? 0;
    if (live > shape.concurrencyLimit) {
      violations.push(
        `campaign ${shape.name}: ${live} calls in flight, concurrencyLimit ${shape.concurrencyLimit}`,
      );
    }
    perAccount.set(shape.accountId, (perAccount.get(shape.accountId) ?? 0) + live);
  }

  for (const [accountId, live] of perAccount) {
    const limit = accountLimits.get(accountId);
    if (limit !== undefined && live > limit) {
      violations.push(`account ${accountId}: ${live} calls in flight, allotment ${limit}`);
    }
  }

  if (sample.poolActive > sample.poolLimit) {
    violations.push(`platform pool: ${sample.poolActive} active, limit ${sample.poolLimit}`);
  }
}

/* ------------------------------------------------------------------ *
 * Shared invariants
 * ------------------------------------------------------------------ */

/**
 * Exactly one dispatch schedule however many instances boot.
 *
 * The mechanism itself rather than a proxy for it: BullMQ keys a repeatable
 * by its id, so two instances upserting the same key leave one entry. Two
 * entries would be two dispatch ticks a period, and the thing that would
 * notice is the partner account's rate limit.
 */
async function checkSingleSchedules(ctx: Ctx, when: string): Promise<void> {
  const inspector = new Redis(ctx.redisUrl, { maxRetriesPerRequest: null });
  const dispatchQueue = new Queue('campaign-dispatch', { connection: inspector });
  const maintenanceQueue = new Queue('maintenance', { connection: inspector });
  try {
    const dispatchSchedules = await dispatchQueue.getJobSchedulers();
    const maintenanceSchedules = await maintenanceQueue.getJobSchedulers();
    if (dispatchSchedules.length !== 1) {
      ctx.violations.push(
        `${dispatchSchedules.length} dispatch schedules across two instances ${when} (must be 1)`,
      );
    }
    const keys = maintenanceSchedules.map((s) => s.key);
    if (new Set(keys).size !== keys.length) {
      ctx.violations.push(`duplicate maintenance schedules ${when}: ${keys.join(', ')}`);
    }
    ctx.metrics.schedules = `${dispatchSchedules.length}+${maintenanceSchedules.length}`;
  } finally {
    await dispatchQueue.close();
    await maintenanceQueue.close();
    await inspector.quit();
  }
}

async function checkMockInvariants(ctx: Ctx): Promise<void> {
  const sim = await simState();

  if (sim.breaches.length > 0) ctx.violations.push(`mock breaches: ${sim.breaches.join('; ')}`);

  // A run that recorded dials but no references would make every per-ref
  // check below pass over an empty object — vacuously, which is the one way
  // a grading loop is allowed to lie.
  if (sim.dialLog.length > 0 && Object.keys(sim.refCounts).length === 0) {
    ctx.violations.push(`${sim.dialLog.length} dial(s) recorded with no references at all`);
  }

  for (const [ref, count] of Object.entries(sim.refCounts)) {
    if (count !== 1) ctx.violations.push(`reference ${ref} dialed ${count} times (must be exactly 1)`);
  }

  ctx.metrics.dials = sim.dialLog.length;
  ctx.metrics.peak = sim.peak;
}

/**
 * One dial per attempt row, and one attempt row per (contact, ordinal).
 *
 * The database's own unique makes the second true, so what this really checks
 * is the first: that every attempt this engine opened reached the platform at
 * most once. A redial after a crash would show up here as an attempt row whose
 * id never appears in the dial log beside a *second* row for the same ordinal.
 */
async function checkNoDoubleDials(ctx: Ctx, campaignIds: string[]): Promise<void> {
  const sim = await simState();
  const attempts = await ctx.prisma.callAttempt.findMany({
    where: { campaignId: { in: campaignIds } },
    select: { id: true, campaignContactId: true, attemptNo: true },
  });

  const pairs = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.campaignContactId}:${attempt.attemptNo}`;
    if (pairs.has(key)) {
      ctx.violations.push(`two attempt rows for ${key} — the dial mutual-exclusion token failed`);
    }
    pairs.add(key);
  }

  const dialedAttemptIds = sim.dialLog
    .map((entry) => entry.ref?.split(':')[3])
    .filter((id): id is string => Boolean(id));

  // Every dial this engine places carries the four-segment reference, and the
  // whole three-attempt retry policy is conditional on the fourth segment
  // being stamped. A dial missing it must fail the run, not fall out of the
  // check — silently dropping those rows would grade "zero double-dials" over
  // exactly the entries that could prove one.
  if (dialedAttemptIds.length !== sim.dialLog.length) {
    ctx.violations.push(
      `${sim.dialLog.length - dialedAttemptIds.length} dial(s) without an attempt segment ` +
        'in their reference — the retry idempotency key is not being stamped',
    );
  }

  const seen = new Set<string>();
  for (const id of dialedAttemptIds) {
    if (seen.has(id)) ctx.violations.push(`attempt ${id} reached the platform twice`);
    seen.add(id);
  }
}

async function checkAllTerminal(ctx: Ctx, campaignIds: string[]): Promise<void> {
  const stuck = await ctx.prisma.campaignContact.groupBy({
    by: ['status'],
    where: { campaignId: { in: campaignIds }, status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
    _count: { _all: true },
  });

  for (const row of stuck) {
    ctx.violations.push(`${row._count._all} contact(s) left ${row.status}`);
  }
}

async function settle(ctx: Ctx, campaignIds: string[], timeoutMs = SETTLE_TIMEOUT): Promise<void> {
  await pollUntil(
    async () => {
      const unfinished = await ctx.prisma.campaignContact.count({
        where: { campaignId: { in: campaignIds }, status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
      });
      if (unfinished > 0) return null;
      const sim = await simState();
      return sim.active === 0 ? true : null;
    },
    timeoutMs,
    'every contact terminal and the platform idle',
    1000,
  );
}

/* ------------------------------------------------------------------ *
 * Scenario 1 — multi-campaign concurrency and utilisation
 * ------------------------------------------------------------------ */

async function scenarioConcurrency(ctx: Ctx): Promise<void> {
  const poolLimit = 14;
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    // Two accounts with different allotments, three campaigns with different
    // ceilings, one of them reserving a retry lane.
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 9, dids: 2 });
    const beta = await seedWorkspace(ctx.prisma, TEST_USER_2, 'beta', { accountConcurrency: 6 });

    const campaigns: SeededCampaign[] = [
      await seedCampaign(ctx.prisma, alpha, {
        name: 'alpha-wide', concurrencyLimit: 6, retryCount: 1, contacts: 70, block: 11,
      }),
      await seedCampaign(ctx.prisma, alpha, {
        name: 'alpha-lanes',
        concurrencyLimit: 4,
        retryConcurrency: 1,
        retryCount: 2,
        contacts: 60,
        retriesDue: 20,
        block: 12,
      }),
      await seedCampaign(ctx.prisma, beta, {
        name: 'beta', concurrencyLimit: 5, retryCount: 1, contacts: 60, block: 13,
      }),
    ];

    const shapes: CampaignShape[] = [
      { id: campaigns[0]!.id, name: 'alpha-wide', accountId: alpha.accountId, concurrencyLimit: 6, retryConcurrency: 0 },
      { id: campaigns[1]!.id, name: 'alpha-lanes', accountId: alpha.accountId, concurrencyLimit: 4, retryConcurrency: 1 },
      { id: campaigns[2]!.id, name: 'beta', accountId: beta.accountId, concurrencyLimit: 5, retryConcurrency: 0 },
    ];
    const accountLimits = new Map([[alpha.accountId, 9], [beta.accountId, 6]]);
    const campaignIds = campaigns.map((c) => c.id);

    for (const campaign of campaigns) await startCampaign(servers.ports[0]!, campaign);

    // Sample twice a second for the whole run.
    const samples: Sample[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          samples.push(await takeSample(ctx.prisma, campaignIds));
        } catch {
          // A sample lost to a transient read is not a finding.
        }
        await sleep(500);
      }
    })();

    await settle(ctx, campaignIds);
    sampling = false;
    await sampler;

    for (const sample of samples) checkCeilings(sample, shapes, accountLimits, ctx.violations);

    /**
     * Utilisation, over the steady state only.
     *
     * The first samples are a dialer that has not had its first tick yet, and
     * grading those would be grading the sweep interval. Counting starts once
     * the first call is live and one sweep period has passed.
     */
    const firstLive = samples.findIndex((s) => actualInFlight(s) > 0);
    const steady = firstLive === -1 ? [] : samples.slice(firstLive + 4);
    const graded = steady
      .map((s) => ({ want: achievable(s, shapes, accountLimits), got: actualInFlight(s) }))
      .filter((s) => s.want > 0);

    if (graded.length < 10) {
      ctx.violations.push(`only ${graded.length} steady-state samples — the run was too short to grade`);
    } else {
      const mean = graded.reduce((sum, s) => sum + s.got / s.want, 0) / graded.length;
      ctx.metrics.utilisation = `${(mean * 100).toFixed(1)}%`;
      ctx.metrics.samples = graded.length;

      // A dialer that stays below its ceiling while contacts wait is broken in
      // a way no correctness assertion notices.
      if (mean < 0.75) {
        ctx.violations.push(
          `mean utilisation ${(mean * 100).toFixed(1)}% of the achievable ceiling (floor 75%)`,
        );
      }

      // And a mean can hide a stall: six consecutive samples — three seconds,
      // more than a sweep period — below half the ceiling is a stall.
      let run = 0;
      let worst = 0;
      for (const s of graded) {
        run = s.got / s.want < 0.5 ? run + 1 : 0;
        worst = Math.max(worst, run);
      }
      ctx.metrics.longestStall = `${(worst * 0.5).toFixed(1)}s`;
      if (worst >= 6) {
        ctx.violations.push(
          `sustained under-utilisation: ${worst} consecutive samples below half the ceiling`,
        );
      }
    }

    // The reserved lane, exercised rather than merely configured: at least one
    // instant where the lane campaign had a retry and a fresh call live at once.
    const lanes = shapes[1]!;
    const sawSplit = samples.some((s) => {
      const live = s.inFlight.get(lanes.id) ?? 0;
      const retry = s.retryInFlight.get(lanes.id) ?? 0;
      return retry >= 1 && live - retry >= 1;
    });
    if (!sawSplit) {
      ctx.violations.push('the reserved retry lane never carried a retry beside a fresh call');
    }

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, campaignIds);
    await checkAllTerminal(ctx, campaignIds);

    const counters = await ctx.prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: { name: true, status: true, completedCount: true, failedCount: true },
    });
    ctx.notes.push(
      `campaigns: ${counters.map((c) => `${c.name} ${c.status} ok=${c.completedCount} fail=${c.failedCount}`).join('; ')}`,
    );
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 2 — two instances, one Redis, one Postgres
 * ------------------------------------------------------------------ */

async function scenarioMultiInstance(ctx: Ctx): Promise<void> {
  const poolLimit = 12;
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit,
    tag: ctx.tag,
    instances: 2,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const beta = await seedWorkspace(ctx.prisma, TEST_USER_2, 'beta', { accountConcurrency: 6 });

    const campaigns = [
      await seedCampaign(ctx.prisma, alpha, {
        name: 'alpha', concurrencyLimit: 5, retryCount: 1, contacts: 70, block: 21,
      }),
      await seedCampaign(ctx.prisma, beta, {
        name: 'beta', concurrencyLimit: 4, retryCount: 1, contacts: 60, block: 22,
      }),
    ];
    const shapes: CampaignShape[] = [
      { id: campaigns[0]!.id, name: 'alpha', accountId: alpha.accountId, concurrencyLimit: 5, retryConcurrency: 0 },
      { id: campaigns[1]!.id, name: 'beta', accountId: beta.accountId, concurrencyLimit: 4, retryConcurrency: 0 },
    ];
    const accountLimits = new Map([[alpha.accountId, 8], [beta.accountId, 6]]);
    const campaignIds = campaigns.map((c) => c.id);

    // Started through *different* instances, so neither is the only writer.
    await startCampaign(servers.ports[0]!, campaigns[0]!);
    await startCampaign(servers.ports[1]!, campaigns[1]!);

    /**
     * One schedule, however many instances registered it.
     *
     * This is the mechanism itself rather than a proxy for it: BullMQ keys a
     * repeatable by its id, so two instances upserting the same key leave one
     * entry. Two entries would be two dispatch ticks a period, and the thing
     * that would notice is the partner account's rate limit.
     */
    await checkSingleSchedules(ctx, 'at boot');

    const samples: Sample[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          samples.push(await takeSample(ctx.prisma, campaignIds));
        } catch {
          /* transient */
        }
        await sleep(500);
      }
    })();

    // Let both instances get properly to work, then take one out with no
    // warning at all — holding whatever claims and open attempts it held.
    await pollUntil(
      async () => (await simState()).dialLog.length >= 25,
      120_000,
      '25 dials before the kill',
      500,
    );
    const heldBefore = await ctx.prisma.campaignContact.count({
      where: { campaignId: { in: campaignIds }, status: 'QUEUED' },
    });
    killTree(servers.backends[1]!);
    ctx.notes.push(
      `SIGKILLed instance b with ${heldBefore} contact(s) QUEUED platform-wide at the kill ` +
        '(claims carry no instance attribution)',
    );

    // The survivor finishes the work. Nothing is restarted: what recovers the
    // dead instance's claims is the cleanup sweep on the live one.
    await settle(ctx, campaignIds);
    sampling = false;
    await sampler;

    for (const sample of samples) checkCeilings(sample, shapes, accountLimits, ctx.violations);

    // Again after the run: the boot-time check can observe a moment before
    // the second instance registered and pass over one schedule trivially. By
    // now both instances have long registered (the killed one included —
    // schedulers are Redis state and outlive their registrar), so a second
    // schedule from either boot would be visible here.
    await checkSingleSchedules(ctx, 'after settle');

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, campaignIds);
    await checkAllTerminal(ctx, campaignIds);

    const totals = await ctx.prisma.campaignContact.groupBy({
      by: ['status'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    });
    const settled = totals.reduce((sum, row) => sum + row._count._all, 0);
    if (settled !== 130) {
      ctx.violations.push(`${settled} contacts accounted for, expected 130`);
    }
    ctx.metrics.contacts = settled;
    ctx.notes.push(
      `final: ${totals.map((t) => `${t.status}=${t._count._all}`).join(' ')}`,
    );
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 3 — queue-failure semantics
 * ------------------------------------------------------------------ */

async function scenarioQueueFailures(ctx: Ctx): Promise<void> {
  const poolLimit = 10;
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit,
    tag: ctx.tag,
    instances: 1,
  });
  let backend: ChildProcess = servers.backends[0]!;

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const campaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'failures', concurrencyLimit: 6, retryCount: 1, contacts: 60, block: 31,
    });
    const campaignIds = [campaign.id];

    await startCampaign(servers.ports[0]!, campaign);

    /**
     * Kill the process mid-batch, with placements in flight and completions
     * arriving.
     *
     * This is the shape both failure cases actually take in production. Some
     * placement jobs were between their attempt-row insert and their answer;
     * some webhook jobs were mid-transaction. Both come back — the placement
     * as a claim the cleanup sweep frees or a job the queue redelivers, the
     * webhook as a stalled job BullMQ hands to the next worker — and the
     * assertions below are that neither produced a second dial or a second
     * charge.
     */
    await pollUntil(
      async () => (await simState()).dialLog.length >= 20,
      120_000,
      '20 dials before the kill',
      500,
    );
    const openBefore = await ctx.prisma.callAttempt.count({
      where: { campaignId: campaign.id, resolvedAt: null },
    });
    killTree(backend);
    // The port has to be genuinely free before the replacement asks for it;
    // a SIGKILLed group takes a moment to let go of its listening socket.
    await waitPortsFree([servers.ports[0]!]);

    // Bring it back on the same port, against the same Redis and Postgres.
    backend = spawnBackend({
      databaseUrl: ctx.databaseUrl,
      redisUrl: ctx.redisUrl,
      seed: ctx.seed,
      poolLimit,
      tag: ctx.tag,
      port: servers.ports[0]!,
      instance: 'a2',
    });
    servers.backends[0] = backend;
    await waitForHttp(`http://127.0.0.1:${servers.ports[0]}/health`);
    ctx.notes.push(`SIGKILLed and restarted with ${openBefore} unresolved attempt(s) in flight`);

    await settle(ctx, campaignIds);

    await checkMockInvariants(ctx);
    // A placement job that died after its dial-attempt insert must not have
    // redialed: one row per (contact, ordinal), one dial per row.
    await checkNoDoubleDials(ctx, campaignIds);
    await checkAllTerminal(ctx, campaignIds);

    /**
     * And no call is charged twice.
     *
     * The webhook queue's exactly-once property, at load and across a crash:
     * the ledger's per-account unique on the attempt id is what enforces it,
     * and a redelivered completion that got past it would show up here as two
     * rows for one attempt.
     */
    const ledger = await ctx.prisma.creditTransaction.groupBy({
      by: ['callAttemptId'],
      where: { type: 'CALL_USAGE', callAttemptId: { not: null } },
      _count: { _all: true },
    });
    for (const row of ledger) {
      if (row._count._all > 1) {
        ctx.violations.push(`attempt ${row.callAttemptId} charged ${row._count._all} times`);
      }
    }
    ctx.metrics.charged = ledger.length;

    // Every completed call was charged: a webhook job lost to the kill and
    // never redelivered would show as a completed attempt with no ledger row.
    const completedUncharged = await ctx.prisma.callAttempt.count({
      where: { campaignId: campaign.id, status: 'COMPLETED', durationSecs: { gt: 0 }, chargedAt: null },
    });
    if (completedUncharged > 0) {
      ctx.violations.push(`${completedUncharged} completed call(s) were never charged`);
    }

    const counters = await ctx.prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      select: { status: true, completedCount: true, failedCount: true },
    });
    ctx.notes.push(
      `campaign ended ${counters.status} ok=${counters.completedCount} fail=${counters.failedCount}`,
    );
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Goal campaigns (scenarios 4-12)
 *
 * ## What these grade
 *
 * The call note the bot returns at the end of every call, on a real clock and
 * through the real queue: `completed`, `incomplete` with a `flexible` or a
 * `requested` callback, `stop`, and the absence of any note at all. The
 * conformance suite grades the same decision table on a virtual clock, where
 * hours are free and a driver can step INTO the gap between a call's terminal
 * status event and the `session.completed` that carries its note. What it
 * cannot grade is any of this happening at speed, across processes, with the
 * platform answering in its own time — which is what these scenarios are for.
 *
 * ## How real time is handled
 *
 * A follow-up waits the retry cooldown ladder since 2026-09-06 — the same
 * wait a no-answer gets — and `seedCampaign` defaults `cooldownMinutes` to
 * one, the shortest the engine allows. A battle run must stay inside
 * SETTLE_TIMEOUT, so these scenarios still do NOT wait the gap out. Each
 * re-arm is first asserted as STATE on the real clock (PENDING,
 * `nextEligibleAt ≈ now + the cooldown`, the counter moved, `callbackAt`
 * untouched), and only then is `nextEligibleAt` moved to now — the exact row
 * state the contact would hold a minute later, nothing else differing, the
 * same device the harness already uses to seed a due retry. Every dial,
 * claim, kind stamp, variable render and resolution after the nudge is the
 * real engine on the real queue. The full multi-hop delay/window behavior is
 * graded on the virtual clock in the conformance suite (rows G1/G5), where
 * hours are free. The waits kept real are the retry cooldown in the voicemail
 * scenario and the callback promise in scenario 7 — a minute and two minutes,
 * both inside the timeout.
 * ------------------------------------------------------------------ */

/**
 * One conversation, and the call note the bot came back with.
 *
 * Every goal scenario below scripts call notes rather than collected fields:
 * the bot says whether the call was `completed`, should `stop`, or is
 * `incomplete` and what kind of callback that needs, and YE applies the caps
 * on top of that. `next_call_instructions_vocobaseplatform` is what the bot
 * writes for the next call, and YE's dial variable of that name — the frame
 * plus that instruction, as one JSON object — is the ONE thing the next dial
 * carries from YE, which is why so many assertions below read the dial log.
 */
const conversation = (note: Record<string, unknown>) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: 20,
  delays_secs: { ringing: 1, hold: 1, talk: 3 },
  extraction: note,
});

/** The one variable YE adds to a dial, and only once a note exists. */
const NOTE_VARIABLE = GOAL_VARIABLE_NAMES[0];

/** All seven variables the previous contract rendered on every goal dial; a
 *  dial still carrying one is an engine that kept the old overlay.
 *  `follow_up_instruction` first, because it was that contract's whole answer
 *  to "tell the model this is a continuation" and the note's own frame is what
 *  replaced it — two standing orders on one dial is the failure this catches,
 *  and the list was written without it. */
const RETIRED_VARIABLES = [
  'follow_up_instruction',
  'campaign_goal',
  'call_number',
  'previous_attempts',
  'memory',
  'last_call_note',
  'goal_missing',
] as const;

/**
 * The keys of a dial's variables that YE added ON TOP of what every dial
 * carries — the contact's own variables and the standing campaign context.
 *
 * The context names are subtracted explicitly rather than left to the
 * "wasn't on dial 1" test. They ARE on dial 1, so the test would exclude
 * them by accident today; naming them says that is the intent, and the day
 * a fifth context variable is added to a later dial only, the difference is
 * a violation rather than a silence.
 */
function ezoKeys(first: Record<string, string>, later: Record<string, string>): string {
  return Object.keys(later)
    .filter((k) => !(k in first) && !CONTEXT_NAMES.has(k))
    .sort()
    .join(',');
}

const CONTEXT_NAMES = new Set<string>(YE_CONTEXT_VARIABLE_NAMES);

/**
 * The campaign context, on every outbound dial without exception.
 *
 * Asserted on the engine's real output rather than only in `test/` because
 * this is what a post-call action's template keys on: a dial that reaches
 * the platform without `ezo_campaign_id` is a sheet row that cannot say
 * which campaign wrote it, and nothing in the unit tests observes the
 * variables the mock actually received.
 *
 * The prefix half matters as much as the presence half. `ezo_` is reserved
 * across the agent's declared list and the campaign's column map, and the
 * only way to catch a projection that smuggled one through is to look at
 * what a dial carried and refuse any `ezo_` key that is not one of the four.
 */
function expectCampaignContext(
  ctx: Ctx,
  vars: Record<string, string> | undefined,
  label: string,
): void {
  if (vars === undefined) return;

  for (const name of YE_CONTEXT_VARIABLE_NAMES) {
    const value = vars[name];
    if (typeof value !== 'string' || value.length === 0) {
      ctx.violations.push(`${label} carried no ${name}: ${JSON.stringify(vars)}`);
    }
  }

  const stray = Object.keys(vars).filter((k) => isReservedVariableName(k) && !CONTEXT_NAMES.has(k));
  if (stray.length > 0) {
    ctx.violations.push(
      `${label} carried a reserved-prefix variable YE does not supply: ${stray.join(', ')}`,
    );
  }
}

/** Pushes a violation unless the dial carried the standing campaign context
 *  and nothing else from YE — no note, and nothing from the old overlay. */
function expectBareDial(ctx: Ctx, vars: Record<string, string> | undefined, label: string): void {
  if (vars === undefined) return;
  expectCampaignContext(ctx, vars, label);
  if (NOTE_VARIABLE in vars || RETIRED_VARIABLES.some((k) => k in vars)) {
    ctx.violations.push(`${label} carried an YE variable: ${JSON.stringify(vars)}`);
  }
}

/**
 * Pushes a violation unless the dial carried exactly YE's follow-up
 * instruction: the one variable, holding the JSON object YE assembles from
 * its own standing frame and the note the previous call wrote.
 *
 * Graded on content — the frame's sentence is present and the previous note
 * came through intact — rather than on an exact string. The exact string is
 * `goalVariables`' own output, and a harness comparing that to a copy of
 * itself grades nothing.
 */
function expectNoteDial(
  ctx: Ctx,
  first: Record<string, string> | undefined,
  later: Record<string, string> | undefined,
  note: string,
  label: string,
): void {
  if (first === undefined || later === undefined) return;
  expectCampaignContext(ctx, later, label);
  const value = later[NOTE_VARIABLE];
  let carried = false;
  if (typeof value === 'string' && value.includes('THIS IS A FOLLOW-UP CALL')) {
    try {
      const parsed = JSON.parse(value) as { note?: unknown; instructions?: unknown };
      carried = parsed.note === FOLLOW_UP_NOTE && parsed.instructions === note;
    } catch {
      carried = false;
    }
  }
  if (!carried) {
    ctx.violations.push(`${label} carried ${JSON.stringify(value)}, expected the follow-up frame plus the note ${JSON.stringify(note)}`);
  }
  if (ezoKeys(first, later) !== NOTE_VARIABLE) {
    ctx.violations.push(`${label} carried more than the note from YE: ${JSON.stringify(later)}`);
  }
}

/**
 * `incomplete` with a `flexible` callback: call again at the campaign's own
 * delay. The `"null"` time is the literal string the platform's description
 * asks the model for, so the engine's reading of it is under test throughout.
 */
const callAgain = (note: string, reason: string) =>
  conversation({
    call_outcome_vocobaseplatform: 'incomplete',
    call_outcome_reason_vocobaseplatform: reason,
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

const goalDone = (note: string, reason = 'they told me everything') =>
  conversation({
    call_outcome_vocobaseplatform: 'completed',
    call_outcome_reason_vocobaseplatform: reason,
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

const goalStop = (note: string, reason: string) =>
  conversation({
    call_outcome_vocobaseplatform: 'stop',
    call_outcome_reason_vocobaseplatform: reason,
    immediate_callback_needed_vocobaseplatform: 'no',
    callback_requested_time_vocobaseplatform: 'null',
    next_call_instructions_vocobaseplatform: note,
  });

/** A conversation whose extraction never came back: the call happened and
 *  nobody judged it. Null everywhere is "no outcome", never a guess. */
const noNote = () => conversation({});

/**
 * An instant in the platform's `YYYY-MM-DDTHH:mm±HH` form at a whole-hour
 * offset — `+05`, not IST's `+05:30`, because the two-digit offset is the one
 * the description asks the model for and the one `Date` alone will not parse.
 * The form has no seconds; the caller hands in a whole minute.
 */
function offsetForm(ms: number, offsetHours: number): string {
  const shifted = new Date(ms + offsetHours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = offsetHours < 0 ? '-' : '+';
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}${sign}${pad(Math.abs(offsetHours))}`
  );
}

/**
 * Voicemail. A silence, so it never reaches the goal decision table at all —
 * the retry ladder arms exactly as it does on a campaign with no goal, and
 * the only goal-shaped thing that happens is the line YE derives for it.
 */
const voicemail = {
  status: 'completed',
  disposition: 'voicemail',
  answered_by: 'machine',
  duration_seconds: 8,
  delays_secs: { ringing: 1, hold: 1, talk: 2 },
};

const goalBusy = { status: 'busy', delays_secs: { ringing: 1, hold: 1 } };

const contactRow = (ctx: Ctx, id: string) =>
  ctx.prisma.campaignContact.findUniqueOrThrow({ where: { id } });

/** The campaign-contact link ids for a seeded campaign, in phone order. */
async function linkIds(ctx: Ctx, campaign: SeededCampaign): Promise<Map<string, string>> {
  const rows = await ctx.prisma.campaignContact.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, contact: { select: { phone: true } } },
  });
  return new Map(rows.map((r) => [r.contact.phone, r.id]));
}

/** The variables one dial carried, as the platform received them. */
async function dialVariables(phone: string): Promise<Array<Record<string, string>>> {
  const sim = await simState();
  return sim.dialLog
    .filter((e) => e.toNumber === phone)
    .map((e) => (e.variables ?? {}) as Record<string, string>);
}

/** The prompt the platform is holding for one agent, as YE last wrote it. */
async function agentPrompt(agentExternalId: string): Promise<string> {
  const sim = await simState();
  return sim.agents?.[agentExternalId]?.prompt ?? '';
}

/** How many managed blocks a prompt carries, edited or not. */
function blockCount(prompt: string): number {
  return prompt.split(NOTE_BLOCK_START).length - 1;
}

/** The header the design fixes, verbatim; the block is graded on it. */
const NOTE_HEADER = '# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)';

/**
 * The note block sits at the TOP of the agent's prompt, between its markers,
 * with the header verbatim and the one variable under it. Where it sits is a
 * design constant the simulator measured (0/3 at the end, 2/3 at the top);
 * here it is asserted as written.
 */
function expectNoteBlockAtTop(ctx: Ctx, prompt: string, label: string): void {
  if (!prompt.startsWith(NOTE_PROMPT_BLOCK)) {
    ctx.violations.push(`${label}: the note block is not at the top of the prompt: ${JSON.stringify(prompt)}`);
  }
  if (!prompt.includes(NOTE_HEADER)) {
    ctx.violations.push(`${label}: the note header is not verbatim in the prompt`);
  }
  if (!prompt.includes(`{{${NOTE_VARIABLE}}}`)) {
    ctx.violations.push(`${label}: the block does not interpolate ${NOTE_VARIABLE}`);
  }
}

/**
 * Waits for the goal re-arm, then asserts it as state: the wait landed on the
 * campaign's cooldown, the counter moved, no promise was invented, and the row
 * says a follow-up is what it is waiting for.
 *
 * `cooldownMinutes` is the campaign's own — `seedCampaign` defaults it to one
 * — and the band around it is the real clock's slack plus one sweep interval.
 * An engine reaching for a follow-up delay of its own, or for the fixed resume
 * gap, has to fail here.
 */
async function expectFollowUpArmed(
  ctx: Ctx,
  contactId: string,
  followUpCount: number,
  cooldownMinutes = 1,
): Promise<void> {
  const row = await pollUntil(
    async () => {
      const r = await contactRow(ctx, contactId);
      return r.status === 'PENDING' && r.followUpCount === followUpCount ? r : null;
    },
    120_000,
    `follow-up ${followUpCount} armed for ${contactId}`,
    500,
  );

  const inMs = (row.nextEligibleAt?.getTime() ?? 0) - Date.now();
  const expectedMs = cooldownMinutes * 60_000;
  if (inMs < expectedMs - 30_000 || inMs > expectedMs + 30_000) {
    ctx.violations.push(
      `follow-up ${followUpCount} armed ${(inMs / 60_000).toFixed(1)}m out, ` +
        `expected ≈ ${cooldownMinutes}m (cooldownMinutes=${cooldownMinutes})`,
    );
  }
  if (row.callbackAt !== null) {
    ctx.violations.push(`follow-up re-arm invented a callback promise (${row.callbackAt.toISOString()})`);
  }
  /**
   * And the arming says which re-arm this was. `callbackAt === null` used to
   * be the whole of that question — a null there meant "not a callback, so a
   * follow-up" — but an `immediate` resume also leaves it null, so on its own
   * the check above would now pass for a row armed RESUME on the fixed
   * three-minute gap rather than FOLLOW_UP on the cooldown. Every caller here
   * scripts a
   * `flexible` note or none at all, so FOLLOW_UP is the only right answer.
   */
  if (row.armKind !== 'FOLLOW_UP') {
    ctx.violations.push(
      `follow-up ${followUpCount} is armed ${row.armKind}, expected FOLLOW_UP`,
    );
  }
}

/** The cooldown later, as row state: the armed wait is moved to now and the
 *  real engine takes it from there. Guarded on PENDING so a race writes
 *  nothing. */
async function elapseFollowUpDelay(ctx: Ctx, contactIds: string[]): Promise<void> {
  await ctx.prisma.campaignContact.updateMany({
    where: { id: { in: contactIds }, status: 'PENDING' },
    data: { nextEligibleAt: new Date(Date.now() - 1000) },
  });
}

async function expectSettled(
  ctx: Ctx,
  contactId: string,
  expect: { status: string; goalAchieved: boolean | null },
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const row = await pollUntil(
    async () => {
      const r = await contactRow(ctx, contactId);
      return r.status !== 'PENDING' && r.status !== 'QUEUED' && r.status !== 'CALLING' ? r : null;
    },
    timeoutMs,
    `${label} settled`,
    500,
  );
  if (row.status !== expect.status || row.goalAchieved !== expect.goalAchieved) {
    ctx.violations.push(
      `${label}: ended ${row.status}/goalAchieved=${row.goalAchieved}, ` +
        `expected ${expect.status}/${expect.goalAchieved}`,
    );
  }
}

async function expectKinds(ctx: Ctx, contactId: string, kinds: string, label: string): Promise<void> {
  const attempts = await ctx.prisma.callAttempt.findMany({
    where: { campaignContactId: contactId },
    orderBy: { attemptNo: 'asc' },
    select: { kind: true },
  });
  const got = attempts.map((a) => a.kind).join(',');
  if (got !== kinds) ctx.violations.push(`${label}: attempt kinds ${got}, expected ${kinds}`);
}

/** The outcome and callback type each recorded attempt left on the context
 *  record, in order, as `outcome/callbackType` (a silence reads `null/null`). */
async function recordedOutcomes(ctx: Ctx, contactId: string): Promise<string[]> {
  const record = await ctx.prisma.campaignContactGoal.findUnique({
    where: { campaignContactId: contactId },
  });
  const log = (record?.attemptLog ?? []) as Array<{ outcome?: string | null; callbackType?: string | null }>;
  return log.map((e) => `${e.outcome ?? null}/${e.callbackType ?? null}`);
}


/* ------------------------------------------------------------------ *
 * Scenario 4 — achieved on the first call, and convergence over three
 * ------------------------------------------------------------------ */

/**
 * Two campaigns, and the two ends of the same decision.
 *
 * The first is the shape the whole wave exists for: a person answers
 * everything on call one, the bot says `completed`, and that is the end of
 * it. The platform sends the terminal `call.status.updated` with the
 * disposition seconds before it sends the `session.completed` that carries
 * the note, so an engine deciding on the first classified event it sees would
 * judge this call with no note at all and schedule a follow-up nobody needs.
 * Here that shows up as a contact that never settles.
 *
 * The second is the same machinery over three conversations, with a note
 * written on each one — and every dial asserted to have carried exactly the
 * PREVIOUS call's note and nothing else from YE, which is the other half of
 * the same ordering property.
 */
const PRIYA_NOTES = [
  'Priya had to run. Open with: "Hi Priya, you mentioned a flat earlier — is now a good time?" Then ask the size and budget.',
  'Priya wants a 2BHK, checking the budget with her husband. Open with: "Hi Priya, did you get a chance to talk it over?" Then ask the budget.',
  'Priya: 2BHK, budget 50L. Nothing left to ask.',
] as const;

async function scenarioGoalAchieved(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const firstCall = await seedCampaign(ctx.prisma, alpha, {
      name: 'first-call',
      concurrencyLimit: 4,
      retryCount: 1,
      contacts: 2,
      block: 41,
    });
    const converge = await seedCampaign(ctx.prisma, alpha, {
      name: 'converge',
      concurrencyLimit: 4,
      retryCount: 1,
      contacts: 2,
      block: 47,
    });

    await simScript({
      numbers: [
        ...firstCall.phones.map((phone) => ({
          to_number: phone,
          rules: [goalDone('Vikram: budget 80L, moving in March. Nothing left to ask.')],
        })),
        ...converge.phones.map((phone) => ({
          to_number: phone,
          rules: [
            callAgain(PRIYA_NOTES[0], 'she had to run'),
            callAgain(PRIYA_NOTES[1], 'she wanted to ask her husband'),
            goalDone(PRIYA_NOTES[2]),
          ],
        })),
      ],
    });

    await startCampaign(servers.ports[0]!, firstCall);
    await startCampaign(servers.ports[0]!, converge);

    // Achieved on the first call: settled, achieved, and never followed up.
    const firstIds = await linkIds(ctx, firstCall);
    for (const phone of firstCall.phones) {
      const id = firstIds.get(phone)!;
      await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'first-call contact');
      const row = await contactRow(ctx, id);
      if (row.followUpCount !== 0 || row.nextEligibleAt !== null) {
        ctx.violations.push(
          `first-call contact was followed up anyway: followUpCount=${row.followUpCount} ` +
            `next=${row.nextEligibleAt?.toISOString()}`,
        );
      }
      await expectKinds(ctx, id, 'fresh', 'first-call contact');
      const vars = await dialVariables(phone);
      if (vars.length !== 1) ctx.violations.push(`${phone} dialed ${vars.length} times, expected 1`);
      expectBareDial(ctx, vars[0], 'the first-call dial');
    }

    // Convergence: two follow-up hops, state-asserted then elapsed.
    const convergeLinks = await linkIds(ctx, converge);
    const ids = converge.phones.map((p) => convergeLinks.get(p)!);
    for (const hop of [1, 2]) {
      for (const id of ids) await expectFollowUpArmed(ctx, id, hop);
      await elapseFollowUpDelay(ctx, ids);
    }
    for (const id of ids) {
      await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'converge contact');
      await expectKinds(ctx, id, 'fresh,follow_up,follow_up', 'converge contact');

      const record = await ctx.prisma.campaignContactGoal.findUnique({
        where: { campaignContactId: id },
      });
      if (record?.memory !== PRIYA_NOTES[2]) {
        ctx.violations.push(`context memory is ${JSON.stringify(record?.memory)}, expected the third call's note`);
      }
      if (record?.lastCallNote !== 'spoke, completed: they told me everything') {
        ctx.violations.push(`the record's last-call line is ${JSON.stringify(record?.lastCallNote)}`);
      }
      const outcomes = await recordedOutcomes(ctx, id);
      if (outcomes.join(',') !== 'incomplete/flexible,incomplete/flexible,completed/null') {
        ctx.violations.push(
          `recorded outcomes ${outcomes.join(',')}, expected incomplete/flexible,incomplete/flexible,completed/null`,
        );
      }
    }

    /**
     * The overlay the platform actually saw, per dial, evolving.
     *
     * The first dial carries the contact's own variables and the standing
     * campaign context and nothing else from YE; each later dial adds
     * exactly `next_call_instructions_vocobaseplatform` = the PREVIOUS
     * call's note. A decision taken on the status event —
     * before the completion delivered the note — would leave every dial one
     * conversation behind, and the third dial would still carry the first
     * call's note.
     */
    for (const phone of converge.phones) {
      const vars = await dialVariables(phone);
      if (vars.length !== 3) {
        ctx.violations.push(`${phone} dialed ${vars.length} times, expected 3`);
        continue;
      }
      expectBareDial(ctx, vars[0], `${phone} dial 1`);
      expectNoteDial(ctx, vars[0], vars[1], PRIYA_NOTES[0], `${phone} dial 2`);
      expectNoteDial(ctx, vars[0], vars[2], PRIYA_NOTES[1], `${phone} dial 3`);
    }
    ctx.metrics.contacts = firstCall.phones.length + ids.length;

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [firstCall.id, converge.id]);
    await checkAllTerminal(ctx, [firstCall.id, converge.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 5 — budget exhaustion, in both lanes
 * ------------------------------------------------------------------ */

/**
 * Two lane budgets since 2026-09-09, spent by two different contacts.
 * `maxGoalFollowUps` bounds a contact somebody ANSWERED; `retryCount` bounds a
 * number nobody has. The first answer forfeits whatever retries were left, and
 * the absolute ceiling `retryCount + maxGoalFollowUps + 1` bounds both.
 *
 * Two campaigns, because each budget has to bind on its own: `fu-budget`
 * spends the FOLLOW-UP budget on conversations that keep coming back
 * incomplete, `dial-cap` spends the RETRY budget on silences. Neither may
 * exceed its own, and the first must settle COMPLETED rather than FAILED —
 * they did talk to us.
 */

async function scenarioGoalBudgets(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    // The FOLLOW-UP budget: one conversation and one more call. The five
    // retries beside it are unspendable — this contact answers its first dial,
    // which forfeits them — so a third call here would be an engine still
    // paying follow-ups out of the retry budget.
    const followUps = await seedCampaign(ctx.prisma, alpha, {
      name: 'fu-budget',
      concurrencyLimit: 2,
      retryCount: 5,
      maxGoalFollowUps: 1,
      contacts: 1,
      block: 42,
    });
    // The RETRY budget, spent on silences instead: `retryCount: 1` is two
    // dials, and the third scripted busy must never be placed. No follow-ups,
    // so nothing can extend it.
    const dialCap = await seedCampaign(ctx.prisma, alpha, {
      name: 'dial-cap',
      concurrencyLimit: 2,
      retryCount: 1,
      maxGoalFollowUps: 0,
      cooldownMinutes: 1,
      contacts: 1,
      block: 43,
    });
    await simScript({
      numbers: [
        {
          to_number: followUps.phones[0]!,
          rules: [
            callAgain('Rohit is buying in west Pune; ask the budget.', 'he was driving'),
            callAgain('Rohit is buying in west Pune; ask the budget.', 'still deciding'),
          ],
        },
        { to_number: dialCap.phones[0]!, rules: [goalBusy, goalBusy, goalBusy] },
      ],
    });

    await startCampaign(servers.ports[0]!, followUps);
    await startCampaign(servers.ports[0]!, dialCap);

    // Spent on conversations: one follow-up hop, then the bot asks for another
    // call the budget cannot buy — settled COMPLETED with the goal unachieved,
    // never FAILED, because they did talk to us.
    const fuId = (await linkIds(ctx, followUps)).get(followUps.phones[0]!)!;
    await expectFollowUpArmed(ctx, fuId, 1);
    await elapseFollowUpDelay(ctx, [fuId]);
    await expectSettled(ctx, fuId, { status: 'COMPLETED', goalAchieved: false }, 'fu-budget contact');
    const fuDials = await ctx.prisma.callAttempt.count({ where: { campaignContactId: fuId } });
    if (fuDials !== 2) {
      ctx.violations.push(
        `fu-budget contact has ${fuDials} attempts, the follow-up budget allows 2`,
      );
    }

    // Spent on silences: the second busy is the last allowed dial, and the
    // third scripted one must never be placed. The retry wait is a real 60s
    // cooldown.
    const capId = (await linkIds(ctx, dialCap)).get(dialCap.phones[0]!)!;
    await expectSettled(ctx, capId, { status: 'FAILED', goalAchieved: null }, 'dial-cap contact');
    const dials = await ctx.prisma.callAttempt.count({ where: { campaignContactId: capId } });
    if (dials !== 2) {
      ctx.violations.push(`dial-cap contact has ${dials} attempts, the retry budget allows 2`);
    }

    const counters = await ctx.prisma.campaign.findUniqueOrThrow({
      where: { id: followUps.id },
      select: { completedCount: true, failedCount: true },
    });
    if (counters.completedCount !== 1 || counters.failedCount !== 0) {
      ctx.violations.push(
        `fu-budget counters ${counters.completedCount}/${counters.failedCount}, expected 1/0`,
      );
    }

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [followUps.id, dialCap.id]);
    await checkAllTerminal(ctx, [followUps.id, dialCap.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 6 — "not interested", heard the first time
 * ------------------------------------------------------------------ */

/**
 * `call_outcome = stop` on a first call: settled at once, listed for THIS
 * campaign, and a second campaign in the same workspace still dials the
 * number. The list moved off the workspace deliberately — a person who told
 * one campaign to stop has told that campaign, not the company.
 */
async function scenarioGoalOptOut(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const phones = makePhones(2, 44);
    const journey = await seedCampaign(ctx.prisma, alpha, {
      name: 'journey',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 1,
      block: 44,
      phones: [phones[0]!],
    });
    const second = await seedCampaign(ctx.prisma, alpha, {
      name: 'second',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 2,
      block: 44,
      phones,
    });
    await simScript({
      numbers: [
        {
          to_number: phones[0]!,
          rules: [
            goalStop('Do not call again.', 'not interested, asked not to be called again'),
            // The second campaign's own call to the same person, which happens
            // precisely because the list is per campaign.
            goalDone('Looking in Kothrud. Nothing left to ask.', 'answered the other campaign'),
          ],
        },
        { to_number: phones[1]!, rules: [goalDone('Looking in Wakad. Nothing left to ask.', 'she told me')] },
      ],
    });

    await startCampaign(servers.ports[0]!, journey);
    const journeyId = (await linkIds(ctx, journey)).get(phones[0]!)!;
    await expectSettled(ctx, journeyId, { status: 'COMPLETED', goalAchieved: false }, 'opt-out contact');
    await expectKinds(ctx, journeyId, 'fresh', 'opt-out contact');

    const optOutRow = await contactRow(ctx, journeyId);
    if (optOutRow.followUpCount !== 0 || optOutRow.nextEligibleAt !== null) {
      ctx.violations.push(
        `the opt-out contact is still armed: followUpCount=${optOutRow.followUpCount} ` +
          `next=${optOutRow.nextEligibleAt?.toISOString()}`,
      );
    }

    const listed = await ctx.prisma.doNotCall.findUnique({
      where: { campaignId_phone: { campaignId: journey.id, phone: phones[0]! } },
    });
    if (!listed) ctx.violations.push('no DoNotCall row was written for the opt-out');
    else if (listed.sourceCampaignContactId !== journeyId) {
      ctx.violations.push(`DoNotCall source is ${listed.sourceCampaignContactId}, expected the journey contact`);
    } else if ((listed.reason ?? '') === '') {
      ctx.violations.push('the DoNotCall row carries no reason');
    }
    const elsewhere = await ctx.prisma.doNotCall.count({ where: { campaignId: { not: journey.id } } });
    if (elsewhere !== 0) {
      ctx.violations.push(`${elsewhere} do-not-call rows were written outside the campaign that heard the stop`);
    }

    // The second campaign, started after the list exists, still dials that
    // number — and settles it on its own goal.
    await startCampaign(servers.ports[0]!, second);
    const secondLinks = await linkIds(ctx, second);
    await expectSettled(ctx, secondLinks.get(phones[1]!)!, { status: 'COMPLETED', goalAchieved: true }, 'clean contact');
    await expectSettled(ctx, secondLinks.get(phones[0]!)!, { status: 'COMPLETED', goalAchieved: true }, 'listed contact, second campaign');

    const sim = await simState();
    const dialsToListed = sim.dialLog.filter((e) => e.toNumber === phones[0]).length;
    if (dialsToListed !== 2) {
      ctx.violations.push(
        `the listed number was dialed ${dialsToListed} times platform-wide, expected 2 (one per campaign)`,
      );
    }
    const denominator = await ctx.prisma.campaign.findUniqueOrThrow({
      where: { id: second.id },
      select: { totalContacts: true, skippedCount: true },
    });
    if (denominator.totalContacts !== 2 || denominator.skippedCount !== 0) {
      ctx.violations.push(
        `second campaign totalContacts=${denominator.totalContacts} skipped=${denominator.skippedCount}, ` +
          'expected 2 and 0 — a per-campaign list must exclude nobody here',
      );
    }

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [journey.id, second.id]);
    await checkAllTerminal(ctx, [journey.id, second.id]);
  } finally {
    servers.kill();
  }
}


/* ------------------------------------------------------------------ *
 * Scenario 7 — "call me next week"
 * ------------------------------------------------------------------ */

/**
 * `callback_type = requested` with a time attached, in the platform's own
 * `YYYY-MM-DDTHH:mm±HH` form. The note re-arms the contact exactly as
 * `flexible` would, at the campaign's own delay; the callback booking that
 * runs after the resolution then moves it to the time the person actually
 * asked for. An explicit promise beats our own guess.
 */
async function scenarioGoalCallback(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const campaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'interleave',
      concurrencyLimit: 2,
      retryCount: 1,
      callbackEnabled: true,
      contacts: 1,
      block: 45,
    });

    // The one real wait in these scenarios. Three minutes, floored to the
    // minute because the platform's time form carries no seconds — so the
    // lead is between two and three minutes, never less: the promise is
    // scripted BEFORE the campaign starts, and boot, the first sweep and the
    // call itself eat wall time before the booking judges the 60s minimum
    // lead — a tighter promise landed `too_soon` on a slow run and read as an
    // engine failure that wasn't one.
    const promiseAt = new Date(Math.floor((Date.now() + 180_000) / 60_000) * 60_000);
    const MEERA_NOTE = 'Meera, budget 50L, asked for a call back shortly. Open with: "Hi Meera, you asked me to call back now — is it a good time?" Then ask when she wants to move.';
    await simScript({
      numbers: [
        {
          to_number: campaign.phones[0]!,
          rules: [
            conversation({
              call_outcome_vocobaseplatform: 'incomplete',
              call_outcome_reason_vocobaseplatform: 'she asked to be called shortly',
              immediate_callback_needed_vocobaseplatform: 'no',
              callback_requested_time_vocobaseplatform: offsetForm(promiseAt.getTime(), 5),
              next_call_instructions_vocobaseplatform: MEERA_NOTE,
            }),
            goalDone('Meera: budget 50L, moving in March. Nothing left to ask.', 'she told me the rest'),
          ],
        },
      ],
    });

    await startCampaign(servers.ports[0]!, campaign);
    const id = (await linkIds(ctx, campaign)).get(campaign.phones[0]!)!;

    // The note said call back, and said when: the promise must be armed —
    // beating the one-hour follow-up delay — with the pair equal.
    const armed = await pollUntil(
      async () => {
        const r = await contactRow(ctx, id);
        return r.status === 'PENDING' && r.callbackAt !== null ? r : null;
      },
      120_000,
      'the promise armed',
      500,
    );
    if (armed.nextEligibleAt?.getTime() !== armed.callbackAt?.getTime()) {
      ctx.violations.push(
        `promise not armed as the pair: next=${armed.nextEligibleAt?.toISOString()} cb=${armed.callbackAt?.toISOString()}`,
      );
    }
    const promisedDrift = Math.abs((armed.callbackAt?.getTime() ?? 0) - promiseAt.getTime());
    if (promisedDrift > 60_000) {
      ctx.violations.push(
        `armed at ${armed.callbackAt?.toISOString()}, promised ${promiseAt.toISOString()} — the follow-up delay won over the promise`,
      );
    }
    if (armed.followUpCount !== 1) {
      ctx.violations.push(
        `followUpCount=${armed.followUpCount} after a requested callback, expected 1 — the re-arm is a follow-up the booking then moved`,
      );
    }
    /**
     * The booking rewrites the arming, not only the two timestamps. This row
     * arrived here as a follow-up and the promise turned it into a callback;
     * a booking that moved the clock and left the arming behind would leave a
     * row the callback lane never claims, and the failure would surface three
     * minutes later as a kind that reads `follow_up` rather than here.
     */
    if (armed.armKind !== 'CALLBACK') {
      ctx.violations.push(
        `the promise is armed ${armed.armKind}, expected CALLBACK — a time the person named`,
      );
    }

    // The callback rides its own lane at the promised time, and that
    // conversation completes the goal.
    // The wait spans the whole three-minute promise, so it gets its own budget.
    await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'interleave contact', 240_000);
    await expectKinds(ctx, id, 'fresh,callback', 'interleave contact');

    const settled = await contactRow(ctx, id);
    const keptAt = settled.lastAttemptAt?.getTime() ?? 0;
    if (keptAt < promiseAt.getTime() - 15_000) {
      ctx.violations.push(`the callback dialed at ${settled.lastAttemptAt?.toISOString()}, before the promise`);
    }
    ctx.metrics.promiseKeptAfter = `${((keptAt - promiseAt.getTime()) / 1000).toFixed(0)}s`;

    // And the callback knew what the first conversation learned: the note,
    // and nothing else from YE. YE's own line records the promise.
    const vars = await dialVariables(campaign.phones[0]!);
    expectBareDial(ctx, vars[0], 'the first dial');
    expectNoteDial(ctx, vars[0], vars[1], MEERA_NOTE, 'the callback dial');
    const log = await ctx.prisma.campaignContactGoal.findUnique({ where: { campaignContactId: id } });
    const first = ((log?.attemptLog ?? []) as Array<{ callbackType?: string | null; callbackRequestedTime?: string | null }>)[0];
    if (first?.callbackType !== 'requested' || first?.callbackRequestedTime !== offsetForm(promiseAt.getTime(), 5)) {
      ctx.violations.push(`the first attempt's log entry is ${JSON.stringify(first)}, expected requested with the raw ±HH time`);
    }

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [campaign.id]);
    await checkAllTerminal(ctx, [campaign.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 8 — a voicemail between two conversations
 * ------------------------------------------------------------------ */

/**
 * A silence in the middle of a goal journey, and what survives it.
 *
 * The voicemail never reaches the goal decision table: it is a silence, so it
 * arms the retry ladder on today's rules and carries no note to read. What
 * it must NOT do is lose what the first conversation taught us — the bot's
 * note is untouched by a call nobody answered, and the next dial still
 * carries it — while YE's own line for the last call has to move, because
 * the next call did in fact reach an answering machine.
 *
 * The retry cooldown here is a real minute; it is the shortest this engine
 * allows and it is the one wait worth spending in this scenario.
 */
const NIKHIL_NOTE = 'Nikhil wants a 2BHK in Baner, was on the road. Open with: "Hi Nikhil, is this a better time?" Then ask the budget.';

async function scenarioGoalVoicemail(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const campaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'voicemail',
      concurrencyLimit: 2,
      retryCount: 2,
      cooldownMinutes: 1,
      contacts: 1,
      block: 48,
    });
    await simScript({
      numbers: [
        {
          to_number: campaign.phones[0]!,
          rules: [
            callAgain(NIKHIL_NOTE, 'he was on the road'),
            voicemail,
            goalDone('Nikhil: 2BHK in Baner, budget 90L. Nothing left to ask.', 'he gave me the budget'),
          ],
        },
      ],
    });

    await startCampaign(servers.ports[0]!, campaign);
    const id = (await linkIds(ctx, campaign)).get(campaign.phones[0]!)!;

    // Call one asked for another call; the follow-up is armed and elapsed.
    await expectFollowUpArmed(ctx, id, 1);
    await elapseFollowUpDelay(ctx, [id]);

    // Call two reaches the machine. That is a retry, on the retry counter —
    // never a second follow-up, because no note was ever read for it.
    const retried = await pollUntil(
      async () => {
        const r = await contactRow(ctx, id);
        return r.status === 'PENDING' && r.attempts === 1 ? r : null;
      },
      120_000,
      'the retry armed after the voicemail',
      500,
    );
    if (retried.followUpCount !== 1) {
      ctx.violations.push(
        `the voicemail moved followUpCount to ${retried.followUpCount}; a silence has no note to spend one on`,
      );
    }
    // YE's own line moved to the voicemail; the bot's note did not.
    const afterVoicemail = await ctx.prisma.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: id },
    });
    if (afterVoicemail.lastCallNote !== 'reached voicemail') {
      ctx.violations.push(`after the voicemail the last-call line is ${JSON.stringify(afterVoicemail.lastCallNote)}`);
    }
    if (afterVoicemail.memory !== NIKHIL_NOTE) {
      ctx.violations.push(`the voicemail changed the note: ${JSON.stringify(afterVoicemail.memory)}`);
    }

    // Call three: the retry runs on its real cooldown and finishes the goal.
    await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'voicemail contact', 180_000);
    /**
     * `retry` for the third dial, and the blur that used to make it
     * `follow_up` is what `armKind` was added to remove.
     *
     * The claim stamps the kind from the arming it froze, and the second
     * call's silence was re-armed by the retry ladder — so the third dial is a
     * retry, whatever the lifetime `followUpCount` this contact happens to
     * carry from the conversation before it. Derived from `followUpCount > 0`
     * instead, every dial after a single follow-up read as another follow-up
     * for ever, which is exactly the reading `ContactArmKind` documents as the
     * reason it exists. The counters still say the same thing they always
     * did, and they are asserted above: the retry counter moved, the follow-up
     * counter did not.
     */
    await expectKinds(ctx, id, 'fresh,follow_up,retry', 'voicemail contact');

    const record = await ctx.prisma.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: id },
    });
    if (record.memory !== 'Nikhil: 2BHK in Baner, budget 90L. Nothing left to ask.') {
      ctx.violations.push(`context memory is ${JSON.stringify(record.memory)} after the journey`);
    }
    const outcomes = await recordedOutcomes(ctx, id);
    if (outcomes.join(',') !== 'incomplete/flexible,null/null,completed/null') {
      ctx.violations.push(
        `recorded outcomes [${outcomes.join('|')}], expected incomplete/flexible, then nothing for the voicemail, then completed/null`,
      );
    }

    /**
     * The dial the whole scenario is for: the third call still carries the
     * first conversation's note — the voicemail wrote none, and a silence
     * must not blank what the person actually said.
     */
    const vars = await dialVariables(campaign.phones[0]!);
    if (vars.length !== 3) {
      ctx.violations.push(`the contact was dialed ${vars.length} times, expected 3`);
    } else {
      expectBareDial(ctx, vars[0], 'the first dial');
      expectNoteDial(ctx, vars[0], vars[1], NIKHIL_NOTE, 'the second dial');
      expectNoteDial(ctx, vars[0], vars[2], NIKHIL_NOTE, 'the third dial (after the voicemail)');
    }

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [campaign.id]);
    await checkAllTerminal(ctx, [campaign.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 9 — no note at all
 * ------------------------------------------------------------------ */

/**
 * A conversation whose extraction never came back. Null everywhere is "no
 * outcome", and the engine's answer to that is one more call at the
 * campaign's own delay — never a guess about the person, in either direction.
 */
async function scenarioGoalNullVerdict(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const campaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'no-note',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 1,
      block: 49,
    });
    await simScript({
      numbers: [
        {
          to_number: campaign.phones[0]!,
          rules: [noNote(), goalDone('Looking in Hinjewadi. Nothing left to ask.', 'she told me on the second call')],
        },
      ],
    });

    await startCampaign(servers.ports[0]!, campaign);
    const id = (await linkIds(ctx, campaign)).get(campaign.phones[0]!)!;

    await expectFollowUpArmed(ctx, id, 1);

    const armed = await contactRow(ctx, id);
    if (armed.goalAchieved !== null) {
      ctx.violations.push(
        `a missing outcome was judged goalAchieved=${armed.goalAchieved}; it must stay unjudged`,
      );
    }
    const record = await ctx.prisma.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: id },
    });
    if (record.memory !== null) {
      ctx.violations.push(`a missing note invented context: memory=${JSON.stringify(record.memory)}`);
    }
    if (record.lastCallNote !== 'spoke, but no outcome was recorded') {
      ctx.violations.push(`the no-note line is ${JSON.stringify(record.lastCallNote)}`);
    }

    await elapseFollowUpDelay(ctx, [id]);
    await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'no-note contact');
    await expectKinds(ctx, id, 'fresh,follow_up', 'no-note contact');

    // No note was written, so the second dial carries nothing from YE either
    // — the header renders empty, exactly as on a first call.
    const vars = await dialVariables(campaign.phones[0]!);
    expectBareDial(ctx, vars[0], 'the first dial');
    expectBareDial(ctx, vars[1], 'the second dial (after a call with no note)');

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [campaign.id]);
    await checkAllTerminal(ctx, [campaign.id]);
  } finally {
    servers.kill();
  }
}


/* ------------------------------------------------------------------ *
 * Scenario 10 — replay idempotency at the armed follow-up
 * ------------------------------------------------------------------ */

async function scenarioGoalReplay(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const campaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'replay',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 1,
      block: 46,
    });
    const firstNote = {
      call_outcome_vocobaseplatform: 'incomplete',
      call_outcome_reason_vocobaseplatform: 'he was in a meeting',
      immediate_callback_needed_vocobaseplatform: 'no',
      callback_requested_time_vocobaseplatform: 'null',
      next_call_instructions_vocobaseplatform:
        'Karan wants a 3BHK, was in a meeting. Open with: "Hi Karan, is this a better time?" Then ask the budget.',
    };
    await simScript({
      numbers: [
        {
          to_number: campaign.phones[0]!,
          rules: [conversation(firstNote), goalDone('Karan: 3BHK, budget 90L. Nothing left to ask.', 'he gave me the budget')],
        },
      ],
    });

    await startCampaign(servers.ports[0]!, campaign);
    const id = (await linkIds(ctx, campaign)).get(campaign.phones[0]!)!;
    await expectFollowUpArmed(ctx, id, 1);

    const record = () =>
      ctx.prisma.campaignContactGoal.findUnique({
        where: { campaignContactId: id },
        select: {
          memory: true,
          memoryAttempt: true,
          lastCallNote: true,
          goalMissing: true,
          attemptLog: true,
        },
      });
    const before = {
      contact: await contactRow(ctx, id),
      record: JSON.stringify(await record()),
      dials: (await simState()).dialLog.length,
      charges: await ctx.prisma.creditTransaction.count({ where: { type: 'CALL_USAGE' } }),
    };

    // The same session.completed, delivered again — signed like the platform
    // signs, through the real HTTP sink and the real worker.
    const attempt = await ctx.prisma.callAttempt.findFirstOrThrow({
      where: { campaignContactId: id, attemptNo: 1 },
      select: { upstreamCallId: true, upstreamSessionId: true },
    });
    // The duration as the original delivery reported it — the mock computes a
    // fractional value from scaled elapsed time on the real clock, and the
    // attempt row stores a rounded copy, so the platform's own record is the
    // only byte-exact source for a true replay.
    const platformCall = (await simState()).calls.find((c) => c.call_id === attempt.upstreamCallId);
    const body = JSON.stringify({
      event: 'session.completed',
      timestamp: new Date().toISOString(),
      data: {
        session_id: attempt.upstreamSessionId,
        duration_seconds: (platformCall?.duration_seconds as number | undefined) ?? 0,
        extraction: { values: firstNote },
        call: {
          call_id: attempt.upstreamCallId,
          status: 'completed',
          disposition: 'completed',
          answered_by: 'human',
          hangup_cause: null,
        },
      },
    });
    const ts = new Date().toISOString();
    const res = await fetch(`http://127.0.0.1:${servers.ports[0]}/webhooks/vocobase`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Webhook-Timestamp': ts,
        'X-Webhook-Signature': 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex'),
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      ctx.violations.push(`the replayed delivery answered ${res.status}`);
    }
    await sleep(4000); // let the worker process it

    const after = {
      contact: await contactRow(ctx, id),
      record: JSON.stringify(await record()),
      dials: (await simState()).dialLog.length,
      charges: await ctx.prisma.creditTransaction.count({ where: { type: 'CALL_USAGE' } }),
    };
    if (after.record !== before.record) {
      ctx.violations.push(`the replay changed the context record: ${after.record} vs ${before.record}`);
    }
    if (
      after.contact.followUpCount !== 1 ||
      after.contact.status !== 'PENDING' ||
      after.contact.nextEligibleAt?.getTime() !== before.contact.nextEligibleAt?.getTime()
    ) {
      ctx.violations.push(
        `the replay moved the schedule: followUpCount=${after.contact.followUpCount} ` +
          `status=${after.contact.status} next=${after.contact.nextEligibleAt?.toISOString()}`,
      );
    }
    if (after.dials !== before.dials) ctx.violations.push('the replay provoked a dial');
    if (after.charges !== before.charges) ctx.violations.push('the replay charged again');

    // And the journey still finishes cleanly afterwards.
    await elapseFollowUpDelay(ctx, [id]);
    await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'replay contact');
    await expectKinds(ctx, id, 'fresh,follow_up', 'replay contact');

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [campaign.id]);
    await checkAllTerminal(ctx, [campaign.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 11 — two goal campaigns on one agent
 * ------------------------------------------------------------------ */

/**
 * The note block YE writes at the top of an agent's prompt is identical for
 * every campaign: the only fact inside it is the one variable. That is what
 * lets one agent serve several goal campaigns at once, and this scenario is
 * the proof of it — one copy of the block, at the top, however many campaigns
 * start on the agent, the second start leaving the prompt byte for byte what
 * the first left (which is what "identical for every campaign" means, and the
 * only form of that claim still worth checking now the campaign holds a switch
 * rather than words something could have interpolated), first dials carrying
 * nothing from YE, and the block given back only when the LAST of them stops.
 *
 * Each campaign keeps one contact parked on a follow-up so that it is still
 * RUNNING when the other is stopped: a release gated on "no other live goal
 * campaign shares this agent" can only be tested while there is another one.
 */
async function scenarioGoalSharedAgent(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const first = await seedCampaign(ctx.prisma, alpha, {
      name: 'shared-a',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 2,
      block: 50,
    });
    const secondCampaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'shared-b',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 2,
      block: 51,
    });

    // One contact each settles; the other parks on a follow-up, which is what
    // keeps its campaign RUNNING for the release check at the end.
    await simScript({
      numbers: [
        { to_number: first.phones[0]!, rules: [goalDone('Ira: budget 60L. Nothing left to ask.')] },
        { to_number: first.phones[1]!, rules: [callAgain('Ira asked for a later call; ask the budget.', 'call me later')] },
        { to_number: secondCampaign.phones[0]!, rules: [goalDone('Sam: moving in June. Nothing left to ask.')] },
        { to_number: secondCampaign.phones[1]!, rules: [callAgain('Sam asked for a later call; ask the date.', 'call me later')] },
      ],
    });

    const prompt0 = await agentPrompt(alpha.agentExternalId);
    if (prompt0 !== '') {
      ctx.violations.push(`the agent's prompt was not empty before any campaign started: ${JSON.stringify(prompt0)}`);
    }

    await startCampaign(servers.ports[0]!, first);
    const afterFirst = await pollUntil(
      async () => {
        const p = await agentPrompt(alpha.agentExternalId);
        return hasIntactGoalBlock(p) ? p : null;
      },
      60_000,
      'the managed block written on the first start',
      500,
    );
    if (blockCount(afterFirst) !== 1) {
      ctx.violations.push(`the agent's prompt carries ${blockCount(afterFirst)} managed blocks after one start`);
    }
    expectNoteBlockAtTop(ctx, afterFirst, 'after the first start');

    await startCampaign(servers.ports[0]!, secondCampaign);
    await sleep(3000); // the second start's prompt write, if it made one
    const afterSecond = await agentPrompt(alpha.agentExternalId);
    if (!hasIntactGoalBlock(afterSecond) || blockCount(afterSecond) !== 1) {
      ctx.violations.push(
        `the agent's prompt carries ${blockCount(afterSecond)} managed blocks after two goal campaigns started ` +
          `(intact: ${hasIntactGoalBlock(afterSecond)})`,
      );
    }
    // Nothing about the second campaign reached the prompt. The agent started
    // this scenario with an empty prompt, so `afterFirst` is the block and
    // nothing else, and any campaign-specific text the second start wrote —
    // its name, its knobs, anything a future release is tempted to interpolate
    // — shows up as a difference. Checking for a goal string instead would
    // grade nothing now: a campaign has none to leak.
    if (afterSecond !== afterFirst) {
      ctx.violations.push(
        'the second goal campaign changed the agent prompt; the managed block is the same text for every campaign, ' +
          `which is what lets one agent serve several: ${JSON.stringify(afterFirst)} became ${JSON.stringify(afterSecond)}`,
      );
    }
    expectNoteBlockAtTop(ctx, afterSecond, 'after the second start');

    // Both campaigns settle their own contact, on their own goal.
    const firstIds = await linkIds(ctx, first);
    const secondIds = await linkIds(ctx, secondCampaign);
    await expectSettled(ctx, firstIds.get(first.phones[0]!)!, { status: 'COMPLETED', goalAchieved: true }, 'shared-a contact');
    await expectSettled(ctx, secondIds.get(secondCampaign.phones[0]!)!, { status: 'COMPLETED', goalAchieved: true }, 'shared-b contact');

    // Neither campaign's first dial carries anything from YE — no note (a
    // first conversation has none) and nothing left over from the retired
    // overlay.
    for (const campaign of [first, secondCampaign]) {
      for (const phone of campaign.phones) {
        const vars = await dialVariables(phone);
        if (vars.length === 0) {
          ctx.violations.push(`${phone} was never dialed`);
          continue;
        }
        expectBareDial(ctx, vars[0], `${campaign.name} ${phone} dial 1`);
      }
    }

    // Both parked contacts are still armed, so both campaigns are still live.
    await expectFollowUpArmed(ctx, firstIds.get(first.phones[1]!)!, 1);
    await expectFollowUpArmed(ctx, secondIds.get(secondCampaign.phones[1]!)!, 1);

    // Stopping one campaign must NOT take the block off an agent the other is
    // still dialling with.
    await apiOk(servers.ports[0]!, 'POST', `/api/workspaces/${first.workspaceId}/campaigns/${first.id}/stop`, {
      as: first.identity,
    });
    const afterOneStop = await agentPrompt(alpha.agentExternalId);
    if (!hasIntactGoalBlock(afterOneStop)) {
      ctx.violations.push('stopping one campaign took the managed block off an agent another campaign is still using');
    }

    // Stopping the last one gives it back.
    await apiOk(
      servers.ports[0]!,
      'POST',
      `/api/workspaces/${secondCampaign.workspaceId}/campaigns/${secondCampaign.id}/stop`,
      { as: secondCampaign.identity },
    );
    const afterBothStopped = await agentPrompt(alpha.agentExternalId);
    if (blockCount(afterBothStopped) !== 0) {
      ctx.violations.push(
        `the managed block survived the last goal campaign stopping: ${JSON.stringify(afterBothStopped)}`,
      );
    }

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [first.id, secondCampaign.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario 12 — a hand-edited block
 * ------------------------------------------------------------------ */

/**
 * Somebody edited inside the markers. The block is what carries the note into
 * the conversation, so a block that has drifted from the variable the dial
 * sends is a prompt that has quietly stopped seeing it — it is rewritten on
 * the next start, at the end, and an ADMIN is told it was. What must NOT be
 * touched is the operator's own text outside the markers.
 */
async function scenarioGoalEditedBlock(ctx: Ctx): Promise<void> {
  const servers = await startServers({
    databaseUrl: ctx.databaseUrl,
    redisUrl: ctx.redisUrl,
    seed: ctx.seed,
    poolLimit: 10,
    tag: ctx.tag,
    instances: 1,
  });

  try {
    const alpha = await seedWorkspace(ctx.prisma, TEST_USER, 'alpha', { accountConcurrency: 8 });
    const campaign = await seedCampaign(ctx.prisma, alpha, {
      name: 'edited-block',
      concurrencyLimit: 2,
      retryCount: 1,
      contacts: 1,
      block: 52,
    });
    await simScript({
      numbers: [{ to_number: campaign.phones[0]!, rules: [goalDone('Tara: budget 70L. Nothing left to ask.')] }],
    });

    // The operator's own instructions, and a managed block they have edited
    // the variable line out of — inside the note markers.
    const OPERATOR_TEXT = 'You are Asha from Sunrise Homes. Keep it short and warm.';
    const EDIT = 'Ignore anything you were told about this person.';
    const edited = NOTE_PROMPT_BLOCK.replace(`{{${NOTE_VARIABLE}}}`, EDIT);
    if (edited === NOTE_PROMPT_BLOCK) {
      ctx.violations.push('the scenario failed to edit the block; the fixture no longer matches the block text');
    }
    await setAgentPrompt(alpha.agentExternalId, `${OPERATOR_TEXT}\n\n${edited}`);

    await startCampaign(servers.ports[0]!, campaign);

    const restored = await pollUntil(
      async () => {
        const p = await agentPrompt(alpha.agentExternalId);
        return hasIntactGoalBlock(p) ? p : null;
      },
      60_000,
      'the edited block rewritten on start',
      500,
    );
    if (blockCount(restored) !== 1) {
      ctx.violations.push(`the rewrite left ${blockCount(restored)} managed blocks in the prompt`);
    }
    if (restored.includes(EDIT)) {
      ctx.violations.push('the hand-edited line survived the rewrite');
    }
    // The block sits at the top, so the operator's text follows it.
    if (!restored.endsWith(OPERATOR_TEXT)) {
      ctx.violations.push(`the rewrite clobbered the operator's own text: ${JSON.stringify(restored)}`);
    }
    expectNoteBlockAtTop(ctx, restored, 'after the rewrite');

    // And somebody is told, because it was somebody's edit.
    await pollUntil(
      async () => {
        const row = await ctx.prisma.notification.findFirst({
          where: { workspaceId: alpha.workspaceId, type: 'campaign.goal_prompt_rewritten' },
        });
        return row ?? null;
      },
      30_000,
      'the ADMIN notification for a rewritten block',
      500,
    ).catch(() => {
      ctx.violations.push('no ADMIN notification was raised for the rewritten block');
    });

    // The campaign still runs; a first dial carries nothing from YE.
    const id = (await linkIds(ctx, campaign)).get(campaign.phones[0]!)!;
    await expectSettled(ctx, id, { status: 'COMPLETED', goalAchieved: true }, 'edited-block contact');
    const vars = await dialVariables(campaign.phones[0]!);
    if (vars.length !== 1) ctx.violations.push(`the edited-block contact was dialed ${vars.length} times, expected 1`);
    expectBareDial(ctx, vars[0], 'the dial after the rewrite');

    await checkMockInvariants(ctx);
    await checkNoDoubleDials(ctx, [campaign.id]);
    await checkAllTerminal(ctx, [campaign.id]);
  } finally {
    servers.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

const SCENARIOS = [
  { n: 1, name: 'multi-campaign concurrency', runs: 3, fn: scenarioConcurrency },
  { n: 2, name: 'two instances, one Redis', runs: 5, fn: scenarioMultiInstance },
  { n: 3, name: 'queue-failure semantics', runs: 3, fn: scenarioQueueFailures },
  // The eight goal cases the design names, three runs each.
  { n: 4, name: 'goal achieved on the first call', runs: 3, fn: scenarioGoalAchieved },
  { n: 5, name: 'goal budget exhaustion', runs: 3, fn: scenarioGoalBudgets },
  { n: 6, name: 'goal not interested', runs: 3, fn: scenarioGoalOptOut },
  { n: 7, name: 'goal call me next week', runs: 3, fn: scenarioGoalCallback },
  { n: 8, name: 'goal voicemail between conversations', runs: 3, fn: scenarioGoalVoicemail },
  { n: 9, name: 'goal null note', runs: 3, fn: scenarioGoalNullVerdict },
  { n: 10, name: 'goal replay idempotency', runs: 3, fn: scenarioGoalReplay },
  { n: 11, name: 'two goal campaigns on one agent', runs: 3, fn: scenarioGoalSharedAgent },
  { n: 12, name: 'goal hand-edited note block', runs: 3, fn: scenarioGoalEditedBlock },
] as const;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg('scenario') ? Number(arg('scenario')) : null;
  const runsOverride = arg('runs') ? Number(arg('runs')) : null;
  const baseSeed = arg('seed') ? Number(arg('seed')) : 2000;
  const redisDb = arg('redis-db') ? Number(arg('redis-db')) : 11;

  const databaseUrl = resolveDatabaseUrl();
  const redisUrl = resolveRedisUrl(redisDb);
  console.log(`battle: db ${databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}  redis db ${redisDb}`);

  preflight([MOCK_PORT, ...BACKEND_PORTS]);

  const prisma = makePrisma(databaseUrl);
  const report = new Report();
  const chosen = SCENARIOS.filter((s) => only === null || s.n === only);

  for (const scenario of chosen) {
    const runs = runsOverride ?? scenario.runs;

    for (let run = 1; run <= runs; run += 1) {
      const seed = baseSeed + scenario.n * 100 + run;
      const tag = `s${scenario.n}-run${run}`;
      console.log(`\n>>> [${scenario.name}] run ${run}/${runs} (seed ${seed})`);

      await waitPortsFree([MOCK_PORT, ...BACKEND_PORTS]);
      await truncateAll(prisma);
      await flushRedis(redisUrl);
      resetSeedState();

      const ctx: Ctx = {
        prisma,
        databaseUrl,
        redisUrl,
        seed,
        tag,
        violations: [],
        notes: [],
        metrics: {},
      };
      const startedAt = Date.now();

      try {
        await scenario.fn(ctx);
      } catch (err) {
        ctx.violations.push(`run aborted: ${err instanceof Error ? err.message : String(err)}`);
      }

      await waitPortsFree([MOCK_PORT, ...BACKEND_PORTS]);

      const result: RunResult = {
        scenario: scenario.name,
        run,
        seed,
        wallMs: Date.now() - startedAt,
        violations: ctx.violations,
        notes: ctx.notes,
        metrics: ctx.metrics,
      };
      report.add(result);
    }
  }

  report.write(path.join(__dirname, 'battle-report.md'));
  await prisma.$disconnect();

  const failed = report.results.filter((r) => r.violations.length > 0);
  if (failed.length > 0) {
    console.error(`\n${failed.length} run(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nEvery run passed.');
}

void main();
