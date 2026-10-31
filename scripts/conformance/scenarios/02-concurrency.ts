import { MINUTE, type Driver, type Scenario } from '../scenario.js';

/**
 * Concurrency ceilings (D7, D8, D9, D6): two campaigns of one account, each
 * with its own limit, sharing the account pool. Calls talk for five minutes so
 * lines stay occupied across sweeps; the suite samples in-flight counts after
 * every tick and asserts no ceiling was ever pierced — including by
 * claimed-but-not-yet-terminal attempts, which is what the in-flight counter
 * reads (D7).
 */
const A_CONTACTS = Array.from({ length: 5 }, (_, i) => `+9198711000${10 + i}`);
const B_CONTACTS = Array.from({ length: 5 }, (_, i) => `+9198722000${10 + i}`);

export const concurrency: Scenario = {
  name: 'concurrency',
  rows: ['D6', 'D7', 'D8', 'D9'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `conc${d.seed}`, accountConcurrency: 3 });
    const a = await d.seedCampaign(ws, { name: 'A', concurrencyLimit: 2, contacts: A_CONTACTS });
    const b = await d.seedCampaign(ws, { name: 'B', concurrencyLimit: 2, contacts: B_CONTACTS });
    const longCall = {
      status: 'completed',
      answered_by: 'human',
      duration_seconds: 300,
      delays_secs: { ringing: 2, hold: 3, talk: 300 },
    };
    await d.script({
      numbers: [...A_CONTACTS, ...B_CONTACTS].map((phone) => ({ to_number: phone, rules: [longCall] })),
    });

    await d.start(ws, a.campaignId);
    await d.start(ws, b.campaignId);

    let peakA = 0;
    let peakB = 0;
    let peakAccount = 0;
    for (let i = 0; i < 40; i++) {
      await d.tick();
      const inflight = await d.backend.prisma.callAttempt.groupBy({
        by: ['campaignId'],
        where: { status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
        _count: true,
      });
      const byId = new Map(inflight.map((r) => [r.campaignId, r._count]));
      const inA = byId.get(a.campaignId) ?? 0;
      const inB = byId.get(b.campaignId) ?? 0;
      peakA = Math.max(peakA, inA);
      peakB = Math.max(peakB, inB);
      peakAccount = Math.max(peakAccount, inA + inB);
      const unfinished = await d.backend.prisma.campaignContact.count({
        where: { status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
      });
      if (unfinished === 0) break;
      d.advanceBy(MINUTE);
    }
    await d.drain({ stepMs: MINUTE, maxTicks: 20 });

    d.check('D9', peakA <= 2 && peakB <= 2, `campaign in-flight peaked A=${peakA} B=${peakB}, limit 2`);
    d.check('D8', peakAccount <= 3, `account in-flight peaked ${peakAccount}, pool is 3`);
    d.check('D7', peakAccount === 3, `pool never filled (peak ${peakAccount}) — claimed work may not be counted`);
    const mock = await d.mockState();
    d.check('D7', mock.peak <= 3, `mock saw ${mock.peak} simultaneous live calls, pool is 3`);

    // Least-recently-dialed ordering: with a shared pool neither campaign may
    // be starved — both must finish fully.
    for (const [label, c] of [['A', a], ['B', b]] as const) {
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: c.campaignId } });
      d.check('D6', row.status === 'COMPLETED', `campaign ${label} ended ${row.status}, expected COMPLETED`);
      d.check(
        'D6',
        row.completedCount === 5,
        `campaign ${label} completed ${row.completedCount}/5 — starvation under a shared pool`,
      );
    }
  },
};
