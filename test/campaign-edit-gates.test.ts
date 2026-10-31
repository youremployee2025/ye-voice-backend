import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CampaignStatus, ContactArmKind } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';
import { sweepContactsOverRetryBudget } from '../src/lib/campaignLifecycle.js';

/**
 * What a campaign will still accept once it has left DRAFT.
 *
 * The rule is not about which fields are convenient to change: it is about
 * which ones can be changed without contradicting a call that has already been
 * placed. The retry and callback settings are re-read by the dispatcher on
 * every pass and stamped onto nothing, so changing them changes only what the
 * next claim does. The agent, the numbers and the variable map are what a call
 * already made was made *with*, and there is no honest way to apply a change to
 * those retroactively.
 */

vi.mock('../src/lib/campaignLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/campaignLifecycle.js')>();

  return { ...actual, sweepContactsOverRetryBudget: vi.fn(actual.sweepContactsOverRetryBudget) };
});

const app = createApp();
const AUTH = as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
  vi.mocked(sweepContactsOverRetryBudget).mockClear();
});

async function seed(status: CampaignStatus) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const agent = await makeAgent(ws, 'Sales');
  const did = await makePhoneNumber(ws, '+918011220000');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Q3',
      status,
      agentId: agent.id,
      phoneNumberId: did.id,
      // Stopped is the only status carrying the column, and the additive
      // variable-map path keys on it rather than on the status.
      ...(status === 'STOPPED' ? { stoppedAt: new Date() } : {}),
      dialNumbers: { create: [{ phoneNumberId: did.id, position: 0 }] },
    },
  });

  return { alice, ws, agent, did, campaign };
}

const patch = (ws: string, campaign: string, body: unknown) =>
  request(app)
    .patch(`/api/workspaces/${ws}/campaigns/${campaign}`)
    .set(...AUTH)
    .send(body);

