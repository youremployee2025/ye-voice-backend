import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The data conversions, run against seeded PRE-migration rows.
 *
 * `migration-parity.test.ts` asserts the post-migration shape — defaults, enum
 * members, uniques, indexes — against the already-migrated test database. It
 * cannot assert the conversions, which run exactly once against whatever a
 * customer's rows held at that instant: `maxAttempts` → `retryCount`, the
 * status-aware `attempts` split, the cooldown clamp, the counter seeding, the
 * rotation backfill, the `attemptNo` renumbering. This file does, the only way
 * that proves anything: a scratch database is migrated up to the eve of the
 * parity migrations, seeded with the old shapes, and then migrated the rest of
 * the way.
 *
 * The scratch database lives on the same server as `TEST_DATABASE_URL` and is
 * dropped afterwards. The two-phase deploy runs the real migration files via
 * `prisma migrate deploy` — not a re-statement of their SQL, which would only
 * test the re-statement.
 */

const PARITY_FIRST = '20260829100000_campaign_parity_enums';
const GOAL_VERDICT = '20260901210442_goal_verdict';
const SCRATCH_DB = 'ye_voice_test_migration_scratch';
const GUARD_DB = 'ye_voice_test_migration_guard';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is not set.');

const dbUrl = (name: string) => {
  const url = new URL(testUrl);
  url.pathname = `/${name}`;
  return url.toString();
};
const scratchUrl = dbUrl(SCRATCH_DB);
const guardUrl = dbUrl(GUARD_DB);

const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(repoRoot, 'prisma', 'migrations');

let admin: PrismaClient;
let scratch: PrismaClient;
let stage: string;

function deploy(schemaDir: string, url = scratchUrl): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', path.join(schemaDir, 'schema.prisma')], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/** Copies the schema plus the named migration folders into the stage dir. */
function stageMigrations(filter: (name: string) => boolean): void {
  rmSync(path.join(stage, 'migrations'), { recursive: true, force: true });
  mkdirSync(path.join(stage, 'migrations'));
  cpSync(path.join(repoRoot, 'prisma', 'schema.prisma'), path.join(stage, 'schema.prisma'));
  cpSync(path.join(migrationsDir, 'migration_lock.toml'), path.join(stage, 'migrations', 'migration_lock.toml'));

  for (const name of readdirSync(migrationsDir)) {
    if (name === 'migration_lock.toml') continue;
    if (filter(name)) {
      cpSync(path.join(migrationsDir, name), path.join(stage, 'migrations', name), { recursive: true });
    }
  }
}

const sql = (parts: TemplateStringsArray, ...args: unknown[]) =>
  scratch.$executeRawUnsafe(String.raw(parts, ...args));

const T = new Date('2026-08-20T10:00:00Z');

beforeAll(async () => {
  admin = new PrismaClient({ datasources: { db: { url: testUrl } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DB}"`);

  stage = mkdtempSync(path.join(tmpdir(), 'ye-migration-stage-'));

  // Phase 1: the world as it was the day before campaign parity.
  stageMigrations((name) => name < PARITY_FIRST);
  deploy(stage);

  scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });

  // The old shapes, exactly as the old dialer wrote them. `attempts` counts
  // DIALS MADE here; `maxAttempts` counts dials allowed.
  await sql`INSERT INTO "Account" (id, "clerkUserId", email) VALUES ('acc1', 'clerk_mig', 'mig@test.local')`;
  await sql`INSERT INTO "Workspace" (id, name, slug, "ownerAccountId") VALUES ('ws1', 'Mig', 'mig', 'acc1')`;
  await sql`INSERT INTO "PhoneNumber" (id, did, "updatedAt") VALUES ('pn1', '+918000000001', NOW())`;

  await sql`INSERT INTO "Campaign" (id, "workspaceId", name, status, "maxAttempts", "retryDelayMins", "updatedAt")
            VALUES ('camp1', 'ws1', 'Waiting', 'RUNNING', 3, 0, NOW())`;
  await sql`INSERT INTO "Campaign" (id, "workspaceId", name, status, "maxAttempts", "retryDelayMins", "phoneNumberId", "updatedAt")
            VALUES ('camp2', 'ws1', 'Clamped', 'RUNNING', 25, 45, 'pn1', NOW())`;

  let n = 0;
  const contact = async (id: string, status: string, attempts: number, lastAttemptAt: Date | null) => {
    n += 1;
    await sql`INSERT INTO "Contact" (id, "workspaceId", phone, "updatedAt")
              VALUES ('p${id}', 'ws1', '+9198000000${String(10 + n)}', NOW())`;
    await sql`INSERT INTO "CampaignContact" (id, "campaignId", "contactId", status, attempts, "lastAttemptAt", "updatedAt")
              VALUES ('${id}', 'camp1', 'p${id}', '${status}', ${attempts},
                      ${lastAttemptAt === null ? 'NULL' : `'${lastAttemptAt.toISOString()}'`}, NOW())`;
  };

  await contact('cc_waiting', 'PENDING', 1, T); // dialed once, waiting for dial 2 of 3
  await contact('cc_failed_within', 'FAILED', 2, T); // failed dial 2, budget for a 3rd
  await contact('cc_exhausted', 'FAILED', 3, T); // spent all three dials
  await contact('cc_done', 'COMPLETED', 1, T);
  await contact('cc_removed', 'EXCLUDED', 0, null); // an operator removed them
  await contact('cc_fresh', 'PENDING', 0, null); // never dialed

  // Two rows numbered 1: the old give-back decremented the dial counter that
  // `attemptNo` was derived from. The unique index must renumber, not refuse.
  await sql`INSERT INTO "CallAttempt" (id, "campaignId", "campaignContactId", "workspaceId", "accountId",
                                       "attemptNo", status, "startedAt", "endedAt", "updatedAt")
            VALUES ('at1', 'camp1', 'cc_waiting', 'ws1', 'acc1', 1, 'FAILED',
                    '${new Date(T.getTime() - 3_600_000).toISOString()}', '${T.toISOString()}', NOW())`;
  await sql`INSERT INTO "CallAttempt" (id, "campaignId", "campaignContactId", "workspaceId", "accountId",
                                       "attemptNo", status, "startedAt", "updatedAt")
            VALUES ('at2', 'camp1', 'cc_waiting', 'ws1', 'acc1', 1, 'QUEUED',
                    '${new Date(T.getTime() - 1_800_000).toISOString()}', NOW())`;

  // Phase 2: the parity migrations and everything after them.
  stageMigrations(() => true);
  deploy(stage);
}, 180_000);

