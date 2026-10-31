import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneNumber } from '@prisma/client';

// No test may build inbound routing on the live account.
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkInboundReady: vi.fn(async () => ({ ready: true, readiness: { inbound: { ready: true } } })),
  clearPhoneNumberAgent: vi.fn(async () => undefined),
  setAgentInbound: vi.fn(async () => ({})),
  getAgent: vi.fn(async () => ({ inbound: { enabled: true } })),
  getFaceDocumentSyncStatusForStart: vi.fn(),
  updateAgentInbound: vi.fn(async () => ({})),
  getAgentLifecycleHooks: vi.fn(async () => ({ hooks: [] })),
  replaceInboundLifecycleHooks: vi.fn(async () => ({ hooks: [] })),
  getInboundLifecycleHooks: vi.fn(async () => ({ hooks: [] })),
}));

const client = await import('../src/adapter/vocobase.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } = await import('./helpers.js');
const { campaignInWorkspace } = await import('../src/lib/campaign.js');
const { assertInboundStartable, claimInboundDids, releaseInboundClaims, runInboundStart } =
  await import('../src/lib/inboundStart.js');

async function setup(opts: { type: 'OUTBOUND' | 'INBOUND' | 'BOTH'; agentInbound: boolean }) {
  const account = await makeAccount('alice');
  const ws = await makeWorkspace(account, 'A Co');
  const agent = await makeAgent(ws, 'Support');
  if (opts.agentInbound) {
    await prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true } });
  }
  const row = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'C', agentId: agent.id, type: opts.type },
  });
  const campaign = await campaignInWorkspace(ws.id, row.id);
  return { ws, agent, campaign };
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.mocked(client.voicelinkInboundReady).mockResolvedValue({
    ready: true,
    readiness: { inbound: { ready: true } },
  });
  vi.mocked(client.clearPhoneNumberAgent).mockResolvedValue(undefined);
  vi.mocked(client.setAgentInbound).mockResolvedValue({});
  // The platform's read (Vocobase `routes/v2/agent.routes.ts:357-382`): the
  // base record, with the face nested under `inbound.config` when asked for.
  vi.mocked(client.getAgent).mockImplementation(async (_id, opts) =>
    opts?.includeInbound
      ? { prompt: 'Base prompt.', inbound: { enabled: true, config: { prompt: 'Face prompt.' } } }
      : { prompt: 'Base prompt.', inbound: { enabled: true } },
  );
  vi.mocked(client.getFaceDocumentSyncStatusForStart).mockResolvedValue(syncStatus({}));
  vi.mocked(client.updateAgentInbound).mockResolvedValue({});
  vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.mocked(client.replaceInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
});

/**
 * A face document sync summary, shaped as Vocobase builds it
 * (`agent-document.routes.ts:159-166`, inside `{ success, data }` at `:194-200`,
 * which the adapter unwraps). Every count defaults to zero.
 */
function syncStatus(counts: Partial<Record<'total' | 'pending' | 'syncing' | 'synced' | 'failed' | 'deleted', number>>) {
  return {
    agent_id: 'face-internal',
    summary: { total: 0, pending: 0, syncing: 0, synced: 0, failed: 0, deleted: 0, ...counts },
    documents: [],
  };
}

/**
 * Drives a start under fake timers. The start interleaves real database I/O
 * with the face-readiness poll's timers, so advancing the clock alone would
 * stall on the next query: each turn advances one poll interval and then
 * yields to the event loop so the I/O behind it can land.
 */
