import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which number a campaign dials from.
 *
 * The adapter is mocked, as it is in every file that touches the dialer: this
 * suite must never place a call.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { getCall, getConcurrency, startCall } = await import('../src/adapter/vocobase.js');
const { runDialerPass, clearPlacements, closePlacementQueue } = await import('./dialer-pass.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace, makePhoneNumber } = await import('./helpers.js');

const mockedStartCall = vi.mocked(startCall);
const mockedGetConcurrency = vi.mocked(getConcurrency);
const mockedGetCall = vi.mocked(getCall);

const NOW = new Date('2026-08-30T10:00:00Z');

interface Fixture {
  campaignId: string;
  workspaceId: string;
  dids: string[];
}

/**
 * A campaign with `attached` numbers in the join table, plus a legacy pointer
 * at a number of its own so the fallback cases have something to fall back to.
 */
async function seed(
  options: { contacts?: number; attached?: number; legacy?: boolean } = {},
): Promise<Fixture> {
  const { contacts = 4, attached = 2, legacy = true } = options;

  const account = await makeAccount(`rot${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits('100'), concurrencyLimit: 10 },
  });

  const workspace = await makeWorkspace(account, 'Rotators');
  const agent = await makeAgent(workspace, 'caller');
  await prisma.agent.update({ where: { id: agent.id }, data: { voiceTierSlug: 'va-pro' } });
  await prisma.tier.create({
    data: {
      slug: 'va-pro',
      name: 'Pro',
      defaultPriceCreditsPerMin: toInternalCredits('1.00'),
      isDefault: true,
    },
  });

  const numbers = [];
  for (let i = 0; i < attached; i += 1) {
    numbers.push(await makePhoneNumber(workspace, `+9180112233${10 + i}`, 'ASSIGNED'));
  }

  const legacyNumber = legacy
    ? await makePhoneNumber(workspace, '+918099887766', 'ASSIGNED')
    : null;

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      phoneNumberId: legacyNumber?.id ?? numbers[0]?.id ?? null,
      status: 'RUNNING',
      concurrencyLimit: 10,
      dialNumbers: {
        create: numbers.map((number, position) => ({ phoneNumberId: number.id, position })),
      },
    },
  });

  for (let i = 0; i < contacts; i += 1) {
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: `+91987651${String(1000 + i).slice(-4)}` },
    });
    await prisma.campaignContact.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        // Distinct, so the queue has a defined order and the rotation is
        // checked against a known sequence of contacts.
        createdAt: new Date(NOW.getTime() - (contacts - i) * 60_000),
      },
    });
  }

  return {
    campaignId: campaign.id,
    workspaceId: workspace.id,
    dids: numbers.map((number) => number.did),
  };
}

const fromNumbers = () => mockedStartCall.mock.calls.map((call) => call[0]!.from_number);

beforeEach(async () => {
  await truncateAll();
  await clearPlacements();
  vi.clearAllMocks();
  mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
  mockedGetCall.mockResolvedValue(null);
  mockedStartCall.mockImplementation(async () => ({
    call_id: `c_${Math.random().toString(36).slice(2, 8)}`,
    session_id: `s_${Math.random().toString(36).slice(2, 8)}`,
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(closePlacementQueue);

describe('the rotation', () => {
  it('dials round-robin across the attached numbers, in position order', async () => {
    const { dids } = await seed({ contacts: 4, attached: 2 });

    await runDialerPass({ now: NOW });

    expect(fromNumbers()).toEqual([dids[0], dids[1], dids[0], dids[1]]);
  });

  /**
   * The cursor is advanced by the whole batch in one statement, so the next
   * pass starts where this one left off. Reset to zero each pass, a campaign
   * with an odd batch size would hammer the first number and never reach the
   * last.
   */
  it('carries on where the previous batch stopped', async () => {
    const { campaignId, dids } = await seed({ contacts: 3, attached: 2 });
    await prisma.campaign.update({ where: { id: campaignId }, data: { concurrencyLimit: 1 } });

    await runDialerPass({ now: NOW });
    // Free the line so the next pass has a slot.
    await prisma.callAttempt.updateMany({ where: { campaignId }, data: { status: 'COMPLETED' } });
    await runDialerPass({ now: NOW });

    expect(fromNumbers()).toEqual([dids[0], dids[1]]);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.rrCursor).toBe(2);
  });

  it('records the number each attempt actually dialled from', async () => {
    const { campaignId, dids } = await seed({ contacts: 2, attached: 2 });

    await runDialerPass({ now: NOW });

    const attempts = await prisma.callAttempt.findMany({
      where: { campaignId },
      orderBy: { attemptNo: 'asc' },
    });
    expect(attempts.map((attempt) => attempt.fromNumber).sort()).toEqual([...dids].sort());
  });

  /**
   * A released number falls out of the rotation rather than failing every Nth
   * call — which is what would happen if the list were taken verbatim.
   */
  it('drops a number that has gone back to the pool', async () => {
    const { dids } = await seed({ contacts: 3, attached: 2 });
    await prisma.phoneNumber.updateMany({
      where: { did: dids[1] },
      data: { workspaceId: null, status: 'UNASSIGNED' },
    });

    await runDialerPass({ now: NOW });

    expect(fromNumbers()).toEqual([dids[0], dids[0], dids[0]]);
  });
});

describe('when every attached number is unusable', () => {
  /**
   * Held, not paused, and above all not resurrected: the legacy pointer is kept
   * in sync with the first attached number and is loaded with no status filter
   * of its own, so falling back to it would very often mean dialing from the
   * very number that was just released.
   */
  it('holds the campaign for this pass and dials nothing', async () => {
    const { campaignId, workspaceId, dids } = await seed({ contacts: 2, attached: 2 });
    await prisma.phoneNumber.updateMany({
      where: { did: { in: dids } },
      data: { workspaceId: null, status: 'UNASSIGNED' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();

    // Nothing is paused and nobody is notified: the operator configured a
    // rotation, and the numbers may well be back before the next pass.
    expect(result.paused).toBe(0);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('RUNNING');

    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });

  it('leaves the queue exactly where it was', async () => {
    const { campaignId, dids } = await seed({ contacts: 2, attached: 2 });
    await prisma.phoneNumber.updateMany({
      where: { did: { in: dids } },
      data: { workspaceId: null, status: 'UNASSIGNED' },
    });

    await runDialerPass({ now: NOW });

    const contacts = await prisma.campaignContact.findMany({ where: { campaignId } });
    for (const contact of contacts) {
      expect(contact.status).toBe('PENDING');
      expect(contact.lastAttemptAt).toBeNull();
    }
  });
});

describe('a campaign with no rotation at all', () => {
  /**
   * Written before the rotation existed. It still dials, from the legacy
   * pointer, and nothing advances a cursor over a list of one.
   */
  it('falls back to the number the campaign points at', async () => {
    const { campaignId } = await seed({ contacts: 2, attached: 0 });
    const legacy = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: { phoneNumber: true },
    });

    await runDialerPass({ now: NOW });

    expect(fromNumbers()).toEqual([legacy.phoneNumber!.did, legacy.phoneNumber!.did]);

    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(after.rrCursor).toBe(0);
  });

  it('pauses when that number is gone too', async () => {
    const { campaignId } = await seed({ contacts: 2, attached: 0 });
    await prisma.phoneNumber.updateMany({
      where: {},
      data: { workspaceId: null, status: 'UNASSIGNED' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('PAUSED');
  });
});
