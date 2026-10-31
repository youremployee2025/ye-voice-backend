import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  getPartnerConfig: vi.fn(),
  listWebhookEndpoints: vi.fn(),
  createWebhookEndpoint: vi.fn(),
  updateWebhookEndpoint: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  // The rest of the app's module graph reaches these; nothing here calls them.
  getConcurrency: vi.fn(),
  voicelinkCallReady: vi.fn(),
  startCall: vi.fn(),
  getCall: vi.fn(),
}));

process.env.ADMIN_STAFF_TOKEN = 'staff-token-for-webhook-config-tests';

const {
  getPartnerConfig,
  listWebhookEndpoints,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  rotateWebhookSecret,
} = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');

const mockedConfig = vi.mocked(getPartnerConfig);
const mockedList = vi.mocked(listWebhookEndpoints);
const mockedCreate = vi.mocked(createWebhookEndpoint);
const mockedUpdate = vi.mocked(updateWebhookEndpoint);
const mockedRotate = vi.mocked(rotateWebhookSecret);

const app = createApp();
const STAFF = ['X-Admin-Token', process.env.ADMIN_STAFF_TOKEN!] as const;

const SECRET = 'whsec_ThisIsTheOnlyTimeAnybodySeesIt0123456789';
const URL_ = 'https://api.ezo.example/webhooks/vocobase';

const ours = {
  id: 'we_ezo',
  label: 'ezo-backend',
  url: URL_,
  enabled: true,
  agent_id: null,
  agent_name: null,
  events: ['session.completed', 'call.status.updated'],
  last_delivery_at: '2026-08-28T09:00:00.000Z',
  last_delivery_status: 200,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
};

/** Somebody else's endpoint on the same shared partner account. */
const theirs = { ...ours, id: 'we_other', label: 'partner-crm', url: 'https://crm.example/hook' };

/** Everything this router could conceivably say, in one string. */
const said = (res: { body: unknown; headers: unknown }, logged: unknown[]) =>
  JSON.stringify({ body: res.body, headers: res.headers, logged });

let logged: unknown[];

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  logged = [];

  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
  }
});

afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

describe('the staff guard', () => {
  it('refuses every route without a staff token', async () => {
    const calls = [
      request(app).get('/api/admin/webhook-config'),
      request(app).put('/api/admin/webhook-config').send({ url: URL_ }),
      request(app).post('/api/admin/webhook-config/rotate'),
    ];

    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }

    // Guarded by construction: nothing reached the partner account either.
    expect(mockedConfig).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/webhook-config', () => {
  it('reports the endpoint this backend receives on, and masks the secret', async () => {
    mockedConfig.mockResolvedValue({
      webhook: { configured: true, url: URL_, secret: '****' },
      webhooks: [theirs, ours],
    });

    const res = await request(app).get('/api/admin/webhook-config').set(...STAFF);

    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(true);
    expect(res.body.data.endpoint).toMatchObject({ id: 'we_ezo', url: URL_, enabled: true });
    expect(res.body.data.endpoint.events).toEqual(['session.completed', 'call.status.updated']);
    // Our own placeholder, not upstream's — a mask this service prints is a
    // mask that cannot stop being a mask when upstream changes its mind.
    expect(res.body.data.secret).toBe('****');
  });

  /**
   * The partner account is shared with every other integrator, exactly as the
   * dictionaries and functions pools are. Their endpoint URLs are addresses on
   * their own networks and are none of YE staff's business.
   */
  it('does not list another integrator’s endpoints', async () => {
    mockedConfig.mockResolvedValue({ webhook: null, webhooks: [theirs, ours] });

    const res = await request(app).get('/api/admin/webhook-config').set(...STAFF);

    expect(said(res, logged)).not.toContain('crm.example');
    expect(said(res, logged)).not.toContain('partner-crm');
  });

  it('says plainly when nothing is registered yet', async () => {
    mockedConfig.mockResolvedValue({ webhook: null, webhooks: [theirs] });

    const res = await request(app).get('/api/admin/webhook-config').set(...STAFF);

    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.endpoint).toBeNull();
    expect(res.body.data.secret).toBeNull();
  });
});

