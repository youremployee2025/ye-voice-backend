/**
 * Whether an agent has ONE face or two — read without naming the enum's
 * current spelling.
 *
 * `feat/persona-uni-bi` is collapsing `AgentDirection` from
 * `OUTBOUND | INBOUND | BOTH` to `UNI | BI`, with `BOTH → BI` and everything
 * else `→ UNI`. Both spellings are live during the merge window, so this
 * surface reads direction through here and nowhere else.
 *
 * Written as the **negation of bi-directional** rather than a list of the
 * uni values, which is what makes it correct on both sides of the rename:
 * "BI" and "BOTH" are the only two-faced spellings that have ever existed,
 * and any third value the enum gains — or that a row holds mid-migration —
 * is one face. A list of uni values would have had to grow with the enum,
 * and the failure mode of forgetting is a BI agent whose two faces get
 * silently mirrored onto each other.
 *
 * Delete the alias, and this file, once both branches are on `main`.
 */
const BI_DIRECTIONS: ReadonlySet<string> = new Set(['BI', 'BOTH']);

export function isUni(agent: { direction: string }): boolean {
  return !BI_DIRECTIONS.has(agent.direction);
}

/**
 * A one-faced agent whose single face answers inbound calls too.
 *
 * The condition the mirror runs on: there is exactly one configuration, and
 * calls arrive at it from both directions, so an action added to it has to
 * be on the face as well or half the calls run a different agent.
 */
export function mirrorsToFace(agent: { direction: string; inboundEnabled: boolean }): boolean {
  return isUni(agent) && agent.inboundEnabled;
}

/**
 * A two-faced agent whose second face exists — the only shape for which
 * `?side=inbound` names something distinct from the base.
 */
export function hasAddressableFace(agent: {
  direction: string;
  inboundEnabled: boolean;
}): boolean {
  return !isUni(agent) && agent.inboundEnabled;
}
