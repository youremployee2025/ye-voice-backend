import { prisma } from './prisma.js';

/** Fixed palette so a workspace's colour is stable and reproducible from its slug. */
const PALETTE = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
] as const;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return base || 'workspace';
}

export function colorForSlug(slug: string): string {
  let hash = 0;
  for (const char of slug) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

/**
 * The narrowest view of a Prisma client this needs.
 *
 * A transaction client and the global one are different types, and typing the
 * parameter as `PrismaClient` would refuse the very argument the parameter
 * exists for.
 */
type WorkspaceReader = {
  workspace: { findMany: typeof prisma.workspace.findMany };
};

/**
 * Returns `base`, or `base-2`, `base-3`… if taken.
 *
 * `client` lets a caller read through its own transaction. That matters when
 * the slug is chosen and the workspace written in one transaction: through the
 * global client the read runs on a different connection and a different
 * snapshot, so a workspace this transaction just created is invisible and the
 * next call hands back the same slug — which then fails the unique index as a
 * 500 rather than as a sentence.
 */
export async function uniqueSlug(
  name: string,
  client: WorkspaceReader = prisma,
): Promise<string> {
  const base = slugify(name);

  const taken = await client.workspace.findMany({
    where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
    select: { slug: true },
  });

  if (!taken.some((w) => w.slug === base)) return base;

  const used = new Set(taken.map((w) => w.slug));
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