describe('PUT /api/admin/webhook-config', () => {
  it('registers the endpoint and shows the secret once', async () => {
    mockedList.mockResolvedValue({ endpoints: [theirs] });
    mockedCreate.mockResolvedValue({ ...ours, secret: SECRET, message: 'Save this secret.' });

    const res = await request(app)
      .put('/api/admin/webhook-config')
      .set(...STAFF)
      .send({ url: URL_ });

    expect(res.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'ezo-backend',
        url: URL_,
        // The two events this service actually handles. An empty allowlist
        // upstream means *every* event, including ones added later.
        events: ['session.completed', 'call.status.updated'],
      }),
    );

    expect(res.body.data.secret).toBe(SECRET);
    // Not just handed over — said what to do with it, since there is no second
    // chance to read it.
    expect(res.body.data.note).toContain('VOCOBASE_WEBHOOK_SECRET');
  });

  it('updates the endpoint it already registered, and mints no new secret', async () => {
    mockedList.mockResolvedValue({ endpoints: [theirs, ours] });
    mockedUpdate.mockResolvedValue({ ...ours, url: 'https://api.ezo.example/hooks/v2' });

    const res = await request(app)
      .put('/api/admin/webhook-config')
      .set(...STAFF)
      .send({ url: 'https://api.ezo.example/hooks/v2', events: ['session.completed'] });

    expect(res.status).toBe(200);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).toHaveBeenCalledWith(
      'we_ezo',
      expect.objectContaining({ url: 'https://api.ezo.example/hooks/v2', events: ['session.completed'] }),
    );

    // Unchanged, and still unreadable. A null here is the difference between
    // "we did not rotate" and "your secret is empty".
    expect(res.body.data.secret).toBeNull();
  });

  it('refuses a URL that is not absolute https, without spending an upstream call', async () => {
    mockedList.mockResolvedValue({ endpoints: [] });

    for (const url of ['http://api.ezo.example/hook', '/hook', 'not a url']) {
      const res = await request(app)
        .put('/api/admin/webhook-config')
        .set(...STAFF)
        .send({ url });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('requires a URL rather than quietly leaving the old one', async () => {
    const res = await request(app)
      .put('/api/admin/webhook-config')
      .set(...STAFF)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/webhook-config/rotate', () => {
  it('returns the new secret once, with the runbook for it', async () => {
    mockedList.mockResolvedValue({ endpoints: [theirs, ours] });
    mockedRotate.mockResolvedValue({
      id: 'we_ezo',
      label: 'ezo-backend',
      secret: SECRET,
      message: 'Save this secret.',
    });

    const res = await request(app).post('/api/admin/webhook-config/rotate').set(...STAFF);

    expect(res.status).toBe(200);
    expect(mockedRotate).toHaveBeenCalledWith('we_ezo');
    expect(res.body.data.secret).toBe(SECRET);
    expect(res.body.data.note).toContain('VOCOBASE_WEBHOOK_SECRET');
    // The zero-drop half of the runbook, or a rotation silently drops every
    // delivery already signed with the old value.
    expect(res.body.data.note).toContain('VOCOBASE_WEBHOOK_SECRET_PREVIOUS');
  });

  it('refuses to rotate an endpoint that was never registered', async () => {
    mockedList.mockResolvedValue({ endpoints: [theirs] });

    const res = await request(app).post('/api/admin/webhook-config/rotate').set(...STAFF);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WEBHOOK_ENDPOINT_NOT_CONFIGURED');
    expect(mockedRotate).not.toHaveBeenCalled();
  });
});

/**
 * The one property this whole surface exists to preserve.
 *
 * A webhook secret signs the deliveries that close call attempts and charge
 * credits. Anything holding one can forge a completion. It is shown once, in
 * one response body, to a staff caller who asked for it — and it must reach no
 * log sink, no notification and no column, because every one of those outlives
 * the request and is read by more people than the operator who rotated it.
 */
describe('where the secret goes, and where it does not', () => {
  const rotate = async () => {
    mockedList.mockResolvedValue({ endpoints: [ours] });
    mockedRotate.mockResolvedValue({ id: 'we_ezo', label: 'ezo-backend', secret: SECRET });

    return request(app).post('/api/admin/webhook-config/rotate').set(...STAFF);
  };

  it('never reaches a log line', async () => {
    const res = await rotate();

    expect(res.body.data.secret).toBe(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain('whsec_');
  });

  it('is never written to the database', async () => {
    await rotate();

    // Nothing on this surface writes at all. Asserted against the two tables a
    // staff action would plausibly land in rather than trusting the absence.
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('appears in exactly one response, and only when it was just minted', async () => {
    await rotate();

    mockedConfig.mockResolvedValue({ webhook: { configured: true, url: URL_, secret: '****' }, webhooks: [ours] });
    const read = await request(app).get('/api/admin/webhook-config').set(...STAFF);

    expect(said(read, logged)).not.toContain(SECRET);
    expect(read.body.data.secret).toBe('****');
  });
});
