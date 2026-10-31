import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';
import {
  DEFAULT_CONCURRENCY_LIMIT,
  DEFAULT_RETRY_CONCURRENCY,
} from '../src/lib/campaignConfig.js';

/**
 * The shape the campaign-parity wave leaves behind.
 *
 * A migration is the one change whose result no other test observes directly:
 * every suite here creates its rows through Prisma, so a column that arrived
 * with the wrong default, a unique that was never created, or an enum member
 * the client knows and the database does not, all pass unnoticed until a
 * campaign misbehaves in production. This file reads the database rather than
 * the schema file — defaults come from a row nobody set fields on, uniques are
 * proven by a rejected duplicate insert, and the indexes the dispatcher plans
 * against are looked up in `pg_indexes`.
 */

beforeEach(async () => {
  await truncateAll();
});

async function seedCampaign() {
  const account = await makeAccount(`mig${Math.random().toString(36).slice(2, 8)}`);
  const workspace = await makeWorkspace(account, 'Migration Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'Shape' },
  });

  return { account, workspace, campaign };
}

describe('Campaign defaults', () => {
  it('defaults the retry policy to two retries, two hours apart, no ladder', async () => {
    const { campaign } = await seedCampaign();

    // Two RETRIES, not two dials: `retryCount` counts what happens after the
    // first call, so the historical three-dial default is two here.
    expect(campaign.retryCount).toBe(2);
    // Two hours since `20260908200000_cooldown_default_2h`: thirty minutes was
    // a redial soon enough that the same person answered twice in an hour.
    expect(campaign.cooldownMinutes).toBe(120);
    expect(campaign.retryDelaysMinutes).toEqual([]);
  });

  /**
   * The claim the `dialDays` migration makes: a campaign nobody configured
   * dials on every day, exactly as it did before the column existed. Read off
   * a row rather than off the schema file, because a default that arrived only
   * in Prisma's model and not in the table would leave the column NULL — and
   * NULL is not `[]` to any reader of it.
   */
  it('defaults the dialing days to every day', async () => {
    const { campaign } = await seedCampaign();

    expect(campaign.dialDays).toEqual([]);
  });

  it('defaults concurrency to two shared slots with nothing reserved for retries', async () => {
    const { campaign } = await seedCampaign();

    expect(campaign.concurrencyLimit).toBe(2);
    // Zero is one shared pool, not "no retries" — the lanes only split above 0.
    expect(campaign.retryConcurrency).toBe(0);

    // The create path validates a caller's `retryConcurrency` against these,
    // because there is no stored row to merge into yet. Mirrored constants
    // drift; this is what stops them.
    expect(campaign.concurrencyLimit).toBe(DEFAULT_CONCURRENCY_LIMIT);
    expect(campaign.retryConcurrency).toBe(DEFAULT_RETRY_CONCURRENCY);
  });

  it('books callbacks by default', async () => {
    const { campaign } = await seedCampaign();

    expect(campaign.callbackEnabled).toBe(true);
  });

  /**
   * And the half a default cannot state: the campaigns that already existed.
   *
   * `callbacks_always_on` is the only migration in this wave whose whole
   * effect is on rows that were already there, so a schema default proves
   * nothing about it — a campaign created before the switch was taken off
   * every screen would go on refusing callbacks with no control left anywhere
   * able to turn them back on.
   *
   * Applied by reading the migration's own SQL and running it, rather than by
   * re-running `migrate deploy`: the test database is already migrated, so a
   * deploy is a no-op and would assert nothing. Reading the file is also what
   * makes this a test OF the migration — an edit that emptied it fails here,
   * where a hand-written `UPDATE` would go on passing.
   */
  it('turns callbacks back on for a campaign that had them off', async () => {
    const { campaign } = await seedCampaign();

    await prisma.$executeRaw`
      UPDATE "Campaign" SET "callbackEnabled" = false WHERE id = ${campaign.id}
    `;

    const sql = readFileSync(
      new URL(
        '../prisma/migrations/20260904141500_callbacks_always_on/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(sql).toContain('UPDATE "Campaign"');
    await prisma.$executeRawUnsafe(sql);

    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).callbackEnabled,
    ).toBe(true);
  });

  it('starts every counter and the rotation cursor at zero', async () => {
    const { campaign } = await seedCampaign();

    expect(campaign.totalContacts).toBe(0);
    expect(campaign.completedCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
    expect(campaign.skippedCount).toBe(0);
    expect(campaign.rrCursor).toBe(0);
  });

  it('leaves every optional column null rather than empty', async () => {
    const { campaign } = await seedCampaign();

    expect(campaign.description).toBeNull();
    expect(campaign.stoppedAt).toBeNull();
    expect(campaign.scheduledStartAt).toBeNull();
    expect(campaign.scheduleError).toBeNull();
    expect(campaign.startedAt).toBeNull();
    expect(campaign.pausedAt).toBeNull();
    expect(campaign.completedAt).toBeNull();
  });

  /**
   * SQL NULL, not JSON `null`. The dispatcher's "is there a mapping" test is
   * `variableMap IS NULL`, and a JSON null would answer it wrongly while
   * looking identical in every response body.
   */
  it('stores an unset variableMap as SQL NULL', async () => {
    const { campaign } = await seedCampaign();

    const rows = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT "variableMap" IS NULL AS "isNull" FROM "Campaign" WHERE id = ${campaign.id}
    `;

    expect(rows[0]!.isNull).toBe(true);
  });
});

describe('CampaignContact defaults', () => {
  it('arms nothing on a fresh row', async () => {
    const { workspace, campaign } = await seedCampaign();
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+918000000001' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    expect(link.nextEligibleAt).toBeNull();
    expect(link.callbackAt).toBeNull();
    expect(link.callbackCount).toBe(0);
    expect(link.lastSessionId).toBeNull();
    expect(link.disposition).toBeNull();
    expect(link.answeredBy).toBeNull();
    // Retries consumed, not dials made.
    expect(link.attempts).toBe(0);
  });
});

describe('Contact defaults', () => {
  it('defaults tags to an empty array and email to null', async () => {
    const { workspace } = await seedCampaign();
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+918000000002' },
    });

    expect(contact.tags).toEqual([]);
    expect(contact.email).toBeNull();
  });
});

describe('new enum members', () => {
  it('accepts CREDIT_EXHAUSTED as a campaign status', async () => {
    const { campaign } = await seedCampaign();

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'CREDIT_EXHAUSTED' },
    });

    expect(updated.status).toBe('CREDIT_EXHAUSTED');
  });

  it('accepts SKIPPED as a contact status', async () => {
    const { workspace, campaign } = await seedCampaign();
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+918000000003' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'SKIPPED' },
    });

    expect(link.status).toBe('SKIPPED');
  });
});

describe('CampaignPhoneNumber', () => {
  it('refuses the same number twice on one campaign', async () => {
    const { workspace, campaign } = await seedCampaign();
    const did = await makePhoneNumber(workspace, '+918011330000');

    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });

    await expect(
      prisma.campaignPhoneNumber.create({
        data: { campaignId: campaign.id, phoneNumberId: did.id, position: 1 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses two numbers at the same rotation position', async () => {
    const { workspace, campaign } = await seedCampaign();
    const first = await makePhoneNumber(workspace, '+918011330001');
    const second = await makePhoneNumber(workspace, '+918011330002');

    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: first.id, position: 0 },
    });

    await expect(
      prisma.campaignPhoneNumber.create({
        data: { campaignId: campaign.id, phoneNumberId: second.id, position: 0 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets two campaigns rotate the same number', async () => {
    const { workspace, campaign } = await seedCampaign();
    const other = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Second' },
    });
    const did = await makePhoneNumber(workspace, '+918011330003');

    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    const shared = await prisma.campaignPhoneNumber.create({
      data: { campaignId: other.id, phoneNumberId: did.id, position: 0 },
    });

    expect(shared.id).toBeTruthy();
  });

  it('goes with the campaign and holds the number in place', async () => {
    const { workspace, campaign } = await seedCampaign();
    const did = await makePhoneNumber(workspace, '+918011330004');

    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });

    // Restrict on the number: an attached DID may not be deleted out from
    // under a rotation.
    await expect(prisma.phoneNumber.delete({ where: { id: did.id } })).rejects.toBeTruthy();

    // Cascade on the campaign: the join row has no meaning without it.
    await prisma.campaign.delete({ where: { id: campaign.id } });

    expect(await prisma.campaignPhoneNumber.count()).toBe(0);
  });
});

describe('CallAttempt', () => {
  async function seedAttempt() {
    const { account, workspace, campaign } = await seedCampaign();
    const agent = await makeAgent(workspace, 'Dialer');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: agent.id } });

    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+918000000004' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    return { account, workspace, campaign, link };
  }

  it('refuses two attempts sharing one number on a contact', async () => {
    const { account, workspace, campaign, link } = await seedAttempt();

    const base = {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: workspace.id,
      accountId: account.id,
    };

    await prisma.callAttempt.create({ data: { ...base, attemptNo: 1 } });

    // The dial mutual-exclusion token: two dispatchers deriving the same next
    // attempt number cannot both place a call.
    await expect(
      prisma.callAttempt.create({ data: { ...base, attemptNo: 1 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('records the number dialled from and when the outcome landed', async () => {
    const { account, workspace, campaign, link } = await seedAttempt();

    const attempt = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: workspace.id,
        accountId: account.id,
        attemptNo: 1,
      },
    });

    expect(attempt.fromNumber).toBeNull();
    expect(attempt.resolvedAt).toBeNull();
  });

  /**
   * The attempt row is also the billing record. Deleting a campaign must not
   * erase the phone bill, so the pointers go null and the row stays.
   */
  it('survives its campaign with the pointers nulled', async () => {
    const { account, workspace, campaign, link } = await seedAttempt();

    const attempt = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: workspace.id,
        accountId: account.id,
        attemptNo: 1,
      },
    });

    await prisma.campaign.delete({ where: { id: campaign.id } });

    const survivor = await prisma.callAttempt.findUnique({ where: { id: attempt.id } });

    expect(survivor).not.toBeNull();
    expect(survivor!.campaignId).toBeNull();
    expect(survivor!.campaignContactId).toBeNull();
    // The snapshots that say who was billed are untouched.
    expect(survivor!.workspaceId).toBe(workspace.id);
    expect(survivor!.accountId).toBe(account.id);
  });
});

describe('indexes the dispatcher plans against', () => {
  async function indexDef(name: string): Promise<string | undefined> {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${name}
    `;

    return rows[0]?.indexdef;
  }

  it('carries a partial index for the callback claim', async () => {
    const def = await indexDef('campaign_contacts_callback_claim_idx');

    expect(def).toBeDefined();
    // Prisma cannot express a partial index, so this one is raw SQL in the
    // migration and would silently disappear on a schema-driven rewrite.
    expect(def).toContain('WHERE');
    expect(def).toContain('PENDING');
  });

  it('carries the eligibility and schedule-scan indexes', async () => {
    expect(await indexDef('CampaignContact_campaignId_status_nextEligibleAt_idx')).toBeDefined();
    expect(await indexDef('CampaignContact_campaignId_callbackAt_idx')).toBeDefined();
    expect(await indexDef('Campaign_status_scheduledStartAt_idx')).toBeDefined();
  });
});
