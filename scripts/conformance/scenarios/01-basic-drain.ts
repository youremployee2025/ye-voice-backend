import { MINUTE, type Driver, type Scenario } from '../scenario.js';

/**
 * Basic drain (D1, D2, L6): eight contacts, everybody answers. Asserts FIFO
 * claim order, one dial per contact, counters, terminal statuses, and the
 * auto-complete that follows the last resolution.
 */
const CONTACTS = Array.from({ length: 8 }, (_, i) => `+9198765000${10 + i}`);

export const basicDrain: Scenario = {
  name: 'basic-drain',
  rows: ['D1', 'D2', 'L6'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `drain${d.seed}` });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 3,
      retryCount: 0,
      contacts: CONTACTS,
    });
    await d.script({
      numbers: CONTACTS.map((phone) => ({
        to_number: phone,
        rules: [
          {
            status: 'completed',
            answered_by: 'human',
            duration_seconds: 30,
            delays_secs: { ringing: 2, hold: 3, talk: 30 },
          },
        ],
      })),
    });

    await d.start(ws, campaign.campaignId);
    const ticks = await d.drain({ stepMs: MINUTE });
    d.note(`drained in ${ticks} ticks`);

    // Every contact dialed exactly once, in creation (FIFO) order.
    const dials = d.trace.filter((e) => e.kind === 'dial');
    d.check('D1', dials.length === CONTACTS.length, `expected ${CONTACTS.length} dials, saw ${dials.length}`);
    const dialedPhones = dials.map((e) => e.phone);
    d.check(
      'D2',
      JSON.stringify(dialedPhones) === JSON.stringify(CONTACTS),
      `dial order ${dialedPhones.join(',')} != creation order`,
    );
    d.check(
      'D1',
      dials.every((e) => e.attemptNo === 1),
      'a fresh drain produced an attempt number other than 1',
    );

    const contacts = await d.backend.prisma.campaignContact.findMany({
      where: { campaignId: campaign.campaignId },
    });
    d.check('D1', contacts.every((c) => c.status === 'COMPLETED'), 'not every answered contact ended COMPLETED');

    const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check(
      'L6',
      row.status === 'COMPLETED' && row.completedAt !== null,
      `campaign should auto-complete, is ${row.status}`,
    );
    d.check(
      'D1',
      row.completedCount === CONTACTS.length && row.failedCount === 0 && row.skippedCount === 0,
      `counters completed=${row.completedCount} failed=${row.failedCount} skipped=${row.skippedCount}`,
    );
  },
};
