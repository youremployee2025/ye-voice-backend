import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
}));

// Configured before the app reads it, so both caps are reachable in a test
// without firing hundreds of requests.
process.env.ADMIN_STAFF_TOKEN = 'staff-token-for-rate-limit-tests';
process.env.ADMIN_RATE_LIMIT_MAX = '6';
process.env.ADMIN_AUTH_FAILURE_MAX = '3';

const { createApp } = await import('../src/app.js');

describe('rate limiting on admin routes', () => {
  it('caps how fast a caller can try staff tokens', async () => {
    const app = createApp();

    // Wrong token every time: this is the shape of a guessing attempt.
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/api/admin/agents').set('X-Admin-Token', `guess-${i}`);
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).get('/api/admin/agents').set('X-Admin-Token', 'guess-3');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('turns away a valid token too, once the general budget is spent', async () => {
    // Spends the window itself rather than inheriting the previous case's.
    // Leaning on that made this pass only in file order: run alone it returned
    // 401, so the assertion it looks like it makes was never actually made.
    //
    // Spent with ACCEPTED requests, so it is the general cap being exhausted
    // and not the failure budget — the point being that the limiter runs ahead
    // of the guard, and a correct token is no way past it.
    const fresh = createApp();
    for (let i = 0; i < 6; i += 1) {
      const res = await request(fresh)
        .get('/api/admin/agents')
        .set('X-Admin-Token', 'staff-token-for-rate-limit-tests');
      expect(res.status).not.toBe(429);
    }

    const res = await request(fresh)
      .get('/api/admin/agents')
      .set('X-Admin-Token', 'staff-token-for-rate-limit-tests');

    expect(res.status).toBe(429);
  });

  // The console renders on its own server, so every operator's page loads
  // arrive from one address and share one key. A budget sized for guessing
  // alone was a budget the console spent on itself.
  it('does not spend the guessing budget on requests that are accepted', async () => {
    const fresh = createApp();

    // More successful reads than the failure budget allows failures, and none
    // of them may count against it.
    for (let i = 0; i < 5; i += 1) {
      const res = await request(fresh)
        .get('/api/admin/agents')
        .set('X-Admin-Token', 'staff-token-for-rate-limit-tests');
      expect(res.status).toBe(200);
    }
  });

  // The limiter is mounted on the prefix, not on one router. This is the
  // assertion that keeps it that way: a staff endpoint added later inherits
  // the cap, and a listing that answered 200 here would mean it had not.
  it('caps every staff router under the prefix, not just the first', async () => {
    const fresh = createApp();
    for (let i = 0; i < 3; i += 1) {
      await request(fresh).get('/api/admin/agents').set('X-Admin-Token', `guess-${i}`);
    }

    const res = await request(fresh)
      .get('/api/admin/accounts')
      .set('X-Admin-Token', 'staff-token-for-rate-limit-tests');

    expect(res.status).toBe(429);
  });
});
