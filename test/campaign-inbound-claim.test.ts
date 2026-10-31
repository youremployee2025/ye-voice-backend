import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';

const app = createApp();
const auth = as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
});

describe('CampaignInboundClaim', () => {
  it('refuses a second live claim on the same DID — the primary key IS the invariant', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Support');
    const did = await makePhoneNumber(ws, '+919000000001', 'ASSIGNED');

    const a = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'A', agentId: agent.id, type: 'INBOUND' },
    });
    const b = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'B', agentId: agent.id, type: 'INBOUND' },
    });

    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: did.id, campaignId: a.id, agentId: agent.id },
    });

    await expect(
      prisma.campaignInboundClaim.create({
        data: { phoneNumberId: did.id, campaignId: b.id, agentId: agent.id },
      }),
    ).rejects.toSatisfy(
      (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    );
  });

  it('cascades away when its campaign is deleted', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Support');
    const did = await makePhoneNumber(ws, '+919000000002', 'ASSIGNED');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'A', agentId: agent.id, type: 'INBOUND' },
    });
    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: did.id, campaignId: campaign.id, agentId: agent.id },
    });

    await prisma.campaign.delete({ where: { id: campaign.id } });

    expect(await prisma.campaignInboundClaim.count()).toBe(0);
  });
});

/**
 * A live inbound campaign answers on the DIDs it claimed at start, and nothing
 * re-claims on a settings save.
 *
 * `claimInboundDids` runs once, inside `runInboundStart`; `releaseInboundClaims`
 * runs at pause and stop. So a PATCH that changed `phoneNumberIds` on a RUNNING
 * inbound campaign left `CampaignInboundClaim` pointing at the old number — the
 * campaign went on answering a DID its own settings no longer named, the new
 * number rang through to whatever the platform's default is, and the save
 * reported success with nothing anywhere saying otherwise.
 *
 * `phoneNumberIds` is in `MID_CAMPAIGN_EDITABLE_FIELDS` because rotating
 * OUTBOUND caller-ID mid-campaign is a legitimate and harmless thing to do: the
 * dispatcher re-reads the list on its next pass and what a call already placed
 * went out from is stamped on its own attempt row. Neither is true here.
 */
async function seedCampaign(
  type: 'INBOUND' | 'OUTBOUND' | 'BOTH',
  status: 'RUNNING' | 'DRAFT',
  handle: string,
) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const agent = await makeAgent(ws, 'Support');
  // A face already on, so nothing here depends on the start creating one.
  await prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true } });
  const held = await makePhoneNumber(ws, `+9190000${handle}1`, 'ASSIGNED');
  const other = await makePhoneNumber(ws, `+9190000${handle}2`, 'ASSIGNED');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Support',
      agentId: agent.id,
      type,
      status,
      phoneNumberId: held.id,
      dialNumbers: { create: [{ phoneNumberId: held.id, position: 0 }] },
    },
  });

  if (type !== 'OUTBOUND' && status === 'RUNNING') {
    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: held.id, campaignId: campaign.id, agentId: agent.id },
    });
  }

  return { ws, campaign, heldId: held.id, otherNumberId: other.id };
}

const patch = (wsId: string, campaignId: string) =>
  request(app).patch(`/api/workspaces/${wsId}/campaigns/${campaignId}`).set(...auth);

/** The rotation lives in a join table, not in a column — `phoneNumberIds` is a
 *  request shape. This is what "the stored list" actually means. */
async function rotation(campaignId: string): Promise<string[]> {
  const rows = await prisma.campaignPhoneNumber.findMany({
    where: { campaignId },
    orderBy: { position: 'asc' },
  });

  return rows.map((row) => row.phoneNumberId);
}

describe('PATCH phoneNumberIds on an inbound-facing campaign', () => {
  it('refuses the change while the campaign is RUNNING', async () => {
    const { ws, campaign, heldId, otherNumberId } = await seedCampaign('INBOUND', 'RUNNING', '11');

    const res = await patch(ws.id, campaign.id).send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_INBOUND_NUMBERS_LOCKED');
    // A refused save must not half-apply.
    expect(await rotation(campaign.id)).toEqual([heldId]);
    // And the claim it would have contradicted is exactly where it was.
    const claim = await prisma.campaignInboundClaim.findUniqueOrThrow({
      where: { phoneNumberId: heldId },
    });
    expect(claim.campaignId).toBe(campaign.id);
  });

  /** BOTH answers as well as dials, so it holds the same claim and the same
   *  rule applies. `isInboundFacing`, not `isInboundOnly`. */
  it('refuses it on a RUNNING BOTH campaign too', async () => {
    const { ws, campaign, otherNumberId } = await seedCampaign('BOTH', 'RUNNING', '12');

    const res = await patch(ws.id, campaign.id).send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_INBOUND_NUMBERS_LOCKED');
  });

  it('allows the same change on a RUNNING OUTBOUND campaign', async () => {
    const { ws, campaign, otherNumberId } = await seedCampaign('OUTBOUND', 'RUNNING', '13');

    const res = await patch(ws.id, campaign.id).send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(200);
    expect(await rotation(campaign.id)).toEqual([otherNumberId]);
  });

  it('allows the change on a DRAFT inbound campaign', async () => {
    // Nothing is claimed before start, so there is nothing to contradict.
    const { ws, campaign, otherNumberId } = await seedCampaign('INBOUND', 'DRAFT', '14');

    const res = await patch(ws.id, campaign.id).send({ phoneNumberIds: [otherNumberId] });

    expect(res.status).toBe(200);
    expect(await rotation(campaign.id)).toEqual([otherNumberId]);
  });

  /** Resubmitting the list a campaign already holds is not a change. The
   *  dashboard sends the whole form back on every save, so a presence-keyed
   *  rule would refuse every edit to a live inbound campaign. */
  it('does not refuse a save that resubmits the numbers it already holds', async () => {
    const { ws, campaign, heldId } = await seedCampaign('INBOUND', 'RUNNING', '15');

    const res = await patch(ws.id, campaign.id).send({
      phoneNumberIds: [heldId],
      retryCount: 3,
    });

    expect(res.status).toBe(200);
  });
});
