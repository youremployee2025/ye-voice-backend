import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeDialable, makePhoneNumber, makeWorkspace } from './helpers.js';
import { processWebhookEvent } from '../src/services/webhookOutcome.js';

/** A workspace with a priced tier and a funded owner, plus a recorded inbound
 *  call ready to settle and charge. */
async function scenario() {
  const account = await makeAccount('alice');
  const ws = await makeWorkspace(account, 'A Co');
  const agent = await makeAgent(ws, 'Support');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', agentId: agent.id, type: 'INBOUND', status: 'RUNNING' },
  });
  // Sets up the va-test tier (10,000 internal credits/min), points the agent at
  // it, and funds the owner (10,000,000).
  await makeDialable(ws, campaign, agent);
  const did = await makePhoneNumber(ws, '+919000000080', 'ASSIGNED');
  const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone: '+919876543210' } });
  const cc = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id },
  });
  const inbound = await prisma.campaignInboundCall.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: cc.id,
      contactId: contact.id,
      workspaceId: ws.id,
      phoneNumberId: did.id,
      fromNumber: '+919876543210',
      upstreamCallId: 'icb-1',
    },
  });
  return { account, ws, campaign, inbound };
}

function completed(durationSecs: number, callId = 'icb-1') {
  return {
    event: 'session.completed' as const,
    receivedAtIso: new Date().toISOString(),
    data: {
      session_id: `s-${callId}`,
      duration_seconds: durationSecs,
      call: { call_id: callId, status: 'completed', disposition: 'answered' },
    },
  };
}

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('inbound calls are charged', () => {
  it('charges the workspace for an answered inbound minute', async () => {
    const { account, inbound } = await scenario();
    const before = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;

    await processWebhookEvent(completed(60));

    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.costCredits).toBe(10_000n);

    const after = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;
    expect(before - after).toBe(10_000n);

    const txns = await prisma.creditTransaction.findMany({ where: { reference: inbound.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ type: 'CALL_USAGE', amount: -10_000n });
  });

  it('charges exactly once across a replay', async () => {
    const { account, inbound } = await scenario();
    const before = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;

    await processWebhookEvent(completed(60));
    await processWebhookEvent(completed(60));

    const after = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;
    expect(before - after).toBe(10_000n);
    expect(await prisma.creditTransaction.count({ where: { reference: inbound.id } })).toBe(1);
  });

  it('writes no ledger row for a call nobody spoke on', async () => {
    const { account, inbound } = await scenario();
    const before = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;

    await processWebhookEvent(completed(0));

    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.costCredits).toBe(0n);
    const after = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;
    expect(before).toBe(after);
    expect(await prisma.creditTransaction.count({ where: { reference: inbound.id } })).toBe(0);
  });

  it('records a shortfall when the balance cannot cover it', async () => {
    const { account, inbound } = await scenario();
    await prisma.account.update({ where: { id: account.id }, data: { credits: 5n } });

    await processWebhookEvent(completed(60));

    const after = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;
    // Fail closed: nothing debited.
    expect(after).toBe(5n);
    const txns = await prisma.creditTransaction.findMany({ where: { reference: inbound.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('CALL_USAGE_SHORTFALL');
  });
});
