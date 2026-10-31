import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent, makeDialable, makeWorkspace } from './helpers.js';
import { runScheduleScan } from '../src/services/scheduleScanner.js';
import { startCampaign } from '../src/services/campaignStart.js';

/**
 * Starting a campaign at a time somebody chose earlier.
 *
 * The schedule is a column, not a timer: a restart cannot lose it, cancelling
 * is an UPDATE, and a scanner reads it. What that buys is worth stating —
 * "schedule the campaign now, upload the list tonight" works, because nothing
 * but the time is checked when the schedule is set, and every real gate runs
 * when it fires.
 */

vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(async () => ({ ready: true, readiness: { state: 'READY', issues: [] } })),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  listExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  attachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(async () => ({ extraction_enabled: true })),
  updateAgent: vi.fn(),
}));

const app = createApp();
const AUTH = as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

/** A campaign that would really start: an agent, a contact, a number, a rate
 *  and a balance. `makeDialable` is shared so this cannot drift from what the
 *  start gates actually check. */
async function schedulable(startAt: Date | null = null) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const agent = await makeAgent(ws, 'Sales');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id, scheduledStartAt: startAt },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210' },
  });
  await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: contact.id } });
  await makeDialable(ws, campaign, agent);

  return { alice, ws, campaign };
}

const schedule = (ws: string, campaign: string, body: unknown) =>
  request(app)
    .post(`/api/workspaces/${ws}/campaigns/${campaign}/schedule`)
    .set(...AUTH)
    .send(body);

