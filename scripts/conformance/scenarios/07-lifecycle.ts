import { MINUTE, T0, type Driver, type Scenario } from '../scenario.js';

/**
 * Lifecycle (L1–L8, CB4): pause stops new claims while in-flight calls
 * finish; stop sweeps PENDING→SKIPPED behind a permanent stoppedAt, refuses
 * complete while calls are live, and blocks both top-up and callback booking
 * afterwards; an auto-completed campaign reopens to PAUSED on top-up (never
 * RUNNING); the sweep pauses an underfunded campaign to CREDIT_EXHAUSTED and
 * resume re-checks the balance.
 */
const A = Array.from({ length: 6 }, (_, i) => `+9198755500${10 + i}`);
const B = ['+919875660011', '+919875660012'];
const B_NEW = '+919875660013';
const C = ['+919875770011', '+919875770012'];

const longHuman = { status: 'completed', answered_by: 'human', duration_seconds: 200, delays_secs: { ringing: 1, hold: 2, talk: 200 } };
const shortHuman = { status: 'completed', answered_by: 'human', duration_seconds: 15, delays_secs: { ringing: 1, hold: 2, talk: 15 } };

export const lifecycle: Scenario = {
  name: 'lifecycle',
  rows: ['L1', 'L2', 'L3', 'L4', 'L5', 'L7', 'L8', 'CB4', 'D10'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `life${d.seed}` });
    const api = d.api(ws);
    const base = (id: string) => `/workspaces/${ws.workspaceId}/campaigns/${id}`;

    /* ---------------- A: pause / stop / complete ---------------- */
    const a = await d.seedCampaign(ws, { name: 'A', concurrencyLimit: 2, retryCount: 0, contacts: A });
    await d.script({
      numbers: A.map((p, i) => ({
        to_number: p,
        // A[3] dials in the post-resume tick and is still live at the stop,
        // so its callback ask resolves against a stopped campaign and must be
        // refused (CB4) — the call itself still resolves and is counted.
        // (Asked any earlier, the booking would land while merely paused,
        // which is allowed, and would re-arm the contact.)
        rules: [i === 3 ? { ...longHuman, extraction: { callback_requested_at: new Date(T0 + 4 * 60 * MINUTE).toISOString() } } : longHuman],
      })),
    });

    // L1: only DRAFT starts.
    const empty = await d.seedCampaign(ws, { name: 'empty', contacts: [] });
    const emptyStart = await api('POST', `${base(empty.campaignId)}/start`);
    d.check('L1', emptyStart.status >= 400, `a campaign with no contacts started (${emptyStart.status})`);
    await d.start(ws, a.campaignId);
    const doubleStart = await api('POST', `${base(a.campaignId)}/start`);
    d.check('L1', doubleStart.status >= 400, `a RUNNING campaign started again (${doubleStart.status})`);

    // First tick claims 2 (limit); pause mid-flight.
    await d.tick();
    const dialsAtPause = d.trace.filter((e) => e.kind === 'dial').length;
    d.check('L2', dialsAtPause === 2, `expected 2 in-flight at pause, saw ${dialsAtPause}`);
    const pause = await api('POST', `${base(a.campaignId)}/pause`);
    d.check('L2', pause.status === 200, `pause refused: ${JSON.stringify(pause.body)}`);

    // Paused: sweeps claim nothing new; the live calls finish and resolve.
    for (let i = 0; i < 6; i++) {
      d.advanceBy(MINUTE);
      await d.tick();
    }
    d.check('L2', d.trace.filter((e) => e.kind === 'dial').length === dialsAtPause, 'a paused campaign dialed');
    const afterPause = await d.backend.prisma.campaignContact.count({
      where: { campaignId: a.campaignId, status: 'COMPLETED' },
    });
    d.check('L2', afterPause === 2, `in-flight calls should finish under pause; ${afterPause}/2 resolved`);

    // L3 resume, then L4 stop with two fresh calls in the air.
    const resume = await api('POST', `${base(a.campaignId)}/resume`);
    d.check('L3', resume.status === 200, `resume refused: ${JSON.stringify(resume.body)}`);
    d.advanceBy(MINUTE);
    await d.tick();
    d.check('L3', d.trace.filter((e) => e.kind === 'dial').length === dialsAtPause + 2, 'resume did not restart claiming');

    const stop = await api('POST', `${base(a.campaignId)}/stop`);
    d.check('L4', stop.status === 200, `stop refused: ${JSON.stringify(stop.body)}`);
    const aStopped = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: a.campaignId } });
    d.check('L4', aStopped.status === 'STOPPED' && aStopped.stoppedAt !== null, `stop wrote ${aStopped.status}, stoppedAt=${aStopped.stoppedAt}`);
    d.check('L4', aStopped.skippedCount === 2, `stop swept ${aStopped.skippedCount} contacts, expected the 2 PENDING`);

    // L5: complete refuses while the two stop-survivors are still live.
    const early = await api('POST', `${base(a.campaignId)}/complete`);
    d.check('L5', early.status === 409, `complete during live calls answered ${early.status}, expected 409`);

    // The live calls finish; no further dials ever.
    for (let i = 0; i < 6; i++) {
      d.advanceBy(MINUTE);
      await d.tick();
    }
    d.check('L4', d.trace.filter((e) => e.kind === 'dial').length === dialsAtPause + 2, 'a stopped campaign dialed');
    const aFinal = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: a.campaignId } });
    d.check('L4', aFinal.completedCount === 4, `stop should let live calls resolve: completed=${aFinal.completedCount}`);

    // CB4: the callback asked for on a post-stop resolution was refused.
    const victim = await d.backend.prisma.campaignContact.findUniqueOrThrow({
      where: { id: a.contactByPhone.get(A[3]!)! },
    });
    d.check('CB4', victim.status === 'COMPLETED' && victim.callbackAt === null && victim.callbackCount === 0,
      `stopped-campaign booking: status=${victim.status} callbackAt=${victim.callbackAt?.toISOString()} count=${victim.callbackCount}`);

    // L5: complete now relabels; stoppedAt survives; top-up stays refused.
    const complete = await api('POST', `${base(a.campaignId)}/complete`);
    d.check('L5', complete.status === 200, `complete refused: ${JSON.stringify(complete.body)}`);
    const aDone = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: a.campaignId } });
    d.check('L5', aDone.status === 'COMPLETED' && aDone.stoppedAt !== null, `complete wrote ${aDone.status}, stoppedAt=${aDone.stoppedAt}`);
    const lateContact = await d.backend.prisma.contact.create({
      data: { workspaceId: ws.workspaceId, phone: '+919875550099', name: 'late' },
    });
    const stoppedTopup = await api('POST', `${base(a.campaignId)}/contacts`, {
      contactIds: [lateContact.id],
    });
    d.check('L8', stoppedTopup.status >= 400, `top-up on a stopped campaign answered ${stoppedTopup.status}`);

    /* ---------------- B: auto-complete + top-up reopen ---------------- */
    const b = await d.seedCampaign(ws, { name: 'B', concurrencyLimit: 2, retryCount: 0, contacts: B });
    await d.script({ numbers: [...B, B_NEW].map((p) => ({ to_number: p, rules: [shortHuman] })) });
    await d.start(ws, b.campaignId);
    await d.drain({ stepMs: MINUTE, maxTicks: 10 });
    const bDone = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: b.campaignId } });
    d.check('L8', bDone.status === 'COMPLETED', `B should auto-complete, is ${bDone.status}`);

    const newContact = await d.backend.prisma.contact.create({
      data: { workspaceId: ws.workspaceId, phone: B_NEW, name: 'new' },
    });
    const dupeContact = await d.backend.prisma.contact.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, phone: B[0] },
    });
    const topup = await api('POST', `${base(b.campaignId)}/contacts`, {
      contactIds: [newContact.id, dupeContact.id],
    });
    d.check('L8', topup.status === 200 || topup.status === 201, `top-up refused: ${JSON.stringify(topup.body)}`);
    const topupData = (topup.body.data ?? {}) as { added?: number; duplicates?: number };
    d.check('L8', topupData.added === 1 && topupData.duplicates === 1,
      `top-up reported added=${topupData.added} duplicates=${topupData.duplicates}, expected 1/1`);
    const bReopened = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: b.campaignId } });
    d.check('L8', bReopened.status === 'PAUSED' && bReopened.completedAt === null,
      `top-up reopened to ${bReopened.status} (completedAt=${bReopened.completedAt}), expected PAUSED`);
    d.check('L8', bReopened.totalContacts === 3, `totalContacts=${bReopened.totalContacts}, expected 3 (dupe not re-added)`);
    const bContacts = await d.backend.prisma.campaignContact.count({ where: { campaignId: b.campaignId } });
    d.check('L8', bContacts === 3, `campaign B has ${bContacts} contact rows, expected 3`);

    const bResume = await api('POST', `${base(b.campaignId)}/resume`);
    d.check('L8', bResume.status === 200, `resume after top-up refused: ${JSON.stringify(bResume.body)}`);
    d.advanceBy(MINUTE);
    await d.drain({ stepMs: MINUTE, maxTicks: 10 });
    const bFinal = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: b.campaignId } });
    d.check('L8', bFinal.status === 'COMPLETED' && bFinal.completedCount === 3, `after resume: ${bFinal.status} completed=${bFinal.completedCount}`);

    /* ---------------- C: credit exhaustion ---------------- */
    const poor = await d.seedWorkspace({ handle: `poor${d.seed}`, credits: '1.5' });
    const c = await d.seedCampaign(poor, { name: 'C', concurrencyLimit: 1, retryCount: 0, contacts: C });
    await d.script({ numbers: C.map((p) => ({ to_number: p, rules: [{ ...shortHuman, duration_seconds: 60, delays_secs: { ringing: 1, hold: 2, talk: 60 } }] })) });
    await d.start(poor, c.campaignId);
    // First call costs 1.0 credit (60s at 1/min), leaving 0.5 — below the
    // 1-credit floor, so the next sweep pauses to CREDIT_EXHAUSTED.
    for (let i = 0; i < 6; i++) {
      await d.tick();
      d.advanceBy(2 * MINUTE);
      const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: c.campaignId } });
      if (row.status !== 'RUNNING') break;
    }
    const cRow = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: c.campaignId } });
    d.check('L7', cRow.status === 'CREDIT_EXHAUSTED', `underfunded campaign is ${cRow.status}, expected CREDIT_EXHAUSTED`);
    const poorApi = d.api(poor);
    const brokeResume = await poorApi('POST', `/workspaces/${poor.workspaceId}/campaigns/${c.campaignId}/resume`);
    d.check('L7', brokeResume.status >= 400, `resume with 0.5 credits answered ${brokeResume.status}`);
    await d.backend.prisma.account.update({
      where: { id: poor.accountId },
      data: { credits: d.backend.toInternalCredits('100') },
    });
    const fundedResume = await poorApi('POST', `/workspaces/${poor.workspaceId}/campaigns/${c.campaignId}/resume`);
    d.check('L7', fundedResume.status === 200, `funded resume refused: ${JSON.stringify(fundedResume.body)}`);
    d.advanceBy(MINUTE);
    await d.drain({ stepMs: 2 * MINUTE, maxTicks: 10 });
    const cFinal = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: c.campaignId } });
    d.check('L7', cFinal.status === 'COMPLETED' && cFinal.completedCount === 2, `after funding: ${cFinal.status} completed=${cFinal.completedCount}`);
  },
};