describe('a DRAFT campaign', () => {
  it('accepts everything', async () => {
    const { ws, campaign } = await seed('DRAFT');
    const other = await makeAgent(ws, 'Support');

    const res = await patch(ws.id, campaign.id, {
      name: 'Q4',
      agentId: other.id,
      retryCount: 5,
      concurrencyLimit: 4,
      variableMap: { City: 'city' },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Q4', retryCount: 5, concurrencyLimit: 4 });
  });
});

describe('a paused campaign', () => {
  for (const status of ['PAUSED', 'CREDIT_EXHAUSTED'] as const) {
    /**
     * `callbackEnabled` rides along in the body a stale dashboard posts back,
     * and it must be a no-op rather than a 409: it stays on the allow-list so
     * the gate never names it, and the validator discards the value so the
     * campaign keeps booking callbacks. Both halves are what make a form from
     * before this release harmless.
     */
    it(`accepts the retry settings and ignores the callback switch while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, {
        retryCount: 5,
        cooldownMinutes: 90,
        retryDelaysMinutes: [10, 20],
        callbackEnabled: false,
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        retryCount: 5,
        cooldownMinutes: 90,
        retryDelaysMinutes: [10, 20],
        callbackEnabled: true,
      });
    });

    it(`names every locked field it refuses while ${status}`, async () => {
      const { ws, campaign } = await seed(status);
      const other = await makeAgent(ws, 'Support');

      const res = await patch(ws.id, campaign.id, {
        name: 'Q4',
        agentId: other.id,
        concurrencyLimit: 6,
        retryCount: 5,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
      // Every field that would not have saved is named. A field that appears
      // to save and does not is the worst of the three outcomes.
      expect(res.body.error.message).toContain('name');
      expect(res.body.error.message).toContain('agentId');
      expect(res.body.error.message).toContain('concurrencyLimit');

      // And nothing was written, including the field that was allowed.
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.name).toBe('Q3');
      expect(stored.retryCount).toBe(2);
    });
  }

  /**
   * The dashboard sends the whole form back on every save. A rule written on
   * which fields are *present* rather than on which ones are *changing* would
   * refuse every edit the page can make — including the ones it is allowed.
   */
  it('accepts a full-form resubmit that only changes the retry policy', async () => {
    const { ws, agent, did, campaign } = await seed('PAUSED');

    const res = await patch(ws.id, campaign.id, {
      name: 'Q3',
      agentId: agent.id,
      phoneNumberIds: [did.id],
      fromTime: null,
      toTime: null,
      timezone: null,
      concurrencyLimit: 2,
      retryCount: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.retryCount).toBe(5);
  });
});

describe('a finished campaign', () => {
  for (const status of ['COMPLETED', 'STOPPED'] as const) {
    it(`refuses even the retry policy while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, { retryCount: 5 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
      expect(res.body.error.message).toContain('retryCount');
    });
  }

  for (const status of ['RUNNING', 'COMPLETED', 'STOPPED'] as const) {
    it(`accepts a body that changes nothing while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      // Not an edit, so not a refusal. The page reads and writes the same form.
      const res = await patch(ws.id, campaign.id, { name: 'Q3', retryCount: 2 });

      expect(res.status).toBe(200);
    });
  }
});

/**
 * The pacing knobs a campaign mid-dial still accepts.
 *
 * Neither of them contradicts a call already placed: the dispatcher re-reads
 * `concurrencyLimit` and the attached numbers on every pass, so both take
 * effect on the next tick and describe only what happens NEXT. The agent is
 * the pair's opposite and keeps its lock — `start` checks it once and nothing
 * looks again.
 */
describe('tuning a campaign that has started', () => {
  const LIVE = ['RUNNING', 'PAUSED', 'CREDIT_EXHAUSTED'] as const;

  for (const status of LIVE) {
    it(`accepts a new concurrency limit while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, {
        concurrencyLimit: 6,
        retryConcurrency: 2,
      });

      expect(res.status).toBe(200);

      // Asserted against the row, not only the response: a 200 over a stale
      // row is the shape of a test that proves nothing.
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.concurrencyLimit).toBe(6);
      expect(stored.retryConcurrency).toBe(2);
    });

    /**
     * The three follow-up settings are live again since 2026-09-09 and are
     * exactly the shape this gate exists for: the dispatcher re-reads all
     * three on its next pass and none of them contradicts a call already
     * placed. An operator watching a campaign follow people up too hard must
     * be able to slow it without pausing the campaign to do it.
     */
    it(`accepts the follow-up budget, wait and daily cap while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, {
        maxGoalFollowUps: 1,
        followUpDelayHours: 48,
        maxDialsPerDay: 3,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.maxGoalFollowUps).toBe(1);
      expect(res.body.data.followUpDelayHours).toBe(48);
      expect(res.body.data.maxDialsPerDay).toBe(3);

      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.maxGoalFollowUps).toBe(1);
      expect(stored.followUpDelayHours).toBe(48);
      expect(stored.maxDialsPerDay).toBe(3);
    });

    it(`accepts a new rotation while ${status}`, async () => {
      const { ws, campaign } = await seed(status);
      const second = await makePhoneNumber(ws, '+918011440000');

      const res = await patch(ws.id, campaign.id, { phoneNumberIds: [second.id] });

      expect(res.status).toBe(200);

      const rows = await prisma.campaignPhoneNumber.findMany({
        where: { campaignId: campaign.id },
        orderBy: { position: 'asc' },
      });
      expect(rows.map((row) => row.phoneNumberId)).toEqual([second.id]);

      // The legacy pointer follows the rotation's head, or the dispatcher's
      // fallback names a number this campaign no longer dials from.
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.phoneNumberId).toBe(second.id);
    });

    it(`refuses to leave a ${status} campaign with no number`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, { phoneNumberIds: [] });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CAMPAIGN_NEEDS_PHONE_NUMBER');

      // And the rotation it already had is intact.
      const rows = await prisma.campaignPhoneNumber.count({ where: { campaignId: campaign.id } });
      expect(rows).toBe(1);
    });
  }

  /**
   * A DRAFT may hold no number at all — `start` is the gate for that, and a
   * form being filled in passes through the empty state on its way to a
   * choice.
   */
  it('still accepts an empty rotation on a draft', async () => {
    const { ws, campaign } = await seed('DRAFT');

    const res = await patch(ws.id, campaign.id, { phoneNumberIds: [] });

    expect(res.status).toBe(200);
    expect(await prisma.campaignPhoneNumber.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  /**
   * Removing a number means "place no NEW calls from this one". The attempt
   * row carries its own number and the outcome webhook resolves against it, so
   * a call already ringing is not the rotation's to cancel.
   */
  it('leaves a call already in flight on a removed number alone', async () => {
    const { alice, ws, did, campaign } = await seed('RUNNING');
    const second = await makePhoneNumber(ws, '+918011550000');

    const attempt = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        workspaceId: ws.id,
        accountId: alice.id,
        attemptNo: 1,
        fromNumber: did.did,
        status: 'IN_PROGRESS',
      },
    });

    const res = await patch(ws.id, campaign.id, { phoneNumberIds: [second.id] });
    expect(res.status).toBe(200);

    const stored = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.fromNumber).toBe(did.did);
  });

  /**
   * The reservation moves with the ceiling or neither moves. Shipping the
   * limit alone would leave an operator who raised it unable to lower it
   * again: the refusal below needs both fields, and the API would accept one.
   */
  it('refuses to lower the ceiling under a reservation the body leaves alone', async () => {
    const { ws, campaign } = await seed('RUNNING');

    expect((await patch(ws.id, campaign.id, { concurrencyLimit: 8, retryConcurrency: 4 })).status)
      .toBe(200);

    const refused = await patch(ws.id, campaign.id, { concurrencyLimit: 3 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('retryConcurrency');

    const together = await patch(ws.id, campaign.id, {
      concurrencyLimit: 3,
      retryConcurrency: 1,
    });
    expect(together.status).toBe(200);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.concurrencyLimit).toBe(3);
    expect(stored.retryConcurrency).toBe(1);
  });

  /**
   * The agent is the one this release does NOT unlock, and it keeps its own
   * code because the dashboard keys on it.
   */
  it('keeps the agent lock on a running campaign', async () => {
    const { ws, campaign } = await seed('RUNNING');
    const other = await makeAgent(ws, 'Support');

    const res = await patch(ws.id, campaign.id, { agentId: other.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_LOCKED');
  });

  it('still refuses the name and the dialing window on a running campaign', async () => {
    const { ws, campaign } = await seed('RUNNING');

    const res = await patch(ws.id, campaign.id, { name: 'Q4', timezone: 'Asia/Kolkata' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
    expect(res.body.error.message).toContain('name');
    expect(res.body.error.message).toContain('timezone');
  });
});

describe('the variable map', () => {
  it('takes a new key on a running campaign, and on a finished one', async () => {
    for (const status of ['RUNNING', 'COMPLETED'] as const) {
      const { ws, campaign } = await seed(status);
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { variableMap: { Phone: 'mobile_number' } },
      });

      const res = await patch(ws.id, campaign.id, {
        variableMap: { Phone: 'mobile_number', City: 'city' },
      });

      expect(res.status, status).toBe(200);
      expect(res.body.data.variableMap).toEqual({ Phone: 'mobile_number', City: 'city' });

      await truncateAll();
    }
  });

  it('refuses to re-point a key that already has a value', async () => {
    const { ws, campaign } = await seed('RUNNING');
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { variableMap: { Phone: 'mobile_number' } },
    });

    // A lead imported under one mapping and dialed an hour later under another
    // is greeted with variables its own CSV row never meant.
    const res = await patch(ws.id, campaign.id, { variableMap: { Phone: 'callee_name' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
  });

  it('refuses to drop a key, and refuses a clear', async () => {
    const { ws, campaign } = await seed('RUNNING');
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { variableMap: { Phone: 'mobile_number', City: 'city' } },
    });

    const dropped = await patch(ws.id, campaign.id, { variableMap: { Phone: 'mobile_number' } });
    expect(dropped.status).toBe(400);

    // `null` is a clear, which contradicts every existing key at once.
    const cleared = await patch(ws.id, campaign.id, { variableMap: null });
    expect(cleared.status).toBe(400);
  });

  it('takes anything flat over a campaign that had no map', async () => {
    const { ws, campaign } = await seed('RUNNING');

    const res = await patch(ws.id, campaign.id, { variableMap: { City: 'city' } });

    expect(res.status).toBe(200);
  });

  it('refuses on a stopped campaign, even after it is marked complete', async () => {
    const { ws, campaign } = await seed('STOPPED');
    // The relabel `complete` does. The rule keys on `stoppedAt`, precisely so
    // that relabel is not a two-click bypass of it.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED' } });

    const res = await patch(ws.id, campaign.id, { variableMap: { City: 'city' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
  });
});

describe('the retry-budget sweep', () => {
  async function withContacts(
    rows: {
      attempts: number;
      armKind?: ContactArmKind;
      nextEligibleAt?: Date | null;
      callbackAt?: Date | null;
      followUpCount?: number;
    }[],
  ) {
    const seeded = await seed('PAUSED');

    for (const [index, row] of rows.entries()) {
      const contact = await prisma.contact.create({
        data: { workspaceId: seeded.ws.id, phone: `+91987654${(3210 + index).toString()}` },
      });
      await prisma.campaignContact.create({
        data: {
          campaignId: seeded.campaign.id,
          contactId: contact.id,
          status: 'PENDING',
          armKind: row.armKind ?? 'RETRY',
          attempts: row.attempts,
          followUpCount: row.followUpCount ?? 0,
          nextEligibleAt: row.nextEligibleAt ?? null,
          callbackAt: row.callbackAt ?? null,
        },
      });
    }

    return seeded;
  }

  it('skips the contacts the new budget has already stranded, and counts them', async () => {
    const { ws, campaign } = await withContacts([{ attempts: 3 }, { attempts: 4 }, { attempts: 1 }]);

    const res = await patch(ws.id, campaign.id, { retryCount: 1 });
    expect(res.status).toBe(200);

    const swept = await prisma.campaignContact.findMany({ orderBy: { attempts: 'asc' } });
    expect(swept.map((row) => row.status)).toEqual(['PENDING', 'SKIPPED', 'SKIPPED']);

    // In the same transaction as the sweep: a status change without its
    // counter leaves the stats page disagreeing with the contact list.
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(2);
  });

  it('never sweeps a contact armed for a promised callback', async () => {
    const at = new Date(Date.now() + 3_600_000);
    const { ws, campaign } = await withContacts([
      // Armed CALLBACK. A callback spends no retry, so a budget it was never
      // spending must not cancel it.
      { attempts: 5, armKind: 'CALLBACK', nextEligibleAt: at, callbackAt: at },
      // A promise already kept: `callbackAt` is history and the ladder has
      // re-armed the contact since. Sweepable.
      { attempts: 5, armKind: 'RETRY', nextEligibleAt: new Date(Date.now() + 60_000), callbackAt: at },
      // The null arm the timestamp-pair negation silently exempted: a stale
      // `callbackAt` beside a lapsed cooldown, which is an ordinary retry.
      { attempts: 5, armKind: 'RETRY', nextEligibleAt: null, callbackAt: at },
    ]);

    await patch(ws.id, campaign.id, { retryCount: 0 });

    const rows = await prisma.campaignContact.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'SKIPPED', 'SKIPPED']);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(2);
  });

  /**
   * The other half of that exemption, and the half the widened timestamp pair
   * got wrong: an `immediate` resume armed the same two columns, so a dropped
   * conversation on a contact that had already spent five retries was exempt
   * from a budget it had very much spent — and lowering `retryCount` could not
   * reach it at all. Nobody promised this call; the engine chose it.
   */
  it('sweeps a resume, which is exempt from nothing', async () => {
    const at = new Date(Date.now() + 5 * 60_000);
    const { ws, campaign } = await withContacts([
      { attempts: 5, armKind: 'RESUME', nextEligibleAt: at, callbackAt: at },
    ]);

    await patch(ws.id, campaign.id, { retryCount: 0 });

    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('SKIPPED');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(1);
  });

  it('runs on a raise too, and sweeps nothing', async () => {
    const { ws, campaign } = await withContacts([{ attempts: 3 }]);

    await patch(ws.id, campaign.id, { retryCount: 10 });

    expect(sweepContactsOverRetryBudget).toHaveBeenCalledTimes(1);
    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('PENDING');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(0);
  });

  /**
   * A FOLLOW_UP row is in the OTHER lane and the retry sweep must not reach
   * it. Its `attempts` is frozen at whatever it had reached when somebody
   * answered — those retries were forfeited, not overspent — so sweeping on
   * that number would settle a contact still inside the only budget it spends.
   */
  it('leaves a follow-up alone whatever the retry budget falls to', async () => {
    const { ws, campaign } = await withContacts([
      { attempts: 3, armKind: 'FOLLOW_UP', followUpCount: 1 },
    ]);

    await patch(ws.id, campaign.id, { retryCount: 0 });

    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('PENDING');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(0);
  });

  it('does not run when retryCount was not supplied', async () => {
    const { ws, campaign } = await withContacts([{ attempts: 3 }]);

    await patch(ws.id, campaign.id, { cooldownMinutes: 45 });

    expect(sweepContactsOverRetryBudget).not.toHaveBeenCalled();
  });

  it('rolls the sweep back with the update it shares a transaction with', async () => {
    const { ws, campaign } = await withContacts([{ attempts: 3 }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Sweeps, then fails before the counter is written. Either both land or
    // neither does — anything else is a contact list the stats disagree with.
    vi.mocked(sweepContactsOverRetryBudget).mockImplementationOnce(async (tx, campaignId) => {
      await tx.$executeRaw`
        UPDATE "CampaignContact" SET status = 'SKIPPED' WHERE "campaignId" = ${campaignId}`;
      throw new Error('interrupted');
    });

    const res = await patch(ws.id, campaign.id, { retryCount: 0 });
    expect(res.status).toBe(500);

    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('PENDING');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(0);

    vi.restoreAllMocks();
  });
});

/**
 * The lead-bucket settings, which every status accepts.
 *
 * They are the one pair of settings that contradicts nothing already dialled.
 * Bucket membership is computed at READ time out of what each call actually
 * extracted, so choosing a key — or changing it — re-reads history rather than
 * changing what any call did. A campaign that finished last week can be sorted
 * by a key nobody had picked while it ran, which is the whole point: an
 * operator does not know which answer matters until they have the answers.
 */
/**
 * The retry share re-paces the NEXT claim and contradicts no call already
 * placed, so it is editable in every status — RUNNING included, which is the
 * campaign the setting exists for. Pinned at the route rather than only in the
 * validator: `changedBy` is where a field becomes locked, and a name added to
 * that list would 409 here while the validator still passed.
 */
/**
 * The follow-up budget's own sweep, the exact analogue of the retry one.
 *
 * The claim refuses a FOLLOW_UP row past `maxGoalFollowUps`, and a refusal
 * alone would leave it PENDING for ever — never dialled, never settled,
 * counted as remaining work by the completion pass, so the campaign could
 * never complete either. That is the same hole `sweepContactsOverRetryBudget`
 * exists to close, one lane over.
 */
describe('the follow-up-budget sweep', () => {
  async function withFollowUps(
    rows: { followUpCount: number; armKind?: ContactArmKind; callbackAt?: Date | null }[],
  ) {
    const seeded = await seed('PAUSED');
    await prisma.campaign.update({
      where: { id: seeded.campaign.id },
      data: { maxGoalFollowUps: 3 },
    });

    for (const [index, row] of rows.entries()) {
      const contact = await prisma.contact.create({
        data: { workspaceId: seeded.ws.id, phone: `+91987651${(3210 + index).toString()}` },
      });
      await prisma.campaignContact.create({
        data: {
          campaignId: seeded.campaign.id,
          contactId: contact.id,
          status: 'PENDING',
          armKind: row.armKind ?? 'FOLLOW_UP',
          followUpCount: row.followUpCount,
          nextEligibleAt: new Date(Date.now() + 3_600_000),
          callbackAt: row.callbackAt ?? null,
        },
      });
    }

    return seeded;
  }

  it('skips the follow-ups the lowered budget stranded, and counts them', async () => {
    const { ws, campaign } = await withFollowUps([{ followUpCount: 2 }, { followUpCount: 1 }]);

    const res = await patch(ws.id, campaign.id, { maxGoalFollowUps: 1 });
    expect(res.status).toBe(200);

    const rows = await prisma.campaignContact.findMany({ orderBy: { followUpCount: 'asc' } });
    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'SKIPPED']);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).skippedCount)
      .toBe(1);
  });

  /** A promise is exempt from this budget as it is from the retry one: a
   *  callback spends neither, so neither may cancel it. */
  it('never sweeps a contact armed for a promised callback', async () => {
    const at = new Date(Date.now() + 3_600_000);
    const { ws, campaign } = await withFollowUps([
      { followUpCount: 3, armKind: 'CALLBACK', callbackAt: at },
    ]);

    await patch(ws.id, campaign.id, { maxGoalFollowUps: 0 });

    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('PENDING');
  });

  /** Only the arm that spends it. A RETRY row's `followUpCount` is a lifetime
   *  tally from a lane it has left, and is not a budget it is over. */
  it('leaves a RETRY row alone whatever its lifetime follow-up tally says', async () => {
    const { ws, campaign } = await withFollowUps([{ followUpCount: 3, armKind: 'RETRY' }]);

    await patch(ws.id, campaign.id, { maxGoalFollowUps: 0 });

    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('PENDING');
  });

  it('runs on a raise too, and sweeps nothing', async () => {
    const { ws, campaign } = await withFollowUps([{ followUpCount: 2 }]);

    await patch(ws.id, campaign.id, { maxGoalFollowUps: 5 });

    expect((await prisma.campaignContact.findFirstOrThrow()).status).toBe('PENDING');
  });
});


describe('the retry share', () => {
  for (const status of ['DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'CREDIT_EXHAUSTED'] as const) {
    it(`is accepted and persisted while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, { retrySharePercent: 60 });

      expect(res.status).toBe(200);
      expect(res.body.data.retrySharePercent).toBe(60);

      const row = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(row.retrySharePercent).toBe(60);
    });
  }

  it('still refuses a locked field carried alongside it', async () => {
    const { ws, campaign } = await seed('RUNNING');

    const res = await patch(ws.id, campaign.id, { retrySharePercent: 60, name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
    expect(res.body.error.message).not.toContain('retrySharePercent');
  });
});

