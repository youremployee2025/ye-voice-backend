import { createHmac } from 'node:crypto';
import { MINUTE, type Driver, type Scenario } from '../scenario.js';
import { BACKEND_PORT, WEBHOOK_SECRET } from '../boot.js';

/**
 * Billing per attempt (B1–B4): charged only when the terminal outcome is
 * applied, on the dial-time rate/increment snapshot; billed seconds round up
 * to the increment and the cost divides truncating; zero duration writes no
 * ledger row; a duplicate completion charges nothing; an unpayable charge is
 * fail-closed — nothing debited, shortfall marked, campaign paused broke.
 *
 * Rate 2.00 credits/min, increment 30s.
 */
const P = {
  b45: '+919879110011', // 45s → billed 60s → 2.00 credits
  b29: '+919879110012', // 29s → billed 30s → 1.00 credit
  b0: '+919879110013', // no answer → 0s → free, no ledger row
  broke: '+919879110021', // 60s → 4.00 credits owed on a 1.2-credit account
};

const humanFor = (secs: number) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: secs,
  delays_secs: { ringing: 1, hold: 2, talk: secs },
});

export const billing: Scenario = {
  name: 'billing',
  rows: ['B1', 'B2', 'B3', 'B4'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({
      handle: `bill${d.seed}`,
      credits: '100',
      tierSlug: `bill${d.seed}`,
      ratePerMinDisplay: '2.00',
      billingIncrementSecs: 30,
    });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 3,
      retryCount: 0,
      contacts: [P.b45, P.b29, P.b0],
    });
    await d.script({
      numbers: [
        { to_number: P.b45, rules: [humanFor(45)] },
        { to_number: P.b29, rules: [humanFor(29)] },
        { to_number: P.b0, rules: [{ status: 'no_answer', delays_secs: { ringing: 1, hold: 4 } }] },
      ],
    });

    await d.start(ws, campaign.campaignId);
    await d.tick();

    // B1: dialed, live, and not a credit moved yet.
    {
      const balance = await d.backend.prisma.account.findUniqueOrThrow({ where: { id: ws.accountId } });
      d.check('B1', balance.credits === d.backend.toInternalCredits('100'), 'credits moved at dial time');
      const charged = await d.backend.prisma.callAttempt.count({
        where: { campaignId: campaign.campaignId, chargedAt: { not: null } },
      });
      d.check('B1', charged === 0, `${charged} attempts charged before any terminal outcome`);
    }

    d.advanceBy(2 * MINUTE);
    await d.drain({ stepMs: MINUTE, maxTicks: 10 });

    const attemptFor = async (phone: string) =>
      d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: campaign.contactByPhone.get(phone)! },
      });

    // B2: the rounding rule, from the snapshots the attempt carries.
    for (const [phone, secs, internal] of [
      [P.b45, 45, 20_000n],
      [P.b29, 29, 10_000n],
    ] as const) {
      const attempt = await attemptFor(phone);
      d.check('B2', attempt.chargedAt !== null, `${phone}: never charged`);
      d.check('B2', attempt.costCredits === internal,
        `${phone} (${secs}s at 2/min, 30s increment): costCredits=${attempt.costCredits}, expected ${internal}`);
      const ledger = await d.backend.prisma.creditTransaction.findMany({ where: { reference: attempt.id } });
      d.check('B3', ledger.length === 1 && ledger[0]!.type === 'CALL_USAGE' && ledger[0]!.amount === -internal,
        `${phone}: ledger ${ledger.map((l) => `${l.type}:${l.amount}`).join(',')}, expected one CALL_USAGE:-${internal}`);
    }

    // B2: the free call — closed, uncharged, no ledger row.
    {
      const attempt = await attemptFor(P.b0);
      d.check('B2', attempt.chargedAt !== null && (attempt.costCredits ?? 0n) === 0n,
        `no-answer: chargedAt=${attempt.chargedAt?.toISOString()} costCredits=${attempt.costCredits}`);
      const ledger = await d.backend.prisma.creditTransaction.count({ where: { reference: attempt.id } });
      d.check('B2', ledger === 0, `no-answer wrote ${ledger} ledger rows, expected none`);
    }

    // Balance arithmetic: 100 − 2.00 − 1.00.
    {
      const account = await d.backend.prisma.account.findUniqueOrThrow({ where: { id: ws.accountId } });
      d.check('B2', account.credits === d.backend.toInternalCredits('97'),
        `balance ${account.credits}, expected 970000 (100 − 3.00)`);
    }

    // B3: the completion webhook, replayed verbatim, changes nothing.
    {
      const attempt = await attemptFor(P.b45);
      const mock = await d.mockState();
      const call = mock.calls.find((c) => c.to_number === P.b45)!;
      const body = JSON.stringify({
        event: 'session.completed',
        timestamp: new Date().toISOString(),
        data: {
          call_id: call.call_id,
          session_id: call.session_id,
          duration_seconds: 45,
          extraction: { values: {} },
          call: { call_id: call.call_id, status: 'completed', disposition: 'completed', answered_by: 'human' },
        },
      });
      const ts = new Date().toISOString();
      const signature = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/webhooks/vocobase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': signature },
        body,
      });
      d.check('B3', res.status >= 200 && res.status < 300, `replayed completion answered ${res.status}`);
      const ledger = await d.backend.prisma.creditTransaction.count({ where: { reference: attempt.id } });
      d.check('B3', ledger === 1, `replayed completion left ${ledger} ledger rows`);
      const account = await d.backend.prisma.account.findUniqueOrThrow({ where: { id: ws.accountId } });
      d.check('B3', account.credits === d.backend.toInternalCredits('97'), 'replayed completion moved credits');
    }

    // B4: the shortfall — a 4.00-credit call on 1.2 credits.
    const poor = await d.seedWorkspace({
      handle: `broke${d.seed}`,
      credits: '1.2',
      tierSlug: `broke${d.seed}`,
      ratePerMinDisplay: '2.00',
      billingIncrementSecs: 30,
    });
    const short = await d.seedCampaign(poor, { concurrencyLimit: 1, retryCount: 0, contacts: [P.broke] });
    await d.script({ numbers: [{ to_number: P.broke, rules: [humanFor(120)] }] });
    await d.start(poor, short.campaignId);
    await d.tick();
    d.advanceBy(3 * MINUTE);
    await d.tick();
    d.advanceBy(MINUTE);
    await d.tick();
    {
      const attempt = await d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: short.contactByPhone.get(P.broke)! },
      });
      d.check('B4', attempt.shortfall && attempt.costCredits === 40_000n,
        `shortfall=${attempt.shortfall} costCredits=${attempt.costCredits}, expected true/40000 owed`);
      const account = await d.backend.prisma.account.findUniqueOrThrow({ where: { id: poor.accountId } });
      d.check('B4', account.credits === d.backend.toInternalCredits('1.2'),
        `fail-closed: balance ${account.credits}, expected untouched 12000`);
      const ledger = await d.backend.prisma.creditTransaction.findMany({ where: { reference: attempt.id } });
      d.check('B4', ledger.length === 1 && ledger[0]!.type === 'CALL_USAGE_SHORTFALL' && ledger[0]!.amount === 0n,
        `shortfall ledger: ${ledger.map((l) => `${l.type}:${l.amount}`).join(',')}`);
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: short.campaignId } });
      d.check('B4', row.status === 'CREDIT_EXHAUSTED', `shortfall left the campaign ${row.status}`);
    }
  },
};
