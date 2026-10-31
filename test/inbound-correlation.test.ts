import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The wire contract between the routing-policy callback and `session.completed`,
 * using the payload shapes Vocobase ACTUALLY sends (its
 * `inboundRoutePolicyWebhook.service.ts#buildPayload` and
 * `partnerWebhook.service.ts` completion payload), not invented ones.
 *
 * The two events carry DIFFERENT identifiers: the policy callback has only the
 * carrier's `provider_call_id`, and the completion has Vocobase's own
 * `call.call_id` (its PhoneCall row id) plus `session_id`. Neither event
 * carries the other's id, so the settle has to find the row it wrote at policy
 * time by the two numbers and the open arrival — or nothing inbound is ever
 * billed, goal-flipped, or re-based.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkInboundReady: vi.fn(),
  clearPhoneNumberAgent: vi.fn(),
}));

const SECRET = 'i'.repeat(48);
process.env.INBOUND_ROUTE_POLICY_SECRET = SECRET;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeDialable, makePhoneNumber, makeWorkspace } = await import('./helpers.js');
const { signInboundRoute } = await import('../src/lib/inboundRouteSignature.js');
const { processWebhookEvent } = await import('../src/services/webhookOutcome.js');
const { flushInboundArrivals } = await import('../src/routes/inboundRoute.routes.js');

const app = createApp();

/** Exactly what Vocobase's buildPayload sends, signed the way it signs. */
async function policyCallback(input: {
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  phoneNumberExternalId: string;
  /** Leave the deferred arrival write in flight, to order it against a settle. */
  flush?: boolean;
}) {
  const body = JSON.stringify({
    event: 'inbound_route.decide',
    version: '2026-09-01',
    provider: 'voicelink',
    call: {
      provider_call_id: input.providerCallId,
      from_number: input.fromNumber,
      to_number: input.toNumber,
    },
    phone_number: { id: input.phoneNumberExternalId, number: input.toNumber },
    agent: { id: 'vb-agent-1' },
    partner: { id: 'vb-partner-1' },
  });
  const ts = Date.now().toString();
  const res = await request(app)
    .post('/webhooks/vocobase/inbound-route')
    .set('Content-Type', 'application/json')
    .set('X-Vocobase-Timestamp', ts)
    .set('X-Vocobase-Signature', signInboundRoute(body, ts, SECRET))
    .send(body);

  // The arrival row is written AFTER the response by design, so every test
  // that reads it has to wait for the seam. Without this the reads below race
  // the write and pass or fail on how long the write happens to take.
  if (input.flush !== false) await flushInboundArrivals();
  return res;
}

/** Exactly the `call` object Vocobase's session.completed carries for an inbound PhoneCall. */
function completion(input: {
  sessionId: string;
  phoneCallId: string;
  fromNumber: string;
  toNumber: string;
  durationSeconds?: number;
  direction?: string;
}) {
  return {
    event: 'session.completed' as const,
    receivedAtIso: new Date().toISOString(),
    data: {
      session_id: input.sessionId,
      agent_id: 'vb-agent-1',
      duration_seconds: input.durationSeconds ?? 61,
      credits_used: 1.02,
      variables: {},
      extraction: { values: { budget: 'high' } },
      call: {
        call_id: input.phoneCallId,
        client_reference_id: null,
        from_number: input.fromNumber,
        to_number: input.toNumber,
        direction: input.direction ?? 'inbound',
        status: 'completed',
        disposition: 'answered',
        answered_by: null,
        hangup_cause: null,
        hangup_source: 'caller',
      },
    },
  };
}

