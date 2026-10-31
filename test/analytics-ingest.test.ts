import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The incremental walk that fills the fact table.
 *
 * The adapter is mocked, as it is everywhere in this suite: the partner account
 * is production and this service's whole job is reading it, so no test here may
 * make a real network call.
 *
 * `vi.hoisted` rather than a factory-local `vi.fn()`, so the handle below is the
 * same function object the module under test received.
 */
const { listCallsMock } = vi.hoisted(() => ({ listCallsMock: vi.fn() }));

vi.mock('../src/adapter/vocobase.js', () => ({ listCalls: listCallsMock }));

import { prisma } from '../src/lib/prisma.js';
import { formatCorrelationId } from '../src/lib/callCorrelation.js';
import { resetAnalyticsSyncState, runAnalyticsSync } from '../src/services/analyticsIngest.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

/** An upstream listing row, in the shape the platform actually sends. */
function call(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_id: id,
    direction: 'outbound',
    status: 'completed',
    disposition: 'completed',
    to_number: '+14155550100',
    started_at: '2026-08-20T10:00:00.000Z',
    duration_seconds: 42,
    ...fields,
  };
}

/**
 * Serves fixed rows by offset, newest-first, as upstream does.
 *
 * A short page is how the walk learns it has reached the end of history, so
 * anything past the supplied rows comes back empty rather than repeating.
 */
function servePages(rows: Record<string, unknown>[]): void {
  listCallsMock.mockImplementation(async ({ offset, limit }: { offset: number; limit: number }) => ({
    calls: rows.slice(offset, offset + limit),
    total: rows.length,
  }));
}

beforeEach(async () => {
  await truncateAll();
  listCallsMock.mockReset();
  resetAnalyticsSyncState();
});

describe('the first pass', () => {
  it('ingests every row and records the coverage window', async () => {
    servePages([
      call('a', { started_at: '2026-08-22T10:00:00.000Z' }),
      call('b', { started_at: '2026-08-21T10:00:00.000Z' }),
      call('c', { started_at: '2026-08-20T10:00:00.000Z' }),
    ]);

    const result = await runAnalyticsSync();

    expect(result.created).toBe(3);
    expect(result.truncated).toBe(false);
    expect(await prisma.callRecord.count()).toBe(3);

    const cursor = await prisma.analyticsCursor.findFirst();
    expect(cursor?.lastStartedAt?.toISOString()).toBe('2026-08-22T10:00:00.000Z');
    // The low-water mark exists so the dashboard can say where the data begins.
    // A chart over a table seeded three days ago must not read as a claim about
    // a workspace's whole history.
    expect(cursor?.coverageFrom?.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('stores the scalar facts off the row', async () => {
    servePages([call('a')]);

    await runAnalyticsSync();

    const record = await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } });
    expect(record).toMatchObject({
      direction: 'outbound',
      status: 'completed',
      disposition: 'completed',
      phone: '+14155550100',
      durationSecs: 42,
    });
    // Never invented. Calling is not metered on this platform yet, and a zero
    // here would be a measurement of a charge nobody made.
    expect(record?.creditsCharged).toBeNull();
  });

  it('stores the far end of an inbound call, not ours', async () => {
    servePages([
      call('in', { direction: 'inbound', from_number: '+919000000001', to_number: '+14155550100' }),
    ]);

    await runAnalyticsSync();

    expect((await prisma.callRecord.findUnique({ where: { upstreamCallId: 'in' } }))?.phone).toBe(
      '+919000000001',
    );
  });

  it('records an unknown duration as null, never as zero', async () => {
    // Zero seconds is a call that connected and said nothing. Unknown is a
    // different fact, and rendering the second as the first is a claim.
    servePages([call('a', { duration_seconds: null })]);

    await runAnalyticsSync();

    expect(
      (await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } }))?.durationSecs,
    ).toBeNull();
  });

  it('skips a row with no call id rather than inventing one', async () => {
    // The id is the unique key and the whole of the idempotency story; a
    // fabricated one would make every re-ingest a duplicate.
    servePages([call('a'), { status: 'completed' }]);

    const result = await runAnalyticsSync();

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('stores a row it cannot attribute, with no workspace', async () => {
    servePages([call('orphan')]);

    await runAnalyticsSync();

    expect(
      (await prisma.callRecord.findUnique({ where: { upstreamCallId: 'orphan' } }))?.workspaceId,
    ).toBeNull();
  });
});

