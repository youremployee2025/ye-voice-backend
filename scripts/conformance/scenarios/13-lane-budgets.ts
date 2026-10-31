import { MINUTE, type Driver, type Scenario } from '../scenario.js';

/**
 * Lane budgets (D3, D4): with concurrencyLimit=2 and retryConcurrency=1, a
 * sweep that finds both a due retry and fresh work claims exactly one of
 * each (the reservation); a sweep that finds no due retries lends the idle
 * reserved slot to the fresh lane (the borrow pass). Asserted as an
 * invariant over every tick, from the pre-sweep eligibility sets.
 */
const RETRY = ['+919879230011', '+919879230012'];
const FRESH = Array.from({ length: 6 }, (_, i) => `+9198792400${10 + i}`);

const human = { status: 'completed', answered_by: 'human', duration_seconds: 10, delays_secs: { ringing: 1, hold: 2, talk: 10 } };
const busy = { status: 'busy', delays_secs: { ringing: 1, hold: 2 } };

export const laneBudgets: Scenario = {
  name: 'lane-budgets',
  rows: ['D3', 'D4'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `lane${d.seed}` });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 2,
      retryConcurrency: 1,
      retryCount: 1,
      cooldownMinutes: 1,
      contacts: [...RETRY, ...FRESH],
    });
    await d.script({
      numbers: [
        ...RETRY.map((p) => ({ to_number: p, rules: [busy, human] })),
        ...FRESH.map((p) => ({ to_number: p, rules: [human] })),
      ],
    });
    await d.start(ws, campaign.campaignId);

    let sawReservedSplit = false;
    let sawBorrow = false;
    for (let i = 0; i < 25; i++) {
      // Deliver everything the mock owes first **and let it be applied**, so
      // the eligibility picture sampled here is exactly what the sweep inside
      // tick() will see. A pre-delivery sample counts calls as live that
      // resolve on delivery — and since outcomes are applied on the webhook
      // queue rather than on the request thread, an advance alone is no longer
      // enough to have applied them.
      await d.deliverPending();
      const [waiting, inflight] = await Promise.all([
        d.backend.prisma.campaignContact.findMany({
          where: {
            campaignId: campaign.campaignId,
            status: 'PENDING',
            OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: d.now() } }],
          },
          select: { attempts: true },
        }),
        d.backend.prisma.callAttempt.count({
          where: { campaignId: campaign.campaignId, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
        }),
      ]);
      const dialsBefore = d.trace.filter((e) => e.kind === 'dial').length;
      await d.tick();
      const newDials = d.trace.filter((e) => e.kind === 'dial').slice(dialsBefore);
      const retryDials = newDials.filter((e) => (e.attemptNo ?? 1) > 1).length;
      const freshDials = newDials.length - retryDials;

      const waitingRetry = waiting.filter((w) => w.attempts > 0).length;
      const waitingFresh = waiting.length - waitingRetry;
      if (inflight === 0 && waitingRetry >= 1 && waitingFresh >= 1) {
        // D3: the reserved split — one slot each way, never two of one kind.
        d.check('D3', retryDials === 1 && freshDials === 1,
          `with ${waitingRetry} retries and ${waitingFresh} fresh due, the sweep claimed ${retryDials} retry + ${freshDials} fresh (limit 2, reserved 1)`);
        sawReservedSplit = true;
      } else if (inflight === 0 && waitingRetry === 0 && waitingFresh >= 2) {
        // D4: nothing to reserve for — the fresh lane borrows the idle slot.
        d.check('D4', freshDials === 2,
          `with no retries due and ${waitingFresh} fresh waiting, the sweep claimed ${freshDials} fresh — the idle reserved slot was not lent`);
        sawBorrow = true;
      }

      const unfinished = await d.backend.prisma.campaignContact.count({
        where: { status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
      });
      const mock = await d.mockState();
      if (unfinished === 0 && mock.active === 0 && mock.pending_timeline === 0) break;
      d.advanceBy(MINUTE);
    }

    d.check('D3', sawReservedSplit, 'no tick ever presented retries and fresh together — the reservation was not exercised');
    d.check('D4', sawBorrow, 'no tick ever presented an idle retry slot — borrowing was not exercised');

    const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('D3', row.status === 'COMPLETED' && row.completedCount === 8 && row.failedCount === 0,
      `ended ${row.status} completed=${row.completedCount} failed=${row.failedCount}`);
  },
};
