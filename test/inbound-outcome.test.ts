import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';
import { processWebhookEvent } from '../src/services/webhookOutcome.js';

async function scenario() {
  const account = await makeAccount('alice');
  const ws = await makeWorkspace(account, 'A Co');
  const agent = await makeAgent(ws, 'Support');
  const did = await makePhoneNumber(ws, '+919000000050', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', agentId: agent.id, type: 'INBOUND', status: 'RUNNING' },
  });
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
      upstreamCallId: 'ic-1',
    },
  });
  return { ws, did, campaign, contact, cc, inbound };
}

function completed(overrides: Record<string, unknown> = {}, at: Date = new Date()) {
  return {
    event: 'session.completed' as const,
    receivedAtIso: at.toISOString(),
    data: {
      session_id: 's-1',
      duration_seconds: 42,
      extraction: { values: { budget: 'high' } },
      call: { call_id: 'ic-1', status: 'completed', disposition: 'answered' },
      ...overrides,
    },
  };
}

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('session.completed with no arrival row', () => {
  it('creates the row from the DID claim and settles it', async () => {
    // The arrival write runs after the routing response and is best-effort;
    // a lost one must not make the completion an unknown call.
    const { ws, did, campaign, cc } = await scenario();
    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: did.id, campaignId: campaign.id, agentId: campaign.agentId! },
    });
    await prisma.campaignInboundCall.deleteMany({ where: { campaignId: campaign.id } });

    await processWebhookEvent(
      completed({
        call: {
          call_id: 'ic-late',
          status: 'completed',
          disposition: 'answered',
          direction: 'inbound',
          from_number: '+919876543210',
          to_number: did.did,
        },
      }),
    );

    const row = await prisma.campaignInboundCall.findUnique({ where: { upstreamPhoneCallId: 'ic-late' } });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      campaignId: campaign.id,
      workspaceId: ws.id,
      phoneNumberId: did.id,
      campaignContactId: cc.id,
      fromNumber: '+919876543210',
      durationSecs: 42,
    });
    expect(row!.endedAt).not.toBeNull();
  });

  it('still ignores an unclaimed number', async () => {
    const { did, campaign } = await scenario();
    await prisma.campaignInboundCall.deleteMany({ where: { campaignId: campaign.id } });

    await processWebhookEvent(
      completed({
        call: { call_id: 'ic-nobody', status: 'completed', direction: 'inbound', from_number: '+919876543210', to_number: did.did },
      }),
    );

    expect(await prisma.campaignInboundCall.count()).toBe(0);
  });
});

describe('session.completed enrols the caller', () => {
  const stranger = '+919900000077';

  async function strangerCall(campaignId: string, ws: string, didId: string, callId = 'ic-stranger') {
    await prisma.campaignInboundCall.create({
      data: { campaignId, workspaceId: ws, phoneNumberId: didId, fromNumber: stranger, upstreamCallId: callId },
    });
    await processWebhookEvent(
      completed({ session_id: `s-${callId}`, call: { call_id: callId, status: 'completed', disposition: 'answered' } }),
    );
  }

  it('enrols an unknown caller as a settled contact on an INBOUND campaign', async () => {
    const { ws, did, campaign } = await scenario();
    const before = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).totalContacts;

    await strangerCall(campaign.id, ws.id, did.id);

    const contact = await prisma.contact.findUnique({
      where: { workspaceId_phone: { workspaceId: ws.id, phone: stranger } },
    });
    expect(contact).not.toBeNull();
    const cc = await prisma.campaignContact.findUnique({
      where: { campaignId_contactId: { campaignId: campaign.id, contactId: contact!.id } },
    });
    // Settled, so no lane ever claims it: an inbound-only campaign never dials.
    // The disposition is the CALL's, not a constant — see the case below.
    expect(cc).toMatchObject({ status: 'COMPLETED', disposition: 'answered' });
    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { upstreamPhoneCallId: 'ic-stranger' } });
    expect(row.campaignContactId).toBe(cc!.id);
    expect(row.contactId).toBe(contact!.id);
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.totalContacts).toBe(before + 1);
    expect(after.completedCount).toBe(1);
  });

  it('does not enrol on a BOTH campaign', async () => {
    const { ws, did, campaign } = await scenario();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { type: 'BOTH' } });

    await strangerCall(campaign.id, ws.id, did.id);

    expect(await prisma.contact.count({ where: { phone: stranger } })).toBe(0);
  });

  it('is idempotent: a second call from the same stranger reuses the contact', async () => {
    const { ws, did, campaign } = await scenario();

    await strangerCall(campaign.id, ws.id, did.id, 'ic-s1');
    await strangerCall(campaign.id, ws.id, did.id, 'ic-s2');

    expect(await prisma.contact.count({ where: { phone: stranger } })).toBe(1);
    expect(await prisma.campaignContact.count({ where: { campaignId: campaign.id } })).toBe(2);
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.totalContacts).toBe(1);
    const rows = await prisma.campaignInboundCall.findMany({ where: { fromNumber: stranger } });
    expect(new Set(rows.map((r) => r.campaignContactId)).size).toBe(1);
  });
});