describe('the lead-bucket settings', () => {
  async function withExtractionKeys(agentId: string, names: string[]) {
    await prisma.agent.update({
      where: { id: agentId },
      data: { rawConfig: { extraction_config: { keys: names.map((name) => ({ name, type: 'string' })) } } },
    });
  }

  for (const status of ['DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'CREDIT_EXHAUSTED'] as const) {
    it(`accepts a bucket key and its won buckets while ${status}`, async () => {
      const { ws, agent, campaign } = await seed(status);
      await withExtractionKeys(agent.id, ['lead_stage']);

      const res = await patch(ws.id, campaign.id, {
        leadBucketKey: 'lead_stage',
        wonBuckets: ['Hot', 'Warm'],
      });

      expect(res.status).toBe(200);
      expect(res.body.data.leadBucketKey).toBe('lead_stage');
      expect(res.body.data.wonBuckets).toEqual(['Hot', 'Warm']);
    });
  }

  /**
   * Bypassing the gate is not the same as suspending it. A request that also
   * carries a locked field is still refused, and the refusal names the locked
   * field alone — the bucket settings were never the problem.
   */
  it('still refuses a locked field carried alongside them', async () => {
    const { ws, agent, campaign } = await seed('RUNNING');
    await withExtractionKeys(agent.id, ['lead_stage']);

    const res = await patch(ws.id, campaign.id, { leadBucketKey: 'lead_stage', name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
    expect(res.body.error.message).toContain('name');
    expect(res.body.error.message).not.toContain('leadBucketKey');
  });

  it('refuses a key the campaign’s agent does not extract', async () => {
    const { ws, agent, campaign } = await seed('RUNNING');
    await withExtractionKeys(agent.id, ['lead_stage']);

    const res = await patch(ws.id, campaign.id, { leadBucketKey: 'temperature' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('lead_stage');
  });

  /** The key names something the AGENT declares, so an agent arriving in the
   *  same request is the one the key is checked against. */
  it('checks the key against the agent the same request assigns', async () => {
    const { ws, campaign } = await seed('DRAFT');
    const other = await makeAgent(ws, 'Support');
    await withExtractionKeys(other.id, ['deal_size']);

    const res = await patch(ws.id, campaign.id, { agentId: other.id, leadBucketKey: 'deal_size' });

    expect(res.status).toBe(200);
    expect(res.body.data.leadBucketKey).toBe('deal_size');
  });

  it('clears the key and its buckets together', async () => {
    const { ws, agent, campaign } = await seed('RUNNING');
    await withExtractionKeys(agent.id, ['lead_stage']);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] },
    });

    const res = await patch(ws.id, campaign.id, { leadBucketKey: null, wonBuckets: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.leadBucketKey).toBeNull();
    expect(res.body.data.wonBuckets).toEqual([]);
  });

  /** Judged on the merged row, so a request that drops the key while its
   *  buckets stand is refused rather than leaving buckets naming nothing. */
  it('refuses clearing the key while its won buckets stand', async () => {
    const { ws, agent, campaign } = await seed('RUNNING');
    await withExtractionKeys(agent.id, ['lead_stage']);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] },
    });

    const res = await patch(ws.id, campaign.id, { leadBucketKey: null });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('wonBuckets needs a leadBucketKey');
  });

  /**
   * Changing the agent re-checks the key, even when the request says nothing
   * about buckets.
   *
   * A stored key the new agent does not extract matches no call's extraction,
   * so the campaign reports zero leads forever — which is exactly the failure
   * the key check exists to prevent, arriving through the one door that did
   * not check.
   */
  it('refuses an agent whose extraction keys do not carry the stored bucket key', async () => {
    const { ws, agent, campaign } = await seed('DRAFT');
    await withExtractionKeys(agent.id, ['lead_stage']);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] },
    });
    const other = await makeAgent(ws, 'Support');
    await withExtractionKeys(other.id, ['deal_size']);

    const res = await patch(ws.id, campaign.id, { agentId: other.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('lead_stage');
  });

  it('accepts an agent that does carry the stored bucket key', async () => {
    const { ws, agent, campaign } = await seed('DRAFT');
    await withExtractionKeys(agent.id, ['lead_stage']);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { leadBucketKey: 'lead_stage' },
    });
    const other = await makeAgent(ws, 'Support');
    await withExtractionKeys(other.id, ['lead_stage', 'deal_size']);

    expect((await patch(ws.id, campaign.id, { agentId: other.id })).status).toBe(200);
  });

  /** Dropping the key in the same request is the way through: the operator is
   *  saying they no longer want this campaign sorted. */
  it('accepts an agent change that clears the key alongside it', async () => {
    const { ws, agent, campaign } = await seed('DRAFT');
    await withExtractionKeys(agent.id, ['lead_stage']);
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] },
    });
    const other = await makeAgent(ws, 'Support');
    await withExtractionKeys(other.id, ['deal_size']);

    const res = await patch(ws.id, campaign.id, {
      agentId: other.id,
      leadBucketKey: null,
      wonBuckets: [],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.leadBucketKey).toBeNull();
  });

  /** A campaign that sorts nothing has no key to invalidate, so an agent
   *  change is none of this rule's business. */
  it('lets an agent change through on a campaign that does not sort', async () => {
    const { ws, campaign } = await seed('DRAFT');
    const other = await makeAgent(ws, 'Support');

    expect((await patch(ws.id, campaign.id, { agentId: other.id })).status).toBe(200);
  });

  it('takes the settings on create', async () => {
    const { ws, agent } = await seed('DRAFT');
    await withExtractionKeys(agent.id, ['lead_stage']);

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...AUTH)
      .send({ name: 'New', agentId: agent.id, leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] });

    expect(res.status).toBe(201);
    expect(res.body.data.leadBucketKey).toBe('lead_stage');
    expect(res.body.data.wonBuckets).toEqual(['Hot']);
  });

  /** A campaign with no agent has nothing declaring keys, and the refusal says
   *  so rather than reporting an empty list of choices. */
  it('refuses a key on a campaign with no agent', async () => {
    const { ws, campaign } = await seed('DRAFT');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const res = await patch(ws.id, campaign.id, { leadBucketKey: 'lead_stage' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('This campaign has none.');
  });
});