async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  while (!done) {
    await vi.advanceTimersByTimeAsync(500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return tracked;
}

describe('assertInboundStartable', () => {
  it('is a no-op for an OUTBOUND campaign', async () => {
    const { campaign } = await setup({ type: 'OUTBOUND', agentInbound: false });
    await expect(assertInboundStartable(campaign, [])).resolves.toBeUndefined();
  });

  /**
   * It used to refuse here, and that refusal is what made an agent's inbound
   * face something somebody had to go and find a dropdown for. A
   * uni-directional agent is one persona that answers as readily as it dials;
   * the face is plumbing, and the backend builds it when something first needs
   * it. See `runInboundStart` below for the enable that replaced this gate.
   */
  it('no longer refuses an agent that has no inbound face', async () => {
    const { ws, campaign } = await setup({ type: 'BOTH', agentInbound: false });
    const did = await makePhoneNumber(ws, '+919000000010', 'ASSIGNED');
    await expect(assertInboundStartable(campaign, [did])).resolves.toBeUndefined();
  });

  it('refuses an inbound campaign with no numbers', async () => {
    const { campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    await expect(assertInboundStartable(campaign, [])).rejects.toMatchObject({
      status: 409,
      code: 'CAMPAIGN_INBOUND_DID_REQUIRED',
    });
  });

  it('refuses a number this workspace no longer holds', async () => {
    const { ws, campaign } = await setup({ type: 'BOTH', agentInbound: true });
    // UNASSIGNED: back in the shared pool, not this workspace's to answer on.
    const pool: PhoneNumber = await makePhoneNumber(null, '+919000000011', 'UNASSIGNED');
    await expect(assertInboundStartable(campaign, [pool])).rejects.toMatchObject({
      status: 409,
      code: 'CAMPAIGN_INBOUND_DID_UNAVAILABLE',
    });
  });

  it('resolves for an inbound campaign whose agent and numbers are ready', async () => {
    const { ws, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const did = await makePhoneNumber(ws, '+919000000012', 'ASSIGNED');
    await expect(assertInboundStartable(campaign, [did])).resolves.toBeUndefined();
  });
});

describe('claimInboundDids', () => {
  it('claims every DID or none', async () => {
    const { ws, agent, campaign } = await setup({ type: 'BOTH', agentInbound: true });
    const [didA, didB, didC] = await Promise.all([
      makePhoneNumber(ws, '+919000000020', 'ASSIGNED'),
      makePhoneNumber(ws, '+919000000021', 'ASSIGNED'),
      makePhoneNumber(ws, '+919000000022', 'ASSIGNED'),
    ]);

    // A rival RUNNING campaign already holds the third number.
    const rival = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Rival', agentId: agent.id, type: 'INBOUND' },
    });
    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: didC.id, campaignId: rival.id, agentId: agent.id },
    });

    await expect(claimInboundDids(campaign, [didA, didB, didC])).rejects.toMatchObject({
      code: 'CAMPAIGN_INBOUND_DID_CONFLICT',
    });
    // A and B must NOT be left claimed.
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  it('names the DID and the campaign already holding it', async () => {
    const { ws, agent, campaign } = await setup({ type: 'BOTH', agentInbound: true });
    const did = await makePhoneNumber(ws, '+919000000023', 'ASSIGNED');
    const rival = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Support West', agentId: agent.id, type: 'INBOUND' },
    });
    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: did.id, campaignId: rival.id, agentId: agent.id },
    });

    await expect(claimInboundDids(campaign, [did])).rejects.toMatchObject({
      status: 409,
      code: 'CAMPAIGN_INBOUND_DID_CONFLICT',
      message: expect.stringContaining('Support West'),
    });
  });

  it('claims and provisions each DID on success, sequentially', async () => {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const [didA, didB] = await Promise.all([
      makePhoneNumber(ws, '+919000000024', 'ASSIGNED'),
      makePhoneNumber(ws, '+919000000025', 'ASSIGNED'),
    ]);

    await expect(claimInboundDids(campaign, [didA, didB])).resolves.toBeUndefined();

    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(2);
    expect(vi.mocked(client.voicelinkInboundReady)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.voicelinkInboundReady)).toHaveBeenCalledWith(didA.did, agent.externalId);
  });

  it('releases claims and unbinds when a DID never reaches inbound-ready', async () => {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const didA = await makePhoneNumber(ws, '+919000000026', 'ASSIGNED');
    const didB = await makePhoneNumber(ws, '+919000000027', 'ASSIGNED');
    // Give the DIDs platform ids so the unbind can be asserted.
    await prisma.phoneNumber.update({ where: { id: didA.id }, data: { externalId: 'pext-a' } });
    await prisma.phoneNumber.update({ where: { id: didB.id }, data: { externalId: 'pext-b' } });
    const a = { ...didA, externalId: 'pext-a' };
    const b = { ...didB, externalId: 'pext-b' };

    // First is ready, second never is.
    vi.mocked(client.voicelinkInboundReady)
      .mockResolvedValueOnce({ ready: true, readiness: { inbound: { ready: true } } })
      .mockResolvedValueOnce({ ready: true, readiness: { inbound: { ready: false } } });

    await expect(claimInboundDids(campaign, [a, b])).rejects.toMatchObject({
      status: 409,
      code: 'CAMPAIGN_DID_NOT_INBOUND_READY',
    });

    // Nothing left claimed, and the DID that DID bind is unbound again.
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(vi.mocked(client.clearPhoneNumberAgent)).toHaveBeenCalledWith('pext-a');
  });

  it('re-claims its own DIDs rather than conflicting with itself', async () => {
    // A start that claimed and then failed before the status write, or an exit
    // from RUNNING whose release was missed, leaves this campaign's own rows
    // behind. The next start must take them over, not refuse on them.
    const { ws, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const did = await makePhoneNumber(ws, '+919000000015', 'ASSIGNED');

    await claimInboundDids(campaign, [did]);
    await expect(claimInboundDids(campaign, [did])).resolves.toBeUndefined();

    const claims = await prisma.campaignInboundClaim.findMany({ where: { campaignId: campaign.id } });
    expect(claims).toHaveLength(1);
  });

  it('is a no-op for an OUTBOUND campaign', async () => {
    const { ws, campaign } = await setup({ type: 'OUTBOUND', agentInbound: false });
    const did = await makePhoneNumber(ws, '+919000000028', 'ASSIGNED');
    await expect(claimInboundDids(campaign, [did])).resolves.toBeUndefined();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
  });
});

