import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

describe('requireAuth', () => {
  it('rejects an unauthenticated request with 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('provisions an Account on the first authenticated request', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('X-Test-Clerk-User', 'user_alice|alice@ezo.test');

    expect(res.status).toBe(200);

    const account = await prisma.account.findUnique({ where: { clerkUserId: 'user_alice' } });
    expect(account).not.toBeNull();
    expect(account?.email).toBe('alice@ezo.test');
  });

  it('reuses the existing Account on later requests', async () => {
    await request(app).get('/api/me').set('X-Test-Clerk-User', 'user_alice|alice@ezo.test');
    await request(app).get('/api/me').set('X-Test-Clerk-User', 'user_alice|alice@ezo.test');

    expect(await prisma.account.count()).toBe(1);
  });

  it('rejects a malformed test identity header', async () => {
    const res = await request(app).get('/api/me').set('X-Test-Clerk-User', 'no-email-here');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
