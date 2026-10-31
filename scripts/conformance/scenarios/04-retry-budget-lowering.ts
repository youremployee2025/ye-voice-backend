import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';

/**
 * Lowering the retry budget mid-campaign (R5, plus the CB2 budget exemption).
 *
 * Campaign ONE holds the sweep case: contact X is waiting on a retry
 * (attempts=1) when the budget drops to 0 — swept SKIPPED with the counter
 * moved; fresh contact Y (attempts=0) survives the sweep and still dials
 * after resume. Campaign TWO holds the exemption case: a contact with a
 * consumed retry AND an armed callback, on a campaign whose budget also
 * drops to 0 — the armed promise is exempt from both the sweep and the
 * claim-time budget test, so the callback still happens.
 */
const P = {
  swept: '+919872220011',
  fresh: '+919872220012',
  armed: '+919872220013',
};

const noAnswer = { status: 'no_answer', delays_secs: { ringing: 1, hold: 4 } };
const busy = { status: 'busy', delays_secs: { ringing: 1, hold: 2 } };
const human = { status: 'completed', answered_by: 'human', duration_seconds: 20, delays_secs: { ringing: 1, hold: 2, talk: 20 } };

export const retryBudgetLowering: Scenario = {
  name: 'retry-budget-lowering',
  rows: ['R5', 'CB2'],
  runs: 3,
  async run(d: Driver) {
    const callbackAt = new Date(T0 + 3 * 60 * MINUTE).toISOString();
    const ws = await d.seedWorkspace({ handle: `lower${d.seed}`, accountConcurrency: 10 });
    const one = await d.seedCampaign(ws, {
      name: 'sweep-case',
      concurrencyLimit: 2,
      retryCount: 5,
      cooldownMinutes: 240,
      contacts: [P.swept, P.fresh],
    });
    const two = await d.seedCampaign(ws, {
      name: 'exemption-case',
      concurrencyLimit: 2,
      retryCount: 5,
      retryDelaysMinutes: [1],
      contacts: [P.armed],
    });
    // Y stays un-dialed until well after the budget change.
    await d.backend.prisma.campaignContact.update({
      where: { id: one.contactByPhone.get(P.fresh)! },
      data: { nextEligibleAt: new Date(T0 + 6 * 60 * MINUTE) },
    });
    await d.script({
      numbers: [
        { to_number: P.swept, rules: [noAnswer] },
        { to_number: P.fresh, rules: [human] },
        {
          to_number: P.armed,
          rules: [busy, { ...human, extraction: { callback_requested_at: callbackAt } }, human],
        },
      ],
    });

    await d.start(ws, one.campaignId);
    await d.start(ws, two.campaignId);

    // A few 1-minute ticks: X resolves to a waiting retry (attempts=1,
    // eligible in 4h); the armed contact burns its busy, retries after 1
    // minute, answers, and books the 3-hour callback.
    for (let i = 0; i < 8; i++) {
      await d.tick();
      d.advanceBy(MINUTE);
      const armed = await d.backend.prisma.campaignContact.findUniqueOrThrow({
        where: { id: two.contactByPhone.get(P.armed)! },
      });
      if (armed.callbackAt !== null && armed.status === 'PENDING') break;
    }

    const sweptBefore = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: one.contactByPhone.get(P.swept)! },
    });
    d.check('R5', sweptBefore.status === 'PENDING' && sweptBefore.attempts === 1,
      `setup: X should be waiting at attempts=1, is ${sweptBefore.status}/${sweptBefore.attempts}`);
    const armedBefore = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: two.contactByPhone.get(P.armed)! },
    });
    d.check(
      'CB2',
      armedBefore.callbackAt !== null &&
        armedBefore.nextEligibleAt?.getTime() === armedBefore.callbackAt.getTime() &&
        armedBefore.attempts === 1 &&
        armedBefore.callbackCount === 1,
      `callback arming: nextEligibleAt=${armedBefore.nextEligibleAt?.toISOString()} callbackAt=${armedBefore.callbackAt?.toISOString()} attempts=${armedBefore.attempts} callbackCount=${armedBefore.callbackCount}`,
    );

    // Pause both, drop both budgets to 0, resume both.
    const api = d.api(ws);
    for (const c of [one, two]) {
      const base = `/workspaces/${ws.workspaceId}/campaigns/${c.campaignId}`;
      const pause = await api('POST', `${base}/pause`);
      d.check('R5', pause.status === 200, `pause refused: ${JSON.stringify(pause.body)}`);
      const patch = await api('PATCH', base, { retryCount: 0 });
      d.check('R5', patch.status === 200, `retryCount PATCH refused: ${JSON.stringify(patch.body)}`);
      const resume = await api('POST', `${base}/resume`);
      d.check('R5', resume.status === 200, `resume refused: ${JSON.stringify(resume.body)}`);
    }
    await d.snapshot();

    const swept = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: one.contactByPhone.get(P.swept)! },
    });
    d.check('R5', swept.status === 'SKIPPED', `over-budget contact is ${swept.status}, expected SKIPPED`);
    const oneRow = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: one.campaignId } });
    d.check('R5', oneRow.skippedCount === 1, `skippedCount=${oneRow.skippedCount}, expected 1`);
    const armedAfterPatch = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: two.contactByPhone.get(P.armed)! },
    });
    d.check('R5', armedAfterPatch.status === 'PENDING', `armed callback swept to ${armedAfterPatch.status}`);

    // The promise survives the budget cut: advance past the callback and the
    // fresh contact's eligibility, drain, and check both were dialed.
    d.advanceBy(6 * 60 * MINUTE + MINUTE);
    await d.drain({ stepMs: 5 * MINUTE, maxTicks: 30 });

    const armedFinal = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: two.contactByPhone.get(P.armed)! },
    });
    d.check('CB2', armedFinal.status === 'COMPLETED', `callback contact ended ${armedFinal.status}`);
    d.check('CB2', armedFinal.attempts === 1, `the callback dial consumed a retry (attempts=${armedFinal.attempts})`);
    const armedDials = d.trace.filter((e) => e.kind === 'dial' && e.phone === P.armed);
    d.check('CB2', armedDials.length === 3, `armed contact dialed ${armedDials.length} times, expected 3`);
    const freshFinal = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: one.contactByPhone.get(P.fresh)! },
    });
    d.check('R5', freshFinal.status === 'COMPLETED', `fresh in-budget contact ended ${freshFinal.status}`);
  },
};