describe('releaseInboundClaims (exit from RUNNING)', () => {
  it('deletes the claims and unbinds each DID upstream', async () => {
    const { ws, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const did = await makePhoneNumber(ws, '+919000000030', 'ASSIGNED');
    await prisma.phoneNumber.update({ where: { id: did.id }, data: { externalId: 'pext-30' } });
    await claimInboundDids(campaign, [{ ...did, externalId: 'pext-30' }]);
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(1);

    await releaseInboundClaims(campaign.id);

    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(vi.mocked(client.clearPhoneNumberAgent)).toHaveBeenCalledWith('pext-30');
  });

  it('lets a rival claim after release, so resume then conflicts — correctly', async () => {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const did = await makePhoneNumber(ws, '+919000000031', 'ASSIGNED');

    // A holds it, then pauses (releases).
    await claimInboundDids(campaign, [did]);
    await releaseInboundClaims(campaign.id);

    // A rival takes it while A is paused.
    const rival = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Rival', agentId: agent.id, type: 'INBOUND' },
    });
    const rivalRow = await campaignInWorkspace(ws.id, rival.id);
    await expect(claimInboundDids(rivalRow, [did])).resolves.toBeUndefined();

    // A resume now refuses — and that is correct, not a bug.
    await expect(claimInboundDids(campaign, [did])).rejects.toMatchObject({
      code: 'CAMPAIGN_INBOUND_DID_CONFLICT',
    });
  });

  it('is a no-op for a campaign that holds nothing', async () => {
    const { campaign } = await setup({ type: 'OUTBOUND', agentInbound: false });
    await expect(releaseInboundClaims(campaign.id)).resolves.toBeUndefined();
    expect(vi.mocked(client.clearPhoneNumberAgent)).not.toHaveBeenCalled();
  });
});

/**
 * The lazy face: a uni-directional agent pays for a second configuration the
 * first time something actually routes inbound to it, and starting an inbound
 * campaign is that moment. Enabling deep-copies the knowledge base upstream,
 * which is why "a face for every agent" is the wrong default and why this is
 * not done at create time.
 */
