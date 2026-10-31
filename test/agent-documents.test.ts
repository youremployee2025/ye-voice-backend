import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';
// Fixtures place a resource wherever the case needs it, which is the staff
// call's job. `claimResource` — the customer path — deliberately refuses to
// move one, so it cannot arrange a foreign-ownership case.
import { reassignResource as mapResource } from '../src/lib/workspaceResource.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  getDocumentSyncStatus: vi.fn(),
  createDocumentUpload: vi.fn(),
  putToPresignedUrl: vi.fn(),
  confirmDocument: vi.fn(),
  createParagraphDocument: vi.fn(),
  createWebLinkDocument: vi.fn(),
  linkDocuments: vi.fn(),
  unlinkDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

async function makeAgent(externalId: string, workspace: Workspace): Promise<Agent> {
  return prisma.agent.create({
    data: { externalId, name: `Agent ${externalId}`, workspaceId: workspace.id },
  });
}

async function setup() {
  const alice = await makeAccount('alice');
  const workspace = await makeWorkspace(alice, 'Alice Co');
  const agent = await makeAgent('ext-1', workspace);
  return { workspace, agent };
}

const auth = as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(client.createDocumentUpload).mockResolvedValue({
    document_id: 'doc-1',
    upload_url: 'https://storage.test/put?sig=1',
  });
  vi.mocked(client.putToPresignedUrl).mockResolvedValue(undefined);
  vi.mocked(client.confirmDocument).mockResolvedValue({ id: 'doc-1', name: 'handbook.pdf' });
  vi.mocked(client.linkDocuments).mockResolvedValue({ linked: [{ document_id: 'doc-1' }] });
});

describe('POST /agents/:agentId/documents:upload', () => {
  it('presigns, uploads, confirms, maps and links, in that order', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...auth)
      .attach('file', Buffer.from('%PDF-1.4 hello'), {
        filename: 'handbook.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(201);
    expect(client.createDocumentUpload).toHaveBeenCalledOnce();
    expect(vi.mocked(client.putToPresignedUrl).mock.calls[0][0]).toBe(
      'https://storage.test/put?sig=1',
    );
    expect(client.confirmDocument).toHaveBeenCalledExactlyOnceWith('doc-1');
    expect(vi.mocked(client.linkDocuments).mock.calls[0]).toEqual(['ext-1', ['doc-1']]);

    const mapping = await prisma.workspaceResource.findFirst({ where: { kind: 'DOCUMENT' } });
    expect(mapping).toMatchObject({ externalId: 'doc-1', workspaceId: workspace.id });
  });

  it('never emits the platform document id it just created', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...auth)
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(JSON.stringify(res.body)).not.toContain('doc-1');
  });

  it('refuses a non-member without reading the file', async () => {
    const { workspace, agent } = await setup();
    await makeAccount('mallory');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...as('user_mallory', 'mallory@ezo.test'))
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(res.status).toBe(403);
    // The membership guard runs ahead of the file parser on purpose: buffering
    // a stranger's upload before checking who they are turns an authorisation
    // check into a memory-exhaustion vector.
    expect(client.createDocumentUpload).not.toHaveBeenCalled();
  });

  it("refuses another workspace's agent before any upstream call", async () => {
    const { workspace } = await setup();
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${foreign.id}/documents:upload`)
      .set(...auth)
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(res.status).toBe(404);
    expect(client.createDocumentUpload).not.toHaveBeenCalled();
  });

  it('rejects a file type the platform does not accept', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...auth)
      .attach('file', Buffer.from('MZ'), {
        filename: 'thing.exe',
        contentType: 'application/x-msdownload',
      });

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(client.createDocumentUpload).not.toHaveBeenCalled();
  });

  it('rejects a request carrying no file', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...auth);

    expect(res.status).toBe(400);
  });

  it('reports a file over the cap as too large rather than as a generic failure', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...auth)
      .attach('file', Buffer.alloc(26 * 1024 * 1024, 0x41), {
        filename: 'huge.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('UPLOAD_TOO_LARGE');
    expect(client.createDocumentUpload).not.toHaveBeenCalled();
  });

  it('keeps the document mapped when linking it to the agent fails', async () => {
    const { workspace, agent } = await setup();
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.linkDocuments).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:upload`)
      .set(...auth)
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(res.status).toBe(502);
    // Mapped but unlinked: the workspace can attach it again. An unmapped
    // document would be invisible to everyone and unreachable forever.
    expect(await prisma.workspaceResource.count({ where: { kind: 'DOCUMENT' } })).toBe(1);
  });
});

