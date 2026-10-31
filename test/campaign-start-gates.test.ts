import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  // The callback extraction key, ensured on every start and resume. Stubbed as
  // "already set up" so these cases exercise the transition rather than it.
  listExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  attachAgentExtractionSet: vi.fn(),
  detachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(async () => ({ extraction_enabled: true })),
  updateAgent: vi.fn(),
}));

const {
  voicelinkCallReady,
  createExtractionSet,
  getAgent,
  listAgentExtractionSets,
  listExtractionSets,
  updateAgent,
} = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { NOTE_BLOCK_START } = await import('../src/lib/goalPromptBlock.js');
const { truncateAll } = await import('./setup.js');
const { as, makeAccount, makeAgent, makeDialable, makeWorkspace } = await import('./helpers.js');
const { withGoalBlock } = await import('../src/lib/goalPromptBlock.js');

const mockedCallReady = vi.mocked(voicelinkCallReady);
const mockedCreateSet = vi.mocked(createExtractionSet);
const mockedGetAgent = vi.mocked(getAgent);
const mockedListAgentSets = vi.mocked(listAgentExtractionSets);
const mockedListSets = vi.mocked(listExtractionSets);
const mockedUpdateAgent = vi.mocked(updateAgent);
const app = createApp();
const AUTH = as('user_alice', 'alice@ezo.test');

const READY = { ready: true, readiness: { state: 'READY', issues: [] } };

async function startable() {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const agent = await makeAgent(ws, 'Sales');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210' },
  });
  await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: contact.id } });
  const did = await makeDialable(ws, campaign, agent);

  return { alice, ws, campaign, agent, did };
}

const start = (ws: string, campaign: string) =>
  request(app).post(`/api/workspaces/${ws}/campaigns/${campaign}/start`).set(...AUTH);

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  mockedCallReady.mockResolvedValue(READY);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

describe('starting a campaign that can dial', () => {
  it('starts, and makes its number outbound-ready upstream', async () => {
    const { ws, campaign, did } = await startable();

    const res = await start(ws.id, campaign.id);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RUNNING');
    // Done at start rather than at rent time: renting creates nothing upstream,
    // and a number nobody dials from should not have routing built for it.
    expect(mockedCallReady).toHaveBeenCalledWith(did.did);
  });

  /**
   * `NO_VOCOBASE_AGENT` governs *inbound* routing on the platform's own number
   * row. This dialer places outbound calls with an explicit from_number and an
   * explicit agent_id, so refusing on it would make every campaign unstartable
   * for a reason that does not apply to it.
   */
  it('starts when the only outstanding readiness issue is an inbound one', async () => {
    mockedCallReady.mockResolvedValue({
      ready: false,
      readiness: { state: 'NO_VOCOBASE_AGENT', issues: ['NO_VOCOBASE_AGENT'] },
    });
    const { ws, campaign } = await startable();

    await expect(start(ws.id, campaign.id)).resolves.toMatchObject({ status: 200 });
  });

  it('starts despite a readiness state this platform has never seen', async () => {
    // The readiness vocabulary is the platform's and it grows. Turning next
    // month's new state into a hard refusal would stop every campaign starting
    // for a reason nobody here has considered.
    mockedCallReady.mockResolvedValue({
      ready: false,
      readiness: { state: 'SOMETHING_NEW', issues: ['SOMETHING_NEW'] },
    });
    const { ws, campaign } = await startable();

    await expect(start(ws.id, campaign.id)).resolves.toMatchObject({ status: 200 });
  });
});