describe('runInboundStart creates the face the first time one is needed', () => {
  it('enables the face on an agent that has none, then starts', async () => {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: false });
    const did = await makePhoneNumber(ws, '+919000000040', 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    const withNumber = await campaignInWorkspace(ws.id, campaign.id);

    await runInboundStart(withNumber);

    expect(vi.mocked(client.setAgentInbound)).toHaveBeenCalledWith(agent.externalId, true);
    // And the mirror follows at once rather than waiting for the sync sweep:
    // every later save of this agent has to write both sides, and a stale
    // `false` would leave the face on an older prompt until sync caught up.
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.inboundEnabled).toBe(true);
    // The start went through: the DID is claimed for this campaign.
    const claims = await prisma.campaignInboundClaim.findMany({
      where: { campaignId: campaign.id },
    });
    expect(claims).toHaveLength(1);
  });

  it('does not enable a face the agent already has', async () => {
    const { ws, campaign } = await setup({ type: 'INBOUND', agentInbound: true });
    const did = await makePhoneNumber(ws, '+919000000041', 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    const withNumber = await campaignInWorkspace(ws.id, campaign.id);

    await runInboundStart(withNumber);

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
  });

  /**
   * The code keeps its name and changes its meaning: it used to say "turn
   * Inbound on for this agent first" and now says the platform would not
   * create the face. The campaign must not start either way, and nothing may
   * be claimed — a DID held by a campaign whose agent cannot answer is a
   * number ringing into silence.
   */
  it('refuses the start when the face cannot be created, claiming nothing', async () => {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: false });
    const did = await makePhoneNumber(ws, '+919000000042', 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    const withNumber = await campaignInWorkspace(ws.id, campaign.id);
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.setAgentInbound).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
    );

    await expect(runInboundStart(withNumber)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    const claims = await prisma.campaignInboundClaim.findMany({
      where: { campaignId: campaign.id },
    });
    expect(claims).toHaveLength(0);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.inboundEnabled).toBe(false);
  });

  /**
   * The mirror write lands after the upstream enable, on a row read at the
   * top of the request. An agent deleted in between must not turn the start
   * into a 500 from a missing row: it is the same refusal as any other face
   * that could not be set up, and still claims nothing.
   *
   * It must be the `count === 0` branch that says so, not the catch below it.
   * With `update` in place of `updateMany` the missing row throws P2025, the
   * catch turns that into the same 422 status and code, and a test asserting
   * only those stays green over the regression — so the message and the
   * absence of the catch's log line are what is pinned here.
   */
  it('refuses with 422, not 500, when the agent row vanished before the mirror write', async () => {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: false });
    const did = await makePhoneNumber(ws, '+919000000043', 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    const withNumber = await campaignInWorkspace(ws.id, campaign.id);
    // Gone between the read and the enable.
    await prisma.agent.delete({ where: { id: agent.id } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInboundStart(withNumber)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message: 'This agent could not be set up to receive calls. The agent no longer exists.',
    });
    expect(logged).not.toHaveBeenCalledWith(
      expect.stringContaining('face mirror write failed'),
      expect.anything(),
    );
    logged.mockRestore();

    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    const claims = await prisma.campaignInboundClaim.findMany({
      where: { campaignId: campaign.id },
    });
    expect(claims).toHaveLength(0);
  });

  /**
   * A write that fails outright is not a missing agent, and must not be
   * reported as one: an operator reading "no longer exists" during a database
   * blip goes looking for a deleted agent. Same 422, a neutral message, and
   * the error itself logged rather than dropped.
   */
  it('reports a failed mirror write neutrally and logs it, rather than as a missing agent', async () => {
    const { ws, campaign } = await setup({ type: 'INBOUND', agentInbound: false });
    const did = await makePhoneNumber(ws, '+919000000045', 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    const withNumber = await campaignInWorkspace(ws.id, campaign.id);
    const dbError = new Error('connection lost');
    vi.spyOn(prisma.agent, 'updateMany').mockRejectedValueOnce(dbError);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInboundStart(withNumber)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message: expect.not.stringContaining('no longer exists'),
    });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('face mirror write failed'), dbError);
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    logged.mockRestore();
  });

  /**
   * With the start-time agent gate (G2) gone, the claim's own fail-closed
   * guard is the only thing refusing an inbound campaign that has no agent at
   * all. There is no face to create and nothing to bind a number to, so it is
   * a 409 before any claim. The claim row's NOT NULL agent column would stop
   * the insert anyway; what the guard buys is the shape of the refusal — a
   * named 409 rather than a 500 from a rejected insert.
   */
  it('refuses an inbound campaign with no agent before claiming anything', async () => {
    const account = await makeAccount('alice');
    const ws = await makeWorkspace(account, 'A Co');
    const row = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Orphan', agentId: null, type: 'INBOUND' },
    });
    const did = await makePhoneNumber(ws, '+919000000044', 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: row.id, phoneNumberId: did.id, position: 0 },
    });
    const campaign = await campaignInWorkspace(ws.id, row.id);

    await expect(runInboundStart(campaign)).rejects.toMatchObject({
      status: 409,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
  });

  it('is still a no-op for an OUTBOUND campaign', async () => {
    const { ws, campaign } = await setup({ type: 'OUTBOUND', agentInbound: false });
    const withNumber = await campaignInWorkspace(ws.id, campaign.id);

    await runInboundStart(withNumber);

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
  });
});