describe('idempotency', () => {
  it('re-running the same page produces no duplicates', async () => {
    servePages([call('a'), call('b')]);

    await runAnalyticsSync();
    await prisma.analyticsCursor.deleteMany();
    await runAnalyticsSync();

    expect(await prisma.callRecord.count()).toBe(2);
  });

  it('reports a re-ingest as updated rather than created', async () => {
    servePages([call('a'), call('b')]);
    await runAnalyticsSync();

    await prisma.analyticsCursor.deleteMany();
    const again = await runAnalyticsSync();

    expect(again.created).toBe(0);
    expect(again.updated).toBe(2);
  });

  it('refreshes the volatile facts on a re-ingest', async () => {
    servePages([call('a', { status: 'ringing', disposition: null, duration_seconds: null })]);
    await runAnalyticsSync();

    expect((await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } }))?.status).toBe(
      'ringing',
    );

    // The same call, now finished. A fact table whose rows froze at first sight
    // would report every call as whatever state it happened to be caught in.
    servePages([call('a', { status: 'completed', disposition: 'voicemail', duration_seconds: 8 })]);
    await prisma.analyticsCursor.deleteMany();
    await runAnalyticsSync();

    expect(await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } })).toMatchObject({
      status: 'completed',
      disposition: 'voicemail',
      durationSecs: 8,
    });
  });
});

describe('attribution is written once', () => {
  it('repairs a quarantined row when its agent is later assigned', async () => {
    const agent = await makeAgent(null, 'Pooled');
    servePages([call('a', { agent_id: agent.externalId })]);

    await runAnalyticsSync();
    expect(
      (await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } }))?.workspaceId,
    ).toBeNull();

    // Staff assign the agent. Its history comes with it on the next pass —
    // this is what makes quarantine safe rather than lossy.
    const account = await makeAccount('later');
    const workspace = await makeWorkspace(account, 'Later');
    await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: workspace.id } });

    await prisma.analyticsCursor.deleteMany();
    await runAnalyticsSync();

    const record = await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } });
    expect(record?.workspaceId).toBe(workspace.id);
    expect(record?.agentId).toBe(agent.id);
  });

  it('never moves a row from one workspace to another', async () => {
    // Staff reassignment is an UPDATE no constraint can see. Without this rule
    // the day an agent moves from A to B is the day a late re-ingest of A's old
    // calls silently moves them onto B's charts.
    const account = await makeAccount('move');
    const a = await makeWorkspace(account, 'A');
    const b = await makeWorkspace(account, 'B');
    const agent = await makeAgent(a, 'Travelling');

    servePages([call('a', { agent_id: agent.externalId })]);
    await runAnalyticsSync();

    await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: b.id } });
    await prisma.analyticsCursor.deleteMany();
    await runAnalyticsSync();

    expect(
      (await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } }))?.workspaceId,
    ).toBe(a.id);
  });

  it('does not store a campaign call — the dialer already recorded it', async () => {
    // The single most important behaviour in this file. A CallAttempt exists
    // for this dial; a CallRecord beside it would double the campaign's numbers
    // on every chart that reads both.
    const account = await makeAccount('corr');
    const workspace = await makeWorkspace(account, 'Corr');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Outreach' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+14155559999' },
    });
    const campaignContact = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    servePages([
      call('a', { client_reference_id: formatCorrelationId(campaign.id, campaignContact.id) }),
    ]);

    const result = await runAnalyticsSync();

    expect(await prisma.callRecord.findUnique({ where: { upstreamCallId: 'a' } })).toBeNull();
    expect(result.created).toBe(0);
    // Reported separately from `skipped`, so an operator can tell "nothing new"
    // from "everything was malformed".
    expect(result.campaignCalls).toBe(1);
  });

  it('still advances the cursor over a page of campaign calls', async () => {
    // Otherwise a platform whose traffic is entirely campaigns would re-walk
    // the same pages forever and never move its high-water mark.
    const account = await makeAccount('corr2');
    const workspace = await makeWorkspace(account, 'Corr2');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'All campaign' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+14155558888' },
    });
    const campaignContact = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    servePages([
      call('a', {
        started_at: '2026-08-22T10:00:00.000Z',
        client_reference_id: formatCorrelationId(campaign.id, campaignContact.id),
      }),
    ]);

    await runAnalyticsSync();

    // The pass read the page and finished it, so the mark moves even though it
    // stored nothing. `coverageFrom` stays null: it describes what the table
    // covers, and the table covers no call here.
    const cursor = await prisma.analyticsCursor.findFirst();
    expect(cursor?.lastRunAt).not.toBeNull();
    expect(cursor?.coverageFrom).toBeNull();
    // The subject of this test. Asserted on the column itself, because the
    // whole failure it guards against is one where every other field on the
    // cursor looks exactly right.
    expect(cursor?.lastStartedAt).toEqual(new Date('2026-08-22T10:00:00.000Z'));
  });

  it('does not re-walk the listing when every row was a campaign call', async () => {
    // The consequence of the mark standing still, and the reason it is asserted
    // above: this pass costs the same as the first one, forever, against a rate
    // limit every workspace on the platform shares — and because the walk
    // always restarts at offset 0 and is bounded, a non-campaign call that
    // sinks past the budget between two passes is never read by either.
    const account = await makeAccount('corr3');
    const workspace = await makeWorkspace(account, 'Corr3');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'All campaign' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+14155557777' },
    });
    const campaignContact = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const reference = formatCorrelationId(campaign.id, campaignContact.id);
    servePages([
      call('a', { started_at: '2026-08-22T10:00:00.000Z', client_reference_id: reference }),
      call('b', { started_at: '2026-08-22T09:00:00.000Z', client_reference_id: reference }),
      call('c', { started_at: '2026-08-22T08:00:00.000Z', client_reference_id: reference }),
      call('d', { started_at: '2026-08-22T07:00:00.000Z', client_reference_id: reference }),
    ]);

    await runAnalyticsSync({ pageSize: 2, maxPages: 5 });
    const firstPassRequests = listCallsMock.mock.calls.length;
    expect(firstPassRequests).toBeGreaterThan(1);

    listCallsMock.mockClear();
    resetAnalyticsSyncState();
    await runAnalyticsSync({ pageSize: 2, maxPages: 5, overlapMins: 0 });

    // One page, and it stopped: the mark is at the newest row it saw.
    expect(listCallsMock.mock.calls.length).toBe(1);
  });

  it('does not let a row dated in the future park the mark there', async () => {
    // The mark only moves forward, so one bad carrier clock would otherwise
    // silently degrade every later pass to reading page one and exiting.
    const future = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    servePages([
      call('future', { started_at: future.toISOString() }),
      call('now', { started_at: '2026-08-22T10:00:00.000Z' }),
    ]);

    await runAnalyticsSync();

    const cursor = await prisma.analyticsCursor.findFirst();
    expect(cursor?.lastStartedAt).toEqual(new Date('2026-08-22T10:00:00.000Z'));
    // Stored like any other row — it is barred from moving the mark, not
    // dropped from the table.
    expect(await prisma.callRecord.findUnique({ where: { upstreamCallId: 'future' } })).not.toBeNull();
  });
});