describe('POST .../schedule', () => {
  it('stores a future start and clears the last failure', async () => {
    const { ws, campaign } = await schedulable();
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { scheduleError: 'Assign an agent before starting this campaign.' },
    });
    const when = new Date(Date.now() + 3_600_000);

    const res = await schedule(ws.id, campaign.id, { startAt: when.toISOString() });

    expect(res.status).toBe(200);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.scheduledStartAt?.toISOString()).toBe(when.toISOString());
    // An error about a start nobody is waiting for any more explains nothing.
    expect(stored.scheduleError).toBeNull();
  });

  it('takes a number of milliseconds as readily as a string', async () => {
    const { ws, campaign } = await schedulable();
    const when = Date.now() + 3_600_000;

    const res = await schedule(ws.id, campaign.id, { startAt: when });

    expect(res.status).toBe(200);
    expect(res.body.data.scheduledStartAt).toBe(new Date(when).toISOString());
  });

  it('refuses a time it cannot read, and one that has passed', async () => {
    const { ws, campaign } = await schedulable();

    for (const startAt of [undefined, null, 'tomorrow-ish', {}, true]) {
      const res = await schedule(ws.id, campaign.id, { startAt });
      expect(res.status, JSON.stringify(startAt)).toBe(400);
      expect(res.body.error.message).toBe('startAt must be a valid date-time.');
    }

    const past = await schedule(ws.id, campaign.id, { startAt: Date.now() - 1000 });
    expect(past.status).toBe(400);
    expect(past.body.error.message).toBe('startAt must be in the future.');
  });

  it('refuses a campaign that is not a draft', async () => {
    const { ws, campaign } = await schedulable();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    const res = await schedule(ws.id, campaign.id, { startAt: Date.now() + 3_600_000 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Can only schedule DRAFT campaigns.');
  });

  it('reschedules on a second post', async () => {
    const { ws, campaign } = await schedulable();
    const later = new Date(Date.now() + 7_200_000);

    await schedule(ws.id, campaign.id, { startAt: Date.now() + 3_600_000 });
    await schedule(ws.id, campaign.id, { startAt: later.toISOString() });

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).scheduledStartAt)
      .toEqual(later);
  });

  it('clears both columns on DELETE, from any status', async () => {
    const { ws, campaign } = await schedulable(new Date(Date.now() + 3_600_000));
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'STOPPED', scheduleError: 'something went wrong' },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/schedule`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.scheduledStartAt).toBeNull();
    expect(stored.scheduleError).toBeNull();
  });

  /**
   * The whole point of the feature: nothing but the time is checked here, so
   * "schedule it now, upload the list tonight" works. Every real gate runs when
   * the schedule fires and lands in `scheduleError`.
   */
  it('schedules a campaign with no contacts and no agent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const bare = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Empty' } });

    const res = await schedule(ws.id, bare.id, { startAt: Date.now() + 3_600_000 });

    expect(res.status).toBe(200);
  });
});

describe('the scanner', () => {
  it('starts a campaign whose time has come', async () => {
    const { campaign } = await schedulable(new Date(Date.now() - 1000));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runScheduleScan();

    expect(result).toMatchObject({ started: 1, refused: 0, errored: 0 });

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('RUNNING');
    expect(stored.startedAt).not.toBeNull();
    // The schedule has fired, so it is no longer waiting for anything.
    expect(stored.scheduledStartAt).toBeNull();
  });

  it('leaves a campaign whose time has not come', async () => {
    const { campaign } = await schedulable(new Date(Date.now() + 3_600_000));

    expect(await runScheduleScan()).toMatchObject({ started: 0 });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
      .toBe('DRAFT');
  });

  it('records a refusal once and never tries it again', async () => {
    const { campaign } = await schedulable(new Date(Date.now() - 1000));
    // A campaign with nothing to dial: the gate a "schedule now, upload later"
    // operator most often hits, and the one they need to read about.
    await prisma.campaignContact.deleteMany({ where: { campaignId: campaign.id } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await runScheduleScan()).toMatchObject({ started: 0, refused: 1 });

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');
    expect(stored.scheduleError).toBe('Add at least one contact before starting this campaign.');
    // Cleared, so the refusal is final: re-running the same gates every thirty
    // seconds forever would refuse for the same reason every time.
    expect(stored.scheduledStartAt).toBeNull();

    expect(await runScheduleScan()).toMatchObject({ started: 0, refused: 0 });
  });

  it('never clobbers a manual start that won the race', async () => {
    const { ws, campaign } = await schedulable(new Date(Date.now() - 1000));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The window the DRAFT guard exists for: the campaign is started by hand
    // between the scanner reading it and the scanner writing its refusal.
    vi.spyOn(prisma.campaignContact, 'count').mockImplementationOnce(async () => {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'RUNNING', scheduledStartAt: null, startedAt: new Date() },
      });
      return 0;
    });

    await runScheduleScan();

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('RUNNING');
    // A stale failure stamped onto a start that succeeded is worse than none.
    expect(stored.scheduleError).toBeNull();
    expect(ws.id).toBeTruthy();
  });

  it('leaves the schedule standing when the start throws', async () => {
    const { campaign } = await schedulable(new Date(Date.now() - 1000));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Not a refusal — a dropped connection or a bug. Nothing has been decided
    // about this campaign, so the next tick tries again.
    vi.spyOn(prisma.campaignContact, 'count').mockRejectedValueOnce(new Error('connection lost'));

    expect(await runScheduleScan()).toMatchObject({ started: 0, refused: 0, errored: 1 });

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');
    expect(stored.scheduledStartAt).not.toBeNull();
    expect(stored.scheduleError).toBeNull();
  });

  it('isolates one bad campaign from the rest of the batch', async () => {
    const first = await schedulable(new Date(Date.now() - 2000));
    const second = await prisma.campaign.create({
      data: {
        workspaceId: first.ws.id,
        name: 'Q4',
        agentId: (await prisma.campaign.findUniqueOrThrow({ where: { id: first.campaign.id } }))
          .agentId,
        scheduledStartAt: new Date(Date.now() - 1000),
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // The second has no contacts, so it refuses. The first must still start.
    const result = await runScheduleScan();

    expect(result).toMatchObject({ started: 1, refused: 1 });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: first.campaign.id } })).status)
      .toBe('RUNNING');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: second.id } })).scheduleError)
      .not.toBeNull();
  });
});

/**
 * The route and the scanner must run the identical routine, or the copy nobody
 * watches is the one that drifts — and a scheduled start runs at 3am against a
 * campaign whose agent was retired at 6pm.
 */
describe('the shared start routine', () => {
  it('refuses a scheduled start for exactly what it would refuse a manual one', async () => {
    const { ws, campaign } = await schedulable(new Date(Date.now() - 1000));
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const manual = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    const scheduled = await startCampaign({ campaignId: campaign.id, workspaceId: ws.id });

    expect(manual.status).toBe(409);
    expect(scheduled).toMatchObject({ ok: false, status: 409, message: manual.body.error.message });
  });

  it('takes concurrency overrides from the route and none from the schedule', async () => {
    const { ws, campaign } = await schedulable();

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH)
      .send({ concurrencyLimit: 5, retryConcurrency: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ concurrencyLimit: 5, retryConcurrency: 2 });
  });
});

describe('where the scanner is scheduled', () => {
  const source = (file: string) =>
    import('node:fs/promises').then((fs) =>
      fs.readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'),
    );

  /**
   * The same rule the dialer sweep and the analytics ingest hold, and for the
   * dialer's reason: this pass does not dial, but everything it starts does.
   *
   * The scan is a repeatable job now rather than a `setInterval`, so the rule
   * is asserted where the schedule is registered. What must stay true is
   * unchanged in every respect that matters: it runs at `SCHEDULE_SCAN_MS`, it
   * is registered only when the dialer is on, and building the app registers
   * nothing.
   */
  it('is a repeatable behind the dialer switch, and never createApp', async () => {
    const repeatable = await source('lib/queue/repeatable.ts');

    expect(repeatable).toContain('SCHEDULE_SCAN');
    expect(repeatable).toContain('env.scheduleScanMs');

    // Inside the `if (env.dialerEnabled)` block: with dialing off, every
    // scheduled start would be refused with DIALER_DISABLED and the scanner
    // would faithfully unschedule every campaign somebody set for tonight.
    // The gate's presence is asserted before the position — `indexOf` answers
    // -1 for a string that is not there, and any real index clears -1, so the
    // positional check alone still passed with the gate deleted. The
    // behavioral halves live in queue-repeatable.test.ts (a flipped switch
    // removes the scheduler) and maintenance-guards.test.ts (a stale job is
    // refused at the consumer).
    const gate = repeatable.indexOf('if (env.dialerEnabled)');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(repeatable.indexOf('REPEATABLE_JOB_IDS.SCHEDULE_SCAN')).toBeGreaterThan(gate);

    // Nothing about background work is composed by the app or repeated by the
    // API entry point: both reach the one bootstrap, and only behind the flag.
    expect(await source('app.ts')).not.toContain('scheduleScan');
    expect(await source('server.ts')).not.toContain('scheduleScan');
  });
});
