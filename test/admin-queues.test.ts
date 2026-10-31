import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const { closeQueues, campaignDispatchQueue } = await import('../src/lib/queue/queues.js');
const { closeQueueConnection } = await import('../src/lib/queue/connection.js');

const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

afterAll(async () => {
  await closeQueues();
  await closeQueueConnection();
});

describe('GET /api/admin/queues', () => {
  it('is staff-only', async () => {
    const res = await request(app).get('/api/admin/queues');

    expect(res.status).toBe(401);
  });

  it('reports counts for every queue', async () => {
    const res = await request(app).get('/api/admin/queues').set(...staff());

    expect(res.status).toBe(200);

    const names = res.body.data.queues.map((queue: { name: string }) => queue.name).sort();

    expect(names).toEqual([
      'call-placement',
      'campaign-cleanup',
      'campaign-dispatch',
      'maintenance',
      'webhook-processing',
    ]);

    for (const queue of res.body.data.queues) {
      expect(queue.counts).toMatchObject({
        waiting: expect.any(Number),
        active: expect.any(Number),
        failed: expect.any(Number),
        delayed: expect.any(Number),
      });
    }
  });

  it('reports a count that actually moves when a job is enqueued', async () => {
    // `expect.any(Number)` above cannot fail — an endpoint reporting zeroes
    // forever would pass it. One real job, one count observed moving, proves
    // the numbers come from the queues rather than from a shape.
    await campaignDispatchQueue.obliterate({ force: true });
    await campaignDispatchQueue.add('probe', { kind: 'dispatch-tick' });

    try {
      const res = await request(app).get('/api/admin/queues').set(...staff());
      const dispatch = res.body.data.queues.find(
        (queue: { name: string }) => queue.name === 'campaign-dispatch',
      );

      expect(dispatch.counts.waiting).toBe(1);
    } finally {
      await campaignDispatchQueue.obliterate({ force: true });
    }
  });

  it('says whether this process is running the workers at all', async () => {
    const res = await request(app).get('/api/admin/queues').set(...staff());

    // Under vitest this is a hard false, and that is the point of reporting
    // it: a page of zeroes means nothing until you know whether anything was
    // supposed to be consuming.
    expect(res.body.data.workersEnabled).toBe(false);
  });
});
