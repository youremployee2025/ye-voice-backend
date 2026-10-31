import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from 'bullmq';

/**
 * The cleanup worker, driven for real.
 *
 * This is the wrapper the design leans on — "the cleanup sweep gives it
 * back" — so the wrapper itself is what runs here, not the functions it
 * calls: a real job through a real worker, against a claim a killed instance
 * would leave behind.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { getCall } = await import('../src/adapter/vocobase.js');
const { prisma } = await import('../src/lib/prisma.js');
const { campaignCleanupQueue, closeQueues } = await import('../src/lib/queue/queues.js');
const { createCampaignCleanupWorker } = await import(
  '../src/lib/queue/workers/campaign-cleanup.worker.js'
);
const { closeWorkerConnections, closeQueueConnection } = await import(
  '../src/lib/queue/connection.js'
);
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

let worker: Worker | null = null;

beforeEach(async () => {
  await truncateAll();
  await campaignCleanupQueue.obliterate({ force: true });
  vi.clearAllMocks();
  vi.mocked(getCall).mockResolvedValue(null);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await worker?.close();
  worker = null;
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await campaignCleanupQueue.obliterate({ force: true });
  await closeWorkerConnections();
  await closeQueues();
  await closeQueueConnection();
});

describe('the cleanup worker', () => {
  it('gives back a stale claim through a real cleanup job', async () => {
    const account = await makeAccount('cw1');
    const workspace = await makeWorkspace(account, 'Cleanup');
    const agent = await makeAgent(workspace, 'caller');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Outreach', agentId: agent.id, status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876500001' },
    });
    const link = await prisma.campaignContact.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        status: 'QUEUED',
        claimedAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    await campaignCleanupQueue.add('cleanup', { kind: 'cleanup-tick' });
    worker = createCampaignCleanupWorker();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cleanup job never settled')), 10_000);
      worker!.on('completed', () => {
        clearTimeout(timer);
        resolve();
      });
      worker!.on('failed', (_job, err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.status).toBe('PENDING');
    expect(row.claimedAt).toBeNull();
  });
});