/**
 * Lowering the absolute dial cap mid-campaign.
 *
 * The cap is `retryCount + 1` since 2026-09-06, so `retryCount` is the field
 * that moves it — and the claim refuses any contact whose placed dials have
 * reached it, in every lane, an armed callback included. Without a sweep the
 * rows the new cap strands sit PENDING for ever: never dialled, never
 * settled, counted as remaining work, so the campaign can never complete
 * either. The retry-reservation sweep beside it closes a different hole — a
 * contact can be inside the reservation and past the cap — so both run on the
 * one edit that can move either.
 */
describe('lowering the dial cap', () => {
  async function goalCampaign(status: CampaignStatus) {
    const ctx = await seed(status);

    await prisma.agent.update({
      where: { id: ctx.agent.id },
      data: { rawConfig: { extraction_config: { keys: [{ name: 'city', type: 'string' }] } } },
    });
    await prisma.campaign.update({
      where: { id: ctx.campaign.id },
      data: {
        retryCount: 5,
        // The follow-up budget is the OTHER half of the dial cap, so it is
        // named rather than left at its default: 0 makes the cap
        // `retryCount + 1` and these cases about the retry budget alone.
        maxGoalFollowUps: 0,
        followUpDelayHours: 24,
        // Retired columns, set to values that would change every answer below
        // if anything still read them.
        goalEnabled: false,
        maxTotalDials: 99,
        immediateCallbackMinutes: 90,
      },
    });

    return ctx;
  }

  async function contactWithDials(
    ctx: Awaited<ReturnType<typeof goalCampaign>>,
    dials: number,
    phone: string,
  ) {
    const contact = await prisma.contact.create({
      data: { workspaceId: ctx.ws.id, phone },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: ctx.campaign.id, contactId: contact.id, status: 'PENDING' },
    });

    for (let attemptNo = 1; attemptNo <= dials; attemptNo += 1) {
      await prisma.callAttempt.create({
        data: {
          campaignId: ctx.campaign.id,
          campaignContactId: link.id,
          workspaceId: ctx.ws.id,
          accountId: ctx.alice.id,
          attemptNo,
          status: 'COMPLETED',
          upstreamCallId: `c_${link.id}_${attemptNo}`,
          resolvedAt: new Date(),
        },
      });
    }

    return link;
  }

  const statusOf = async (id: string) =>
    (await prisma.campaignContact.findUniqueOrThrow({ where: { id } })).status;

  it('settles the contacts the new cap strands, in the same transaction', async () => {
    const ctx = await goalCampaign('PAUSED');
    const stranded = await contactWithDials(ctx, 3, '+918011229001');
    const reachable = await contactWithDials(ctx, 1, '+918011229002');

    // `retryCount: 2` on a campaign that follows nobody up is a budget of
    // three: the contact with three placed dials is out of reach in every
    // lane, the one with a single dial is not.
    const res = await patch(ctx.ws.id, ctx.campaign.id, { retryCount: 2 });

    expect(res.status).toBe(200);
    expect(await statusOf(stranded.id)).toBe('SKIPPED');
    expect(await statusOf(reachable.id)).toBe('PENDING');
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: ctx.campaign.id } })).skippedCount,
    ).toBe(1);
  });

  /** Lowering the FOLLOW-UP budget lowers the dial cap too, so the same sweep
   *  runs on an edit that never mentions `retryCount`. Here the cap falls from
   *  `5 + 3 + 1` to `5 + 0 + 1`, which strands a contact holding six dials. */
  it('settles the contacts a lowered follow-up budget strands', async () => {
    const ctx = await goalCampaign('PAUSED');
    await prisma.campaign.update({
      where: { id: ctx.campaign.id },
      data: { maxGoalFollowUps: 3 },
    });
    const stranded = await contactWithDials(ctx, 6, '+918011229011');
    const reachable = await contactWithDials(ctx, 4, '+918011229012');

    const res = await patch(ctx.ws.id, ctx.campaign.id, { maxGoalFollowUps: 0 });

    expect(res.status).toBe(200);
    expect(await statusOf(stranded.id)).toBe('SKIPPED');
    expect(await statusOf(reachable.id)).toBe('PENDING');
  });

  /** The retired column moves nothing: an edit that lowers it alone leaves
   *  every contact exactly where it was. */
  it('sweeps nothing when only the retired maxTotalDials is lowered', async () => {
    const ctx = await goalCampaign('PAUSED');
    const dialed = await contactWithDials(ctx, 3, '+918011229003');

    const res = await patch(ctx.ws.id, ctx.campaign.id, { maxTotalDials: 3 });

    expect(res.status).toBe(200);
    expect(await statusOf(dialed.id)).toBe('PENDING');
  });

  /**
   * The retired knobs stay mid-campaign editable, and they must: an older
   * dashboard build sends all four on every edit of the campaign panel, and
   * dropping them from the allow-list would refuse the whole save.
   *
   * `maxTotalDials` is accepted and stored — but the response reports the
   * EFFECTIVE dial budget, `retryCount + maxGoalFollowUps + 1`, not the number
   * that was sent. Echoing 5 back would tell the panel a straight untruth
   * about a campaign that stops at 4.
   */
  it('is accepted while PAUSED, and answered with the effective budget', async () => {
    const ctx = await goalCampaign('PAUSED');

    const res = await patch(ctx.ws.id, ctx.campaign.id, {
      maxTotalDials: 5,
      maxGoalFollowUps: 1,
      followUpDelayHours: 12,
      retryCount: 2,
    });

    expect(res.status).toBe(200);
    // 2 retries + 1 follow-up + the first call.
    expect(res.body.data.maxTotalDials).toBe(4);
    expect(res.body.data.maxGoalFollowUps).toBe(1);
    expect(res.body.data.followUpDelayHours).toBe(12);
    // The daily cap has no effective value to derive: it is echoed as stored.
    expect(res.body.data.maxDialsPerDay).toBe(2);

    // Stored all the same, so nothing an operator typed is destroyed.
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: ctx.campaign.id } })).maxTotalDials,
    ).toBe(5);
  });

  /**
   * `immediateCallbackMinutes` is accepted, stored, and answered with the
   * constant the engine actually uses.
   *
   * The column round-tripped its stored value until 2026-09-06, back when the
   * panel that edited it needed to read what it had written. The gap is now a
   * fixed three minutes on every campaign, so the serializer reports 3 —
   * whatever the column holds — because a payload echoing 12 back would tell
   * the panel that a campaign resumes a dropped call twelve minutes later
   * when it resumes it in three.
   */
  it('accepts immediateCallbackMinutes and answers with the fixed gap', async () => {
    const ctx = await goalCampaign('PAUSED');

    const saved = await patch(ctx.ws.id, ctx.campaign.id, { immediateCallbackMinutes: 12 });

    expect(saved.status).toBe(200);
    expect(saved.body.data.immediateCallbackMinutes).toBe(3);

    const reloaded = await request(app)
      .get(`/api/workspaces/${ctx.ws.id}/campaigns/${ctx.campaign.id}`)
      .set(...AUTH);

    expect(reloaded.status).toBe(200);
    expect(reloaded.body.data.immediateCallbackMinutes).toBe(3);

    // Stored all the same, so nothing an operator typed is destroyed.
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: ctx.campaign.id } }))
        .immediateCallbackMinutes,
    ).toBe(12);
  });
});

