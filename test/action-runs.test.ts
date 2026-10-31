import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentTools: vi.fn(),
  getAgentLifecycleHooks: vi.fn(),
  listIntegrationLogs: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

const NOW = new Date('2026-09-21T12:00:00.000Z');

/** One audit row, field for field what integration-logs.routes.ts:216-231 sends. */
function logRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-1',
    agentId: 'ext-1',
    sessionId: 'sess_1',
    toolSlug: 'google_sheets',
    fn: 'post_call_append_extraction',
    status: 'OK',
    upstreamCode: 200,
    latencyMs: 412,
    // Nothing on the allow-list, so nothing of it may appear on the wire.
    argsRedacted: { spreadsheet_id: 'sheet-secret-123' },
    resultSummary: null,
    errorMessage: null,
    createdAt: '2026-09-21T11:59:00.000Z',
    ...overrides,
  };
}

let alice: Awaited<ReturnType<typeof makeAccount>>;
let workspace: Workspace;
let agent: Agent;

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.setSystemTime(NOW);
  vi.mocked(client.listIntegrationLogs).mockResolvedValue({ logs: [logRow()], nextCursor: null });

  alice = await makeAccount('alice');
  workspace = await makeWorkspace(alice, 'Alice Co');
  agent = await prisma.agent.create({
    data: { externalId: 'ext-1', name: 'Caller', workspaceId: workspace.id },
  });
});

const auth = () => as('user_alice', 'alice@ezo.test');

