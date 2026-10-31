import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { colorForSlug, slugify, uniqueSlug } from '../src/lib/slug.js';
import { makeAccount } from './helpers.js';

beforeEach(async () => {
  await truncateAll();
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Moomba Foods')).toBe('moomba-foods');
  });

  it('falls back to a word rather than an empty slug', () => {
    expect(slugify('!!!')).toBe('workspace');
  });
});

describe('uniqueSlug', () => {
  it('suffixes a slug that is taken', async () => {
    const owner = await makeAccount('alice');
    await prisma.workspace.create({
      data: {
        name: 'Moomba Foods',
        slug: 'moomba-foods',
        color: colorForSlug('moomba-foods'),
        ownerAccountId: owner.id,
      },
    });

    expect(await uniqueSlug('Moomba Foods')).toBe('moomba-foods-2');
  });

  /**
   * The reason this parameter exists.
   *
   * Onboarding picks the slug and writes the workspace in one transaction. Read
   * through the global client, the read runs on a different connection and a
   * different snapshot from the write — so a workspace this very transaction
   * created is invisible to the next call, and both land on the same slug. The
   * second then fails the unique index with a foreign-key-shaped 500 instead of
   * a sentence.
   */
  it('sees a workspace created earlier in the caller’s own transaction', async () => {
    const owner = await makeAccount('alice');

    const slugs = await prisma.$transaction(async (tx) => {
      const first = await uniqueSlug('Moomba Foods', tx);
      await tx.workspace.create({
        data: {
          name: 'Moomba Foods',
          slug: first,
          color: colorForSlug(first),
          ownerAccountId: owner.id,
        },
      });

      const second = await uniqueSlug('Moomba Foods', tx);
      return [first, second];
    });

    expect(slugs[0]).toBe('moomba-foods');
    expect(slugs[1]).toBe('moomba-foods-2');
  });
});