/**
 * The goal switch, kept for compatibility.
 *
 * Retired on 2026-09-06 and read by nothing. Still accepted, still
 * type-checked, still written to its column and still mid-campaign editable,
 * because an older dashboard build sends it on every save of the campaign
 * panel and refusing it during the deploy skew would break those saves for
 * the cost of nothing.
 *
 * What the API ANSWERS with is `true`, always: a response echoing a stored
 * `false` would tell that panel a campaign does not follow people up when it
 * does. So the cases below assert the column and the payload separately —
 * that is the whole shape of a compatibility field.
 *
 * Gated on what the request would CHANGE, like everything else here, because
 * the dashboard sends the whole form back on every save.
 */
describe('the goal switch', () => {
  async function withGoal(status: CampaignStatus, goalEnabled: boolean) {
    const ctx = await seed(status);

    await prisma.campaign.update({ where: { id: ctx.campaign.id }, data: { goalEnabled } });

    return ctx;
  }

  it('is editable while DRAFT', async () => {
    const { ws, campaign } = await withGoal('DRAFT', false);

    const res = await patch(ws.id, campaign.id, { goalEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.goalEnabled).toBe(true);
  });

  /**
   * Accepted in both directions and in both statuses that take a mid-campaign
   * edit — and answered `true` either way, because the answer is what the
   * engine does rather than what the column holds.
   */
  for (const status of ['RUNNING', 'PAUSED', 'CREDIT_EXHAUSTED'] as const) {
    it(`is accepted while ${status}, on and off alike, and always answered true`, async () => {
      const { ws, campaign } = await withGoal(status, false);

      expect((await patch(ws.id, campaign.id, { goalEnabled: true })).status).toBe(200);

      const off = await patch(ws.id, campaign.id, { goalEnabled: false });
      expect(off.status).toBe(200);
      expect(off.body.data.goalEnabled).toBe(true);

      // Written all the same: the column is compatibility storage, not a lie.
      expect(
        (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).goalEnabled,
      ).toBe(false);
    });
  }

  it('is editable on a paused campaign that has already judged contacts', async () => {
    const { ws, campaign } = await withGoal('PAUSED', true);
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919000000009' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, goalAchieved: false },
    });
    await prisma.campaignContactGoal.create({
      data: { campaignContactId: link.id, lastCallNote: 'spoke, no decision' },
    });

    const res = await patch(ws.id, campaign.id, { goalEnabled: false });

    expect(res.status).toBe(200);
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).goalEnabled,
    ).toBe(false);
  });

  /**
   * Editable mid-campaign is not editable in every status. A stopped campaign
   * refuses it by the generic lock, and the refusal names it — the field is
   * dispatcher policy, and a stopped campaign has no next pass to apply it to.
   */
  for (const status of ['STOPPED'] as const) {
    it(`is refused while ${status}, and named in the refusal`, async () => {
      const { ws, campaign } = await withGoal(status, false);

      const res = await patch(ws.id, campaign.id, { goalEnabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
      expect(res.body.error.message).toContain('goalEnabled');
    });
  }

  /** The whole reason the gate is written on change rather than presence: the
   *  form re-sends the stored switch on every save. */
  it('reads the identical switch as not a change, even while RUNNING', async () => {
    const { ws, campaign } = await withGoal('RUNNING', true);

    const res = await patch(ws.id, campaign.id, { goalEnabled: true, name: 'Q3' });

    expect(res.status).toBe(200);
    expect(res.body.data.goalEnabled).toBe(true);
  });

  /** Absent is "leave it alone", as it is for every other field here. */
  it('leaves the switch standing when the body does not mention it', async () => {
    const { ws, campaign } = await withGoal('PAUSED', true);

    const res = await patch(ws.id, campaign.id, { maxTotalDials: 4 });

    expect(res.status).toBe(200);
    expect(res.body.data.goalEnabled).toBe(true);
  });

  /** `"false"` is truthy. Coerced, the string a form serialiser produces for
   *  an unchecked box would leave the campaign chasing people nobody asked it
   *  to chase — refused by shape, and by shape before status, so the caller is
   *  told what is wrong with the value rather than which door they are at. */
  for (const status of ['DRAFT', 'PAUSED'] as const) {
    it(`refuses anything that is not a boolean while ${status}`, async () => {
      const { ws, campaign } = await withGoal(status, false);

      const res = await patch(ws.id, campaign.id, { goalEnabled: 'true' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('goalEnabled must be a boolean.');
    });
  }

  /**
   * The deprecated prose column, accepted and ignored for one release.
   *
   * The dashboard and the backend deploy independently, so a dashboard still
   * carrying the textarea must not have its saves refused — and it must not be
   * refused by the STATUS gate either, which is the case a schema-level strip
   * alone would not cover: `goal` names no changed field, so a paused campaign
   * accepts a body carrying it and stores nothing from it.
   */
  it('accepts and ignores the deprecated goal prose after DRAFT', async () => {
    const { ws, campaign } = await withGoal('PAUSED', true);

    const res = await patch(ws.id, campaign.id, { goal: 'Collect a budget' });

    expect(res.status).toBe(200);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.goal).toBeNull();
    expect(stored.goalEnabled).toBe(true);
  });
});

/**
 * The dialing days sit with the hours beside them: part of the window, and so
 * DRAFT-only, because a campaign that has already dialed people on Saturdays
 * cannot honestly be told it never dials on Saturdays.
 */
describe('the dialing days', () => {
  it('saves on a DRAFT campaign and comes back on the wire', async () => {
    const { ws, campaign } = await seed('DRAFT');

    const res = await patch(ws.id, campaign.id, { dialDays: [1, 2, 3, 4, 5] });

    expect(res.status).toBe(200);
    expect(res.body.data.dialDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('is locked once the campaign has left DRAFT, and the refusal names it', async () => {
    const { ws, campaign } = await seed('PAUSED');

    const res = await patch(ws.id, campaign.id, { dialDays: [1, 2, 3, 4, 5] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CAMPAIGN_CONFIG_LOCKED");
    expect(res.body.error.message).toMatch(/dialDays/);
  });

  /**
   * The array trap. The dashboard sends the whole form back on every save, so
   * a change test written as `!==` would call an unchanged day list changed —
   * two arrays holding the same days are never `!==`-equal — and refuse every
   * mid-campaign edit the gate is supposed to allow.
   */
  it('does not count a resubmitted day list as a change', async () => {
    const { ws, campaign } = await seed('DRAFT');
    await patch(ws.id, campaign.id, { dialDays: [1, 2, 3, 4, 5] });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });

    // Same days, different order, alongside a field PAUSED does allow.
    const res = await patch(ws.id, campaign.id, {
      dialDays: [5, 4, 3, 2, 1],
      retryCount: 4,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.retryCount).toBe(4);
  });

  it('refuses a day named twice rather than quietly deduping it', async () => {
    const { ws, campaign } = await seed('DRAFT');

    const res = await patch(ws.id, campaign.id, { dialDays: [1, 1, 2] });

    expect(res.status).toBe(400);
  });

  it('refuses a day outside the week', async () => {
    const { ws, campaign } = await seed('DRAFT');

    expect((await patch(ws.id, campaign.id, { dialDays: [7] })).status).toBe(400);
    expect((await patch(ws.id, campaign.id, { dialDays: [-1] })).status).toBe(400);
  });

  /**
   * "Every day" has two spellings and they are one state: `[]` is what a
   * campaign nobody configured holds, and all seven is what a form with every
   * box ticked sends. A change test comparing the raw arrays calls that a
   * change, so a paused campaign whose operator ticked the last box — or
   * whose dashboard spells the default the other way — is refused with
   * CAMPAIGN_CONFIG_LOCKED over an edit that restricts nothing and changes
   * nothing.
   */
  it('does not count re-spelling every-day as a change', async () => {
    const { ws, campaign } = await seed('PAUSED');

    expect(campaign.dialDays).toEqual([]);

    const res = await patch(ws.id, campaign.id, { dialDays: [0, 1, 2, 3, 4, 5, 6] });

    expect(res.status).toBe(200);
  });

  it('does not count clearing a full week as a change either', async () => {
    const { ws, campaign } = await seed('DRAFT');
    await patch(ws.id, campaign.id, { dialDays: [0, 1, 2, 3, 4, 5, 6] });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });

    expect((await patch(ws.id, campaign.id, { dialDays: [] })).status).toBe(200);
  });

  /**
   * `null` as a spelling of `[]`.
   *
   * Every other field of the window is `.nullable()`, so a form that clears
   * the whole window sends four nulls; refusing the fourth is a 400 on the
   * one field of the four that has a value meaning "no restriction" already.
   * It is an alias, not a fifth state — the column is `NOT NULL` and stays
   * so.
   */
  it('accepts null as a spelling of every day', async () => {
    const { ws, campaign } = await seed('DRAFT');
    await patch(ws.id, campaign.id, { dialDays: [1, 2] });

    const res = await patch(ws.id, campaign.id, { dialDays: null });

    expect(res.status).toBe(200);
    expect(res.body.data.dialDays).toEqual([]);
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).dialDays,
    ).toEqual([]);
  });

  it('reads null as no change on a campaign that already dials every day', async () => {
    const { ws, campaign } = await seed('PAUSED');

    expect((await patch(ws.id, campaign.id, { dialDays: null })).status).toBe(200);
  });
});
