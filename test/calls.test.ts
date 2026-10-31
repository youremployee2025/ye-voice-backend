import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeAgent, makeWorkspace } from './helpers.js';
import { formatCorrelationId } from '../src/lib/callCorrelation.js';

// No test may reach the real partner API.
vi.mock('../src/adapter/vocobase.js', () => ({
  listCalls: vi.fn(),
  getCall: vi.fn(),
  getCallRecordingUrl: vi.fn(),
  fetchRecording: vi.fn(),
  // Unused here, but createApp() mounts every router, and a mock missing an
  // export the app imports fails the whole suite at load.
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  listPurchasedDids: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

const listCalls = vi.mocked(client.listCalls);
const getCall = vi.mocked(client.getCall);
const getCallRecordingUrl = vi.mocked(client.getCallRecordingUrl);
const fetchRecording = vi.mocked(client.fetchRecording);

function upstreamCall(overrides: Record<string, unknown> = {}) {
  return {
    call_id: 'call-1',
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

function serve(rows: Record<string, unknown>[]) {
  listCalls.mockImplementation(async ({ limit, offset }) => ({
    calls: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  }));
}

let owner: Awaited<ReturnType<typeof makeAccount>>;
let member: Awaited<ReturnType<typeof makeAccount>>;
let stranger: Awaited<ReturnType<typeof makeAccount>>;
let workspace: Workspace;
let other: Workspace;
let agent: Agent;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();

  const suffix = Math.random().toString(36).slice(2, 8);
  owner = await makeAccount(`owner_${suffix}`);
  member = await makeAccount(`member_${suffix}`);
  stranger = await makeAccount(`stranger_${suffix}`);

  workspace = await makeWorkspace(owner, 'Ours');
  other = await makeWorkspace(stranger, 'Theirs');
  await addMember(workspace, member, 'MEMBER');

  agent = await makeAgent(workspace, 'Support');
  serve([]);
});

const path = (suffix = '') => `/api/workspaces/${workspace.id}/calls${suffix}`;

describe('authorisation', () => {
  const routes = () => [path(), path('/call-1'), path('/call-1/recording')];

  it('refuses an unauthenticated caller on every route', async () => {
    for (const route of routes()) {
      const res = await request(app).get(route);
      expect(res.status).toBe(401);
    }
  });

  it('refuses a non-member with 403 on every route', async () => {
    for (const route of routes()) {
      const res = await request(app).get(route).set(...as(stranger.clerkUserId, stranger.email));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('lets a MEMBER read the history — there is no admin gate here', async () => {
    serve([upstreamCall({ agent_id: agent.externalId })]);

    const res = await request(app).get(path()).set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it('offers no way to write', async () => {
    for (const method of ['post', 'patch', 'delete'] as const) {
      const res = await request(app)[method](path()).set(...as(owner.clerkUserId, owner.email));
      expect(res.status).toBe(404);
    }
  });
});

describe('GET /calls', () => {
  it('answers the page envelope', async () => {
    serve([upstreamCall({ agent_id: agent.externalId })]);

    const res = await request(app).get(path()).set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      page: 1,
      limit: 25,
      hasMore: false,
      truncated: false,
      scanned: 1,
    });
  });

  it('carries no total — the set is deliberately not measured', async () => {
    serve([upstreamCall({ agent_id: agent.externalId })]);

    const res = await request(app).get(path()).set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data).not.toHaveProperty('total');
  });

  it('never ships a call this workspace may not see', async () => {
    const theirs = await makeAgent(other, 'Theirs');
    serve([
      upstreamCall({ call_id: 'mine', agent_id: agent.externalId }),
      upstreamCall({ call_id: 'theirs', agent_id: theirs.externalId }),
    ]);

    const res = await request(app).get(path()).set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data.items.map((c: { id: string }) => c.id)).toEqual(['mine']);
    expect(JSON.stringify(res.body)).not.toContain('theirs');
  });

  it('404s an agent filter naming another workspace agent, rather than filtering to nothing', async () => {
    // An empty list would be an existence oracle: a real id and a nonsense one
    // would answer differently over time.
    const theirs = await makeAgent(other, 'Theirs');

    const res = await request(app)
      .get(path(`?agentId=${theirs.id}`))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s an agent filter naming nothing at all, identically', async () => {
    const res = await request(app)
      .get(path('?agentId=agt_nonexistent'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s a campaign filter naming another workspace campaign', async () => {
    const theirs = await prisma.campaign.create({
      data: { workspaceId: other.id, name: 'Not ours' },
    });

    const res = await request(app)
      .get(path(`?campaignId=${theirs.id}`))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
  });

  it('accepts a campaign filter naming one of its own', async () => {
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'August outreach' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876500002' },
    });
    const campaignContact = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    serve([
      upstreamCall({
        call_id: 'campaign-call',
        agent_id: agent.externalId,
        client_reference_id: formatCorrelationId(campaign.id, campaignContact.id),
      }),
    ]);

    const res = await request(app)
      .get(path(`?campaignId=${campaign.id}`))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
  });

  it('rejects malformed paging and dates with 400', async () => {
    for (const query of ['?page=two', '?limit=0', '?from=yesterday', '?from=2026-09-01&to=2026-08-01']) {
      const res = await request(app).get(path(query)).set(...as(owner.clerkUserId, owner.email));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('reports an unreachable platform rather than an empty history', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    listCalls.mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app).get(path()).set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('GET /calls/:callId', () => {
  it('returns the detail with transcript, variables and extraction', async () => {
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: {
          transcript: [{ role: 'bot', content: 'Hello?', timestamp: '2026-08-20T10:00:01.000Z' }],
          variables: { brand_name: 'University Of Mumbai' },
          extraction: { status: 'success', values: { interested: true } },
          recording_url: 'https://storage.test/signed.wav?sig=secret',
        },
      }),
    );

    const res = await request(app).get(path('/call-1')).set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.transcript.kind).toBe('turns');
    expect(res.body.data.variables).toEqual({ brand_name: 'University Of Mumbai' });
    expect(res.body.data.recordingAvailable).toBe(true);
  });

  it('never hands the browser the upstream recording url', async () => {
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { recording_url: 'https://storage.test/signed.wav?sig=secret' },
      }),
    );

    const res = await request(app).get(path('/call-1')).set(...as(owner.clerkUserId, owner.email));

    expect(JSON.stringify(res.body)).not.toContain('storage.test');
    expect(JSON.stringify(res.body)).not.toContain('sig=secret');
  });

  it('distinguishes a transcript still processing from one that will never arrive', async () => {
    // The same absence, and two different facts. "Still processing" tells the
    // reader to come back; "not available" tells them not to. Reporting the
    // first as the second sends them away for good.
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { transcript: null, processing_complete: false },
      }),
    );

    const processing = await request(app)
      .get(path('/call-1'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(processing.body.data.processingComplete).toBe(false);
    expect(processing.body.data.transcript.kind).toBe('unavailable');

    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { transcript: null, processing_complete: true },
      }),
    );

    const settled = await request(app)
      .get(path('/call-1'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(settled.body.data.processingComplete).toBe(true);
    expect(settled.body.data.transcript.kind).toBe('unavailable');
  });

  it('reports a call that never connected as such, not as a conversation', async () => {
    // Upstream sends an object describing the failure where a transcript would
    // be. Rendered loosely that becomes carrier diagnostics laid out as things
    // the customer said.
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: {
          transcript: { error: 'no answer', provider: 'mcube', terminal_reason: 'NO_ANSWER' },
          processing_complete: true,
        },
      }),
    );

    const res = await request(app).get(path('/call-1')).set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data.transcript).toEqual({ kind: 'unavailable', reason: 'not_connected' });
    // The carrier's own wording names the supplier and never reaches the browser.
    expect(JSON.stringify(res.body)).not.toContain('mcube');
  });

  it('carries an empty timeline and a null charge for a call it holds no attempt for', async () => {
    getCall.mockResolvedValue(upstreamCall({ agent_id: agent.externalId }));

    const res = await request(app).get(path('/call-1')).set(...as(owner.clerkUserId, owner.email));

    expect(res.body.data.timeline).toEqual([]);
    expect(res.body.data.timelineSource).toBe('none');
    expect(res.body.data.billing).toBeNull();
  });

  it('404s a call belonging to another workspace', async () => {
    const theirs = await makeAgent(other, 'Theirs');
    getCall.mockResolvedValue(upstreamCall({ agent_id: theirs.externalId }));

    const res = await request(app).get(path('/call-1')).set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s a foreign call and a nonexistent one in bytes-identical terms', async () => {
    // Not merely the same status: the same body. A difference anywhere here
    // lets a caller sort ids into real and unreal by watching the response.
    const theirs = await makeAgent(other, 'Theirs');
    getCall.mockResolvedValue(upstreamCall({ agent_id: theirs.externalId }));
    const foreign = await request(app)
      .get(path('/call-1'))
      .set(...as(owner.clerkUserId, owner.email));

    getCall.mockResolvedValue(null);
    const absent = await request(app)
      .get(path('/nope'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });

  it('404s a call that does not exist, in the same words', async () => {
    getCall.mockResolvedValue(null);

    const res = await request(app).get(path('/nope')).set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /calls/:callId/recording', () => {
  beforeEach(() => {
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { recording_url: 'https://storage.test/signed.wav?sig=secret' },
      }),
    );
    getCallRecordingUrl.mockResolvedValue({
      call_id: 'call-1',
      recording_url: 'https://storage.test/fresh.wav?sig=fresh',
    });
  });

  it('streams the audio through this service', async () => {
    fetchRecording.mockResolvedValue(
      new Response('RIFFDATA', {
        status: 200,
        headers: { 'Content-Type': 'audio/wav', 'Content-Length': '8' },
      }),
    );

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('survives storage failing part-way through the audio', async () => {
    // The whole point of proxying is that the body is streamed, so the failure
    // that matters arrives *after* the headers. `pipe()` does not forward a
    // source error, and an unhandled one on a Readable is an uncaught
    // exception — which takes the process down for every other workspace.
    let delivered = false;
    fetchRecording.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            // First pull delivers audio, so headers are already on the wire.
            // The second fails, which is how a dropped storage connection
            // actually presents.
            if (delivered) {
              controller.error(new Error('storage connection reset'));
              return;
            }
            delivered = true;
            controller.enqueue(new TextEncoder().encode('RIFF'));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'audio/wav' } },
      ),
    );

    // A mid-stream abort surfaces to the client as a broken connection; there
    // is no status left to change. What must not happen is a crash.
    await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email))
      .catch(() => undefined);

    // Still serving: a later request is answered normally.
    fetchRecording.mockResolvedValue(new Response('RIFFDATA', { status: 200 }));
    const after = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(after.status).toBe(200);
  });

  it('does not let storage choose how the browser treats the bytes', async () => {
    fetchRecording.mockResolvedValue(
      new Response('RIFFDATA', {
        status: 200,
        // Whatever was set at upload time. This route serves from our own
        // origin and is reachable by direct navigation with ?token=.
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('does not forward a content-length that describes the compressed body', async () => {
    // undici decodes on the way in, so a gzipped upstream response leaves the
    // compressed length on the header and the decoded bytes in the body.
    fetchRecording.mockResolvedValue(
      new Response('RIFFDATA', {
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Encoding': 'gzip',
          'Content-Length': '12',
        },
      }),
    );

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.headers['content-length']).toBeUndefined();
  });

  it('never reveals the upstream url, in the body or in a redirect', async () => {
    fetchRecording.mockResolvedValue(new Response('RIFFDATA', { status: 200 }));

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).not.toBe(302);
    expect(res.headers.location).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toContain('storage.test');
  });

  it('passes a Range through so a player can seek', async () => {
    fetchRecording.mockResolvedValue(
      new Response('DAT', {
        status: 206,
        headers: { 'Content-Range': 'bytes 2-4/8', 'Content-Type': 'audio/wav' },
      }),
    );

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set('Range', 'bytes=2-4')
      .set(...as(owner.clerkUserId, owner.email));

    expect(fetchRecording).toHaveBeenCalledWith(expect.any(String), 'bytes=2-4');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-4/8');
  });

  it('reports a call with no recording distinctly from one it cannot see', async () => {
    getCall.mockResolvedValue(upstreamCall({ agent_id: agent.externalId, session: {} }));

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RECORDING_NOT_AVAILABLE');
  });

  it('404s NOT_FOUND for a call in another workspace, without asking for audio', async () => {
    const theirs = await makeAgent(other, 'Theirs');
    getCall.mockResolvedValue(
      upstreamCall({ agent_id: theirs.externalId, session: { recording_url: 'https://s/x.wav' } }),
    );

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(fetchRecording).not.toHaveBeenCalled();
  });

  it('reports storage refusing the signed url as an upstream failure', async () => {
    fetchRecording.mockResolvedValue(new Response('gone', { status: 403 }));

    const res = await request(app)
      .get(path('/call-1/recording'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('rate limiting', () => {
  it('caps the listing per workspace, since one request costs many upstream', async () => {
    serve([upstreamCall({ agent_id: agent.externalId })]);

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app).get(path()).set(...as(owner.clerkUserId, owner.email));
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
    const limited = statuses.indexOf(429);
    expect(statuses.slice(0, limited).every((s) => s === 200)).toBe(true);
  });

  it('caps the detail route, which also spends an upstream read per request', async () => {
    // The listing limiter protected the expensive route and left the cheap
    // ones open, so a loop on this one spends the same shared partner budget
    // without ever meeting a limit.
    getCall.mockResolvedValue(upstreamCall({ agent_id: agent.externalId }));

    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .get(path('/call-1'))
        .set(...as(owner.clerkUserId, owner.email));
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });

  it('caps the recording route, which is reachable with a token and no session', async () => {
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { recording_url: 'https://storage.test/signed.wav?sig=secret' },
      }),
    );
    getCallRecordingUrl.mockResolvedValue({
      call_id: 'call-1',
      recording_url: 'https://storage.test/fresh.wav?sig=fresh',
    });
    fetchRecording.mockResolvedValue(new Response('RIFFDATA', { status: 200 }));

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await request(app)
        .get(path('/call-1/recording'))
        .set(...as(owner.clerkUserId, owner.email));
      statuses.push(res.status);
    }

    expect(statuses).toContain(429);
  });

  it('does not let a second member of the same workspace reset the budget', async () => {
    // The resource protected is the workspace's share of a rate limit every
    // customer shares, so keying on the caller would let members multiply it.
    serve([upstreamCall({ agent_id: agent.externalId })]);

    for (let i = 0; i < 7; i += 1) {
      await request(app).get(path()).set(...as(owner.clerkUserId, owner.email));
    }

    const res = await request(app).get(path()).set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(429);
  });
});

describe('recording playback with no signing secret', () => {
  // "A missing secret must not mean an open door" is asserted in prose in
  // three places and, until now, nowhere in code.
  beforeEach(() => {
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { recording_url: 'https://storage.test/signed.wav?sig=secret' },
      }),
    );
  });

  it('refuses to mint, and refuses every token, when unconfigured', async () => {
    const { env } = await import('../src/lib/env.js');
    const configured = env.recordingTokenSecret;
    (env as { recordingTokenSecret: string }).recordingTokenSecret = '';

    try {
      const mint = await request(app)
        .get(path('/call-1/recording-token'))
        .set(...as(owner.clerkUserId, owner.email));

      expect(mint.status).toBe(502);

      // And nothing forged gets in either — an empty key is still a valid HMAC
      // key, so "no secret" must be refused rather than merely unusual.
      const played = await request(app).get(path('/call-1/recording?token=anything'));

      expect(played.status).toBe(401);
    } finally {
      (env as { recordingTokenSecret: string }).recordingTokenSecret = configured;
    }
  });
});