describe('session.completed settles an inbound call', () => {
  it('settles the recorded row by call id', async () => {
    const { inbound } = await scenario();

    await processWebhookEvent(completed());

    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.durationSecs).toBe(42);
    expect(row.disposition).toBe('answered');
    expect(row.extraction).toEqual({ budget: 'high' });
    expect(row.endedAt).toBeInstanceOf(Date);
    // The session id is learned only at completion — the session did not exist
    // at policy time.
    expect(row.upstreamSessionId).toBe('s-1');
  });

  /**
   * The conversation and whether audio exists, captured the way the dial path
   * captures them — bounded, the flag and never the URL, and left unset when
   * post-call processing has not produced them yet.
   */
  it('stores the bounded transcript and the recording flag', async () => {
    const { inbound } = await scenario();

    await processWebhookEvent(
      completed({
        processing_complete: true,
        transcript: [{ role: 'assistant', text: 'Hello?' }, { role: 'user', content: 'Hi, billing question.' }],
        recording_url: 'https://storage.test/r.mp3?sig=x',
      }),
    );

    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.transcript).toEqual([
      { role: 'assistant', content: 'Hello?', timestamp: null },
      { role: 'user', content: 'Hi, billing question.', timestamp: null },
    ]);
    expect(row.recordingAvailable).toBe(true);
    expect(JSON.stringify(row)).not.toContain('storage.test');
  });

  it('leaves the transcript and the flag unset when processing has not happened yet', async () => {
    const { inbound } = await scenario();

    await processWebhookEvent(completed());

    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.transcript).toBeNull();
    expect(row.recordingAvailable).toBeNull();
  });

  it('does not throw for a completion that is neither an attempt nor a recorded inbound call', async () => {
    await expect(
      processWebhookEvent(completed({ call: { call_id: 'nobody', status: 'completed' } })),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — a replay settles to the same values', async () => {
    const { inbound } = await scenario();
    await processWebhookEvent(completed());
    await processWebhookEvent(completed());
    const row = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.durationSecs).toBe(42);
  });
});

