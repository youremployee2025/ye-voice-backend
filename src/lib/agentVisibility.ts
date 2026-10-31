import type { Prisma } from '@prisma/client';

/**
 * "Not already retired", written NULL-safely.
 *
 * `status: { not: 'removed' }` is SQL `status <> 'removed'`, which evaluates to
 * NULL — and so does not match — when `status` is NULL. Upstream omits `status`
 * often enough that the naive version would exempt a whole class of agents:
 * here it would make every unsynced agent unpickable, and in the sync it once
 * made them unremovable.
 *
 * Shared rather than repeated. There are three places that must agree on what
 * makes an agent usable — the assignment check, the start gate and the
 * serializer — and a rule spelled out three times is a rule that eventually
 * says three different things.
 */
export const NOT_REMOVED: Prisma.AgentWhereInput = {
  OR: [{ status: null }, { status: { not: 'removed' } }],
};

/**
 * The in-memory half of the same rule, for a row already joined.
 *
 * Two conditions, both necessary, neither implied by `agentId != null`:
 *
 * - **Still this workspace's.** Staff unassign by setting `Agent.workspaceId`,
 *   an UPDATE the foreign key cannot see, so a campaign can hold a perfectly
 *   valid id for an agent it can no longer use.
 * - **Not retired.** Sync retires by setting `status`, leaving `workspaceId`
 *   intact — so a removed agent still resolves in its workspace and satisfies
 *   the foreign key completely. Ownership alone would wave it through.
 *
 * `status` NULL means never synced, not removed, and stays usable — the same
 * asymmetry `NOT_REMOVED` encodes in SQL.
 */
export function agentIsUsable(
  agent: { status: string | null; workspaceId: string | null } | null | undefined,
  workspaceId: string,
): boolean {
  if (!agent) return false;
  if (agent.workspaceId !== workspaceId) return false;
  return agent.status !== 'removed';
}
