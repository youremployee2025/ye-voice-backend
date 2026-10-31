import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';

/**
 * Dial window (W1, W2, W3): a campaign whose window opens two hours from now
 * claims nothing while closed — statuses and eligibility timestamps
 * untouched, campaign not paused — and starts claiming on the first sweep
 * after opening. A half-configured window fails closed at start (W1).
 *
 * W3 is the same claim about DAYS rather than hours: a campaign whose window
 * excludes today dials nothing at any hour of it, stays RUNNING while it does
 * — a closed day is a campaign working exactly as configured, not a fault —
 * and drains once the clock reaches a day it does call on.
 */
const P = {
  fresh: '+919874440011',
  waiting: '+919874440012', // eligibility long past — must stay past, untouched
  offDay: '+919874440013', // W3: seeded on a weekday the campaign does not call on
};

const human = { status: 'completed', answered_by: 'human', duration_seconds: 15, delays_secs: { ringing: 1, hold: 2, talk: 15 } };

function istHour(ms: number, plus: number): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' });
  return `${String((Number(fmt.format(ms)) + plus) % 24).padStart(2, '0')}:00`;
}

/** The campaign-local date of an instant, read the way `dialingWindow.ts`
 *  reads it, so a scenario and the gate cannot disagree about which day it is. */
function istParts(ms: number): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    weekday: new Date(Date.UTC(get('year'), get('month') - 1, get('day'))).getUTCDay(),
    minutes: (get('hour') % 24) * 60 + get('minute'),
  };
}

export const dialWindow: Scenario = {
  name: 'dial-window',
  rows: ['W1', 'W2', 'W3'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `win${d.seed}` });
    // Opens 2 hours from now, closes 6 hours later. (Hour-granular, so the
    // "open" instant is somewhere within the next 2 hours; the scenario only
    // advances past a bound, never asserts against wall-hour arithmetic.)
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 4,
      retryCount: 0,
      window: { fromTime: istHour(T0, 2), toTime: istHour(T0, 8), timezone: 'Asia/Kolkata' },
      contacts: [P.fresh, P.waiting],
    });
    const waitingEligible = new Date(T0 - 45 * MINUTE);
    await d.backend.prisma.campaignContact.update({
      where: { id: campaign.contactByPhone.get(P.waiting)! },
      data: { nextEligibleAt: waitingEligible },
    });
    await d.script({
      numbers: [P.fresh, P.waiting].map((p) => ({ to_number: p, rules: [human] })),
    });
    await d.start(ws, campaign.campaignId);

    // Closed: sweeps claim nothing and touch nothing.
    for (let i = 0; i < 5; i++) {
      await d.tick();
      d.advanceBy(10 * MINUTE);
    }
    d.check('W2', d.trace.filter((e) => e.kind === 'dial').length === 0, 'a closed window still dialed');
    const rows = await d.backend.prisma.campaignContact.findMany({
      where: { campaignId: campaign.campaignId },
      include: { contact: { select: { phone: true } } },
    });
    for (const row of rows) {
      d.check('W2', row.status === 'PENDING', `${row.contact.phone} left PENDING while closed: ${row.status}`);
    }
    const waiting = rows.find((r) => r.contact.phone === P.waiting)!;
    d.check(
      'W2',
      waiting.nextEligibleAt?.getTime() === waitingEligible.getTime(),
      `a closed window moved nextEligibleAt to ${waiting.nextEligibleAt?.toISOString()}`,
    );
    const campaignRow = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('W2', campaignRow.status === 'RUNNING', `a closed window paused the campaign: ${campaignRow.status}`);

    // Open: claiming resumes on its own.
    d.advanceBy(2 * 60 * MINUTE);
    await d.drain({ stepMs: 10 * MINUTE, maxTicks: 30 });
    const dials = d.trace.filter((e) => e.kind === 'dial');
    d.check('W2', dials.length === 2, `expected 2 dials once open, saw ${dials.length}`);
    const done = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('W2', done.status === 'COMPLETED' && done.completedCount === 2, `after opening: ${done.status} completed=${done.completedCount}`);

    // W1 fail-closed: one end configured without the other cannot start.
    const half = await d.seedCampaign(ws, {
      name: 'half-window',
      window: { fromTime: '09:00', toTime: null, timezone: 'Asia/Kolkata' },
      contacts: ['+919874440099'],
    });
    const res = await d.api(ws)('POST', `/workspaces/${ws.workspaceId}/campaigns/${half.campaignId}/start`);
    d.check('W1', res.status >= 400, `half-configured window started anyway (${res.status})`);
    const halfRow = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: half.campaignId } });
    d.check('W1', halfRow.status === 'DRAFT', `half-configured window left ${halfRow.status}, expected DRAFT`);

    /**
     * W3 — a day the campaign does not call on.
     *
     * The excluded day is whichever one it is right now in the campaign's own
     * zone, so this holds on every day the suite is run rather than on the one
     * the author happened to write it on. No hours at all: the whole of an
     * allowed day is the window, which makes this a test of the day gate and
     * nothing else — an hours bound would decide the outcome before the days
     * were consulted.
     */
    /**
     * Moved clear of local midnight first, deliberately.
     *
     * The closed phase below ticks fifty campaign-minutes forward, so a run
     * that happens to start within an hour of midnight in Asia/Kolkata would
     * cross into the NEXT day — one of the six this campaign is allowed to
     * dial on — and the scenario would fail on the clock rather than on the
     * behaviour. One hour at a time, at most twice, so the walk itself stays
     * as simple as what it is checking.
     */
    while (istParts(d.nowMs).minutes >= 22 * 60) d.advanceBy(60 * MINUTE);

    const today = istParts(d.nowMs).weekday;
    const elsewhere = [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== today);
    const closedDay = await d.seedCampaign(ws, {
      name: 'closed-day',
      concurrencyLimit: 4,
      retryCount: 0,
      window: { fromTime: null, toTime: null, timezone: 'Asia/Kolkata', dialDays: elsewhere },
      contacts: [P.offDay],
    });
    await d.script({ numbers: [{ to_number: P.offDay, rules: [human] }] });
    await d.start(ws, closedDay.campaignId);

    const before = d.trace.filter((e) => e.kind === 'dial').length;
    for (let i = 0; i < 5; i++) {
      await d.tick();
      d.advanceBy(10 * MINUTE);
    }
    d.check(
      'W3',
      d.trace.filter((e) => e.kind === 'dial').length === before,
      `a day the campaign does not call on still dialed (local weekday ${istParts(d.nowMs).weekday}, excluded ${today})`,
    );
    const offDayRow = await d.backend.prisma.campaign.findUniqueOrThrow({
      where: { id: closedDay.campaignId },
    });
    d.check(
      'W3',
      offDayRow.status === 'RUNNING',
      `a closed DAY is not a fault, but the campaign is ${offDayRow.status}`,
    );

    // Tomorrow is one of the six allowed days, whichever day this started on.
    d.advanceBy(24 * 60 * MINUTE);
    await d.drain({ stepMs: 10 * MINUTE, maxTicks: 30 });
    const dayDials = d.trace.filter((e) => e.kind === 'dial').length - before;
    d.check('W3', dayDials === 1, `expected 1 dial on an allowed day, saw ${dayDials}`);
  },
};
