import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  listInboundRoutePolicies: vi.fn(),
  createInboundRoutePolicy: vi.fn(),
  updateInboundRoutePolicy: vi.fn(),
  // Reached by the app's module graph; unused here.
  getConcurrency: vi.fn(),
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getCall: vi.fn(),
}));

process.env.ADMIN_STAFF_TOKEN = 'staff-token-for-inbound-policy-tests';
process.env.INBOUND_ROUTE_POLICY_SECRET = 'i'.repeat(48);

const { listInboundRoutePolicies, createInboundRoutePolicy, updateInboundRoutePolicy } = await import(
  '../src/adapter/vocobase.js'
);
const { createApp } = await import('../src/app.js');
const { truncateAll } = await import('./setup.js');

const app = createApp();
const STAFF = ['X-Admin-Token', process.env.ADMIN_STAFF_TOKEN!] as const;
const URL_ = 'https://api.ezo.example/webhooks/vocobase/inbound-route';

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

describe('admin inbound route policy', () => {
  it('creates the account-wide policy when none exists', async () => {
    vi.mocked(listInboundRoutePolicies).mockResolvedValue({ policies: [] });
    vi.mocked(createInboundRoutePolicy).mockResolvedValue({
      id: 'pol_1',
      scope: 'PARTNER',
      name: 'EZO inbound route policy',
      webhook_url: URL_,
      failure_action: 'ANSWER_WITH_AI',
      allowed_actions: ['ANSWER_WITH_AI'],
    });

    const res = await request(app)
      .put('/api/admin/inbound-route-policy')
      .set(...STAFF)
      .send({ url: URL_ });

    expect(res.status).toBe(201);
    const sent = vi.mocked(createInboundRoutePolicy).mock.calls[0][0];
    expect(sent).toMatchObject({
      scope: 'PARTNER',
      webhook_url: URL_,
      timeout_ms: 2000,
      failure_action: 'ANSWER_WITH_AI',
      allowed_actions: ['ANSWER_WITH_AI'],
      webhook_secret: 'i'.repeat(48),
    });
    // The secret is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain('i'.repeat(48));
  });

  it('updates the existing policy in place', async () => {
    vi.mocked(listInboundRoutePolicies).mockResolvedValue({
      policies: [{ id: 'pol_1', scope: 'PARTNER', name: 'EZO inbound route policy', webhook_url: 'https://old' }],
    });
    vi.mocked(updateInboundRoutePolicy).mockResolvedValue({ id: 'pol_1', webhook_url: URL_ });

    const res = await request(app)
      .put('/api/admin/inbound-route-policy')
      .set(...STAFF)
      .send({ url: URL_ });

    expect(res.status).toBe(200);
    expect(vi.mocked(updateInboundRoutePolicy)).toHaveBeenCalledWith('pol_1', expect.objectContaining({ webhook_url: URL_ }));
    expect(vi.mocked(createInboundRoutePolicy)).not.toHaveBeenCalled();
  });

  it("does not adopt another integrator's PARTNER-scope policy as ours", async () => {
    // The partner account is shared. A PARTNER-scope policy that is not ours by
    // name must be left alone — overwriting its URL and secret would hijack
    // somebody else's inbound routing.
    vi.mocked(listInboundRoutePolicies).mockResolvedValue({
      policies: [{ id: 'pol_theirs', scope: 'PARTNER', name: 'Some other CRM', webhook_url: 'https://theirs' }],
    });
    vi.mocked(createInboundRoutePolicy).mockResolvedValue({ id: 'pol_ours', scope: 'PARTNER', name: 'EZO inbound route policy', webhook_url: URL_ });

    const res = await request(app)
      .put('/api/admin/inbound-route-policy')
      .set(...STAFF)
      .send({ url: URL_ });

    expect(res.status).toBe(201);
    expect(vi.mocked(updateInboundRoutePolicy)).not.toHaveBeenCalled();
    expect(vi.mocked(createInboundRoutePolicy)).toHaveBeenCalled();
  });

  it('rejects a non-https url', async () => {
    const res = await request(app)
      .put('/api/admin/inbound-route-policy')
      .set(...STAFF)
      .send({ url: 'http://insecure.example/x' });
    expect(res.status).toBe(400);
  });

  it('requires the staff token', async () => {
    const res = await request(app).put('/api/admin/inbound-route-policy').send({ url: URL_ });
    expect(res.status).toBe(401);
  });
});
