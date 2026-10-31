import { MINUTE, type Driver, type Scenario } from '../scenario.js';

/**
 * Number rotation (N1, N2): attached numbers rotate in attachment order via
 * the batch cursor — the i-th dial overall comes from numbers[i % n] while
 * batches stay sequential — and the attempt row snapshots the from-number
 * used. A deactivated number drops out of rotation; with every number
 * unusable the campaign holds (no claims, no pause) and resumes when one
 * comes back.
 */
const DIDS = ['+918011771001', '+918011771002', '+918011771003'];
const WAVE1 = Array.from({ length: 6 }, (_, i) => `+9198791200${10 + i}`);
const WAVE2 = ['+919879120021', '+919879120022'];
const WAVE3 = '+919879120031';

const human = { status: 'completed', answered_by: 'human', duration_seconds: 15, delays_secs: { ringing: 1, hold: 2, talk: 15 } };

export const rotation: Scenario = {
  name: 'rotation',
  rows: ['N1', 'N2'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `rot${d.seed}`, dids: DIDS });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 2,
      retryCount: 0,
      attachNumbers: [0, 1, 2],
      contacts: [...WAVE1, ...WAVE2, WAVE3],
    });
    // The later waves wait so the deactivation happens between them.
    for (const phone of [...WAVE2, WAVE3]) {
      await d.backend.prisma.campaignContact.update({
        where: { id: campaign.contactByPhone.get(phone)! },
        data: { nextEligibleAt: new Date(d.nowMs + (phone === WAVE3 ? 90 : 60) * MINUTE) },
      });
    }
    await d.script({
      numbers: [...WAVE1, ...WAVE2, WAVE3].map((p) => ({ to_number: p, rules: [human] })),
    });

    await d.start(ws, campaign.campaignId);
    for (let i = 0; i < 12; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
      const left = await d.backend.prisma.campaignContact.count({
        where: { campaignId: campaign.campaignId, status: { in: ['PENDING', 'QUEUED'] }, nextEligibleAt: null },
      });
      if (left === 0) break;
    }

    // N1: the i-th dial overall came from DIDS[i % 3], and the attempt row
    // snapshotted it.
    const wave1Dials = d.trace.filter((e) => e.kind === 'dial');
    d.check('N1', wave1Dials.length === 6, `wave 1 dialed ${wave1Dials.length}, expected 6`);
    for (const [i, dial] of wave1Dials.entries()) {
      d.check('N1', dial.fromNumber === DIDS[i % 3],
        `dial ${i} from ${dial.fromNumber}, expected ${DIDS[i % 3]} (cursor order)`);
      if (dial.attemptId) {
        const attempt = await d.backend.prisma.callAttempt.findUniqueOrThrow({ where: { id: dial.attemptId } });
        d.check('N1', attempt.fromNumber === dial.fromNumber,
          `attempt snapshot ${attempt.fromNumber} != dialed ${dial.fromNumber}`);
      }
    }

    // N2: the middle number is deactivated; wave 2 rotates over the survivors.
    await d.backend.prisma.phoneNumber.update({
      where: { id: ws.phoneNumberIds[1]! },
      data: { status: 'RELEASED_NONPAYMENT' },
    });
    d.advanceBy(60 * MINUTE);
    for (let i = 0; i < 8; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }
    const wave2Dials = d.trace.filter((e) => e.kind === 'dial').slice(6);
    d.check('N2', wave2Dials.length === 2, `wave 2 dialed ${wave2Dials.length}, expected 2`);
    d.check('N2', wave2Dials.every((e) => e.fromNumber !== DIDS[1]),
      `a deactivated number kept dialing: ${wave2Dials.map((e) => e.fromNumber).join(',')}`);

    // N2: all numbers unusable — the campaign holds, unpaused, claiming
    // nothing; reactivation resumes it without an operator.
    await d.backend.prisma.phoneNumber.updateMany({
      where: { id: { in: ws.phoneNumberIds } },
      data: { status: 'RELEASED_NONPAYMENT' },
    });
    d.advanceBy(30 * MINUTE);
    for (let i = 0; i < 3; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }
    d.check('N2', d.trace.filter((e) => e.kind === 'dial').length === 8, 'an unusable-number hold still dialed');
    const held = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('N2', held.status === 'RUNNING', `all-numbers-unusable should hold, not pause: ${held.status}`);

    await d.backend.prisma.phoneNumber.update({
      where: { id: ws.phoneNumberIds[2]! },
      data: { status: 'ASSIGNED' },
    });
    await d.drain({ stepMs: MINUTE, maxTicks: 10 });
    const finalDials = d.trace.filter((e) => e.kind === 'dial');
    d.check('N2', finalDials.length === 9, `after reactivation ${finalDials.length} dials, expected 9`);
    d.check('N2', finalDials[8]!.fromNumber === DIDS[2], `the reactivated number should dial (from=${finalDials[8]!.fromNumber})`);
    const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('N2', row.status === 'COMPLETED' && row.completedCount === 9, `ended ${row.status} completed=${row.completedCount}`);
  },
};