describe('the local gates', () => {
  /**
   * The property that matters most across this whole describe block: a start
   * that is going to be refused writes nothing to a partner account every
   * customer on the platform shares.
   */
  const refusesWithoutTouchingUpstream = async (
    setup: () => Promise<{ wsId: string; campaignId: string }>,
    status: number,
    code: string,
  ) => {
    const { wsId, campaignId } = await setup();

    const res = await start(wsId, campaignId);

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(mockedCallReady).not.toHaveBeenCalled();

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(stored.status).toBe('DRAFT');
  };

  it('refuses when the dialer is switched off', async () => {
    vi.resetModules();
    process.env.DIALER_ENABLED = 'false';

    const { createApp: build } = await import('../src/app.js');
    const disabledApp = build();

    const { ws, campaign } = await startable();

    const res = await request(disabledApp)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIALER_DISABLED');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');

    vi.resetModules();
    process.env.DIALER_ENABLED = 'true';
  });

  it('refuses without a caller number', async () => {
    await refusesWithoutTouchingUpstream(
      async () => {
        const { ws, campaign } = await startable();
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { phoneNumberId: null },
        });
        return { wsId: ws.id, campaignId: campaign.id };
      },
      409,
      'CAMPAIGN_PHONE_NUMBER_REQUIRED',
    );
  });

  it('refuses when the caller number has gone back to the pool', async () => {
    await refusesWithoutTouchingUpstream(
      async () => {
        const { ws, campaign, did } = await startable();
        await prisma.phoneNumber.update({
          where: { id: did.id },
          data: { workspaceId: null, status: 'UNASSIGNED' },
        });
        return { wsId: ws.id, campaignId: campaign.id };
      },
      409,
      'CAMPAIGN_PHONE_NUMBER_REQUIRED',
    );
  });

  it('refuses on a half-configured dialing window', async () => {
    await refusesWithoutTouchingUpstream(
      async () => {
        const { ws, campaign } = await startable();
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { fromTime: '09:00', timezone: 'Asia/Kolkata' },
        });
        return { wsId: ws.id, campaignId: campaign.id };
      },
      409,
      'CAMPAIGN_WINDOW_INCOMPLETE',
    );
  });

  it('refuses when calling is not priced for the account', async () => {
    await refusesWithoutTouchingUpstream(
      async () => {
        const { ws, campaign } = await startable();
        // Unpriced is not free: a call placed at an unknown price is a call
        // whose cost is decided after the money is spent.
        await prisma.tier.updateMany({ where: {}, data: { defaultPriceCreditsPerMin: null } });
        return { wsId: ws.id, campaignId: campaign.id };
      },
      409,
      'CAMPAIGN_RATE_UNAVAILABLE',
    );
  });

  it('refuses when the owner cannot cover the minimum float', async () => {
    await refusesWithoutTouchingUpstream(
      async () => {
        const { ws, campaign, alice } = await startable();
        await prisma.account.update({ where: { id: alice.id }, data: { credits: 0n } });
        return { wsId: ws.id, campaignId: campaign.id };
      },
      402,
      'INSUFFICIENT_CREDITS',
    );
  });
});

describe('when the number is not call-ready', () => {
  it('refuses and names the missing step', async () => {
    mockedCallReady.mockResolvedValue({
      ready: false,
      readiness: { state: 'ROUTING_MISSING', issues: ['ROUTING_MISSING'] },
    });
    const { ws, campaign } = await startable();

    const res = await start(ws.id, campaign.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_DID_NOT_CALL_READY');
    expect(res.body.error.message).toMatch(/routed/i);
  });

  /**
   * Which supplier sits under this product is not something a customer learns
   * from an error — the same two-registers rule every other message here
   * follows.
   */
  it('names no supplier in any refusal', async () => {
    for (const issue of ['NO_CLIENT_MAPPING', 'NO_BOT', 'ROUTING_MISSING', 'REMOTE_DID_EXPIRED']) {
      await truncateAll();
      mockedCallReady.mockResolvedValue({ ready: false, readiness: { state: issue, issues: [issue] } });
      const { ws, campaign } = await startable();

      const res = await start(ws.id, campaign.id);

      expect(res.status).toBe(409);
      expect(res.body.error.message).not.toMatch(/vocobase|voicelink/i);
    }
  });

  it('leaves the campaign in its previous state', async () => {
    mockedCallReady.mockResolvedValue({
      ready: false,
      readiness: { state: 'NO_BOT', issues: ['NO_BOT'] },
    });
    const { ws, campaign } = await startable();

    await start(ws.id, campaign.id);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');
  });
});

describe('resume', () => {
  /**
   * `resume` reaches exactly the state `start` does, so it must pass exactly
   * the same gates. Two lists would eventually let one of them through with
   * fewer checks.
   */
  it('enforces the same gates as start', async () => {
    const { ws, campaign, alice } = await startable();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 0n } });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/resume`)
      .set(...AUTH);

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(mockedCallReady).not.toHaveBeenCalled();
  });

  it('readies the number again on resume', async () => {
    const { ws, campaign, did } = await startable();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });

    await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/resume`)
      .set(...AUTH);

    // Idempotent upstream, so re-running it costs nothing and covers a number
    // whose routing changed while the campaign was paused.
    expect(mockedCallReady).toHaveBeenCalledWith(did.did);
  });
});

