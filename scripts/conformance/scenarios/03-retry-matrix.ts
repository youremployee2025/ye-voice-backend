import { MINUTE, type Driver, type Scenario } from '../scenario.js';

/**
 * Retry semantics (R1–R4): one contact per outcome class, retryCount=2 with a
 * 10/30-minute ladder. Asserts which outcomes retry vs settle permanently,
 * the attempt budget at both ends, ladder timing from the dial trace, and
 * that a retry moves no campaign counter and never touches callbackAt.
 */
const P = {
  noAnswer: '+919871110011',
  busyThenHuman: '+919871110012',
  voicemail: '+919871110013',
  machineThenHuman: '+919871110014',
  hangupThenHuman: '+919871110015',
  blocked: '+919871110016',
  failedDisp: '+919871110017',
  human: '+919871110018',
};

const human = { status: 'completed', answered_by: 'human', duration_seconds: 25, delays_secs: { ringing: 1, hold: 2, talk: 25 } };
const noAnswer = { status: 'no_answer', delays_secs: { ringing: 1, hold: 5 } };
const busy = { status: 'busy', delays_secs: { ringing: 1, hold: 2 } };
const voicemail = { status: 'completed', disposition: 'voicemail', duration_seconds: 12, delays_secs: { ringing: 1, hold: 2, talk: 12 } };
const machine = { status: 'completed', answered_by: 'machine', duration_seconds: 8, delays_secs: { ringing: 1, hold: 2, talk: 8 } };
const hangup = { status: 'completed', disposition: 'user_hangup_no_speech', duration_seconds: 3, delays_secs: { ringing: 1, hold: 2, talk: 3 } };
const blocked = { status: 'failed', disposition: 'blocked', delays_secs: { ringing: 1, hold: 2 } };
const failedDisp = { status: 'failed', disposition: 'failed', delays_secs: { ringing: 1, hold: 2 } };

export const retryMatrix: Scenario = {
  name: 'retry-matrix',
  rows: ['R1', 'R2', 'R3', 'R4'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `retry${d.seed}` });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 8,
      retryCount: 2,
      cooldownMinutes: 30,
      retryDelaysMinutes: [10, 30],
      contacts: Object.values(P),
    });
    await d.script({
      numbers: [
        { to_number: P.noAnswer, rules: [noAnswer, noAnswer, noAnswer] },
        { to_number: P.busyThenHuman, rules: [busy, human] },
        { to_number: P.voicemail, rules: [voicemail, voicemail, voicemail] },
        { to_number: P.machineThenHuman, rules: [machine, human] },
        { to_number: P.hangupThenHuman, rules: [hangup, human] },
        { to_number: P.blocked, rules: [blocked] },
        { to_number: P.failedDisp, rules: [failedDisp] },
        { to_number: P.human, rules: [human] },
      ],
    });

    await d.start(ws, campaign.campaignId);
    await d.drain({ stepMs: 5 * MINUTE, maxTicks: 60 });

    const contacts = await d.backend.prisma.campaignContact.findMany({
      where: { campaignId: campaign.campaignId },
      include: { contact: { select: { phone: true } } },
    });
    const byPhone = new Map(contacts.map((c) => [c.contact.phone, c]));
    const expect = (phone: string, status: string, attempts: number, label: string) => {
      const c = byPhone.get(phone)!;
      d.check('R1', c.status === status, `${label}: status ${c.status}, expected ${status}`);
      d.check('R2', c.attempts === attempts, `${label}: attempts ${c.attempts}, expected ${attempts}`);
    };

    // Retryable outcomes burn the whole budget then settle FAILED.
    expect(P.noAnswer, 'FAILED', 2, 'no_answer x3');
    expect(P.voicemail, 'FAILED', 2, 'voicemail x3');
    // Retryable then answered: COMPLETED with the retry recorded.
    expect(P.busyThenHuman, 'COMPLETED', 1, 'busy then human');
    expect(P.machineThenHuman, 'COMPLETED', 1, 'machine then human');
    expect(P.hangupThenHuman, 'COMPLETED', 1, 'hangup-no-speech then human');
    // Permanent dispositions never redial.
    expect(P.blocked, 'FAILED', 0, 'blocked');
    expect(P.failedDisp, 'FAILED', 0, 'failed disposition');
    expect(P.human, 'COMPLETED', 0, 'human first dial');

    const dialCount = (phone: string) =>
      d.trace.filter((e) => e.kind === 'dial' && e.phone === phone).length;
    d.check('R2', dialCount(P.noAnswer) === 3, `no_answer dialed ${dialCount(P.noAnswer)} times, expected 1+retryCount=3`);
    d.check('R1', dialCount(P.blocked) === 1, `blocked dialed ${dialCount(P.blocked)} times, expected 1`);
    d.check('R1', dialCount(P.failedDisp) === 1, `failed-disposition dialed ${dialCount(P.failedDisp)} times, expected 1`);

    // Ladder timing, from the engine's own timestamps (the virtual clock and
    // the wall clock drift apart, so dial-to-dial gaps in virtual time are
    // not the spec — nextEligibleAt relative to the resolution instant is):
    // retry 1 waits retryDelaysMinutes[0]=10, retry 2 waits [1]=30.
    const noAnswerId = campaign.contactByPhone.get(P.noAnswer)!;
    const reArms = d.trace.filter(
      (e) => e.kind === 'contact' && e.id === noAnswerId && e.to === 'PENDING',
    );
    const attempts = await d.backend.prisma.callAttempt.findMany({
      where: { campaignContactId: noAnswerId },
      orderBy: { attemptNo: 'asc' },
    });
    d.check('R3', reArms.length === 2, `expected 2 retry re-arms for no_answer, saw ${reArms.length}`);
    for (const [i, expectedMin] of [10, 30].entries()) {
      const reArm = reArms[i];
      const resolvedAt = attempts[i]?.resolvedAt;
      if (reArm?.kind !== 'contact' || !reArm.nextEligibleAt || !resolvedAt) continue;
      const waitedMin = (reArm.nextEligibleAt.getTime() - resolvedAt.getTime()) / MINUTE;
      d.check(
        'R3',
        Math.abs(waitedMin - expectedMin) < 0.1,
        `retry ${i + 1} armed ${waitedMin.toFixed(2)}min after resolution, ladder says ${expectedMin}`,
      );
    }

    // A retry is not a resolution: exactly one terminal counter movement per
    // contact, and callbackAt untouched throughout.
    const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('R4', row.completedCount === 4 && row.failedCount === 4, `counters completed=${row.completedCount} failed=${row.failedCount}, expected 4/4`);
    d.check('R4', contacts.every((c) => c.callbackAt === null), 'a retry re-arm touched callbackAt');
  },
};