describe('POST /agents/:agentId/documents:text and :link', () => {
  it('creates a pasted-text source in one call, then maps and links it', async () => {
    const { workspace, agent } = await setup();
    vi.mocked(client.createParagraphDocument).mockResolvedValue({ id: 'doc-2' });
    vi.mocked(client.linkDocuments).mockResolvedValue({ linked: [{ document_id: 'doc-2' }] });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:text`)
      .set(...auth)
      .send({ name: 'Refund policy', content: 'Refunds within 30 days.' });

    expect(res.status).toBe(201);
    expect(vi.mocked(client.linkDocuments).mock.calls[0]).toEqual(['ext-1', ['doc-2']]);
    expect(await prisma.workspaceResource.count({ where: { kind: 'DOCUMENT' } })).toBe(1);
  });

  it('creates a web-link source', async () => {
    const { workspace, agent } = await setup();
    vi.mocked(client.createWebLinkDocument).mockResolvedValue({ id: 'doc-3' });
    vi.mocked(client.linkDocuments).mockResolvedValue({ linked: [{ document_id: 'doc-3' }] });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:link`)
      .set(...auth)
      .send({ name: 'Pricing', url: 'https://acme.test/pricing' });

    expect(res.status).toBe(201);
    expect(vi.mocked(client.createWebLinkDocument).mock.calls[0][0]).toMatchObject({
      url: 'https://acme.test/pricing',
    });
  });

  it('rejects a URL that is not http or https', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:link`)
      .set(...auth)
      .send({ name: 'Local', url: 'file:///etc/passwd' });

    expect(res.status).toBe(400);
    expect(client.createWebLinkDocument).not.toHaveBeenCalled();
  });

  it('rejects empty pasted text rather than creating a blank source', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents:text`)
      .set(...auth)
      .send({ name: 'Nothing', content: '   ' });

    expect(res.status).toBe(400);
    expect(client.createParagraphDocument).not.toHaveBeenCalled();
  });
});