describe('pause and stop', () => {
  it('record who halted the campaign, and resume clears it', async () => {
    const { ws, campaign } = await startable();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    const paused = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/pause`)
      .set(...AUTH);
    expect(paused.status).toBe(200);
    expect(paused.body.data.haltReason).toMatch(/^Paused by .+@.+\.$/);

    const resumed = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/resume`)
      .set(...AUTH);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.haltReason).toBeNull();

    const stopped = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stop`)
      .set(...AUTH);
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.haltReason).toMatch(/^Stopped by .+@.+\.$/);

    // The relabel retires the stop and its sentence with it.
    const completed = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/complete`)
      .set(...AUTH);
    expect(completed.status).toBe(200);
    expect(completed.body.data.haltReason).toBeNull();
  });

  it('never reach the platform', async () => {
    const { ws, campaign } = await startable();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    await request(app).post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/pause`).set(...AUTH);
    await request(app).post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stop`).set(...AUTH);

    // Stopping dialing is a local decision. Nothing upstream needs to know,
    // and a stop that depended on the platform being reachable would be a stop
    // that fails when it is most needed.
    expect(mockedCallReady).not.toHaveBeenCalled();
  });
});

/**
 * What a **goal** campaign's start does upstream beyond readying the number:
 * the call-note set on the agent, and the managed block in its prompt.
 *
 * Both are needed together and neither is optional for a goal campaign. The
 * platform substitutes only the `{{variables}}` a prompt actually names, so
 * without the block the goal, the memory and the last-call note reach nobody
 * however faithfully the dial carries them; without the set the call comes
 * back with no judgement on the goal at all.
 */