describe('GET /agents/:id/action-runs', () => {
  const runs = (query = '') =>
    request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/action-runs${query}`)
      .set(...auth());

  it('projects a run to the fields the panel renders, and nothing else', async () => {
    const res = await runs();

    expect(res.status).toBe(200);
    expect(res.body.data.runs).toEqual([
      {
        id: 'log-1',
        session_id: 'sess_1',
        tool_slug: 'google_sheets',
        fn: 'post_call_append_extraction',
        status: 'OK',
        upstream_code: 200,
        latency_ms: 412,
        error: null,
        created_at: '2026-09-21T11:59:00.000Z',
      },
    ]);
    // The platform's redacted args summary still names a customer's
    // spreadsheet. Rebuilt, never passed through.
    expect(JSON.stringify(res.body)).not.toContain('sheet-secret-123');
  });

  it('serves runs from the bare body the platform really sends, through the real adapter', async () => {
    // The mocks above hand the route an already-parsed document, which is
    // how a fixture invented an envelope once. This one goes through the
    // real `listIntegrationLogs` and `fetch`, with the body copied from
    // integration-logs.routes.ts:215-233 — bare, no `{ success, data }`.
    const actual = await vi.importActual<typeof import('../src/adapter/vocobase.js')>(
      '../src/adapter/vocobase.js',
    );
    const { env } = await import('../src/lib/env.js');
    const key = env.vocobaseApiKey;
    env.vocobaseApiKey = 'test-key';
    vi.mocked(client.listIntegrationLogs).mockImplementation(actual.listIntegrationLogs);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            logs: [
              {
                id: 'log-1',
                agentId: 'ext-1',
                sessionId: 'sess_1',
                toolSlug: 'google_sheets',
                fn: 'lookup_row',
                status: 'OK',
                upstreamCode: 200,
                latencyMs: 12,
                argsRedacted: { spreadsheet_id: 'sheet-secret-123' },
                resultSummary: null,
                errorMessage: null,
                createdAt: '2026-09-21T11:59:00.000Z',
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    try {
      const res = await runs();

      expect(res.status).toBe(200);
      expect(res.body.data.runs).toHaveLength(1);
      expect(res.body.data.runs[0]).toMatchObject({ id: 'log-1', status: 'OK', fn: 'lookup_row' });
      expect(res.body.data.next_cursor).toBeNull();
    } finally {
      env.vocobaseApiKey = key;
      vi.unstubAllGlobals();
    }
  });

  describe('the error line', () => {
    it('reads the platform’s errorMessage, which is what a failed row carries', async () => {
      vi.mocked(client.listIntegrationLogs).mockResolvedValue({
        logs: [logRow({ status: 'UPSTREAM_ERROR', errorMessage: 'Sheet is read-only.' })],
      });

      const res = await runs();

      expect(res.body.data.runs[0].error).toBe('Sheet is read-only.');
    });

    it('reads errorMessage and no other spelling, since that is the only one sent', async () => {
      // integration-logs.routes.ts:229 sends camelCase `errorMessage`. A
      // field of another name is not the platform's and says nothing.
      vi.mocked(client.listIntegrationLogs).mockResolvedValue({
        logs: [
          logRow({ id: 'a', errorMessage: 'camel' }),
          logRow({ id: 'b', errorMessage: null, error_message: 'snake', error: 'bare' }),
        ],
      });

      const res = await runs();

      expect(res.body.data.runs.map((r: { error: unknown }) => r.error)).toEqual(['camel', null]);
    });

    it('derives a sentence for a SKIPPED row from the path the guard stopped at', async () => {
      // A skipped row has no error — nothing failed — but a panel that shows
      // "SKIPPED" and a blank leaves the reader asking which guard fired.
      vi.mocked(client.listIntegrationLogs).mockResolvedValue({
        logs: [
          logRow({
            status: 'SKIPPED',
            resultSummary: { reason: 'skip_unless', path: 'extraction.email' },
          }),
        ],
      });

      const res = await runs();

      expect(res.body.data.runs[0].error).toBe('Skipped: extraction.email was empty');
    });

    it('falls back to the reason when a SKIPPED row names no path', async () => {
      vi.mocked(client.listIntegrationLogs).mockResolvedValue({
        logs: [logRow({ status: 'SKIPPED', resultSummary: { reason: 'disabled' } })],
      });

      const res = await runs();

      expect(res.body.data.runs[0].error).toBe('Skipped: disabled');
    });

    it('keeps a SKIPPED row’s own message when the platform wrote one', async () => {
      vi.mocked(client.listIntegrationLogs).mockResolvedValue({
        logs: [
          logRow({
            status: 'SKIPPED',
            errorMessage: 'Skipped by operator.',
            resultSummary: { reason: 'x', path: 'y' },
          }),
        ],
      });

      const res = await runs();

      expect(res.body.data.runs[0].error).toBe('Skipped by operator.');
    });
  });

  it('asks for the last 24 hours by default, and says which window it read', async () => {
    const res = await runs();

    expect(client.listIntegrationLogs).toHaveBeenCalledWith({
      agentId: 'ext-1',
      from: '2026-09-20T12:00:00.000Z',
      to: '2026-09-21T12:00:00.000Z',
      limit: 50,
    });
    // Returned so an empty list reads as "nothing in this window" rather
    // than "nothing ever ran" — the platform prunes at 30 days and the
    // dashboard cannot tell the two apart without being told the window.
    expect(res.body.data.window).toEqual({
      from: '2026-09-20T12:00:00.000Z',
      to: '2026-09-21T12:00:00.000Z',
    });
  });

  it('honours an explicit window and a cursor', async () => {
    await runs('?from=2026-09-01T00:00:00.000Z&to=2026-09-02T00:00:00.000Z&cursor=c1');

    expect(client.listIntegrationLogs).toHaveBeenCalledWith({
      agentId: 'ext-1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-02T00:00:00.000Z',
      cursor: 'c1',
      limit: 50,
    });
  });

  it('passes the platform’s cursor back for the next page', async () => {
    vi.mocked(client.listIntegrationLogs).mockResolvedValue({ logs: [], nextCursor: 'c2' });

    const res = await runs();

    expect(res.body.data.next_cursor).toBe('c2');
    expect(res.body.data.runs).toEqual([]);
  });

  it('refuses a window whose end precedes its start', async () => {
    const res = await runs('?from=2026-09-02T00:00:00.000Z&to=2026-09-01T00:00:00.000Z');

    expect(res.status).toBe(400);
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });

  it('refuses a date it cannot parse rather than reading a silent NaN window', async () => {
    const res = await runs('?from=yesterday');

    expect(res.status).toBe(400);
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });

  it("404s another workspace's agent without reaching the platform", async () => {
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await prisma.agent.create({
      data: { externalId: 'ext-theirs', name: 'Theirs', workspaceId: theirs.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${foreign.id}/action-runs`)
      .set(...auth());

    expect(res.status).toBe(404);
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });

  describe('?side=inbound', () => {
    it('asks the platform for the face’s runs, keyed on the base agent id', async () => {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { direction: 'BI', inboundEnabled: true },
      });

      const res = await runs('?side=inbound');

      expect(res.status).toBe(200);
      expect(client.listIntegrationLogs).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'ext-1', side: 'inbound' }),
      );
    });

    it('404s INBOUND_NOT_ENABLED on an agent with no addressable face, without asking', async () => {
      // UNI: the one face IS the inbound behaviour, and its runs are the
      // base's runs. Naming a second side here names nothing.
      await prisma.agent.update({
        where: { id: agent.id },
        data: { direction: 'UNI', inboundEnabled: true },
      });

      const res = await runs('?side=inbound');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
      expect(client.listIntegrationLogs).not.toHaveBeenCalled();
    });

    it('passes the platform’s own INBOUND_NOT_ENABLED through as the same 404', async () => {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { direction: 'BI', inboundEnabled: true },
      });
      const { ApiError } = await import('../src/lib/errors.js');
      // Exactly the ApiError `listIntegrationLogs` builds from the platform's
      // `{ success:false, error:{ code:'INBOUND_NOT_ENABLED' } }` 404 — pinned
      // in vocobase-actions-adapter.test.ts ("passes the platform's
      // INBOUND_NOT_ENABLED on a face read through as itself"). Before that
      // pass-through the adapter could only produce RESOURCE_NOT_FOUND here,
      // and this test would have been pinning an error that never arrives.
      vi.mocked(client.listIntegrationLogs).mockRejectedValue(
        new ApiError(404, 'INBOUND_NOT_ENABLED', 'Inbound is not enabled on this agent.'),
      );

      const res = await runs('?side=inbound');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
    });

    it('refuses a side it does not know', async () => {
      const res = await runs('?side=sideways');

      expect(res.status).toBe(400);
      expect(client.listIntegrationLogs).not.toHaveBeenCalled();
    });
  });
});

