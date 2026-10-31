import { filterMapped } from './workspaceResource.js';
import { connectionIdOf } from './serialize.js';

/**
 * Which of these upstream tools rows this workspace owns.
 *
 * One mapping lookup for the whole list, then an in-memory predicate — the
 * listing used to ask the same question of the same table once per half, two
 * round trips for one answer.
 *
 * `null` — no connection behind the row at all — reads as **owned**. "Not a
 * connection this workspace owns" and "not a connection" are different facts,
 * and only the first means the row is managed elsewhere. A built-in is the
 * workspace's to switch; calling it unowned hands them their own tool
 * labelled as someone else's.
 *
 * The listing and the write both resolve ownership through this, so the rule
 * the GET renders and the rule the PUT enforces cannot drift into a surface
 * that shows a switch the server will refuse — or worse, the other way round.
 *
 * Lifted out of `agents.routes.ts` so the hook surface can hold the same rule.
 * It does **not** reuse the null-is-owned half — see `hookOwnership.ts` for
 * why a hook has to answer that differently.
 */
export async function toolOwnership(
  rows: unknown[],
  workspaceId: string,
): Promise<(row: unknown) => boolean> {
  const ownedIds = new Set(
    (await filterMapped(rows, 'CONNECTION', workspaceId, connectionIdOf)).map(connectionIdOf),
  );

  return (row: unknown): boolean => {
    const connectionId = connectionIdOf(row);
    return connectionId === null || ownedIds.has(connectionId);
  };
}
