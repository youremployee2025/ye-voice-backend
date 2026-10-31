import { createHmac } from 'node:crypto';
import { MINUTE, type Driver, type Scenario } from '../scenario.js';
import { BACKEND_PORT, WEBHOOK_SECRET } from '../boot.js';

/**
 * Stuck-attempt cleanup (S1–S4): a call whose webhooks were all lost is
 * reconciled from the platform's call detail — same outcome, same charge,
 * same callback booking as the webhook would have made; a launch that never
 * confirmed is closed ABANDONED and retried on the contact's budget; a call
 * still live upstream past the timeout is abandoned too; a terminal-but-
 * unclassified attempt (bare completed status, completion lost) is picked up
 * by the second reaper class. A late webhook after a reconcile changes
 * nothing (S4).
 */
const P = {
  lostWebhooks: '+919878990011',
  neverConfirmed: '+919878990012',
  stillLive: '+919878990013',
  unclassified: '+919878990014',
};

const human = { status: 'completed', answered_by: 'human', duration_seconds: 40, delays_secs: { ringing: 1, hold: 2, talk: 40 } };

export const stuckCleanup: Scenario = {
  name: 'stuck-cleanup',
  rows: ['S1', 'S2', 'S3', 'S4'],
  runs: 3,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `stuck${d.seed}` });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 4,
      retryCount: 1,
      cooldownMinutes: 2,
      contacts: Object.values(P),
    });
    await d.script({
      numbers: [
        {
          to_number: P.lostWebhooks,
          rules: [{ ...human, suppress_status_events: true, suppress_completion: true }],
        },
        { to_number: P.neverConfirmed, rules: [{ fault: 'drop' }, { fault: 'drop' }] },
        {
          to_number: P.stillLive,
          rules: [
            { ...human, delays_secs: { ringing: 1, hold: 2, talk: 7200 }, suppress_status_events: true, suppress_completion: true },
            human,
          ],
        },
        /**
         * The bare-completed shape this row is named for, now that it has to
         * be asked for.
         *
         * The platform computes the disposition and `answered_by` before its
         * terminal status event goes out, so a completed call's status event
         * normally carries them — and a driver that let this rule default
         * would be scripting a *classified* terminal with a lost completion,
         * which is a different call for the reaper to make. `S1`'s second
         * class is the attempt closed by an event that knew nothing yet, and
         * `classify_on_status: false` is how the mock is asked for exactly
         * that.
         */
        {
          to_number: P.unclassified,
          rules: [{ ...human, classify_on_status: false, suppress_completion: true }],
        },
      ],
    });

    await d.start(ws, campaign.campaignId);
    await d.tick();
    d.advanceBy(2 * MINUTE);
    await d.tick(); // lifecycles fire on the mock; no webhooks for the stuck ones
    d.advanceBy(MINUTE);
    await d.tick(); // the second dropped write goes out and is dropped too

    const contact = async (phone: string) =>
      d.backend.prisma.campaignContact.findUniqueOrThrow({ where: { id: campaign.contactByPhone.get(phone)! } });

    // Everyone is stuck: nothing resolved yet.
    for (const phone of [P.lostWebhooks, P.stillLive, P.unclassified]) {
      const c = await contact(phone);
      d.check('S1', c.status === 'QUEUED', `${phone} should be stuck QUEUED before the timeout, is ${c.status}`);
    }

    // Past the timeout the reaper reconciles or abandons each class.
    d.advanceBy(61 * MINUTE);
    await d.drain({ stepMs: 2 * MINUTE, maxTicks: 20 });

    // S2: the lost-webhook call reconciled to the same place a webhook run
    // lands — COMPLETED, charged once from the call detail's duration.
    {
      const c = await contact(P.lostWebhooks);
      d.check('S2', c.status === 'COMPLETED' && c.attempts === 0,
        `lost webhooks: expected reconciled COMPLETED/0, got ${c.status}/${c.attempts}`);
      const attempt = await d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: c.id, attemptNo: 1 },
      });
      d.check('S2', attempt.chargedAt !== null && attempt.durationSecs === 40,
        `lost webhooks: chargedAt=${attempt.chargedAt?.toISOString()} durationSecs=${attempt.durationSecs}`);
      const ledger = await d.backend.prisma.creditTransaction.findMany({
        where: { reference: attempt.id },
      });
      d.check('S4', ledger.length === 1 && ledger[0]!.type === 'CALL_USAGE',
        `lost webhooks: ${ledger.length} ledger rows of ${ledger.map((l) => l.type).join(',')}`);

      // S4: the webhook that never arrived shows up late — after the
      // reconcile — and must change nothing.
      const mock = await d.mockState();
      const call = mock.calls.find((x) => x.to_number === P.lostWebhooks)!;
      const body = JSON.stringify({
        event: 'session.completed',
        timestamp: new Date().toISOString(),
        data: {
          call_id: call.call_id,
          session_id: call.session_id,
          duration_seconds: 40,
          extraction: { values: {} },
          call: { call_id: call.call_id, status: 'completed', disposition: 'completed', answered_by: 'human' },
        },
      });
      const ts = new Date().toISOString();
      const signature = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
      const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/webhooks/vocobase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': signature },
        body,
      });
      d.check('S4', res.status >= 200 && res.status < 300, `late webhook answered ${res.status}`);
      const ledgerAfter = await d.backend.prisma.creditTransaction.count({ where: { reference: attempt.id } });
      d.check('S4', ledgerAfter === 1, `late webhook after reconcile left ${ledgerAfter} ledger rows`);
      const cAfter = await contact(P.lostWebhooks);
      d.check('S4', cAfter.status === 'COMPLETED' && cAfter.attempts === 0,
        `late webhook moved the contact to ${cAfter.status}/${cAfter.attempts}`);
    }

    // The retried dropped write is dropped again and sits out a second
    // timeout before the reaper can settle it.
    d.advanceBy(61 * MINUTE);
    await d.drain({ stepMs: 2 * MINUTE, maxTicks: 10 });

    // S3: the never-confirmed launch abandoned twice — one retry consumed,
    // then settled FAILED, never a success.
    {
      const c = await contact(P.neverConfirmed);
      d.check('S3', c.status === 'FAILED' && c.attempts === 1,
        `never confirmed: expected FAILED at attempts=1, got ${c.status}/${c.attempts}`);
      const rows = await d.backend.prisma.callAttempt.findMany({
        where: { campaignContactId: c.id },
        orderBy: { attemptNo: 'asc' },
      });
      d.check('S3', rows.length === 2 && rows.every((r) => r.status === 'ABANDONED'),
        `never confirmed: attempts [${rows.map((r) => r.status).join(',')}], expected two ABANDONED`);
    }

    // S3: still-live upstream past the timeout — abandoned, retried, done.
    {
      const c = await contact(P.stillLive);
      d.check('S3', c.status === 'COMPLETED' && c.attempts === 1,
        `still live: expected COMPLETED after one abandonment, got ${c.status}/${c.attempts}`);
      const first = await d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: c.id, attemptNo: 1 },
      });
      d.check('S3', first.status === 'ABANDONED' && first.chargedAt === null,
        `still live: first attempt ${first.status}, chargedAt=${first.chargedAt?.toISOString()}`);
    }

    // S1 class 2: the bare-completed attempt (line freed, never classified)
    // reconciled and charged.
    {
      const c = await contact(P.unclassified);
      d.check('S1', c.status === 'COMPLETED' && c.attempts === 0,
        `unclassified terminal: expected COMPLETED/0, got ${c.status}/${c.attempts}`);
      const attempt = await d.backend.prisma.callAttempt.findFirstOrThrow({
        where: { campaignContactId: c.id, attemptNo: 1 },
      });
      d.check('S1', attempt.chargedAt !== null, 'unclassified terminal: the reconcile never charged');
    }
  },
};