afterAll(async () => {
  await scratch?.$disconnect();
  await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${GUARD_DB}"`);
  await admin?.$disconnect();
  if (stage) rmSync(stage, { recursive: true, force: true });
});

const rows = <T>(q: string) => scratch.$queryRawUnsafe<T[]>(q);

describe('Campaign conversions', () => {
  it('turns a dial budget into a retry budget, clamped to the new range', async () => {
    const campaigns = await rows<{ id: string; retryCount: number; cooldownMinutes: number }>(
      `SELECT id, "retryCount", "cooldownMinutes" FROM "Campaign" ORDER BY id`,
    );

    // Three dials is two retries; 25 clamps into [0,20].
    expect(campaigns).toEqual([
      { id: 'camp1', retryCount: 2, cooldownMinutes: 1 },
      { id: 'camp2', retryCount: 20, cooldownMinutes: 45 },
    ]);
  });

  it('seeds the counters from the rows, with EXCLUDED outside the roster', async () => {
    const [camp1] = await rows<{
      totalContacts: number;
      completedCount: number;
      failedCount: number;
      skippedCount: number;
    }>(
      `SELECT "totalContacts", "completedCount", "failedCount", "skippedCount" FROM "Campaign" WHERE id = 'camp1'`,
    );

    // Six rows seeded, one EXCLUDED. The outcomes partition buckets EXCLUDED
    // nowhere and the runtime decrements totalContacts on every exclude, so a
    // backfill that counted it would leave the four numbers summing short of
    // the roster forever.
    expect(camp1).toEqual({
      totalContacts: 5,
      completedCount: 1,
      failedCount: 1,
      skippedCount: 0,
    });
  });

  it('backfills the rotation with the legacy pointer at position 0', async () => {
    const rotation = await rows<{ campaignId: string; phoneNumberId: string; position: number }>(
      `SELECT "campaignId", "phoneNumberId", position FROM "CampaignPhoneNumber"`,
    );

    expect(rotation).toEqual([{ campaignId: 'camp2', phoneNumberId: 'pn1', position: 0 }]);
  });
});

