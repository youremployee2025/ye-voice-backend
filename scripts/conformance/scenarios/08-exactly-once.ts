import { MINUTE, type Driver, type Scenario } from '../scenario.js';
import { mockClient } from '../lib.js';
import { MOCK_PORT } from '../boot.js';

/**
 * Exactly-once dialing (X1, X2): four dispatch passes racing over the same
 * queue produce one call per contact — the attempt row is the mutex — and
 * the idempotency key is attempt-scoped: a replayed request returns the
 * original call without dialing, while a retry carries a fresh key and does.
 * Runs 10× — a race that passes once isn't proven.
 */
const CONTACTS = Array.from({ length: 10 }, (_, i) => `+9198766600${10 + i}`);
const RETRIED = '+919876660099';

const human = { status: 'completed', answered_by: 'human', duration_seconds: 20, delays_secs: { ringing: 1, hold: 2, talk: 20 } };
const busy = { status: 'busy', delays_secs: { ringing: 1, hold: 2 } };

export const exactlyOnce: Scenario = {
  name: 'exactly-once',
  rows: ['X1', 'X2'],
  runs: 10,
  async run(d: Driver) {
    const ws = await d.seedWorkspace({ handle: `once${d.seed}`, accountConcurrency: 20 });
    const campaign = await d.seedCampaign(ws, {
      concurrencyLimit: 15,
      retryCount: 1,
      retryDelaysMinutes: [0], // an immediate-retry ladder is legal config
      contacts: [...CONTACTS, RETRIED],
    });
    await d.script({
      numbers: [
        ...CONTACTS.map((p) => ({ to_number: p, rules: [human] })),
        { to_number: RETRIED, rules: [busy, human] },
      ],
    });

    await d.start(ws, campaign.campaignId);

    // Four sweeps race over the fresh queue in one tick.
    await d.tick(4);
    const firstWave = d.trace.filter((e) => e.kind === 'dial');
    d.check('X1', firstWave.length === 11, `racing sweeps dialed ${firstWave.length} contacts, expected 11`);
    const seen = new Set(firstWave.map((e) => e.phone));
    d.check('X1', seen.size === firstWave.length, 'racing sweeps dialed one contact twice');

    // Drain (the busy contact's immediate retry included), still racing.
    for (let i = 0; i < 10; i++) {
      d.advanceBy(MINUTE);
      await d.tick(4);
      const unfinished = await d.backend.prisma.campaignContact.count({
        where: { status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
      });
      const mock = await d.mockState();
      if (unfinished === 0 && mock.active === 0 && mock.pending_timeline === 0) break;
    }
    await d.snapshot();

    // One dial per attempt row, everywhere (the GLOBAL refCounts invariant
    // re-checks this); the retried contact carried two distinct keys.
    const retriedDials = d.trace.filter((e) => e.kind === 'dial' && e.phone === RETRIED);
    d.check('X2', retriedDials.length === 2, `retried contact dialed ${retriedDials.length} times, expected 2`);
    d.check(
      'X2',
      new Set(retriedDials.map((e) => e.attemptId)).size === 2,
      'a retry reused the previous attempt id in its idempotency key',
    );

    // X2 replay probe: re-sending the exact request of an already-placed call
    // is answered with the original call and never dials again.
    const state = await mockClient.state();
    const target = state.dialLog[0]!;
    const replay = await fetch(`http://127.0.0.1:${MOCK_PORT}/api/v2/calls/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer mockkey' },
      body: JSON.stringify({
        agent_id: 'probe',
        to_number: target.toNumber,
        from_number: target.fromNumber,
        client_reference_id: target.ref,
      }),
    });
    const replayBody = (await replay.json()) as { data?: { call_id?: string; idempotent_replay?: boolean } };
    d.check('X2', replay.status === 200 && replayBody.data?.idempotent_replay === true && replayBody.data?.call_id === target.callId,
      `replay answered ${replay.status} ${JSON.stringify(replayBody.data)}`);
    const after = await mockClient.state();
    d.check('X2', after.dialLog.length === state.dialLog.length, 'a replayed reference dialed again');

    // Terminal counts add up exactly once per contact.
    const row = await d.backend.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
    d.check('X1', row.completedCount === 11 && row.failedCount === 0,
      `counters completed=${row.completedCount} failed=${row.failedCount}, expected 11/0`);
    const attempts = await d.backend.prisma.callAttempt.count({ where: { campaignId: campaign.campaignId } });
    d.check('X1', attempts === 12, `attempt rows ${attempts}, expected 12 (11 firsts + 1 retry)`);
  },
};
