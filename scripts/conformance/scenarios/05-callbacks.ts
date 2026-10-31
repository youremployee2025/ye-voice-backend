import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';

/**
 * Callbacks (CB1, CB2, CB3, CB4, CB5, CB6): booking from extraction, the
 * armed equality, oldest-promise-first claiming, the 3-per-contact cap, the
 * booking-time window roll, YE's own extraction key with `callback_at` as
 * fallback, and the refusals (date-only, too-soon).
 */
const P = {
  serial: '+919873330011', // asks for a callback on every call; capped at 3
  older: '+919873330012', // promise at +60m — must be dialed before...
  newer: '+919873330013', // ...the promise at +70m, when both are due
  fallback: '+919873330014', // uses the legacy callback_at key
  dateOnly: '+919873330015', // date-only promise: rejected
  tooSoon: '+919873330016', // +30s promise: rejected (60s lead)
  windowed: '+919873330021', // promise outside the campaign window: rolled
};

const human = (extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  answered_by: 'human',
  duration_seconds: 20,
  delays_secs: { ringing: 1, hold: 2, talk: 20 },
  ...extra,
});

/** IST wall-clock parts for an instant (the default campaign timezone). */
function istParts(ms: number): { hour: number; day: string; hm: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour),
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
  };
}

export const callbacks: Scenario = {
  name: 'callbacks',
  rows: ['CB1', 'CB2', 'CB3', 'CB4', 'CB5', 'CB6'],
  runs: 3,
  async run(d: Driver) {
    const at = (mins: number) => new Date(T0 + mins * MINUTE).toISOString();
    const ws = await d.seedWorkspace({ handle: `cb${d.seed}` });
    const open = await d.seedCampaign(ws, {
      name: 'open',
      concurrencyLimit: 6,
      retryCount: 0,
      contacts: [P.serial, P.older, P.newer, P.fallback, P.dateOnly, P.tooSoon],
    });

    // A second campaign whose window is open now and closes in two hours, so
    // a promise for +3h lands outside it and must roll to the next opening.
    const nowIst = istParts(T0);
    const fromTime = `${String(nowIst.hour).padStart(2, '0')}:00`;
    const toTime = `${String((nowIst.hour + 2) % 24).padStart(2, '0')}:00`;
    const windowed = await d.seedCampaign(ws, {
      name: 'windowed',
      concurrencyLimit: 2,
      retryCount: 0,
      window: { fromTime, toTime, timezone: 'Asia/Kolkata' },
      contacts: [P.windowed],
    });
    const outsideIst = istParts(T0 + 3 * 60 * MINUTE); // naive local, campaign tz

    await d.script({
      numbers: [
        {
          to_number: P.serial,
          rules: [1, 2, 3, 4].map((n) =>
            human({ extraction: { callback_requested_at: at(60 + n) } }),
          ),
        },
        { to_number: P.older, rules: [human({ extraction: { callback_requested_at: at(60) } }), human()] },
        { to_number: P.newer, rules: [human({ extraction: { callback_requested_at: at(70) } }), human()] },
        { to_number: P.fallback, rules: [human({ extraction: { callback_at: at(80) } }), human()] },
        { to_number: P.dateOnly, rules: [human({ extraction: { callback_requested_at: '2026-12-24' } })] },
        { to_number: P.tooSoon, rules: [human({ extraction: { callback_requested_at: at(0.5) } })] },
        {
          to_number: P.windowed,
          rules: [human({ extraction: { callback_requested_at: `${outsideIst.day}T${outsideIst.hm}` } })],
        },
      ],
    });

    await d.start(ws, open.campaignId);
    await d.start(ws, windowed.campaignId);

    // First wave: everyone answers; the bookings land or are refused.
    for (let i = 0; i < 4; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
    }

    const contact = async (phone: string, campaign = open) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({
        where: { id: campaign.contactByPhone.get(phone)! },
      });

    // CB1: the armed pair is the equality, written by booking alone.
    for (const [label, phone, mins] of [
      ['older', P.older, 60],
      ['newer', P.newer, 70],
      ['fallback (callback_at key)', P.fallback, 80],
    ] as const) {
      const c = await contact(phone);
      const armed =
        c.status === 'PENDING' &&
        c.callbackAt !== null &&
        c.nextEligibleAt?.getTime() === c.callbackAt.getTime();
      const row = label.startsWith('fallback') ? 'CB6' : 'CB1';
      d.check(row, armed, `${label}: not armed (status=${c.status} next=${c.nextEligibleAt?.toISOString()} cb=${c.callbackAt?.toISOString()})`);
      d.check(row, c.callbackAt?.getTime() === T0 + mins * MINUTE, `${label}: promise at ${c.callbackAt?.toISOString()}, asked for +${mins}m`);
    }

    // CB6/CB4: rejected promises leave the contact settled and unarmed.
    for (const [row, label, phone] of [
      ['CB6', 'date-only', P.dateOnly],
      ['CB4', 'too-soon', P.tooSoon],
    ] as const) {
      const c = await contact(phone);
      d.check(row, c.status === 'COMPLETED' && c.callbackAt === null && c.callbackCount === 0,
        `${label}: expected settled+unarmed, got status=${c.status} callbackAt=${c.callbackAt?.toISOString()} count=${c.callbackCount}`);
    }

    // CB5: the out-of-window promise rolls forward to the next window opening
    // (next day at fromTime, in the campaign's timezone).
    {
      const c = await contact(P.windowed, windowed);
      const rolled = c.callbackAt ? istParts(c.callbackAt.getTime()) : null;
      const promisedDay = istParts(T0 + 24 * 60 * MINUTE).day;
      d.check(
        'CB5',
        rolled !== null && rolled.hm === fromTime && rolled.day === promisedDay,
        `windowed promise rolled to ${c.callbackAt?.toISOString()} (${rolled?.day} ${rolled?.hm} IST), expected ${promisedDay} ${fromTime}`,
      );
      d.check('CB5', c.nextEligibleAt?.getTime() === c.callbackAt?.getTime(), 'windowed promise is not armed');
    }

    // CB2: with one slot and both promises due, the older promise dials first.
    await d.backend.prisma.campaign.update({
      where: { id: open.campaignId },
      data: { concurrencyLimit: 1 },
    });
    d.advanceBy(75 * MINUTE);
    // The windowed campaign's armed promise sits until tomorrow, so a full
    // drain never quiesces — cap the ticks and assert states directly.
    await d.drain({ stepMs: 2 * MINUTE, maxTicks: 40 });
    const olderDial = d.trace.findIndex(
      (e) => e.kind === 'dial' && e.phone === P.older && e.attemptNo === 2,
    );
    const newerDial = d.trace.findIndex(
      (e) => e.kind === 'dial' && e.phone === P.newer && e.attemptNo === 2,
    );
    d.check('CB2', olderDial !== -1 && newerDial !== -1 && olderDial < newerDial,
      `oldest promise first: older idx=${olderDial}, newer idx=${newerDial}`);

    // CB3: the serial requester was granted exactly three callbacks; the
    // fourth ask changed nothing and the contact settled.
    const serial = await contact(P.serial);
    d.check('CB3', serial.callbackCount === 3, `callbackCount=${serial.callbackCount}, cap is 3`);
    d.check('CB3', serial.status === 'COMPLETED', `serial requester ended ${serial.status}`);
    const serialDials = d.trace.filter((e) => e.kind === 'dial' && e.phone === P.serial).length;
    d.check('CB3', serialDials === 4, `serial requester dialed ${serialDials} times, expected 1+3`);
    d.check('CB2', serial.attempts === 0, `callbacks consumed retries (attempts=${serial.attempts})`);

    // CB4: booking hands the settled counter back — the open campaign's
    // counters must still sum to its six contacts, exactly once each.
    const campaignRow = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: open.campaignId } });
    d.check(
      'CB4',
      campaignRow.completedCount + campaignRow.failedCount === 6,
      `counters completed=${campaignRow.completedCount} failed=${campaignRow.failedCount}, expected to sum to 6`,
    );
  },
};