describe('the incremental walk', () => {
  it('stops at the high-water mark instead of walking the listing again', async () => {
    const rows = [
      call('a', { started_at: '2026-08-22T10:00:00.000Z' }),
      call('b', { started_at: '2026-08-21T10:00:00.000Z' }),
      call('c', { started_at: '2026-08-20T10:00:00.000Z' }),
      call('d', { started_at: '2026-08-19T10:00:00.000Z' }),
    ];
    servePages(rows);
    await runAnalyticsSync({ pageSize: 2 });

    // A second pass over an unchanged listing reads the first page, sees it has
    // descended past the mark, and stops — rather than paging to the end again.
    listCallsMock.mockClear();
    servePages(rows);
    const result = await runAnalyticsSync({ pageSize: 2 });

    expect(listCallsMock).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(0);
  });

  it('picks up a call placed since the last pass', async () => {
    servePages([call('a', { started_at: '2026-08-22T10:00:00.000Z' })]);
    await runAnalyticsSync();

    servePages([
      call('new', { started_at: '2026-08-23T10:00:00.000Z' }),
      call('a', { started_at: '2026-08-22T10:00:00.000Z' }),
    ]);
    const result = await runAnalyticsSync();

    expect(result.created).toBe(1);
    expect(await prisma.callRecord.count()).toBe(2);
  });

  it('re-reads below the mark for as long as the overlap window says', async () => {
    // Upstream offsets are computed against a list that grows while it is
    // walked, so a call placed mid-pass shifts every row down one and a page
    // boundary read after the shift skips the row that crossed it.
    const seed = [
      call('a', { started_at: '2026-08-22T10:00:00.000Z' }),
      call('b', { started_at: '2026-08-22T09:55:00.000Z' }),
    ];
    servePages(seed);
    await runAnalyticsSync({ pageSize: 2, overlapMins: 0 });

    // `late` sits on page two, just under the mark.
    const shifted = [...seed, call('late', { started_at: '2026-08-22T09:30:00.000Z' })];

    servePages(shifted);
    await runAnalyticsSync({ pageSize: 2, overlapMins: 0 });
    // With no overlap the walk stops on page one and never reaches it.
    expect(await prisma.callRecord.findUnique({ where: { upstreamCallId: 'late' } })).toBeNull();

    await prisma.analyticsCursor.updateMany({
      data: { lastStartedAt: new Date('2026-08-22T10:00:00.000Z') },
    });
    servePages(shifted);
    await runAnalyticsSync({ pageSize: 2, overlapMins: 60 });
    expect(
      await prisma.callRecord.findUnique({ where: { upstreamCallId: 'late' } }),
    ).not.toBeNull();
  });

  it('reports itself truncated when the page budget runs out', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      call(`c${i}`, { started_at: new Date(Date.UTC(2026, 7, 20, 0, 0, 60 - i)).toISOString() }),
    );
    servePages(rows);

    const result = await runAnalyticsSync({ maxPages: 2, pageSize: 2 });

    expect(result.truncated).toBe(true);
    expect(result.created).toBe(4);
    expect((await prisma.analyticsCursor.findFirst())?.lastRunTruncated).toBe(true);
  });

  it('is not truncated when it reached the end of history', async () => {
    servePages([call('a'), call('b')]);

    expect((await runAnalyticsSync({ maxPages: 5, pageSize: 2 })).truncated).toBe(false);
  });

  it('does not take the early exit when the listing is not newest-first', async () => {
    // The ordering is documented behaviour, not a promise, and the cost of
    // assuming it is silent: page one would fall below the mark, the walk would
    // stop on it, and every call after the first pass would be missed with
    // nothing to say so.
    servePages([call('seed', { started_at: '2026-08-22T10:00:00.000Z' })]);
    await runAnalyticsSync();

    // Ascending, and page one is entirely below the mark. Under an assumed
    // descent the walk stops there and never sees the newer row behind it.
    servePages([
      call('old1', { started_at: '2026-08-01T10:00:00.000Z' }),
      call('old2', { started_at: '2026-08-02T10:00:00.000Z' }),
      call('old3', { started_at: '2026-08-03T10:00:00.000Z' }),
      call('newer', { started_at: '2026-08-25T10:00:00.000Z' }),
    ]);

    await runAnalyticsSync({ pageSize: 2 });

    expect(
      await prisma.callRecord.findUnique({ where: { upstreamCallId: 'newer' } }),
    ).not.toBeNull();
  });

  it('propagates an upstream failure rather than advancing the cursor', async () => {
    // A pass that swallowed the error would move its high-water mark past calls
    // it never read, and nothing would ever read them again.
    listCallsMock.mockRejectedValue(new Error('upstream down'));

    await expect(runAnalyticsSync()).rejects.toThrow('upstream down');
    expect(await prisma.analyticsCursor.findFirst()).toBeNull();
  });

  it('lets the next pass retry after a failure', async () => {
    listCallsMock.mockRejectedValueOnce(new Error('upstream down'));
    await expect(runAnalyticsSync()).rejects.toThrow();

    servePages([call('a')]);
    expect((await runAnalyticsSync()).created).toBe(1);
  });
});

describe('re-entrancy', () => {
  it('joins a pass already in flight rather than starting a second', async () => {
    // Two concurrent walks would double the upstream cost to produce identical
    // rows, against a rate limit every workspace shares.
    let release: (value: { calls: Record<string, unknown>[] }) => void = () => {};
    listCallsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release;
        }),
    );

    const first = runAnalyticsSync();
    const second = runAnalyticsSync();

    // Wait for the condition, not for a duration. `release` is only assigned
    // once the mock is actually reached, and the sync does DB work first — so
    // a fixed tick is a bet on how fast that is. Lose the bet and `release`
    // is still the no-op, the mocked promise never settles, and both passes
    // hang to the timeout. That is exactly how this failed on CI while
    // passing on every developer machine.
    await vi.waitFor(() => expect(listCallsMock).toHaveBeenCalled());
    release({ calls: [call('a')] });

    const [a, b] = await Promise.all([first, second]);

    expect(listCallsMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});