describe('GET /calls/:id/actions', () => {
  async function makeAttempt(data: Record<string, unknown> = {}) {
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Outreach', agentId: agent.id, status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876500001' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    return prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: workspace.id,
        accountId: alice.id,
        attemptNo: 1,
        startedAt: new Date('2026-09-21T10:00:00.000Z'),
        ...data,
      },
    });
  }

  const actions = (id: string) =>
    request(app).get(`/api/workspaces/${workspace.id}/calls/${id}/actions`).set(...auth());

  it('reads the runs for the attempt’s upstream session, around its own clock', async () => {
    const attempt = await makeAttempt({
      upstreamCallId: 'c_1',
      upstreamSessionId: 'sess_1',
      endedAt: new Date('2026-09-21T10:02:00.000Z'),
    });

    const res = await actions(attempt.id);

    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(client.listIntegrationLogs).toHaveBeenCalledWith({
      agentId: 'ext-1',
      sessionId: 'sess_1',
      // Five minutes before it started and an hour after it ended: a
      // pre-call hook runs before the session is answered and the post-call
      // queue runs well after it hangs up.
      from: '2026-09-21T09:55:00.000Z',
      to: '2026-09-21T11:02:00.000Z',
      limit: 50,
    });
  });

  it('is reachable by the upstream call id too, which is what the detail page holds', async () => {
    await makeAttempt({ upstreamCallId: 'c_1', upstreamSessionId: 'sess_1' });

    const res = await actions('c_1');

    expect(res.status).toBe(200);
    expect(client.listIntegrationLogs).toHaveBeenCalled();
  });

  it('says a call was never placed rather than reporting that nothing ran', async () => {
    const attempt = await makeAttempt({ upstreamSessionId: null });

    const res = await actions(attempt.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ runs: [], reason: 'not_placed' });
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });

  it('falls back to the clock when the call has not ended yet', async () => {
    const attempt = await makeAttempt({ upstreamSessionId: 'sess_1', endedAt: null });

    await actions(attempt.id);

    const sent = vi.mocked(client.listIntegrationLogs).mock.calls[0]![0]!;
    expect(sent.from).toBe('2026-09-21T09:55:00.000Z');
    expect(sent.to).toBe('2026-09-21T13:00:00.000Z');
  });

  it("answers not_tracked for an attempt in another workspace, without asking", async () => {
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreignAgent = await prisma.agent.create({
      data: { externalId: 'ext-theirs', name: 'T', workspaceId: theirs.id },
    });
    const campaign = await prisma.campaign.create({
      data: { workspaceId: theirs.id, name: 'X', agentId: foreignAgent.id, status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: theirs.id, phone: '+919876500009' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    const foreign = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: theirs.id,
        accountId: bob.id,
        attemptNo: 1,
        upstreamSessionId: 'sess_theirs',
      },
    });

    const res = await actions(foreign.id);

    // The same answer as an id that names nothing: a 404 would have the
    // panel offer a retry that cannot succeed, and a different answer
    // would say the id is real somewhere.
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ runs: [], reason: 'not_tracked' });
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });

  it('answers not_tracked for an id that names nothing, rather than a 404', async () => {
    const res = await actions('nope');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ runs: [], reason: 'not_tracked' });
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });

  describe('an inbound call', () => {
    async function makeInbound(ws: Workspace, data: Record<string, unknown> = {}) {
      const campaign = await prisma.campaign.create({
        data: { workspaceId: ws.id, name: 'Inbound', agentId: agent.id, status: 'RUNNING' },
      });
      const did = await prisma.phoneNumber.create({
        data: { did: `+9180000${Math.floor(Math.random() * 1e5)}`, workspaceId: ws.id },
      });
      return prisma.campaignInboundCall.create({
        data: {
          campaignId: campaign.id,
          workspaceId: ws.id,
          phoneNumberId: did.id,
          fromNumber: '+919876500002',
          arrivedAt: new Date('2026-09-21T10:00:00.000Z'),
          ...data,
        },
      });
    }

    it('reads its runs by the session alone, with no agent filter to drop the face’s rows', async () => {
      // integration-logs.routes.ts:153-170: a bare agentId is the PARENT and
      // matches only the base's rows, while an inbound call's runs are the
      // face's. sessionId alone is exact, and the user scope bounds it.
      const call = await makeInbound(workspace, {
        upstreamCallId: 'prov_1',
        upstreamPhoneCallId: 'pc_1',
        upstreamSessionId: 'sess_in',
        endedAt: new Date('2026-09-21T10:03:00.000Z'),
      });

      const res = await actions(call.id);

      expect(res.status).toBe(200);
      expect(res.body.data.runs).toHaveLength(1);
      expect(client.listIntegrationLogs).toHaveBeenCalledWith({
        sessionId: 'sess_in',
        from: '2026-09-21T09:55:00.000Z',
        to: '2026-09-21T11:03:00.000Z',
        limit: 50,
      });
    });

    it('is reachable by the provider call id and by the platform call id', async () => {
      await makeInbound(workspace, {
        upstreamCallId: 'prov_1',
        upstreamPhoneCallId: 'pc_1',
        upstreamSessionId: 'sess_in',
      });

      expect((await actions('prov_1')).body.data.runs).toHaveLength(1);
      expect((await actions('pc_1')).body.data.runs).toHaveLength(1);
      expect(client.listIntegrationLogs).toHaveBeenCalledTimes(2);
    });

    it('says an inbound call with no session was never placed', async () => {
      const call = await makeInbound(workspace, { upstreamSessionId: null });

      const res = await actions(call.id);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ runs: [], reason: 'not_placed' });
      expect(client.listIntegrationLogs).not.toHaveBeenCalled();
    });

    it("does not find another workspace's inbound call", async () => {
      const bob = await makeAccount('bob');
      const theirs = await makeWorkspace(bob, 'Bob Co');
      const call = await makeInbound(theirs, {
        upstreamCallId: 'prov_theirs',
        upstreamSessionId: 'sess_theirs',
      });

      for (const id of [call.id, 'prov_theirs']) {
        const res = await actions(id);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ runs: [], reason: 'not_tracked' });
      }
      expect(client.listIntegrationLogs).not.toHaveBeenCalled();
    });
  });

  it('404s an attempt whose agent has been unassigned, having nothing to ask about', async () => {
    const attempt = await makeAttempt({ upstreamSessionId: 'sess_1' });
    await prisma.campaign.updateMany({ data: { agentId: null } });

    const res = await actions(attempt.id);

    expect(res.status).toBe(404);
    expect(client.listIntegrationLogs).not.toHaveBeenCalled();
  });
});