describe('recording access tokens', () => {
  beforeEach(() => {
    getCall.mockResolvedValue(
      upstreamCall({
        agent_id: agent.externalId,
        session: { recording_url: 'https://storage.test/signed.wav?sig=secret' },
      }),
    );
    getCallRecordingUrl.mockResolvedValue({
      call_id: 'call-1',
      recording_url: 'https://storage.test/fresh.wav?sig=fresh',
    });
    fetchRecording.mockResolvedValue(new Response('RIFFDATA', { status: 200 }));
  });

  async function mint(as_: [string, string], callId = 'call-1'): Promise<string> {
    const res = await request(app)
      .get(path(`/${callId}/recording-token`))
      .set(...as_);
    return res.body?.data?.token;
  }

  it('mints a token for a member of the workspace', async () => {
    const res = await request(app)
      .get(path('/call-1/recording-token'))
      .set(...as(member.clerkUserId, member.email));

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.expiresIn).toBeGreaterThan(0);
  });

  it('refuses to mint for a non-member', async () => {
    const res = await request(app)
      .get(path('/call-1/recording-token'))
      .set(...as(stranger.clerkUserId, stranger.email));

    expect(res.status).toBe(403);
  });

  it('refuses to mint for a call this workspace cannot see', async () => {
    // Or the token would authenticate a request for somebody else's audio.
    const theirs = await makeAgent(other, 'Theirs');
    getCall.mockResolvedValue(
      upstreamCall({ agent_id: theirs.externalId, session: { recording_url: 'https://s/x.wav' } }),
    );

    const res = await request(app)
      .get(path('/call-1/recording-token'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(404);
  });

  it('never puts the upstream url in the mint response', async () => {
    const res = await request(app)
      .get(path('/call-1/recording-token'))
      .set(...as(owner.clerkUserId, owner.email));

    expect(JSON.stringify(res.body)).not.toContain('storage.test');
  });

  it('plays a recording with a minted token and no session header', async () => {
    const token = await mint(as(owner.clerkUserId, owner.email));

    const res = await request(app).get(path(`/call-1/recording?token=${token}`));

    expect(res.status).toBe(200);
  });

  it('refuses playback with no credential at all', async () => {
    const res = await request(app).get(path('/call-1/recording'));

    expect(res.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    const res = await request(app).get(path('/call-1/recording?token=made.up'));

    expect(res.status).toBe(401);
    expect(fetchRecording).not.toHaveBeenCalled();
  });

  it('refuses a token minted for a different call', async () => {
    const token = await mint(as(owner.clerkUserId, owner.email), 'call-1');

    const res = await request(app).get(path(`/call-99/recording?token=${token}`));

    expect(res.status).toBe(401);
    expect(fetchRecording).not.toHaveBeenCalled();
  });

  it('refuses a token minted for a different workspace', async () => {
    const token = await mint(as(owner.clerkUserId, owner.email));

    const res = await request(app).get(
      `/api/workspaces/${other.id}/calls/call-1/recording?token=${token}`,
    );

    expect(res.status).toBe(401);
    expect(fetchRecording).not.toHaveBeenCalled();
  });

  it('still checks visibility on playback, not only at mint time', async () => {
    // The token authenticates; it never stands in for authorization.
    const token = await mint(as(owner.clerkUserId, owner.email));

    const theirs = await makeAgent(other, 'Theirs');
    getCall.mockResolvedValue(
      upstreamCall({ agent_id: theirs.externalId, session: { recording_url: 'https://s/x.wav' } }),
    );

    const res = await request(app).get(path(`/call-1/recording?token=${token}`));

    expect(res.status).toBe(404);
    expect(fetchRecording).not.toHaveBeenCalled();
  });
});
