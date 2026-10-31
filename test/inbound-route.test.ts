import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The routing endpoint reaches nothing upstream; still, mock the adapter so a
// stray call can never touch the live account.
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkInboundReady: vi.fn(),
  clearPhoneNumberAgent: vi.fn(),
}));

const SECRET = 'i'.repeat(48);
process.env.INBOUND_ROUTE_POLICY_SECRET = SECRET;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } = await import('./helpers.js');
const { signInboundRoute } = await import('../src/lib/inboundRouteSignature.js');
const { flushInboundArrivals } = await import('../src/routes/inboundRoute.routes.js');

const app = createApp();

async function post(payload: unknown, opts: { sig?: string; ts?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = opts.ts ?? new Date().toISOString();
  return request(app)
    .post('/webhooks/vocobase/inbound-route')
    .set('Content-Type', 'application/json')
    .set('X-Vocobase-Timestamp', ts)
    .set('X-Vocobase-Signature', opts.sig ?? signInboundRoute(body, ts, SECRET))
    .send(body);
}

/** A claimed DID with a known caller, ready to answer. */
async function scenario() {
  const account = await makeAccount('alice');
  const ws = await makeWorkspace(account, 'A Co');
  const agent = await makeAgent(ws, 'Support');
  await prisma.agent.update({
    where: { id: agent.id },
    data: { inboundEnabled: true, variables: ['name'] },
  });
  const did = await makePhoneNumber(ws, '+919000000040', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', agentId: agent.id, type: 'INBOUND', status: 'RUNNING' },
  });
  await prisma.campaignInboundClaim.create({
    data: { phoneNumberId: did.id, campaignId: campaign.id, agentId: agent.id },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210', name: 'Rahul' },
  });
  const cc = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, disposition: 'no_answer', attempts: 1 },
  });
  return { ws, agent, did, campaign, contact, cc };
}

beforeEach(async () => {
  await truncateAll();
});

describe('POST /webhooks/vocobase/inbound-route', () => {
  it('returns the contact variables for a claimed DID', async () => {
    const { did } = await scenario();

    const res = await post({ from_number: '+919876543210', to_number: did.did });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      action: 'ANSWER_WITH_AI',
      variables: { name: 'Rahul', last_outcome: 'no_answer' },
    });
  });

  it('writes the attribution row when the caller is a known contact', async () => {
    const { did, campaign, cc } = await scenario();

    await post({ from_number: '+919876543210', to_number: did.did });
    await flushInboundArrivals();

    const rows = await prisma.campaignInboundCall.findMany({ where: { campaignId: campaign.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaignContactId: cc.id, fromNumber: '+919876543210' });
  });

  it('answers before the arrival row is written, and the row lands after', async () => {
    // The caller hears every millisecond of this handler as ring time, so the
    // decision is made from reads alone and the arrival row is written once
    // the response is on the wire. The seam is what lets a test wait for it.
    //
    // The write is HELD OPEN for the duration of the request rather than timed:
    // a plain `count() === 0` after `await post(...)` is a race — the deferred
    // write is a microtask and usually wins — so it would pass against a
    // handler that awaited the write and prove nothing. With the upsert parked
    // on a gate nobody resolves, a response can only arrive if the handler did
    // not wait for it.
    const { did, cc } = await scenario();

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

    try {
      const res = await post({ from_number: '+919876543210', to_number: did.did, provider_call_id: 'pc-9' });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('ANSWER_WITH_AI');
      // The response is on the wire with the write still parked.
      expect(await prisma.campaignInboundCall.count()).toBe(0);

      openTheGate();
      await flushInboundArrivals();
    } finally {
      spy.mockRestore();
    }

    const rows = await prisma.campaignInboundCall.findMany({ where: { upstreamCallId: 'pc-9' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaignContactId).toBe(cc.id);
  });

  it('answers unseeded for an unclaimed DID rather than failing', async () => {
    const account = await makeAccount('bob');
    const ws = await makeWorkspace(account, 'B Co');
    const unclaimed = await makePhoneNumber(ws, '+919000000041', 'ASSIGNED');

    const res = await post({ from_number: '+919876543210', to_number: unclaimed.did });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'ANSWER_WITH_AI' });
  });

  it('answers unseeded (but attributed) for a caller who is not a contact', async () => {
    const { did, campaign } = await scenario();

    const res = await post({ from_number: '+910000000000', to_number: did.did });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'ANSWER_WITH_AI' });
    await flushInboundArrivals();
    // Still attributed to the campaign through the DID claim; only the contact
    // is absent, and no Contact row is created for an unknown caller HERE —
    // enrolment is the settle's job, off the caller's path.
    const rows = await prisma.campaignInboundCall.findMany({ where: { campaignId: campaign.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].campaignContactId).toBeNull();
    expect(await prisma.contact.count({ where: { phone: '+910000000000' } })).toBe(0);
  });

  it('rejects an invalid signature with 401', async () => {
    const { did } = await scenario();
    const res = await post({ from_number: '+919876543210', to_number: did.did }, { sig: 'v1=deadbeef' });
    expect(res.status).toBe(401);
  });

  it('fails open: a body that throws still answers 200 ANSWER_WITH_AI', async () => {
    // Signed correctly, but not valid JSON — the handler throws parsing it and
    // must degrade to an answering agent, never a dropped customer call.
    const ts = new Date().toISOString();
    const raw = 'not json{';
    const res = await request(app)
      .post('/webhooks/vocobase/inbound-route')
      .set('Content-Type', 'application/json')
      .set('X-Vocobase-Timestamp', ts)
      .set('X-Vocobase-Signature', signInboundRoute(raw, ts, SECRET))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'ANSWER_WITH_AI' });
  });
  it('carries the last conversation\'s follow-up instruction into an inbound call', async () => {
    // The whole point of an inbound face on a campaign: somebody we dialled
    // rings back, and the agent must resume rather than open cold. The
    // instruction lives in the goal record exactly as it does for a dial, so
    // this call must carry the same reserved variable a dial carries.
    const { did, cc } = await scenario();
    await prisma.campaignContactGoal.create({
      data: {
        campaignContactId: cc.id,
        memory: 'PREVIOUS CALL SUMMARY: quoted the renewal, they asked to think.',
        memoryAttempt: 1,
        attemptLog: [{ attemptNo: 1, callTimestamp: '2026-09-09T14:05+05:30' }],
      },
    });

    const res = await post({ from_number: '+919876543210', to_number: did.did });

    expect(res.status).toBe(200);
    const carried = res.body.variables?.next_call_instructions_vocobaseplatform;
    expect(carried).toBeTypeOf('string');
    expect(JSON.parse(carried)).toMatchObject({
      note: expect.stringContaining('THIS IS A FOLLOW-UP CALL'),
      previous_call_end_timestamp: 'Previous call ended at 2026-09-09T14:05+05:30',
      instructions: 'PREVIOUS CALL SUMMARY: quoted the renewal, they asked to think.',
    });
  });
});