describe('a goal campaign start', () => {
  const withGoal = async () => {
    const seeded = await startable();
    await prisma.campaign.update({
      where: { id: seeded.campaign.id },
      data: { goalEnabled: true },
    });
    return seeded;
  };

  it('attaches the call-note set and writes the prompt block', async () => {
    const { ws, campaign } = await withGoal();
    mockedListSets.mockResolvedValue({ extraction_sets: [] });
    mockedListAgentSets.mockResolvedValue({ extraction_sets: [] });
    mockedCreateSet.mockResolvedValue({ id: 'set_goal' });
    mockedGetAgent.mockResolvedValue({ prompt: 'You are Asha.', extraction_enabled: true });
    mockedUpdateAgent.mockResolvedValue({});

    const res = await start(ws.id, campaign.id);

    expect(res.status).toBe(200);
    // Fingerprinted: the set's name carries a hash of its keys and their
    // descriptions, so an edit to the managed set reaches the platform as a
    // new set rather than being silently ignored on a name that already
    // exists. Matched as a pattern for that reason — pinning the literal hash
    // would make every description edit a test edit.
    expect(mockedCreateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^Campaign call note \([0-9a-f]{8}\)$/),
      }),
    );
    // The constant, not a literal: the marker is renameable and this assertion
    // is about the block being written, not about what it is called. The
    // wording itself is pinned in `goal-prompt-block.test.ts`.
    expect(mockedUpdateAgent).toHaveBeenCalledWith(
      expect.any(String),
      { prompt: expect.stringContaining(NOTE_BLOCK_START) },
    );
  });

  /** The write is idempotent, which is what makes it safe on every start and
   *  every resume: a prompt already carrying the block costs one read. */
  it('rewrites nothing when the block is already there', async () => {
    const { ws, campaign } = await withGoal();
    mockedListSets.mockResolvedValue({ extraction_sets: [] });
    mockedListAgentSets.mockResolvedValue({ extraction_sets: [] });
    mockedCreateSet.mockResolvedValue({ id: 'set_goal' });
    mockedGetAgent.mockResolvedValue({
      prompt: withGoalBlock('You are Asha.'),
      extraction_enabled: true,
    });

    await expect(start(ws.id, campaign.id)).resolves.toMatchObject({ status: 200 });

    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  /**
   * Every start prepares, whatever the stored switches say.
   *
   * A campaign with both columns `false` used to need nothing on its agent, so
   * the start wrote nothing. It follows every conversation up since
   * 2026-09-06, and a start that skipped the attach would leave it dialing
   * with an agent that cannot leave a note, book a callback or hear an
   * opt-out. The set is attached and the managed block written, exactly as for
   * a campaign whose columns say `true`.
   */
  it('a start attaches the note set whatever the stored switches say', async () => {
    const { ws, campaign } = await startable();
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { goalEnabled: false, callbackEnabled: false },
    });
    mockedListSets.mockResolvedValue({ extraction_sets: [] });
    mockedListAgentSets.mockResolvedValue({ extraction_sets: [] });
    mockedCreateSet.mockResolvedValue({ id: 'set_goal' });
    mockedGetAgent.mockResolvedValue({ prompt: 'You are Asha.', extraction_enabled: true });

    await expect(start(ws.id, campaign.id)).resolves.toMatchObject({ status: 200 });

    expect(mockedCreateSet).toHaveBeenCalled();
    expect(mockedUpdateAgent).toHaveBeenCalled();
  });
});

/**
 * The preflight report: the same five local gates, read out instead of thrown.
 *
 * The point of putting these in this file rather than their own is the
 * anti-drift case below. A report assembled from a second copy of the rules
 * would pass its own tests forever while diverging from the refusal that
 * actually stops a start, so every case here drives both doors from one
 * fixture and compares them.
 */
