import { MINUTE, type Driver, type Scenario } from '../scenario.js';

/**
 * Launch-failure triage (X3, X4, X5): a transient upstream failure gives the
 * contact back with one flat cooldown and consumes nothing; a 429 halts the
 * rest of the pass without pausing anything; a 400 is the one per-contact
 * permanent launch failure; a 403 pauses the campaign; an unconfirmed write
 * leaves the attempt for the reaper and never double-dials. Runs 10× — the
 * give-backs race the sweep that claimed them.
 */
const P = {
  t502: '+919877880011',
  t429: '+919877880012',
  t400: '+919877880013',
  tdrop: '+919877880014',
  t403: '+919877880021',
};

const human = { status: 'completed', answered_by: 'human', duration_seconds: 20, delays_secs: { ringing: 1, hold: 2, talk: 20 } };

export const transientFaults: Scenario = {
  name: 'transient-faults',
  rows: ['X3', 'X4', 'X5'],
  runs: 10,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `fault${d.seed}` });
    const main = await d.seedCampaign(ws, {
      name: 'main',
      concurrencyLimit: 4,
      retryCount: 1, // the reaper's abandonment of the dropped write consumes a retry
      cooldownMinutes: 2,
      contacts: [P.t502, P.t429, P.t400, P.tdrop],
    });
    // The 403 case pauses its campaign AND halts the pass it happens in, so
    // it runs after the main cases, on its own campaign.
    const refused = await d.seedCampaign(ws, {
      name: 'refused',
      concurrencyLimit: 2,
      retryCount: 0,
      cooldownMinutes: 2,
      contacts: [P.t403],
    });
    await d.script({
      numbers: [
        { to_number: P.t502, rules: [{ fault: 'http_502' }, human] },
        { to_number: P.t429, rules: [{ fault: 'http_429_rate' }, human] },
        { to_number: P.t400, rules: [{ fault: 'http_400' }] },
        { to_number: P.tdrop, rules: [{ fault: 'drop' }, human] },
        { to_number: P.t403, rules: [{ fault: 'http_403' }, human] },
      ],
    });

    const contact = async (phone: string, c = main) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({ where: { id: c.contactByPhone.get(phone)! } });

    // Tick 1: the batch is claimed FIFO; the 502 launch fails and carries on,
    // the 429 halts the pass, so the last two are released unlaunched.
    await d.start(ws, main.campaignId);
    await d.tick();

    for (const [label, phone] of [['502', P.t502], ['429', P.t429]] as const) {
      const c = await contact(phone);
      d.check('X3', c.status === 'PENDING' && c.attempts === 0,
        `${label}: expected given back untouched, got status=${c.status} attempts=${c.attempts}`);
      d.check('X3', c.nextEligibleAt !== null && c.nextEligibleAt.getTime() > Date.now() + 1.5 * MINUTE,
        `${label}: give-back cooldown missing (nextEligibleAt=${c.nextEligibleAt?.toISOString()})`);
    }
    {
      const halted = await contact(P.t400);
      d.check('X4', halted.status === 'PENDING' && halted.nextEligibleAt === null,
        `429 halt: the released remainder should be untouched, got ${halted.status}/${halted.nextEligibleAt?.toISOString()}`);
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: main.campaignId } });
      d.check('X4', row.status === 'RUNNING', `429 must not pause the campaign (status=${row.status})`);
    }

    // Tick 2 (the 502/429 are still cooling): the 400 settles its contact
    // alone; the dropped write goes stuck.
    d.advanceBy(MINUTE);
    await d.tick();
    {
      const c = await contact(P.t400);
      d.check('X4', c.status === 'FAILED', `400: contact is ${c.status}, expected FAILED`);
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: main.campaignId } });
      d.check('X4', row.failedCount === 1 && row.status === 'RUNNING',
        `400: failedCount=${row.failedCount} status=${row.status}, expected 1/RUNNING`);
      const dropped = await contact(P.tdrop);
      d.check('X5', dropped.status === 'QUEUED', `dropped write: contact is ${dropped.status}, expected QUEUED (held)`);
      d.check('X5', d.trace.filter((e) => e.kind === 'dial' && e.phone === P.tdrop).length === 0,
        'the dropped write reached the dial log');
    }

    // Tick 3: the cooled-off pair redials and completes; the unknown-outcome
    // contact must not be redialed inside the timeout.
    d.advanceBy(4 * MINUTE);
    await d.tick();
    d.advanceBy(MINUTE);
    await d.tick();
    {
      const still = await contact(P.tdrop);
      d.check('X5', still.status === 'QUEUED', `dropped write redialed inside the timeout (${still.status})`);
    }

    // Past the attempt timeout: the reaper abandons the dropped write, the
    // abandonment consumes a retry, and the redial completes.
    d.advanceBy(61 * MINUTE);
    await d.drain({ stepMs: 2 * MINUTE, maxTicks: 20 });

    for (const [label, phone] of [['502', P.t502], ['429', P.t429]] as const) {
      const c = await contact(phone);
      d.check('X3', c.status === 'COMPLETED' && c.attempts === 0,
        `${label}: after give-back expected COMPLETED at attempts=0, got ${c.status}/${c.attempts}`);
      const attemptRows = await d.backend.prisma.callAttempt.count({ where: { campaignContactId: c.id } });
      d.check('X3', attemptRows === 2, `${label}: ${attemptRows} attempt rows, expected failed launch + real call`);
    }
    {
      const c = await contact(P.tdrop);
      d.check('X5', c.status === 'COMPLETED' && c.attempts === 1,
        `dropped write: expected COMPLETED with the abandoned dial counted (attempts=1), got ${c.status}/${c.attempts}`);
      const first = await d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: c.id, attemptNo: 1 },
      });
      d.check('X5', first.status === 'ABANDONED', `dropped write's first attempt is ${first.status}, expected ABANDONED`);
      d.check('X5', d.trace.filter((e) => e.kind === 'dial' && e.phone === P.tdrop).length === 1,
        'the unconfirmed write was double-dialed');
    }
    const mainRow = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: main.campaignId } });
    d.check('X3', mainRow.status === 'COMPLETED' && mainRow.completedCount === 3 && mainRow.failedCount === 1,
      `main ended ${mainRow.status} completed=${mainRow.completedCount} failed=${mainRow.failedCount}`);

    // Finally the 403: pauses its campaign, gives its contact back.
    await d.start(ws, refused.campaignId);
    await d.tick();
    {
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: refused.campaignId } });
      d.check('X4', row.status === 'PAUSED', `403: campaign is ${row.status}, expected PAUSED`);
      const c = await contact(P.t403, refused);
      d.check('X4', c.status === 'PENDING' && c.attempts === 0,
        `403: contact should be given back, got ${c.status}/${c.attempts}`);
    }
  },
};
