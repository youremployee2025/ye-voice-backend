import { prisma } from '../lib/prisma.js';

/** One workspace's agents, split by what each direction costs upstream. */
export interface AgentDirectionRow {
  /** Null is the unassigned pool — agents no workspace holds. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** One persona, no face yet. The face is built the first time an inbound
   *  campaign starts against the agent. */
  uniNoFace: number;
  /** One persona with a face: every save writes both sides. */
  uniWithFace: number;
  /** Two personas, edited independently. Nothing is mirrored. */
  bi: number;
  /** Of `bi`, the ones with no face — see the report's own note. */
  biNoFace: number;
}

export interface AgentDirectionReport {
  rows: AgentDirectionRow[];
  totals: Omit<AgentDirectionRow, 'workspaceId' | 'workspaceName'>;
}

/**
 * The post-deploy check for the uni/bi enum move.
 *
 * It answers the one question the migration cannot: whether the rollout's
 * reading of the world matches the mirror's. `BI` should be exactly the
 * agents that were `BOTH`, and the `UNI` split says how many of the rest
 * already carry a face — the population whose saves now write both sides,
 * which is the behaviour change an operator would want to see the size of.
 *
 * Read-only, and one grouped statement: the mirror is one row per agent
 * somebody created, so this is cheap, but a report is not a reason to walk a
 * table per workspace.
 */
export async function reportAgentDirections(): Promise<AgentDirectionReport> {
  const grouped = await prisma.agent.groupBy({
    by: ['workspaceId', 'direction', 'inboundEnabled'],
    _count: { _all: true },
  });

  const names = new Map(
    (
      await prisma.workspace.findMany({
        where: { id: { in: grouped.map((g) => g.workspaceId).filter((id): id is string => !!id) } },
        select: { id: true, name: true },
      })
    ).map((w) => [w.id, w.name]),
  );

  const rows = new Map<string, AgentDirectionRow>();
  const totals = { uniNoFace: 0, uniWithFace: 0, bi: 0, biNoFace: 0 };

  for (const group of grouped) {
    // `null` is a real key here — the unassigned pool — and a Map keyed on the
    // raw value would collide with nothing, but the empty string cannot be a
    // cuid, so it is the safe stand-in for grouping.
    const key = group.workspaceId ?? '';
    const row = rows.get(key) ?? {
      workspaceId: group.workspaceId,
      workspaceName: group.workspaceId ? (names.get(group.workspaceId) ?? null) : null,
      uniNoFace: 0,
      uniWithFace: 0,
      bi: 0,
      biNoFace: 0,
    };
    const count = group._count._all;

    if (group.direction === 'UNI') {
      if (group.inboundEnabled) {
        row.uniWithFace += count;
        totals.uniWithFace += count;
      } else {
        row.uniNoFace += count;
        totals.uniNoFace += count;
      }
    } else {
      row.bi += count;
      totals.bi += count;
      if (!group.inboundEnabled) {
        row.biNoFace += count;
        totals.biNoFace += count;
      }
    }

    rows.set(key, row);
  }

  // Named workspaces first, alphabetically, with the pool last: the pool is
  // not a customer and reads as a footnote rather than as a row somebody owns.
  const ordered = [...rows.values()].sort((a, b) => {
    if (a.workspaceId === null) return 1;
    if (b.workspaceId === null) return -1;
    return (a.workspaceName ?? '').localeCompare(b.workspaceName ?? '');
  });

  return { rows: ordered, totals };
}
