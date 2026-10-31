import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';
import { parseCallQuery } from '../src/lib/callQuery.js';
import { formatCorrelationId } from '../src/lib/callCorrelation.js';
import type { ApiError } from '../src/lib/errors.js';

// Mocked in every test. This surface's whole job is reading a production
// partner account; no case here may reach it.
vi.mock('../src/adapter/vocobase.js', () => ({
  listCalls: vi.fn(),
  getCall: vi.fn(),
}));

const { getCall, listCalls } = await import('../src/adapter/vocobase.js');
const { getWorkspaceCall, listWorkspaceCalls, UPSTREAM_PAGE_SIZE, MAX_UPSTREAM_PAGES } =
  await import('../src/services/callHistory.js');

const mockedListCalls = vi.mocked(listCalls);
const mockedGetCall = vi.mocked(getCall);

/** A call as the listing returns it. `agent_id` is the UPSTREAM agent id. */
function upstreamCall(overrides: Record<string, unknown> = {}) {
  return {
    call_id: `call-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: 'ext-unknown',
    direction: 'outbound',
    from_number: '+919876543200',
    to_number: '+919876543210',
    status: 'completed',
    disposition: 'completed',
    duration_seconds: 30,
    started_at: '2026-08-20T10:00:00.000Z',
    ended_at: '2026-08-20T10:00:30.000Z',
    ...overrides,
  };
}

/** Serves the given rows as upstream pages of UPSTREAM_PAGE_SIZE. */
function servePages(rows: Record<string, unknown>[]) {
  mockedListCalls.mockReset();
  mockedListCalls.mockImplementation(async ({ limit, offset }) => ({
    calls: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  }));
}

/** An endless stream of calls belonging to nobody, to exhaust the walk budget. */
function serveEndlessForeignCalls() {
  mockedListCalls.mockReset();
  mockedListCalls.mockImplementation(async ({ limit, offset }) => ({
    calls: Array.from({ length: limit }, (_, i) =>
      upstreamCall({ call_id: `foreign-${offset + i}` }),
    ),
    total: 1_000_000,
    limit,
    offset,
  }));
}

const query = (overrides: Record<string, unknown> = {}) => parseCallQuery(overrides);

let workspace: Workspace;
let other: Workspace;
let agent: Agent;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();

  const owner = await makeAccount(`owner_${Math.random().toString(36).slice(2, 8)}`);
  workspace = await makeWorkspace(owner, 'Ours');
  other = await makeWorkspace(owner, 'Theirs');
  agent = await makeAgent(workspace, 'Support');
});

describe('listWorkspaceCalls — isolation', () => {
  it('lists a call placed by one of this workspace agents', async () => {
    servePages([upstreamCall({ call_id: 'mine', agent_id: agent.externalId })]);

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items.map((call) => call.id)).toEqual(['mine']);
    expect(page.items[0].agent).toEqual({ id: agent.id, name: 'Support' });
  });

  it('hides a call placed by another workspace agent', async () => {
    const theirs = await makeAgent(other, 'Theirs');
    servePages([upstreamCall({ call_id: 'not-mine', agent_id: theirs.externalId })]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toEqual([]);
  });

  it('hides a call placed by an unassigned agent in the pool', async () => {
    const pooled = await makeAgent(null, 'Pooled');
    servePages([upstreamCall({ agent_id: pooled.externalId })]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toEqual([]);
  });

  it('hides a call whose agent this platform has never mirrored', async () => {
    servePages([upstreamCall({ agent_id: 'ext-belongs-to-nobody' })]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toEqual([]);
  });

  it('still lists calls placed by an agent that has since been retired', async () => {
    // History is what happened, not what may happen next. A retired agent
    // cannot take new work, but filtering its past calls out would erase a
    // workspace's history the day staff retire an agent upstream.
    const retired = await makeAgent(workspace, 'Retired', 'removed');
    servePages([upstreamCall({ call_id: 'old', agent_id: retired.externalId })]);

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items.map((call) => call.id)).toEqual(['old']);
    expect(page.items[0].agent).toEqual({ id: retired.id, name: 'Retired' });
  });
});

describe('listWorkspaceCalls — the campaign leg', () => {
  async function makeCampaign(inWorkspace: Workspace, name: string) {
    return prisma.campaign.create({
      data: { workspaceId: inWorkspace.id, name },
    });
  }

  /** A real row for the campaign, whose id the dispatcher would stamp. */
  async function makeCampaignContact(campaignId: string, inWorkspace: Workspace) {
    const contact = await prisma.contact.create({
      data: { workspaceId: inWorkspace.id, phone: `+9198765${Math.floor(Math.random() * 90000 + 10000)}` },
    });
    return prisma.campaignContact.create({
      data: { campaignId, contactId: contact.id },
    });
  }

  it('refuses a correlation key naming a real campaign and no real contact', async () => {
    // client_reference_id is free text on a partner account every customer
    // shares, so this leg cannot rest on one guessable id. A campaign id is an
    // ordinary identifier every member of the workspace can read.
    const campaign = await makeCampaign(workspace, 'August outreach');
    servePages([
      upstreamCall({
        call_id: 'forged',
        agent_id: 'ext-belongs-to-nobody',
        client_reference_id: formatCorrelationId(campaign.id, 'cc_never_existed'),
      }),
    ]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toEqual([]);
  });

  it('refuses a contact that is real but belongs to another campaign', async () => {
    const [mine, sibling] = [
      await makeCampaign(workspace, 'August outreach'),
      await makeCampaign(workspace, 'September outreach'),
    ];
    const contact = await makeCampaignContact(sibling.id, workspace);
    servePages([
      upstreamCall({
        call_id: 'mismatched',
        agent_id: 'ext-belongs-to-nobody',
        // Both halves name something real; they do not name each other.
        client_reference_id: formatCorrelationId(mine.id, contact.id),
      }),
    ]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toEqual([]);
  });

  it('lists a call correlated to one of this workspace campaigns', async () => {
    const campaign = await makeCampaign(workspace, 'August outreach');
    const contact = await makeCampaignContact(campaign.id, workspace);
    servePages([
      upstreamCall({
        call_id: 'campaign-call',
        // Placed by an agent this workspace does not hold — the campaign leg
        // alone must make it visible.
        agent_id: 'ext-belongs-to-nobody',
        client_reference_id: formatCorrelationId(campaign.id, contact.id),
      }),
    ]);

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items.map((call) => call.id)).toEqual(['campaign-call']);
    expect(page.items[0].campaign).toEqual({ id: campaign.id, name: 'August outreach' });
  });

  it('hides a call correlated to another workspace campaign', async () => {
    const theirs = await makeCampaign(other, 'Not ours');
    // A wholly legitimate key — for them. It must still resolve to nothing here.
    const contact = await makeCampaignContact(theirs.id, other);
    servePages([
      upstreamCall({
        agent_id: 'ext-belongs-to-nobody',
        client_reference_id: formatCorrelationId(theirs.id, contact.id),
      }),
    ]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toEqual([]);
  });

  it('ignores another integrator key and falls back to the agent leg', async () => {
    servePages([
      upstreamCall({
        call_id: 'agent-only',
        agent_id: agent.externalId,
        client_reference_id: 'crm:their-automation:their-job',
      }),
    ]);

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items.map((call) => call.id)).toEqual(['agent-only']);
    expect(page.items[0].campaign).toBeNull();
  });

  it('names the campaign on a call that also matches by agent', async () => {
    const campaign = await makeCampaign(workspace, 'August outreach');
    const contact = await makeCampaignContact(campaign.id, workspace);
    servePages([
      upstreamCall({
        agent_id: agent.externalId,
        client_reference_id: formatCorrelationId(campaign.id, contact.id),
      }),
    ]);

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items[0].campaign).toEqual({ id: campaign.id, name: 'August outreach' });
    expect(page.items[0].agent).toEqual({ id: agent.id, name: 'Support' });
  });
});

describe('listWorkspaceCalls — paging the filtered stream', () => {
  /** `count` visible calls, interleaved one-for-one with invisible ones. */
  function interleaved(count: number) {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i += 1) {
      rows.push(upstreamCall({ call_id: `mine-${i}`, agent_id: agent.externalId }));
      rows.push(upstreamCall({ call_id: `theirs-${i}` }));
    }
    return rows;
  }

  it('pages over matches, not over upstream offsets', async () => {
    servePages(interleaved(60));

    const first = await listWorkspaceCalls(workspace.id, query({ limit: '25' }));
    const second = await listWorkspaceCalls(workspace.id, query({ page: '2', limit: '25' }));

    expect(first.items.map((call) => call.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `mine-${i}`),
    );
    expect(second.items.map((call) => call.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `mine-${i + 25}`),
    );
  });

  it('reports a further page when one more match exists', async () => {
    servePages(interleaved(26));

    const page = await listWorkspaceCalls(workspace.id, query({ limit: '25' }));

    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
  });

  it('reports no further page on the last one', async () => {
    servePages(interleaved(25));

    const page = await listWorkspaceCalls(workspace.id, query({ limit: '25' }));

    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(false);
  });

  it('answers an empty page past the end rather than failing', async () => {
    servePages(interleaved(5));

    const page = await listWorkspaceCalls(workspace.id, query({ page: '4', limit: '25' }));

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('still stops early on a newest-first listing that has run past ?from', async () => {
    // The guard above must not cost the optimisation it protects: given rows
    // that visibly descend, a bounded query still stops instead of spending
    // all twenty pages.
    mockedListCalls.mockReset();
    mockedListCalls.mockImplementation(async ({ limit, offset }) => ({
      calls: Array.from({ length: limit }, (_, i) =>
        upstreamCall({
          call_id: `old-${offset + i}`,
          agent_id: agent.externalId,
          // Strictly descending, and all of it below the bound.
          started_at: new Date(Date.UTC(2020, 0, 1) - (offset + i) * 60_000).toISOString(),
        }),
      ),
      total: 1_000_000,
      limit,
      offset,
    }));

    const page = await listWorkspaceCalls(workspace.id, query({ from: '2026-08-01' }));

    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(mockedListCalls.mock.calls.length).toBeLessThan(MAX_UPSTREAM_PAGES);
  });

  it('reports a full page that ran out of budget as truncated', async () => {
    // The state a paging UI mishandles: a complete-looking page, hasMore
    // false because nothing more was reached, and truncated true because the
    // question was still open. Every other truncated case here returns an
    // empty page, so this is the one that goes untested by accident.
    mockedListCalls.mockReset();
    mockedListCalls.mockImplementation(async ({ limit, offset }) => ({
      // Exactly enough of ours to fill a page, then nothing but strangers.
      calls: Array.from({ length: limit }, (_, i) => {
        const n = offset + i;
        return n < 5
          ? upstreamCall({ call_id: `mine-${n}`, agent_id: agent.externalId })
          : upstreamCall({ call_id: `foreign-${n}` });
      }),
      total: 1_000_000,
      limit,
      offset,
    }));

    const page = await listWorkspaceCalls(workspace.id, query({ limit: '5' }));

    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.truncated).toBe(true);
  });

  it('spends the same budget on a later page, and says so', async () => {
    // The re-walk starts from offset 0 every time, so page 3 can exhaust the
    // budget where page 1 did not.
    serveEndlessForeignCalls();

    const page = await listWorkspaceCalls(workspace.id, query({ page: '3' }));

    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(true);
    expect(page.page).toBe(3);
  });

  it('does not end a ?from walk early when upstream is not newest-first', async () => {
    // The early exit reads "a whole batch older than ?from means every later
    // row is too", which is true only of a newest-first listing. If upstream
    // ever answers oldest-first, page one is entirely below the bound and the
    // walk would stop on it — reporting items: [] with truncated: false, which
    // states the calls do not exist.
    const wanted = upstreamCall({
      call_id: 'recent',
      agent_id: agent.externalId,
      started_at: '2026-08-20T10:00:00.000Z',
    });
    const ancient = Array.from({ length: UPSTREAM_PAGE_SIZE }, (_, i) =>
      upstreamCall({
        call_id: `old-${i}`,
        agent_id: agent.externalId,
        started_at: '2020-01-01T00:00:00.000Z',
      }),
    );
    servePages([...ancient, wanted]);

    const page = await listWorkspaceCalls(workspace.id, query({ from: '2026-08-01' }));

    expect(page.items.map((c) => c.id)).toEqual(['recent']);
  });

  it('stops as soon as upstream runs out', async () => {
    servePages(interleaved(3));

    await listWorkspaceCalls(workspace.id, query());

    // One short page ends the walk; it must not keep asking for offset 100.
    expect(mockedListCalls).toHaveBeenCalledTimes(1);
  });
});

describe('listWorkspaceCalls — the walk budget', () => {
  it('stops at the page budget and says the result is incomplete', async () => {
    serveEndlessForeignCalls();

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(true);
    expect(page.scanned).toBe(MAX_UPSTREAM_PAGES * UPSTREAM_PAGE_SIZE);
    expect(mockedListCalls).toHaveBeenCalledTimes(MAX_UPSTREAM_PAGES);
  });

  it('does not claim truncation when the page filled', async () => {
    servePages(
      Array.from({ length: 30 }, (_, i) =>
        upstreamCall({ call_id: `mine-${i}`, agent_id: agent.externalId }),
      ),
    );

    const page = await listWorkspaceCalls(workspace.id, query({ limit: '25' }));

    expect(page.truncated).toBe(false);
    expect(page.hasMore).toBe(true);
  });

  it('does not claim truncation when upstream history simply ended', async () => {
    servePages([upstreamCall({ agent_id: agent.externalId })]);

    expect((await listWorkspaceCalls(workspace.id, query())).truncated).toBe(false);
  });

  it('reports how many upstream rows it examined', async () => {
    servePages(
      Array.from({ length: 150 }, (_, i) =>
        upstreamCall({ call_id: `c-${i}`, agent_id: i === 149 ? agent.externalId : 'ext-nobody' }),
      ),
    );

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.scanned).toBe(150);
  });
});

describe('listWorkspaceCalls — filters', () => {
  it('narrows to one agent, resolving the local id to the upstream one', async () => {
    const second = await makeAgent(workspace, 'Sales');
    servePages([
      upstreamCall({ call_id: 'support', agent_id: agent.externalId }),
      upstreamCall({ call_id: 'sales', agent_id: second.externalId }),
    ]);

    const page = await listWorkspaceCalls(workspace.id, query({ agentId: second.id }));

    expect(page.items.map((call) => call.id)).toEqual(['sales']);
  });

  it('matches status and disposition case-insensitively', async () => {
    servePages([
      upstreamCall({ call_id: 'done', agent_id: agent.externalId, status: 'completed' }),
      upstreamCall({ call_id: 'busy', agent_id: agent.externalId, status: 'busy' }),
    ]);

    const page = await listWorkspaceCalls(workspace.id, query({ status: 'COMPLETED' }));

    expect(page.items.map((call) => call.id)).toEqual(['done']);
  });

  it('matches a disposition no published enum contains', async () => {
    servePages([
      upstreamCall({
        call_id: 'odd',
        agent_id: agent.externalId,
        disposition: 'carrier_specific_thing',
      }),
      upstreamCall({ call_id: 'normal', agent_id: agent.externalId }),
    ]);

    const page = await listWorkspaceCalls(
      workspace.id,
      query({ disposition: 'carrier_specific_thing' }),
    );

    expect(page.items.map((call) => call.id)).toEqual(['odd']);
  });

  it('bounds the range at both ends, inclusively', async () => {
    servePages([
      upstreamCall({ call_id: 'aug-20', agent_id: agent.externalId, started_at: '2026-08-20T10:00:00.000Z' }),
      upstreamCall({ call_id: 'aug-10', agent_id: agent.externalId, started_at: '2026-08-10T10:00:00.000Z' }),
      upstreamCall({ call_id: 'aug-01', agent_id: agent.externalId, started_at: '2026-08-01T10:00:00.000Z' }),
    ]);

    const page = await listWorkspaceCalls(
      workspace.id,
      query({ from: '2026-08-10', to: '2026-08-20' }),
    );

    expect(page.items.map((call) => call.id)).toEqual(['aug-20', 'aug-10']);
  });

  it('stops walking once a whole batch predates the range', async () => {
    // The listing is newest-first, so everything after such a batch is older
    // still. Continuing would spend the budget reading rows that cannot match.
    const recent = Array.from({ length: UPSTREAM_PAGE_SIZE }, (_, i) =>
      upstreamCall({ call_id: `new-${i}`, agent_id: agent.externalId, started_at: '2026-08-20T10:00:00.000Z' }),
    );
    const ancient = Array.from({ length: UPSTREAM_PAGE_SIZE }, (_, i) =>
      upstreamCall({ call_id: `old-${i}`, agent_id: agent.externalId, started_at: '2020-01-01T10:00:00.000Z' }),
    );
    servePages([...recent, ...ancient, ...ancient]);

    const page = await listWorkspaceCalls(
      workspace.id,
      query({ from: '2026-08-01', limit: '100' }),
    );

    expect(page.items).toHaveLength(100);
    // Page one (all matches) and page two (all too old) — never a third.
    expect(mockedListCalls).toHaveBeenCalledTimes(2);
  });

  it('composes filters rather than applying only the last', async () => {
    const second = await makeAgent(workspace, 'Sales');
    servePages([
      upstreamCall({ call_id: 'wanted', agent_id: second.externalId, status: 'completed', started_at: '2026-08-15T10:00:00.000Z' }),
      upstreamCall({ call_id: 'wrong-agent', agent_id: agent.externalId, status: 'completed', started_at: '2026-08-15T10:00:00.000Z' }),
      upstreamCall({ call_id: 'wrong-status', agent_id: second.externalId, status: 'busy', started_at: '2026-08-15T10:00:00.000Z' }),
      upstreamCall({ call_id: 'wrong-date', agent_id: second.externalId, status: 'completed', started_at: '2026-07-01T10:00:00.000Z' }),
    ]);

    const page = await listWorkspaceCalls(
      workspace.id,
      query({ agentId: second.id, status: 'completed', from: '2026-08-01', to: '2026-08-31' }),
    );

    expect(page.items.map((call) => call.id)).toEqual(['wanted']);
  });

  it('keeps a call with no start time rather than dropping it from an unbounded view', async () => {
    servePages([upstreamCall({ call_id: 'timeless', agent_id: agent.externalId, started_at: null })]);

    expect((await listWorkspaceCalls(workspace.id, query())).items).toHaveLength(1);
  });

  it('excludes a call with no start time from a bounded view', async () => {
    // It cannot be shown to fall inside the range, and a date filter that
    // silently admits undated rows is not a date filter.
    servePages([upstreamCall({ call_id: 'timeless', agent_id: agent.externalId, started_at: null })]);

    const page = await listWorkspaceCalls(workspace.id, query({ from: '2026-08-01' }));

    expect(page.items).toEqual([]);
  });
});

describe('listWorkspaceCalls — failures', () => {
  it('surfaces an upstream failure rather than an empty list', async () => {
    const { ApiError: ApiErrorClass } = await import('../src/lib/errors.js');
    mockedListCalls.mockRejectedValue(
      new ApiErrorClass(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
    );

    const error = await listWorkspaceCalls(workspace.id, query()).catch((err: unknown) => err);

    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
  });

  it('does not call upstream at all when the workspace holds nothing to match', async () => {
    // No agents and no campaigns means no call can be visible. Walking 2,000
    // rows to prove it spends a rate limit every workspace shares.
    await prisma.agent.deleteMany({ where: { workspaceId: workspace.id } });
    servePages([upstreamCall()]);

    const page = await listWorkspaceCalls(workspace.id, query());

    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(mockedListCalls).not.toHaveBeenCalled();
  });
});

describe('getWorkspaceCall', () => {
  it('returns a call this workspace placed', async () => {
    mockedGetCall.mockResolvedValue(
      upstreamCall({
        call_id: 'mine',
        agent_id: agent.externalId,
        session: { transcript: [{ role: 'bot', content: 'Hello?' }], recording_url: 'https://s/x.wav' },
      }),
    );

    const call = await getWorkspaceCall(workspace.id, 'mine');

    expect(call.id).toBe('mine');
    expect(call.agent).toEqual({ id: agent.id, name: 'Support' });
    expect(call.transcript).toEqual({
      kind: 'turns',
      turns: [{ role: 'bot', content: 'Hello?', timestamp: null }],
    });
    expect(call.recordingAvailable).toBe(true);
  });

  it('404s a call belonging to another workspace', async () => {
    const theirs = await makeAgent(other, 'Theirs');
    mockedGetCall.mockResolvedValue(upstreamCall({ agent_id: theirs.externalId }));

    const error = await getWorkspaceCall(workspace.id, 'not-mine').catch((err: unknown) => err);

    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('NOT_FOUND');
  });

  it('404s a call that does not exist, indistinguishably from a foreign one', async () => {
    // Upstream says "no such call"; so do we, in the same words a call
    // belonging to another workspace gets. Distinguishing them would let a
    // caller sort ids into real and unreal by watching the status code.
    mockedGetCall.mockResolvedValue(null);

    const error = await getWorkspaceCall(workspace.id, 'nope').catch((err: unknown) => err);

    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('NOT_FOUND');
  });

  it('reports an outage as an outage, not as a missing call', async () => {
    // The one distinction worth making. "Call not found" when the platform is
    // simply unreachable tells the reader their call was deleted, and they act
    // on that.
    const { ApiError: ApiErrorClass } = await import('../src/lib/errors.js');
    mockedGetCall.mockRejectedValue(
      new ApiErrorClass(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const error = await getWorkspaceCall(workspace.id, 'mine').catch((err: unknown) => err);

    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
  });

  it('attaches the timeline and billing from the attempt this platform recorded', async () => {
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Attempted' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876500011' },
    });
    const campaignContact = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: campaignContact.id,
        workspaceId: workspace.id,
        accountId: workspace.ownerAccountId,
        attemptNo: 1,
        upstreamCallId: 'attempted',
        status: 'COMPLETED',
        disposition: 'interested',
        hangupCause: 'NORMAL_CLEARING',
        startedAt: new Date('2026-08-20T10:00:00.000Z'),
        answeredAt: new Date('2026-08-20T10:00:06.000Z'),
        endedAt: new Date('2026-08-20T10:00:44.000Z'),
        resolvedAt: new Date('2026-08-20T10:00:45.000Z'),
        chargedAt: new Date('2026-08-20T10:00:46.000Z'),
        durationSecs: 38,
        billedSecs: 60,
        costCredits: 15000n,
      },
    });
    mockedGetCall.mockResolvedValue(
      upstreamCall({ call_id: 'attempted', agent_id: agent.externalId }),
    );

    const call = await getWorkspaceCall(workspace.id, 'attempted');

    expect(call.timelineSource).toBe('attempt');
    expect(call.timeline.map((event) => event.kind)).toEqual([
      'dialed',
      'answered',
      'ended',
      'resolved',
      'charged',
    ]);
    expect(call.billing).toEqual({
      creditsCharged: '1.5',
      billedSeconds: 60,
      shortfall: false,
    });
  });

  it('says no timeline was recorded for a call this platform did not dial', async () => {
    // An inbound or hand-placed call has no attempt row. Empty is the honest
    // answer, and `none` is what stops the surface rendering it as a call that
    // did nothing.
    mockedGetCall.mockResolvedValue(
      upstreamCall({ call_id: 'undialled', agent_id: agent.externalId }),
    );

    const call = await getWorkspaceCall(workspace.id, 'undialled');

    expect(call.timeline).toEqual([]);
    expect(call.timelineSource).toBe('none');
    expect(call.billing).toBeNull();
  });

  it('does not attach an attempt another workspace recorded for the same call id', async () => {
    // The attempt lookup is scoped on the workspace as well as the id. Without
    // that a shared partner account could put one workspace's charge on
    // another's call detail.
    const theirCampaign = await prisma.campaign.create({
      data: { workspaceId: other.id, name: 'Theirs' },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId: theirCampaign.id,
        workspaceId: other.id,
        accountId: other.ownerAccountId,
        attemptNo: 1,
        upstreamCallId: 'shared-id',
        status: 'COMPLETED',
        startedAt: new Date('2026-08-20T10:00:00.000Z'),
        chargedAt: new Date('2026-08-20T10:00:46.000Z'),
        costCredits: 99990000n,
      },
    });
    mockedGetCall.mockResolvedValue(
      upstreamCall({ call_id: 'shared-id', agent_id: agent.externalId }),
    );

    const call = await getWorkspaceCall(workspace.id, 'shared-id');

    expect(call.billing).toBeNull();
    expect(call.timelineSource).toBe('none');
  });

  it('resolves a call visible only through its campaign', async () => {
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'August outreach' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876500001' },
    });
    const campaignContact = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    mockedGetCall.mockResolvedValue(
      upstreamCall({
        call_id: 'campaign-call',
        agent_id: 'ext-belongs-to-nobody',
        client_reference_id: formatCorrelationId(campaign.id, campaignContact.id),
      }),
    );

    const call = await getWorkspaceCall(workspace.id, 'campaign-call');

    expect(call.campaign).toEqual({ id: campaign.id, name: 'August outreach' });
  });
});