describe('the preflight report', () => {
  const preflight = (ws: string, campaign: string) =>
    request(app).get(`/api/workspaces/${ws}/campaigns/${campaign}/preflight`).set(...AUTH);

  /** Every local gate, with the refusal `start` raises for it. */
  const BLOCKERS: {
    name: string;
    key: string;
    code: string;
    status: number;
    setup: () => Promise<{ wsId: string; campaignId: string }>;
  }[] = [
    {
      name: 'no caller number',
      key: 'caller_number',
      code: 'CAMPAIGN_PHONE_NUMBER_REQUIRED',
      status: 409,
      setup: async () => {
        const { ws, campaign } = await startable();
        await prisma.campaign.update({ where: { id: campaign.id }, data: { phoneNumberId: null } });
        return { wsId: ws.id, campaignId: campaign.id };
      },
    },
    {
      name: 'a caller number back in the pool',
      key: 'caller_number',
      code: 'CAMPAIGN_PHONE_NUMBER_REQUIRED',
      status: 409,
      setup: async () => {
        const { ws, campaign, did } = await startable();
        await prisma.phoneNumber.update({
          where: { id: did.id },
          data: { workspaceId: null, status: 'UNASSIGNED' },
        });
        return { wsId: ws.id, campaignId: campaign.id };
      },
    },
    {
      name: 'a half-configured dialing window',
      key: 'dialing_window',
      code: 'CAMPAIGN_WINDOW_INCOMPLETE',
      status: 409,
      setup: async () => {
        const { ws, campaign } = await startable();
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { fromTime: '09:00', timezone: 'Asia/Kolkata' },
        });
        return { wsId: ws.id, campaignId: campaign.id };
      },
    },
    {
      name: 'calling not priced for the account',
      key: 'voice_tier',
      code: 'CAMPAIGN_RATE_UNAVAILABLE',
      status: 409,
      setup: async () => {
        const { ws, campaign } = await startable();
        await prisma.tier.updateMany({ where: {}, data: { defaultPriceCreditsPerMin: null } });
        return { wsId: ws.id, campaignId: campaign.id };
      },
    },
    {
      name: 'an owner who cannot cover the minimum float',
      key: 'credits',
      code: 'INSUFFICIENT_CREDITS',
      status: 402,
      setup: async () => {
        const { ws, campaign, alice } = await startable();
        await prisma.account.update({ where: { id: alice.id }, data: { credits: 0n } });
        return { wsId: ws.id, campaignId: campaign.id };
      },
    },
  ];

  it('reports every gate as ok on a campaign that can start', async () => {
    const { ws, campaign } = await startable();

    const res = await preflight(ws.id, campaign.id);

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.checks).toHaveLength(5);
    expect(res.body.data.checks.map((c: { key: string }) => c.key)).toEqual([
      'dialer',
      'caller_number',
      'dialing_window',
      'voice_tier',
      'credits',
    ]);
    for (const check of res.body.data.checks) {
      expect(check.status).toBe('ok');
      expect(check.detail).toBeNull();
      expect(check.code).toBeNull();
    }
  });

  for (const blocker of BLOCKERS) {
    it(`names ${blocker.name} as the blocked gate`, async () => {
      const { wsId, campaignId } = await blocker.setup();

      const res = await preflight(wsId, campaignId);

      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(false);

      const blocked = res.body.data.checks.filter(
        (c: { status: string }) => c.status === 'blocked',
      );
      expect(blocked.map((c: { key: string }) => c.key)).toContain(blocker.key);

      const named = blocked.find((c: { key: string }) => c.key === blocker.key)!;
      expect(named.code).toBe(blocker.code);
      // A sentence the operator can act on, not an empty string.
      expect(named.detail).toBeTruthy();

      // Still a full report: a blocked gate does not truncate the rest.
      expect(res.body.data.checks).toHaveLength(5);
    });

    /**
     * The anti-drift property, and the reason this endpoint exists on the
     * server at all: the first gate the report calls blocked is the exact
     * refusal `start` raises, for the same campaign.
     */
    it(`agrees with what start refuses for ${blocker.name}`, async () => {
      const { wsId, campaignId } = await blocker.setup();

      const report = await preflight(wsId, campaignId);
      const firstBlocked = report.body.data.checks.find(
        (c: { status: string }) => c.status === 'blocked',
      )!;

      const refused = await start(wsId, campaignId);

      expect(refused.status).toBe(blocker.status);
      expect(refused.body.error.code).toBe(firstBlocked.code);
    });
  }

  it('changes nothing and never reaches the platform', async () => {
    const { ws, campaign } = await startable();

    await preflight(ws.id, campaign.id);

    expect(mockedCallReady).not.toHaveBeenCalled();
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
    expect(mockedCreateSet).not.toHaveBeenCalled();

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');
  });

  it('reports the dialer switch, which no operator can clear', async () => {
    vi.resetModules();
    process.env.DIALER_ENABLED = 'false';

    const { createApp: build } = await import('../src/app.js');
    const disabledApp = build();

    const { ws, campaign } = await startable();

    const res = await request(disabledApp)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/preflight`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);

    const dialer = res.body.data.checks.find((c: { key: string }) => c.key === 'dialer')!;
    expect(dialer.status).toBe('blocked');
    expect(dialer.code).toBe('DIALER_DISABLED');

    vi.resetModules();
    process.env.DIALER_ENABLED = 'true';
  });
});