/**
 * Re-enabling revives an existing face UNCHANGED — config and hooks included
 * (Vocobase `agentFace.service.ts:426-438`). While a `UNI` agent's face was
 * off, nothing kept it level: the UNI save mirror and the BI→UNI overwrite
 * both skip an agent with no face. So the start that turns it back on would
 * bind numbers to whatever persona the face last had. For a `UNI` agent the
 * face is overwritten from the base — config, then actions — before the
 * readiness wait, and so before anything is bound.
 */
describe('runInboundStart brings a revived face level with the base', () => {
  async function uniCampaign(number: string, direction: 'UNI' | 'BI' = 'UNI') {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: false });
    await prisma.agent.update({ where: { id: agent.id }, data: { direction } });
    const did = await makePhoneNumber(ws, number, 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    return { agent, campaign: await campaignInWorkspace(ws.id, campaign.id) };
  }

  /** The persona the switched-off face still holds, revived by the enable. */
  const STALE_FACE = {
    prompt: 'An inbound persona from before the face was switched off.',
    intro_message: 'Hello from the old face.',
  };

  /**
   * The base as `GET /agent/:id` answers it (Vocobase
   * `routes/v2/agent.routes.ts:374-382`), with the revived face nested as
   * `inbound: { enabled, config }` on the `?include=inbound` read (`:357-382`),
   * and the base's hooks as the bare `{ hooks }` of
   * `routes/v2/lifecycle-hooks.routes.ts:64-67`.
   */
  function baseOnPlatform(face: Record<string, unknown> | null = STALE_FACE) {
    const base = {
      agent_name: 'Support',
      prompt: 'The prompt the operator wrote last week.',
      intro_message: 'Hello from the base.',
    };
    vi.mocked(client.getAgent).mockImplementation(async (_id, opts) =>
      opts?.includeInbound && face
        ? { ...base, inbound: { enabled: true, config: face } }
        : { ...base, inbound: { enabled: true } },
    );
    // The revived face's own actions (`inbound-lifecycle-hooks.routes.ts:130-135`, unwrapped).
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'fh-1',
          agentId: 'ext',
          stage: 'PRE_CALL',
          position: 0,
          toolSlug: 'google_sheets',
          toolFn: 'lookup_row',
          functionId: null,
          name: 'Old caller lookup',
          input: { spreadsheetId: 'sheet-old' },
          exposeAs: 'caller',
          skipUnless: [],
          required: false,
          timeoutMs: 3000,
          enabled: true,
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z',
        },
      ],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'bh-1',
          agentId: 'ext',
          stage: 'POST_CALL',
          position: 0,
          toolSlug: null,
          toolFn: null,
          functionId: 'fn-crm',
          name: 'Push to CRM',
          input: {},
          exposeAs: null,
          skipUnless: ['extraction.callback_at'],
          required: false,
          timeoutMs: 3000,
          enabled: false,
          createdAt: '2026-09-20T10:00:00.000Z',
          updatedAt: '2026-09-20T10:00:00.000Z',
        },
      ],
    });
  }

  it('overwrites the face config and actions with the base before waiting on it', async () => {
    const { agent, campaign } = await uniCampaign('+919000000060');
    baseOnPlatform();

    await runInboundStart(campaign);

    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    const [configId, config] = vi.mocked(client.updateAgentInbound).mock.calls[0];
    expect(configId).toBe(agent.externalId);
    expect(config).toMatchObject({
      prompt: 'The prompt the operator wrote last week.',
      intro_message: 'Hello from the base.',
    });
    expect(config).not.toHaveProperty('agent_name');

    expect(vi.mocked(client.replaceInboundLifecycleHooks)).toHaveBeenCalledWith(agent.externalId, [
      {
        stage: 'POST_CALL',
        name: 'Push to CRM',
        functionId: 'fn-crm',
        input: {},
        required: false,
        timeoutMs: 3000,
        enabled: false,
        skipUnless: ['extraction.callback_at'],
      },
    ]);

    // Enable → config → actions → readiness → bind.
    const order = (fn: unknown) =>
      (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(order(client.setAgentInbound)).toBeLessThan(order(client.updateAgentInbound));
    expect(order(client.updateAgentInbound)).toBeLessThan(order(client.replaceInboundLifecycleHooks));
    expect(order(client.replaceInboundLifecycleHooks)).toBeLessThan(
      order(client.getFaceDocumentSyncStatusForStart),
    );
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  /**
   * The overwrite above destroys whatever the revived face held, and nobody
   * is asked: it is an automatic path. So it is saved first, and a face that
   * cannot be saved is not overwritten and not bound.
   */
  it('snapshots the revived face before overwriting it', async () => {
    const { agent, campaign } = await uniCampaign('+919000000064');
    baseOnPlatform();
    let snapshotsAtWrite: number | undefined;
    vi.mocked(client.updateAgentInbound).mockImplementation(async () => {
      snapshotsAtWrite ??= await prisma.agentPersonaSnapshot.count();
      return {};
    });

    await runInboundStart(campaign);

    const snaps = await prisma.agentPersonaSnapshot.findMany();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      side: 'INBOUND',
      reason: 'INBOUND_START_REVIVE',
      takenByUserId: null,
    });
    expect((snaps[0].config as Record<string, unknown>).prompt).toBe(STALE_FACE.prompt);
    expect((snaps[0].hooks as Array<{ name: string }>).map((h) => h.name)).toEqual([
      'Old caller lookup',
    ]);
    expect(snapshotsAtWrite).toBe(1);
  });

  it('refuses the start, overwriting and claiming nothing, when the face cannot be read to save it', async () => {
    const { campaign } = await uniCampaign('+919000000065');
    baseOnPlatform(null);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInboundStart(campaign)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    logged.mockRestore();
  });

  it('refuses the start when the snapshot cannot be written', async () => {
    const { campaign } = await uniCampaign('+919000000066');
    baseOnPlatform();
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('connection reset'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInboundStart(campaign)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    logged.mockRestore();
    vi.mocked(prisma.$transaction).mockRestore();
  });

  /**
   * A `BI` agent's face is somebody's own persona. Staff may have switched it
   * off; switching it back on must bring back what they wrote, not the base.
   */
  it("leaves a BI agent's revived face as it was", async () => {
    const { campaign } = await uniCampaign('+919000000061', 'BI');
    baseOnPlatform();

    await runInboundStart(campaign);

    expect(vi.mocked(client.setAgentInbound)).toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    // Nothing is overwritten, so nothing is saved.
    expect(await prisma.agentPersonaSnapshot.count()).toBe(0);
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  /**
   * Fail closed, unlike the direction route's best effort: this start is about
   * to bind live numbers, and a face that could not be brought level would
   * answer them with the stale persona this exists to prevent.
   */
  it('refuses the start, claiming nothing, when the face cannot be overwritten', async () => {
    const { campaign } = await uniCampaign('+919000000062');
    baseOnPlatform();
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.replaceInboundLifecycleHooks).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED' as never, 'One or more hooks are invalid'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInboundStart(campaign)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).not.toHaveBeenCalled();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    logged.mockRestore();
  });

  it('refuses the start when the face config cannot be overwritten', async () => {
    const { campaign } = await uniCampaign('+919000000063');
    baseOnPlatform();
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.updateAgentInbound).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runInboundStart(campaign)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    logged.mockRestore();
  });
});