describe('GET /agents/:agentId/documents', () => {
  it('merges each row with its sync state', async () => {
    const { workspace, agent } = await setup();
    vi.mocked(client.getAgentDocuments).mockResolvedValue({
      documents: [
        { id: 'doc-1', name: 'handbook.pdf', type: 'pdf', file_size: 400 },
        { id: 'doc-2', name: 'pricing.docx', type: 'docx' },
      ],
    });
    vi.mocked(client.getDocumentSyncStatus).mockResolvedValue({
      documents: [
        { id: 'doc-1', sync_status: 'synced', synced_at: '2026-08-27T10:00:00.000Z' },
        { id: 'doc-2', sync_status: 'failed', sync_error: 'unreadable' },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ name: 'handbook.pdf', sync_status: 'synced' });
    // A failed sync must read as failed. Reporting it as synced, or as blank,
    // tells the reader the agent can answer from a document it cannot read.
    expect(res.body.data[1]).toMatchObject({ name: 'pricing.docx', sync_status: 'failed' });
  });

  it('shows a document whose sync state could not be read as unknown, not as synced', async () => {
    const { workspace, agent } = await setup();
    vi.mocked(client.getAgentDocuments).mockResolvedValue({
      documents: [{ id: 'doc-1', name: 'handbook.pdf' }],
    });
    vi.mocked(client.getDocumentSyncStatus).mockRejectedValue(new Error('sync status down'));

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents`)
      .set(...auth);

    // The list is still worth showing; the state simply is not known.
    expect(res.status).toBe(200);
    expect(res.body.data[0].sync_status).toBeNull();
  });

  it('drops upstream fields the workspace has no business holding', async () => {
    const { workspace, agent } = await setup();
    const hostile = {
      agent_id: 'ext-1',
      webhook_url: 'https://hooks.example/secret',
      callback_token: 'rg_live_abc123',
      partner_id: 'partner_42',
      s3_key: 'partner_42/doc-1/handbook.pdf',
    };
    vi.mocked(client.getAgentDocuments).mockResolvedValue({
      documents: [{ ...hostile, id: 'doc-1', name: 'handbook.pdf' }],
    });
    vi.mocked(client.getDocumentSyncStatus).mockResolvedValue({ documents: [] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents`)
      .set(...auth);

    // The row is rebuilt to an allow-list, not filtered, so a field the
    // platform adds tomorrow cannot appear without a change here.
    const body = JSON.stringify(res.body);
    for (const secret of Object.values(hostile)) {
      expect(body, `leaked ${secret}`).not.toContain(secret);
    }
    // The document id is the one identifier that *is* emitted, because
    // unlinking requires naming it — and the mapping, not secrecy, is what
    // stops another workspace using it.
    expect(res.body.data[0].id).toBe('doc-1');
  });

  it('marks a document this workspace does not own as not removable', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DOCUMENT', 'doc-mine', workspace.id);
    vi.mocked(client.getAgentDocuments).mockResolvedValue({
      documents: [
        { id: 'doc-mine', name: 'mine.pdf' },
        { id: 'doc-staff', name: 'attached-by-staff.pdf' },
      ],
    });
    vi.mocked(client.getDocumentSyncStatus).mockResolvedValue({ documents: [] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents`)
      .set(...auth);

    // Both are shown — hiding one would make the agent's knowledge base look
    // smaller than it is — but only the workspace's own may be acted on.
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].removable).toBe(true);
    expect(res.body.data[1].removable).toBe(false);
  });
});

describe('DELETE /agents/:agentId/documents/:documentId', () => {
  it('unlinks a document this workspace owns', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DOCUMENT', 'doc-1', workspace.id);
    vi.mocked(client.unlinkDocument).mockResolvedValue({});
    vi.mocked(client.deleteDocument).mockResolvedValue(undefined);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents/doc-1`)
      .set(...auth);

    expect(res.status).toBe(200);
    expect(vi.mocked(client.unlinkDocument).mock.calls[0]).toEqual(['ext-1', 'doc-1']);
  });

  it('deletes the document too, so removed sources do not accumulate forever', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DOCUMENT', 'doc-1', workspace.id);
    vi.mocked(client.unlinkDocument).mockResolvedValue({});
    vi.mocked(client.deleteDocument).mockResolvedValue(undefined);

    await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents/doc-1`)
      .set(...auth);

    // A source is created by, and linked to, exactly one agent here — there is
    // no attach-an-existing-document flow — so unlinking is the end of its
    // life. Leaving it behind would grow the partner account without bound
    // with rows no workspace can see or reclaim.
    expect(client.deleteDocument).toHaveBeenCalledExactlyOnceWith('doc-1');
    expect(await prisma.workspaceResource.count({ where: { kind: 'DOCUMENT' } })).toBe(0);
  });

  it('still reports success when the source is unlinked but could not be deleted', async () => {
    const { workspace, agent } = await setup();
    await mapResource('DOCUMENT', 'doc-1', workspace.id);
    vi.mocked(client.unlinkDocument).mockResolvedValue({});
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.deleteDocument).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'Could not reach the voice platform.'),
    );

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents/doc-1`)
      .set(...auth);

    // What the caller asked for — the agent no longer uses this source — did
    // happen. Reporting a failure would send them back to undo something that
    // already worked.
    expect(res.status).toBe(200);
    // The mapping survives, so the leftover is still attributable and can be
    // cleaned up later rather than becoming invisible.
    expect(await prisma.workspaceResource.count({ where: { kind: 'DOCUMENT' } })).toBe(1);
  });

  it("refuses a document mapped to another workspace, before calling upstream", async () => {
    const { workspace, agent } = await setup();
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await mapResource('DOCUMENT', 'doc-theirs', theirs.id);

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents/doc-theirs`)
      .set(...auth);

    expect(res.status).toBe(404);
    expect(client.unlinkDocument).not.toHaveBeenCalled();
  });

  it('refuses an unmapped document, so a staff-attached source cannot be removed', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/documents/doc-staff`)
      .set(...auth);

    expect(res.status).toBe(404);
    expect(client.unlinkDocument).not.toHaveBeenCalled();
  });
});
