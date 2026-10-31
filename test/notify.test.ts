import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { notify } from '../src/lib/notify.js';

/**
 * The emitter's contract is mostly about what it refuses to do. A notification
 * is a side effect of an action that has *already succeeded*, so the one thing
 * it must never do is put a failure back into the caller's request path.
 */
describe('notify', () => {
  beforeEach(truncateAll);
  afterEach(() => vi.restoreAllMocks());

  it('records the event', async () => {
    const workspace = await makeWorkspace(await makeAccount('alice'), 'A Co');

    await notify(
      workspace.id,
      'ALL_MEMBERS',
      'campaign.started',
      'Winter outreach was started',
      'Alice started this campaign.',
      '/campaigns/c1',
    );

    const rows = await prisma.notification.findMany({ where: { workspaceId: workspace.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'ALL_MEMBERS',
      type: 'campaign.started',
      title: 'Winter outreach was started',
      body: 'Alice started this campaign.',
      href: '/campaigns/c1',
    });
  });

  it('stores a null href when the event has nowhere to go', async () => {
    const workspace = await makeWorkspace(await makeAccount('alice'), 'A Co');

    await notify(workspace.id, 'ADMINS_ONLY', 'member.left', 'Bob left', 'Bob left the workspace.');

    const row = await prisma.notification.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    expect(row.href).toBeNull();
  });

  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a backslash-relative URL', '/\\evil.example/steal'],
    ['a bare scheme', 'javascript:alert(1)'],
  ])('drops %s rather than storing it as an href', async (_label, href) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const workspace = await makeWorkspace(await makeAccount('alice'), 'A Co');

    await notify(workspace.id, 'ALL_MEMBERS', 'test.event', 'Title', 'Body.', href);

    // The row still lands — a link that cannot be trusted degrades the
    // notification, it does not cancel the event it records.
    const row = await prisma.notification.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    expect(row.href).toBeNull();
    expect(logged).toHaveBeenCalled();
  });

  it('keeps an in-app path', async () => {
    const workspace = await makeWorkspace(await makeAccount('alice'), 'A Co');

    await notify(workspace.id, 'ALL_MEMBERS', 'test.event', 'Title', 'Body.', '/settings/members');

    const row = await prisma.notification.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    expect(row.href).toBe('/settings/members');
  });

  it('resolves rather than rejecting when the insert fails', async () => {
    const workspace = await makeWorkspace(await makeAccount('alice'), 'A Co');
    vi.spyOn(prisma.notification, 'create').mockRejectedValue(new Error('db down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notify(workspace.id, 'ALL_MEMBERS', 'campaign.started', 'T', 'B'),
    ).resolves.toBeUndefined();

    // Dropped, but not silently: nothing upstream can act on this, so the log
    // is the only place the failure can still be noticed.
    expect(logged).toHaveBeenCalled();
  });

  it('resolves when the workspace does not exist, and writes nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notify('ws_does_not_exist', 'ALL_MEMBERS', 'campaign.started', 'T', 'B'),
    ).resolves.toBeUndefined();

    await expect(prisma.notification.count()).resolves.toBe(0);
    expect(logged).toHaveBeenCalled();
  });

  it('does not throw synchronously', () => {
    // A caller writes `void notify(...)`. If construction could throw, that
    // `void` would not protect the request either.
    expect(() => void notify('ws_missing', 'ALL_MEMBERS', 't', 'T', 'B')).not.toThrow();
  });
});
