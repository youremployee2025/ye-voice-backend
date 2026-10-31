import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetPgTimeZoneCache, resolvePgTimeZone } from '../src/lib/pgTimeZone.js';

/**
 * The zone resolver's own tests, which it did not have.
 *
 * It was exercised only through `leadActivity`, so the two properties it is
 * built out of — the catalogue is the authority for what EXISTS and `Intl`
 * only for what is equivalent to what, and the read is cached — were asserted
 * by nothing. The cache is the one that bites: a rejected build left behind a
 * rejected promise that every later call re-awaited, so one connection blip
 * 500d the Activity tab for the lifetime of the process.
 */

beforeEach(() => {
  resetPgTimeZoneCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPgTimeZoneCache();
});

describe('resolving a zone against the catalogue', () => {
  it('answers an exact Postgres name with itself', async () => {
    expect(await resolvePgTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('answers a legacy alias with the name Postgres carries', async () => {
    // The bug that shipped: Chrome in India reports `Asia/Calcutta`, `Intl`
    // accepts it, and this Postgres does not carry it at all.
    expect(await resolvePgTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
  });

  it('refuses a zone that is no zone', async () => {
    expect(await resolvePgTimeZone('Mars/Olympus')).toBeNull();
  });
});

describe('the catalogue cache', () => {
  it('reads the catalogue once across many calls', async () => {
    const read = vi.spyOn(prisma, '$queryRaw');

    await resolvePgTimeZone('UTC');
    await resolvePgTimeZone('Asia/Kolkata');
    await resolvePgTimeZone('Asia/Calcutta');

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight read between concurrent cold callers', async () => {
    const read = vi.spyOn(prisma, '$queryRaw');

    const [a, b, c] = await Promise.all([
      resolvePgTimeZone('UTC'),
      resolvePgTimeZone('Asia/Kolkata'),
      resolvePgTimeZone('America/New_York'),
    ]);

    expect(read).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(['UTC', 'Asia/Kolkata', 'America/New_York']);
  });

  it('retries the catalogue after a failed read, rather than latching it', async () => {
    const read = vi
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('P1001: database unreachable'));

    // The blip. One request fails, which is correct and expected.
    await expect(resolvePgTimeZone('Asia/Kolkata')).rejects.toThrow('database unreachable');

    // And the next one works. Without this the rejected promise stayed in the
    // cache slot, every later call re-awaited it, and `/leads/activity` 500d
    // for the life of the process — including for requests naming no zone at
    // all, since the resolver runs unconditionally for the UTC default.
    read.mockRestore();
    expect(await resolvePgTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });
});
