import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CampaignStatus } from '@prisma/client';

/**
 * The agent preparation a mid-campaign edit is responsible for: none of it.
 *
 * `prepareCampaignAgent` attaches the managed extraction set and writes the
 * managed block into the agent's prompt, and this route used to run it
 * whenever an edit turned a switch ON after the campaign had started: the
 * preparation was tied to the TRANSITION rather than to the setting that
 * needed it, so a campaign could be left dialing with an agent that could not
 * answer the questions its new setting depended on.
 *
 * Neither switch moves any more. `callbackEnabled` is accepted and never
 * written; `goalEnabled` is written and read by nothing, because every
 * campaign follows a conversation up. So a PATCH prepares nothing, and the
 * invariant is held where the work always happened — `start`, `resume`, and
 * the boot sweep, which re-prepares every RUNNING campaign.
 *
 * This file is negatives now, and they earn their place: the mistake this
 * guards against is preparing on PRESENCE rather than on change, which would
 * spend six upstream calls per keystroke-sized save, on the partner account
 * every YE customer shares. The dashboard posts the whole form back on every
 * save, so that is one careless condition away at all times.
 *
 * Mocked whole, as `campaign-agent-sweep.test.ts` mocks it: what this asserts
 * is WHICH edits prepare, which is a property of the route rather than of the
 * six upstream calls. `campaign-extraction.test.ts` owns those.
 */
vi.mock('../src/services/campaignExtraction.js', () => ({
  prepareCampaignAgent: vi.fn(),
}));

const extraction = await import('../src/services/campaignExtraction.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { as, makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const prepare = vi.mocked(extraction.prepareCampaignAgent);
const app = createApp();
const AUTH = as('user_alice', 'alice@ezo.test');

async function seed(
  status: CampaignStatus,
  fields: { goalEnabled?: boolean; callbackEnabled?: boolean; agent?: boolean } = {},
) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const agent = fields.agent === false ? null : await makeAgent(ws, 'Sales');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Q3',
      status,
      agentId: agent?.id ?? null,
      goalEnabled: fields.goalEnabled ?? false,
      callbackEnabled: fields.callbackEnabled ?? false,
      ...(status === 'STOPPED' ? { stoppedAt: new Date() } : {}),
    },
  });

  return { ws, agent, campaign };
}

const patch = (ws: string, campaign: string, body: unknown) =>
  request(app)
    .patch(`/api/workspaces/${ws}/campaigns/${campaign}`)
    .set(...AUTH)
    .send(body);

beforeEach(async () => {
  await truncateAll();
  prepare.mockReset();
});

afterEach(async () => {
  await truncateAll();
});

describe('an edit after the campaign started', () => {
  for (const status of ['PAUSED', 'CREDIT_EXHAUSTED'] as const) {
    it(`prepares nothing when the goal switch is turned on while ${status}`, async () => {
      const { ws, campaign } = await seed(status);

      const res = await patch(ws.id, campaign.id, { goalEnabled: true });

      expect(res.status).toBe(200);
      expect(prepare).not.toHaveBeenCalled();
    });
  }

  /** Off is not a preparation either, and never was. The managed set stays on
   *  the agent, as it does when a campaign ends: agents are many-to-one with
   *  campaigns and the set is not this campaign's to take back. */
  it('prepares nothing when the goal switch is turned off', async () => {
    const { ws, campaign } = await seed('PAUSED', { goalEnabled: true });

    expect((await patch(ws.id, campaign.id, { goalEnabled: false })).status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
  });

  /** The case this file exists for. The dashboard sends the whole form back on
   *  every save, so a body carrying both switches and every retired knob
   *  arrives on an edit that only moved the retry count — and preparing on
   *  presence would spend six upstream calls on it. */
  it('prepares nothing on an ordinary save carrying the whole form', async () => {
    const { ws, campaign } = await seed('PAUSED', { goalEnabled: true });

    const res = await patch(ws.id, campaign.id, {
      goalEnabled: true,
      callbackEnabled: true,
      retryCount: 4,
      maxTotalDials: 6,
      maxGoalFollowUps: 2,
      followUpDelayHours: 24,
      immediateCallbackMinutes: 5,
    });

    expect(res.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('prepares nothing on a DRAFT campaign', async () => {
    const { ws, campaign } = await seed('DRAFT');

    expect((await patch(ws.id, campaign.id, { goalEnabled: true })).status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
  });

  /**
   * The callback switch cannot be turned on through the API, because it cannot
   * be turned off through it either: the row this seeds with `false` is a
   * state no path creates now, and a PATCH asking for `true` writes nothing.
   * A 200 rather than a 409 is the point — a dashboard from before that
   * release posts the whole form back.
   */
  it('accepts the callback switch, writes nothing, and prepares nothing', async () => {
    const { ws, campaign } = await seed('PAUSED');

    const res = await patch(ws.id, campaign.id, { callbackEnabled: true });

    expect(res.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).callbackEnabled,
    ).toBe(false);
  });

  /**
   * A refused edit changed nothing, and prepares nothing — the same answer
   * for a different reason, and worth pinning either way.
   *
   * The goal switch rides along **on purpose**: it is the field that would
   * trigger a prepare, and a running campaign accepts it now. Refusing the
   * request on the locked field beside it is what proves the prepare is gated
   * on the edit landing rather than on the trigger merely being absent — a
   * body carrying no goal field at all would pass this test saying nothing.
   */
  it('prepares nothing when the edit is refused', async () => {
    const { ws, campaign } = await seed('RUNNING');

    expect(
      (await patch(ws.id, campaign.id, { goalEnabled: true, name: 'Renamed' })).status,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });
});
