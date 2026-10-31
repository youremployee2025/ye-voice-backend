import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import {
  claimResource,
  filterMapped,
  reassignResource,
  renameResource,
  resourceInWorkspace,
  unmapResource,
} from '../src/lib/workspaceResource.js';

/** The staff mapping call, used here to arrange fixtures — it is the one that
 *  may put a resource anywhere. */
const mapResource = reassignResource;
import { ApiError } from '../src/lib/errors.js';

/**
 * The mapping is what makes a shared partner-level pool safe to expose. These
 * tests are the isolation the rest of the slice leans on.
 */

beforeEach(async () => {
  await truncateAll();
});

describe('resourceInWorkspace', () => {
  it('returns a resource mapped to the caller', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('DICTIONARY', 'dict-1', workspace.id, 'Clinical terms');

    const row = await resourceInWorkspace('DICTIONARY', 'dict-1', workspace.id);

    expect(row.externalId).toBe('dict-1');
    expect(row.name).toBe('Clinical terms');
  });

  it('refuses an id mapped to another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await mapResource('DICTIONARY', 'dict-1', theirs.id);

    await expect(resourceInWorkspace('DICTIONARY', 'dict-1', mine.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses an unmapped id exactly as it refuses a foreign one', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await mapResource('DICTIONARY', 'mapped-elsewhere', theirs.id);

    const foreign = await resourceInWorkspace('DICTIONARY', 'mapped-elsewhere', mine.id).catch(
      (err: ApiError) => err,
    );
    const unknown = await resourceInWorkspace('DICTIONARY', 'never-existed', mine.id).catch(
      (err: ApiError) => err,
    );

    // Identical, deliberately: a different message would confirm which ids
    // name something real elsewhere on the platform.
    expect((foreign as ApiError).message).toBe((unknown as ApiError).message);
    expect((foreign as ApiError).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('does not confuse two kinds that share an id', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('DICTIONARY', 'shared-id', workspace.id);

    await expect(resourceInWorkspace('FUNCTION', 'shared-id', workspace.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('claimResource', () => {
  it('is idempotent, so a retried create does not violate the unique index', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    await claimResource('FUNCTION', 'fn-1', workspace.id, 'lookup_order');
    await claimResource('FUNCTION', 'fn-1', workspace.id, 'lookup_order_v2');

    const rows = await prisma.workspaceResource.findMany({ where: { externalId: 'fn-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('lookup_order_v2');
  });

  /**
   * The customer-facing call reaches here holding an id upstream just returned
   * from a *create*. A row already naming another workspace therefore means
   * upstream handed back something that was not new — which is what a platform
   * that de-duplicates on create does. Moving the mapping there would transfer
   * another customer's resource to the caller silently, with nothing to notice
   * it, so it refuses instead.
   */
  it('refuses to take over a resource another workspace already owns', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');

    await reassignResource('DOCUMENT', 'doc-1', theirs.id, 'Their handbook');

    const error = await claimResource('DOCUMENT', 'doc-1', mine.id, 'Mine').catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);

    const row = await prisma.workspaceResource.findFirst({ where: { externalId: 'doc-1' } });
    expect(row?.workspaceId).toBe(theirs.id);
    expect(row?.name).toBe('Their handbook');
  });
});

describe('renameResource', () => {
  it('relabels a resource this workspace owns', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await claimResource('DICTIONARY', 'dict-9', workspace.id, 'Old');

    await renameResource('DICTIONARY', 'dict-9', workspace.id, 'New');

    const row = await prisma.workspaceResource.findFirst({ where: { externalId: 'dict-9' } });
    expect(row?.name).toBe('New');
  });

  it('cannot touch a resource belonging to another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await reassignResource('DICTIONARY', 'dict-9', theirs.id, 'Theirs');

    await renameResource('DICTIONARY', 'dict-9', mine.id, 'Mine');

    const row = await prisma.workspaceResource.findFirst({ where: { externalId: 'dict-9' } });
    expect(row?.workspaceId).toBe(theirs.id);
    expect(row?.name).toBe('Theirs');
  });
});

describe('reassignResource', () => {
  it('moves a mapping rather than creating a second one', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');

    await mapResource('CONNECTION', 'conn-1', mine.id);
    await mapResource('CONNECTION', 'conn-1', theirs.id);

    const rows = await prisma.workspaceResource.findMany({ where: { externalId: 'conn-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(theirs.id);
  });
});

describe('unmapResource', () => {
  it('removes only the named mapping', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('FUNCTION', 'fn-1', workspace.id);
    await mapResource('FUNCTION', 'fn-2', workspace.id);

    await unmapResource('FUNCTION', 'fn-1');

    const rows = await prisma.workspaceResource.findMany();
    expect(rows.map((row) => row.externalId)).toEqual(['fn-2']);
  });
});

describe('filterMapped', () => {
  it('keeps only the rows this workspace owns, in the order given', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await mapResource('DICTIONARY', 'a', mine.id);
    await mapResource('DICTIONARY', 'c', mine.id);
    await mapResource('DICTIONARY', 'b', theirs.id);

    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const visible = await filterMapped(rows, 'DICTIONARY', mine.id, (row) => row.id);

    expect(visible).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('drops a row whose id cannot be read rather than showing it', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('DICTIONARY', 'a', workspace.id);

    const visible = await filterMapped(
      [{ id: 'a' }, { id: null }],
      'DICTIONARY',
      workspace.id,
      (row) => row.id,
    );

    expect(visible).toEqual([{ id: 'a' }]);
  });

  it('makes one query regardless of how many rows it is given', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await mapResource('DICTIONARY', 'a', workspace.id);

    // A per-row lookup would turn a 100-item list into 100 round trips.
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: `id-${index}` }));
    const visible = await filterMapped([...rows, { id: 'a' }], 'DICTIONARY', workspace.id, (row) => row.id);

    expect(visible).toEqual([{ id: 'a' }]);
  });

  it('returns nothing for an empty input without querying at all', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    expect(await filterMapped([], 'DICTIONARY', workspace.id, () => null)).toEqual([]);
  });
});