/**
 * The platform's enable answers before the face is usable. It commits the face
 * — and the parent's `inboundEnabled` — in one transaction and only then
 * queues the copied knowledge-base documents `PENDING` (Vocobase
 * `agentFace.service.ts:604-607`, `:616-636`), so the agent read says "enabled"
 * on the very first try while the face still cannot answer out of its KB. The
 * start therefore waits on the face's document sync signal instead:
 * `summary.pending + summary.syncing === 0`, half a second apart, for at most
 * fifteen seconds of wall time with every read bounded by what is left.
 *
 * Every summary below has the shape `agent-document.routes.ts:159-166` builds.
 */
describe('runInboundStart waits for the face before binding numbers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function inboundCampaign(number: string) {
    const { ws, agent, campaign } = await setup({ type: 'INBOUND', agentInbound: false });
    const did = await makePhoneNumber(ws, number, 'ASSIGNED');
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
    });
    return { ws, agent, campaign: await campaignInWorkspace(ws.id, campaign.id) };
  }

  it('polls the face documents until none is pending or syncing, then claims', async () => {
    const { agent, campaign } = await inboundCampaign('+919000000050');
    vi.mocked(client.getFaceDocumentSyncStatusForStart)
      .mockResolvedValueOnce(syncStatus({ total: 2, pending: 2 }))
      .mockResolvedValueOnce(syncStatus({ total: 2, pending: 1, syncing: 1 }))
      .mockResolvedValueOnce(syncStatus({ total: 2, synced: 2 }));

    await settle(runInboundStart(campaign));

    expect(vi.mocked(client.setAgentInbound)).toHaveBeenCalledWith(agent.externalId, true);
    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).toHaveBeenCalledWith(
      agent.externalId,
    );
    // The knowledge base is confirmed before the number is bound to the agent.
    const readyOrder = vi.mocked(client.getFaceDocumentSyncStatusForStart).mock
      .invocationCallOrder[2];
    const bindOrder = vi.mocked(client.voicelinkInboundReady).mock.invocationCallOrder[0];
    expect(readyOrder).toBeLessThan(bindOrder);
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(1);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.inboundEnabled).toBe(true);
  });

  it('proceeds on one read when the face has no knowledge base at all', async () => {
    const { campaign } = await inboundCampaign('+919000000055');
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockResolvedValue(syncStatus({}));

    await settle(runInboundStart(campaign));

    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).toHaveBeenCalledTimes(1);
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it('refuses the start when documents are still pending at fifteen seconds, claiming nothing', async () => {
    const { agent, campaign } = await inboundCampaign('+919000000051');
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockResolvedValue(
      syncStatus({ total: 3, synced: 1, pending: 2 }),
    );
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(settle(runInboundStart(campaign))).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message: 'The inbound configuration is still being prepared; try again in a minute',
    });

    // A read at every half second from 0 s to 14.5 s: the next would start
    // with nothing of the fifteen seconds left.
    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).toHaveBeenCalledTimes(30);
    // The number to tune the bound by: how long the platform took is the one
    // thing the 422 cannot say.
    expect(warned).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${agent.externalId}.*30 reads`)),
    );
    warned.mockRestore();
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: campaign.id } })).toBe(0);
    // The mirror is not written for a face that never became ready.
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.inboundEnabled).toBe(false);
  });

  /**
   * A body the adapter unwrapped but that carries no summary must not read as
   * "zero pending": that is the empty answer the wait exists to not take.
   */
  it('keeps waiting, and refuses at the deadline, when the summary is unreadable', async () => {
    const { campaign } = await inboundCampaign('+919000000059');
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockResolvedValue({});
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(settle(runInboundStart(campaign))).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message: 'The inbound configuration is still being prepared; try again in a minute',
    });

    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    warned.mockRestore();
  });

  /**
   * A document that failed to sync will not recover by waiting — the face
   * would answer without it. Its own refusal, naming the remedy, rather than
   * the "try again in a minute" that would send the operator round again.
   */
  it('refuses with the failed-documents message once the sync settles with failures', async () => {
    const { campaign } = await inboundCampaign('+919000000056');
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockResolvedValue(
      syncStatus({ total: 2, synced: 1, failed: 1 }),
    );

    await expect(settle(runInboundStart(campaign))).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message:
        "Some of this agent's documents could not be prepared for inbound calls; " +
        're-upload them and try again',
    });

    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
  });

  /**
   * The bound is on wall time, and each read is bounded by what is left of
   * it: a read the platform never answers must not hold the start for the
   * adapter's own timeout on top of the fifteen seconds.
   */
  it('refuses at about fifteen seconds when a read never resolves', async () => {
    const { campaign } = await inboundCampaign('+919000000057');
    let readBegan = 0;
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockImplementation(() => {
      readBegan = Date.now();
      return new Promise(() => undefined);
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let refusedAt = 0;
    const start = runInboundStart(campaign).catch((err: unknown) => {
      refusedAt = Date.now();
      throw err;
    });

    await expect(settle(start)).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message: 'The inbound configuration is still being prepared; try again in a minute',
    });

    // Measured from the read, since the fake clock also runs while the
    // start's own database work is in flight: the hung read is abandoned at
    // the deadline, within one poll step of fifteen seconds.
    expect(refusedAt - readBegan).toBeGreaterThanOrEqual(15_000);
    expect(refusedAt - readBegan).toBeLessThanOrEqual(15_500);
    expect(vi.mocked(client.getFaceDocumentSyncStatusForStart)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    warned.mockRestore();
  });

  it('refuses with the documented 422, not a 502, when a read rejects mid-poll', async () => {
    const { campaign } = await inboundCampaign('+919000000058');
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.getFaceDocumentSyncStatusForStart)
      .mockResolvedValueOnce(syncStatus({ total: 1, pending: 1 }))
      .mockRejectedValueOnce(
        new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
      );
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(settle(runInboundStart(campaign))).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
      message: 'The inbound configuration is still being prepared; try again in a minute',
    });

    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);
    logged.mockRestore();
  });

  /**
   * With each read costing 300 ms, no read may begin more than fifteen seconds
   * after the first one. Measured from the reads themselves, since the fake
   * clock also runs while the start's own database work is in flight.
   */
  it('begins no read more than fifteen seconds after the first, even when reads are slow', async () => {
    const { campaign } = await inboundCampaign('+919000000054');
    const readStarts: number[] = [];
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockImplementation(async () => {
      readStarts.push(Date.now());
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      return syncStatus({ total: 1, syncing: 1 });
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(settle(runInboundStart(campaign))).rejects.toMatchObject({
      status: 422,
      code: 'AGENT_INBOUND_NOT_ENABLED',
    });

    const span = readStarts[readStarts.length - 1] - readStarts[0];
    expect(span).toBeLessThanOrEqual(15_000);
    // 800 ms per cycle (300 ms read + 500 ms sleep): well under thirty reads.
    expect(readStarts.length).toBeLessThan(30);
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it('lets two concurrent starts on the same agent both wait for the face', async () => {
    const { ws, agent, campaign: first } = await inboundCampaign('+919000000052');
    const didB = await makePhoneNumber(ws, '+919000000053', 'ASSIGNED');
    const secondRow = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'D', agentId: agent.id, type: 'INBOUND' },
    });
    await prisma.campaignPhoneNumber.create({
      data: { campaignId: secondRow.id, phoneNumberId: didB.id, position: 0 },
    });
    const second = await campaignInWorkspace(ws.id, secondRow.id);
    let ready = false;
    vi.mocked(client.getFaceDocumentSyncStatusForStart).mockImplementation(async () =>
      ready ? syncStatus({ total: 1, synced: 1 }) : syncStatus({ total: 1, pending: 1 }),
    );
    const reads = () => vi.mocked(client.getFaceDocumentSyncStatusForStart).mock.calls.length;

    const both = Promise.all([runInboundStart(first), runInboundStart(second)]);
    both.catch(() => undefined);
    // Each start saves the face before it overwrites it — real database I/O,
    // which the fake-timer turns below do not wait for. Let both land first.
    for (let turn = 0; turn < 200 && (await prisma.agentPersonaSnapshot.count()) < 2; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Wait until both starts are demonstrably polling (two reads each), then
    // check neither has claimed while the documents are still pending.
    for (let turn = 0; turn < 40 && reads() < 4; turn++) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(reads()).toBeGreaterThanOrEqual(4);
    expect(vi.mocked(client.voicelinkInboundReady)).not.toHaveBeenCalled();
    expect(await prisma.campaignInboundClaim.count()).toBe(0);

    ready = true;
    await settle(both);

    expect(vi.mocked(client.voicelinkInboundReady)).toHaveBeenCalledTimes(2);
    expect(await prisma.campaignInboundClaim.count()).toBe(2);
  });
});