describe('CampaignContact conversions', () => {
  const contactRows = () =>
    rows<{ id: string; status: string; attempts: number; nextEligibleAt: Date | null }>(
      `SELECT id, status, attempts, "nextEligibleAt" FROM "CampaignContact" ORDER BY id`,
    );

  it('splits attempts between rows that will be dialed again and rows that will not', async () => {
    const contacts = await contactRows();
    const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));

    // Waiting rows keep their count: the re-arm increments at RESOLUTION now,
    // so a contact waiting for retry 1 already carries 1. Settled rows lose
    // the first dial, which was never a retry.
    expect(byId.cc_waiting).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(byId.cc_exhausted).toMatchObject({ status: 'FAILED', attempts: 2 });
    expect(byId.cc_done).toMatchObject({ status: 'COMPLETED', attempts: 0 });
    expect(byId.cc_removed).toMatchObject({ status: 'EXCLUDED', attempts: 0 });
    expect(byId.cc_fresh).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('re-opens a FAILED row that still had dial budget', async () => {
    const contacts = await contactRows();
    const reopened = contacts.find((c) => c.id === 'cc_failed_within');

    // Under the old rule this row would have been re-claimed by the sweep's
    // eligibility formula; under the new rule FAILED means settled, so the
    // budget it still had must travel with it into PENDING.
    expect(reopened).toMatchObject({ status: 'PENDING', attempts: 2 });
  });

  it('stores the eligibility the old formula computed at query time', async () => {
    const contacts = await contactRows();
    const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));

    // lastAttemptAt + the OLD cooldown (0 minutes, pre-clamp): due immediately.
    expect(byId.cc_waiting!.nextEligibleAt?.toISOString()).toBe(T.toISOString());
    // Never dialed and settled rows carry no eligibility.
    expect(byId.cc_fresh!.nextEligibleAt).toBeNull();
    expect(byId.cc_exhausted!.nextEligibleAt).toBeNull();
    // Nothing manufactures an armed pair out of history.
    const armed = await rows<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM "CampaignContact" WHERE "callbackAt" IS NOT NULL`,
    );
    expect(Number(armed[0]!.n)).toBe(0);
  });
});

describe('CallAttempt conversions', () => {
  it('renumbers colliding attempt ordinals in dial order', async () => {
    const attempts = await rows<{ id: string; attemptNo: number; resolvedAt: Date | null }>(
      `SELECT id, "attemptNo", "resolvedAt" FROM "CallAttempt" ORDER BY "attemptNo"`,
    );

    expect(attempts.map((a) => [a.id, a.attemptNo])).toEqual([
      ['at1', 1],
      ['at2', 2],
    ]);
  });

  it('backfills resolvedAt from endedAt for settled rows only', async () => {
    const attempts = await rows<{ id: string; resolvedAt: Date | null }>(
      `SELECT id, "resolvedAt" FROM "CallAttempt" ORDER BY id`,
    );
    const byId = Object.fromEntries(attempts.map((a) => [a.id, a]));

    // Settled when the call ended — the webhook's flight time, not NOW(),
    // which would print a cooldown of months on old history.
    expect(byId.at1!.resolvedAt?.toISOString()).toBe(T.toISOString());
    expect(byId.at2!.resolvedAt).toBeNull();
  });
});

/**
 * The guard on the goal-verdict migration.
 *
 * That migration drops `Campaign.goalKeys` and the three `CampaignContactGoal`
 * context columns on the stated assumption that no goal campaign has run in
 * production. An assumption a migration relies on is one it should check: run
 * unattended by `docker-entrypoint.sh`, a drop that turned out to be wrong
 * would destroy a customer's goal configuration with nobody watching. So the
 * migration refuses, loudly, when either table says a goal campaign did run —
 * and this is the only way to prove that it does, because the guard's whole
 * job is to fail on data the migrated test database can no longer hold.
 */
describe('the goal_verdict guard', () => {
  let guard: PrismaClient;

  const deployGoalVerdict = () => {
    stageMigrations(() => true);
    deploy(stage, guardUrl);
  };

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${GUARD_DB}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${GUARD_DB}"`);

    // The eve of the goal-verdict migration: `goalKeys` still exists.
    stageMigrations((name) => name < GOAL_VERDICT);
    deploy(stage, guardUrl);

    guard = new PrismaClient({ datasources: { db: { url: guardUrl } } });
    await guard.$executeRawUnsafe(
      `INSERT INTO "Account" (id, "clerkUserId", email) VALUES ('acc1', 'clerk_guard', 'guard@test.local')`,
    );
    await guard.$executeRawUnsafe(
      `INSERT INTO "Workspace" (id, name, slug, "ownerAccountId") VALUES ('ws1', 'Guard', 'guard', 'acc1')`,
    );
    await guard.$executeRawUnsafe(
      `INSERT INTO "Campaign" (id, "workspaceId", name, "goalKeys", "updatedAt")
       VALUES ('camp_goal', 'ws1', 'Ran with a goal', ARRAY['budget'], NOW())`,
    );
  }, 180_000);

  afterAll(async () => {
    await guard?.$disconnect();
  });

  it('refuses to drop goalKeys while a campaign still carries one', () => {
    expect(deployGoalVerdict).toThrow(/goalKeys/);
  });

  /**
   * The refused deploy is recorded as a failed migration, and Prisma answers
   * every later deploy with P3009 until somebody marks it rolled back — the
   * DO block raised before its first ALTER, so rolled back is exactly what it
   * is. This is the recovery `docs/deploy.md` gives, run the way an operator
   * would run it.
   */
  it('proceeds once the column has been cleared by hand and the failure marked rolled back', async () => {
    await guard.$executeRawUnsafe(`UPDATE "Campaign" SET "goalKeys" = '{}'`);
    execFileSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', GOAL_VERDICT, '--schema', path.join(stage, 'schema.prisma')], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: guardUrl },
      stdio: 'pipe',
    });

    expect(deployGoalVerdict).not.toThrow();

    const columns = await guard.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'Campaign' AND column_name IN ('goalKeys', 'goal')`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['goal']);
  }, 60_000);
});