describe('an inbound call re-bases the chase', () => {
  const past = new Date(Date.now() - 60 * 60_000);

  it('pushes the next retry out from the inbound call end', async () => {
    const { cc } = await scenario();
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { status: 'PENDING', attempts: 0, nextEligibleAt: past },
    });

    const at = new Date();
    await processWebhookEvent(completed({}, at));

    const row = await prisma.campaignContact.findUniqueOrThrow({
      where: { id: cc.id },
      include: { campaign: { select: { cooldownMinutes: true } } },
    });
    // The campaign's own cooldown (the schema default, whatever it is today);
    // the clock restarts from the inbound end.
    expect(row.nextEligibleAt!.getTime()).toBe(at.getTime() + row.campaign.cooldownMinutes * 60_000);
  });

  it('does NOT consume a retry', async () => {
    const { cc } = await scenario();
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { status: 'PENDING', attempts: 2, nextEligibleAt: past },
    });

    await processWebhookEvent(completed());

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: cc.id } });
    expect(row.attempts).toBe(2);
  });

  it('LEAVES AN ARMED CALLBACK ALONE', async () => {
    const { cc } = await scenario();
    const armedAt = new Date(Date.now() + 2 * 60 * 60_000);
    // nextEligibleAt === callbackAt, both non-null: the sole marker of a promise.
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { status: 'PENDING', attempts: 0, nextEligibleAt: armedAt, callbackAt: armedAt },
    });

    await processWebhookEvent(completed());

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: cc.id } });
    expect(row.nextEligibleAt!.getTime()).toBe(armedAt.getTime());
    expect(row.callbackAt!.getTime()).toBe(armedAt.getTime());
  });

  it('leaves a QUEUED contact alone', async () => {
    const { cc } = await scenario();
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { status: 'QUEUED', nextEligibleAt: past },
    });

    await processWebhookEvent(completed());

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: cc.id } });
    expect(row.nextEligibleAt!.getTime()).toBe(past.getTime());
  });

  it('does not reopen a COMPLETED contact', async () => {
    const { cc } = await scenario();
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { status: 'COMPLETED', nextEligibleAt: null },
    });

    await processWebhookEvent(completed());

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: cc.id } });
    expect(row.status).toBe('COMPLETED');
    expect(row.nextEligibleAt).toBeNull();
  });

  it('counts a goal-achieved inbound call toward the goal', async () => {
    const account = await makeAccount('carol');
    const ws = await makeWorkspace(account, 'C Co');
    const agent = await makeAgent(ws, 'S');
    const did = await makePhoneNumber(ws, '+919000000070', 'ASSIGNED');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'G', agentId: agent.id, type: 'INBOUND', status: 'RUNNING', goal: 'Book a demo' },
    });
    const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone: '+919876500000' } });
    const cc = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'PENDING' },
    });
    await prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        contactId: contact.id,
        workspaceId: ws.id,
        phoneNumberId: did.id,
        fromNumber: '+919876500000',
        upstreamCallId: 'ic-goal',
      },
    });

    await processWebhookEvent(
      completed({ call: { call_id: 'ic-goal', status: 'completed' }, extraction: { values: { call_outcome_vocobaseplatform: 'completed' } } }),
    );

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: cc.id } });
    expect(row.goalAchieved).toBe(true);
  });

  it('does not mark the goal unmet on an inbound call that did not achieve it', async () => {
    const account = await makeAccount('dan');
    const ws = await makeWorkspace(account, 'D Co');
    const agent = await makeAgent(ws, 'S');
    const did = await makePhoneNumber(ws, '+919000000071', 'ASSIGNED');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'G', agentId: agent.id, type: 'INBOUND', status: 'RUNNING', goal: 'Book a demo' },
    });
    const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone: '+919876500001' } });
    const cc = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'PENDING' },
    });
    await prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        contactId: contact.id,
        workspaceId: ws.id,
        phoneNumberId: did.id,
        fromNumber: '+919876500001',
        upstreamCallId: 'ic-nogoal',
      },
    });

    await processWebhookEvent(
      completed({ call: { call_id: 'ic-nogoal', status: 'completed' }, extraction: { values: { call_outcome_vocobaseplatform: 'incomplete' } } }),
    );

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: cc.id } });
    // Positive-only: an unmet inbound call leaves the verdict where it was.
    expect(row.goalAchieved).toBeNull();
  });

  it('an unknown caller re-bases nothing', async () => {
    // A recorded inbound call with no contact — settles, but there is nothing
    // to re-base.
    const account = await makeAccount('bob');
    const ws = await makeWorkspace(account, 'B Co');
    const agent = await makeAgent(ws, 'S');
    const did = await makePhoneNumber(ws, '+919000000060', 'ASSIGNED');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', agentId: agent.id, type: 'INBOUND', status: 'RUNNING' },
    });
    await prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id,
        workspaceId: ws.id,
        phoneNumberId: did.id,
        fromNumber: '+910000000000',
        upstreamCallId: 'ic-unknown',
      },
    });

    await expect(
      processWebhookEvent(completed({ call: { call_id: 'ic-unknown', status: 'completed' } })),
    ).resolves.toBeUndefined();
  });
});