async function scenario() {
  const account = await makeAccount('alice');
  const ws = await makeWorkspace(account, 'A Co');
  const agent = await makeAgent(ws, 'Support');
  await prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true, variables: ['name'] } });
  const did = await makePhoneNumber(ws, '+919000000060', 'ASSIGNED');
  await prisma.phoneNumber.update({ where: { id: did.id }, data: { externalId: 'vb-pn-1' } });
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', agentId: agent.id, type: 'INBOUND', status: 'RUNNING' },
  });
  // A priced tier and a funded owner, so the settle can bill.
  await makeDialable(ws, campaign, agent);
  await prisma.campaignInboundClaim.create({
    data: { phoneNumberId: did.id, campaignId: campaign.id, agentId: agent.id },
  });
  const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone: '+919876543210', name: 'Rahul' } });
  const cc = await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: contact.id } });
  return { ws, did, campaign, contact, cc };
}

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('policy callback → session.completed, with the real payload shapes', () => {
  it('settles the row the policy wrote even though the two events carry different ids', async () => {
    const { did, cc } = await scenario();

    const res = await policyCallback({
      providerCallId: 'CA-carrier-1',
      fromNumber: '+919876543210',
      toNumber: did.did,
      phoneNumberExternalId: 'vb-pn-1',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('ANSWER_WITH_AI');

    const before = await prisma.campaignInboundCall.findFirstOrThrow();
    expect(before.upstreamCallId).toBe('CA-carrier-1');
    expect(before.endedAt).toBeNull();

    await processWebhookEvent(
      completion({ sessionId: 's-1', phoneCallId: 'pc-uuid-1', fromNumber: '+919876543210', toNumber: did.did }),
    );

    const after = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.endedAt).toBeInstanceOf(Date);
    expect(after.durationSecs).toBe(61);
    expect(after.upstreamSessionId).toBe('s-1');
    // The policy's id is untouched and the completion's is now recorded beside
    // it — the pair is what makes a redelivery settle this row again.
    expect(after.upstreamCallId).toBe('CA-carrier-1');
    expect(after.upstreamPhoneCallId).toBe('pc-uuid-1');
    expect(after.extraction).toEqual({ budget: 'high' });
    expect(after.campaignContactId).toBe(cc.id);
    // And it was billed — the whole point of settling.
    expect(after.costCredits).not.toBeNull();
    // Exactly one row: the completion settled, it did not create a second.
    expect(await prisma.campaignInboundCall.count()).toBe(1);
  });

  it('matches the caller across formatting differences between the two events', async () => {
    const { did } = await scenario();
    await policyCallback({
      providerCallId: 'CA-carrier-2',
      fromNumber: '+91 98765 43210',
      toNumber: did.did,
      phoneNumberExternalId: 'vb-pn-1',
    });
    await processWebhookEvent(
      completion({ sessionId: 's-2', phoneCallId: 'pc-uuid-2', fromNumber: '+919876543210', toNumber: did.did }),
    );
    const row = await prisma.campaignInboundCall.findFirstOrThrow();
    expect(row.endedAt).toBeInstanceOf(Date);
  });

  it('settles the OLDEST open call from that caller on that number, and only once', async () => {
    const { did } = await scenario();
    await policyCallback({ providerCallId: 'CA-a', fromNumber: '+919876543210', toNumber: did.did, phoneNumberExternalId: 'vb-pn-1' });
    await policyCallback({ providerCallId: 'CA-b', fromNumber: '+919876543210', toNumber: did.did, phoneNumberExternalId: 'vb-pn-1' });

    await processWebhookEvent(
      completion({ sessionId: 's-3', phoneCallId: 'pc-3', fromNumber: '+919876543210', toNumber: did.did }),
    );

    const rows = await prisma.campaignInboundCall.findMany({ orderBy: { arrivedAt: 'asc' } });
    expect(rows.map((r) => [r.upstreamCallId, r.endedAt !== null])).toEqual([
      ['CA-a', true],
      ['CA-b', false],
    ]);

    // A replay of the same completion re-settles the same row by its session id
    // rather than consuming the next open one.
    await processWebhookEvent(
      completion({ sessionId: 's-3', phoneCallId: 'pc-3', fromNumber: '+919876543210', toNumber: did.did }),
    );
    const again = await prisma.campaignInboundCall.findMany({ orderBy: { arrivedAt: 'asc' } });
    expect(again[1]!.endedAt).toBeNull();
  });

  /**
   * The redelivery that used to double-charge.
   *
   * Delivery 1 finds the arrival row the only way it can — the caller, the DID
   * and the fact that the call is still open — and closes it. Delivery 2 can no
   * longer match that way, because the row is no longer open. Unless the first
   * delivery STAMPED the ids it learned, the second falls through to
   * `recoverArrival` and fabricates a second row: a second call in every count,
   * and a second debit, because all three idempotency guards on the charge are
   * keyed on the row id.
   *
   * `session_id` is asserted absent on purpose. A real `session.completed`
   * always carries one (it is `session.id`), and that alone made this
   * unreachable in production — but the dedupe must not REST on a contract we
   * do not own, and nothing in the suite covered its absence.
   */
  it('settles once when the completion is redelivered without a session id', async () => {
    const { did } = await scenario();
    await policyCallback({
      providerCallId: 'CA-redeliver',
      fromNumber: '+919876543210',
      toNumber: did.did,
      phoneNumberExternalId: 'vb-pn-1',
    });

    const withoutSession = () => {
      const payload = completion({
        sessionId: 's-redeliver',
        phoneCallId: 'pc-redeliver',
        fromNumber: '+919876543210',
        toNumber: did.did,
      });
      delete (payload.data as Record<string, unknown>).session_id;
      return payload;
    };

    await processWebhookEvent(withoutSession());
    await processWebhookEvent(withoutSession());

    const rows = await prisma.campaignInboundCall.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.upstreamCallId).toBe('CA-redeliver');
    expect(rows[0]!.upstreamPhoneCallId).toBe('pc-redeliver');

    // And it was charged exactly once.
    const ledger = await prisma.creditTransaction.findMany({ where: { type: 'CALL_USAGE' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reference).toBe(rows[0]!.id);
  });

  /**
   * The other half of the same duplicate: the arrival write landing AFTER the
   * settle already recovered a row for the call. The late write used to create
   * a second row that nothing would ever settle — and the next call from that
   * caller would then settle against the phantom, so the corruption spread
   * instead of healing.
   */
  it('does not duplicate the row the settle recovered when the arrival write lands late', async () => {
    const { did, campaign } = await scenario();

    // The real ordering: the policy decides FIRST (so its write is parked with
    // the call still ringing), the call runs, the completion arrives and
    // recovers a row, and only then does the parked write get to run.
    let openTheGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    const executeRaw = prisma.$executeRaw.bind(prisma);
    const spy = vi
      .spyOn(prisma, '$executeRaw')
      .mockImplementation((async (...args: Parameters<typeof executeRaw>) => {
        await gate;
        return executeRaw(...args);
      }) as typeof executeRaw);

    let recoveredId: string;
    try {
      await policyCallback({
        providerCallId: 'CA-late',
        fromNumber: '+919876543210',
        toNumber: did.did,
        phoneNumberExternalId: 'vb-pn-1',
        flush: false,
      });
      expect(await prisma.campaignInboundCall.count()).toBe(0);

      await processWebhookEvent(
        completion({ sessionId: 's-late', phoneCallId: 'pc-late', fromNumber: '+919876543210', toNumber: did.did }),
      );
      const recovered = await prisma.campaignInboundCall.findFirstOrThrow();
      expect(recovered.upstreamCallId).toBeNull();
      expect(recovered.upstreamPhoneCallId).toBe('pc-late');
      recoveredId = recovered.id;

      openTheGate();
      await flushInboundArrivals();
    } finally {
      spy.mockRestore();
    }

    // The late write added nothing: the settle's row stands, still settled.
    // Its `upstreamCallId` stays null on purpose — the carrier's id correlates
    // the two events and both have already happened, so writing it now would
    // buy nothing and cost a second statement on a best-effort path.
    const rows = await prisma.campaignInboundCall.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(recoveredId);
    expect(rows[0]!.endedAt).not.toBeNull();

    // A LATER call by the same person is a new row, never suppressed: the
    // settled row ended strictly before that policy decided.
    await policyCallback({
      providerCallId: 'CA-later',
      fromNumber: '+919876543210',
      toNumber: did.did,
      phoneNumberExternalId: 'vb-pn-1',
    });
    const both = await prisma.campaignInboundCall.findMany({ where: { campaignId: campaign.id } });
    expect(both).toHaveLength(2);
    expect(new Set(both.map((r) => r.upstreamCallId))).toEqual(new Set([null, 'CA-later']));
  });

  /**
   * A caller who hung up during the greeting did not have a conversation.
   * Enrolling them as `disposition: completed` puts a call that never happened
   * in the campaign's settled bucket and feeds `last_outcome: completed` into
   * that caller's next prompt.
   */
  it('enrols a stranger with the CALL\'s disposition, not a hardcoded one', async () => {
    const { did } = await scenario();
    const stranger = '+919000000099';
    await policyCallback({
      providerCallId: 'CA-greeting',
      fromNumber: stranger,
      toNumber: did.did,
      phoneNumberExternalId: 'vb-pn-1',
    });

    const payload = completion({
      sessionId: 's-greeting',
      phoneCallId: 'pc-greeting',
      fromNumber: stranger,
      toNumber: did.did,
      durationSeconds: 0,
    });
    (payload.data.call as Record<string, unknown>).disposition = 'no_answer';
    await processWebhookEvent(payload);

    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: stranger } });
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    // Still settled — that is what keeps a lane from ever claiming them — but
    // the campaign no longer reports a conversation that did not happen.
    expect(cc.status).toBe('COMPLETED');
    expect(cc.disposition).toBe('no_answer');
  });

  it('never claims an OUTBOUND completion by number coincidence', async () => {
    const { did } = await scenario();
    await policyCallback({ providerCallId: 'CA-c', fromNumber: '+919876543210', toNumber: did.did, phoneNumberExternalId: 'vb-pn-1' });

    await processWebhookEvent(
      completion({ sessionId: 's-4', phoneCallId: 'pc-4', fromNumber: '+919876543210', toNumber: did.did, direction: 'outbound' }),
    );

    const row = await prisma.campaignInboundCall.findFirstOrThrow();
    expect(row.endedAt).toBeNull();
  });

  it('prefers provider_call_id when a completion carries it', async () => {
    const { did } = await scenario();
    await policyCallback({ providerCallId: 'CA-d', fromNumber: '+919876543210', toNumber: did.did, phoneNumberExternalId: 'vb-pn-1' });
    const payload = completion({ sessionId: 's-5', phoneCallId: 'pc-5', fromNumber: '+910000000000', toNumber: did.did });
    (payload.data.call as Record<string, unknown>).provider_call_id = 'CA-d';

    await processWebhookEvent(payload);

    const row = await prisma.campaignInboundCall.findFirstOrThrow();
    expect(row.endedAt).toBeInstanceOf(Date);
  });
});
