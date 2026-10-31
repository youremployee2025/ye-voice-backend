import { getAgentTools, type AgentToolsResponse } from '../adapter/vocobase.js';
import { connectionIdOf, isUpstreamRow } from './serialize.js';
import { readString } from './upstream.js';
import { filterMapped } from './workspaceResource.js';

/**
 * Whether a lifecycle hook's source belongs to this workspace.
 *
 * The question the whole actions surface turns on. An owned row is read back
 * in full — its input template is what the editor loads — and is the only
 * kind a write may touch; an unowned one keeps the summary shape it has
 * always had and 404s every write, the same rule the tools tab holds.
 *
 * Two sources, two rules:
 *
 * - **A tool hook** is owned when the agent has a binding for that slug whose
 *   connection maps to this workspace. Deliberately **not** `toolOwnership`'s
 *   rule, which reads a null connection as owned: that is right for the tools
 *   list, where a null means a built-in the workspace may switch, and wrong
 *   here, where an unbound Google row would make every workspace the owner of
 *   a staff-configured hook — and hand them the spreadsheet id on it. A hook
 *   needs a real connection behind it, mapped here, and nothing less.
 *
 * - **A function hook** is owned when the workspace owns the function
 *   (`WorkspaceResource(kind=FUNCTION)`), the same gate the functions surface
 *   already passes every read and write through.
 *
 * A row that is neither — no slug, no function id — is not owned. There is
 * nothing to check, so there is nothing that could have granted it.
 *
 * **Whose bindings** is the caller's to say, through `listTools`. A hook runs
 * against the tool set of the face it sits on, so a face hook's owner is
 * decided by the FACE's bindings (`getInboundAgentTools`), never the base's:
 * a face bound on its own has nothing on the base, and a face bound by staff
 * to a pool connection runs on that account's token whatever the base holds.
 * The default is the base agent's list.
 *
 * Batched on purpose: one tools read and at most two mapping reads for a
 * whole list, however many hooks it holds. A per-row `hookOwned` would spend
 * a round trip each on a surface whose normal state is five of them.
 */
export type ToolsLister = (agentExternalId: string) => Promise<AgentToolsResponse>;

export async function hookOwnership(
  rows: unknown[],
  agentExternalId: string,
  workspaceId: string,
  listTools: ToolsLister = getAgentTools,
): Promise<(row: unknown) => boolean> {
  const hooks = rows.filter(isUpstreamRow);
  const slugs = new Set(
    hooks.map(hookToolSlug).filter((slug): slug is string => slug !== null),
  );
  const functionIds = hooks
    .map(hookFunctionId)
    .filter((id): id is string => id !== null);

  // Only when a hook actually names one. An agent whose actions are all
  // functions must not pay an upstream round trip to be told about tools
  // nothing asked about.
  const ownedSlugs = slugs.size === 0
    ? new Set<string>()
    : await ownedToolSlugs(agentExternalId, workspaceId, listTools);

  const ownedFunctions = new Set(
    (
      await filterMapped(functionIds, 'FUNCTION', workspaceId, (id) => id)
    ),
  );

  return (row: unknown): boolean => {
    const slug = hookToolSlug(row);
    if (slug !== null) return ownedSlugs.has(slug);

    const functionId = hookFunctionId(row);
    if (functionId !== null) return ownedFunctions.has(functionId);

    return false;
  };
}

/**
 * The single-row form, for a write that holds one hook id.
 *
 * Built on the batch predicate rather than beside it, so the rule a write
 * enforces and the rule the read renders cannot drift — the failure the tools
 * surface's shared `toolOwnership` exists to prevent, in a second place.
 */
export async function hookOwned(
  row: unknown,
  agentExternalId: string,
  workspaceId: string,
  listTools: ToolsLister = getAgentTools,
): Promise<boolean> {
  const owned = await hookOwnership([row], agentExternalId, workspaceId, listTools);
  return owned(row);
}

/** The tool slugs on this face whose binding names a connection mapped here. */
async function ownedToolSlugs(
  agentExternalId: string,
  workspaceId: string,
  listTools: ToolsLister,
): Promise<Set<string>> {
  const { tools } = await listTools(agentExternalId);
  const rows = (Array.isArray(tools) ? tools : []).filter(isUpstreamRow);

  // A row with no connection is dropped before the mapping read rather than
  // after it: `filterMapped` would keep it out of the result anyway, but the
  // predicate below must never see a slug whose only evidence was a null.
  const bound = rows.filter((row) => connectionIdOf(row) !== null);
  const owned = await filterMapped(bound, 'CONNECTION', workspaceId, connectionIdOf);

  return new Set(
    owned.map(hookToolSlug).filter((slug): slug is string => slug !== null),
  );
}

/** A tool slug, on a tools row or on a hook — upstream spells it both ways. */
export const hookToolSlug = (row: unknown): string | null =>
  readString(row, ['toolSlug', 'tool_slug']);

/** A hook's function id — null on a tool hook. */
export const hookFunctionId = (row: unknown): string | null =>
  readString(row, ['functionId', 'function_id']);
