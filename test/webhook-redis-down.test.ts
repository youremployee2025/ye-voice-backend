import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * A delivery that cannot be enqueued must be *refused*, not held.
 *
 * The handler answers 200 only once the job is durable in Redis — that is the
 * design. What that must never become is a request that neither succeeds nor
 * fails: the shared queue connection retries forever (BullMQ requires
 * `maxRetriesPerRequest: null`), so with Redis unreachable a bare
 * `queue.add()` promise can simply never settle, and every delivery then
 * holds a socket and an Express handler until the sender times out. The
 * platform's retry policy — four more deliveries over eight hours — fires on
 * a non-2xx; a timeout is the one shape of failure it may not count. So the
 * enqueue is bounded, and both shapes of failure answer 503.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const enqueue = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('../src/lib/queue/queues.js', () => ({
  webhookProcessingQueue: { add: enqueue.add },
}));

const SECRET = 'w'.repeat(48);
process.env.VOCOBASE_WEBHOOK_SECRET = SECRET;

const { createApp } = await import('../src/app.js');
const { signWebhook } = await import('../src/lib/webhookSignature.js');

const app = createApp();

async function deliver() {
  const body = JSON.stringify({
    event: 'session.completed',
    timestamp: new Date().toISOString(),
    data: { session_id: 's_down', duration_seconds: 10, call: { call_id: 'c_down' } },
  });
  const timestamp = new Date().toISOString();

  return request(app)
    .post('/webhooks/vocobase')
    .set('Content-Type', 'application/json')
    .set('X-Webhook-Timestamp', timestamp)
    .set('X-Webhook-Signature', signWebhook(body, timestamp, SECRET))
    .send(body);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  enqueue.add.mockReset();
});

describe('a delivery while Redis is unreachable', () => {
  it('answers 503 when the enqueue fails', async () => {
    enqueue.add.mockRejectedValue(new Error('Connection is closed.'));

    const res = await deliver();

    expect(res.status).toBe(503);
  });

  it('answers 503 when the enqueue never settles, instead of hanging', async () => {
    // The offline-queue shape: a promise that neither resolves nor rejects.
    enqueue.add.mockImplementation(() => new Promise(() => {}));

    const res = await deliver();

    expect(res.status).toBe(503);
  }, 15_000);
});
