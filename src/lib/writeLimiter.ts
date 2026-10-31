import { createRateLimiter } from '../middleware/rateLimit.js';
import { workspaceOf } from '../middleware/workspace.js';

/**
 * The cap on how fast one workspace may write through to the voice platform.
 *
 * Every route it guards spends one to four calls against a partner rate limit
 * that **every customer on the platform shares** — the same reason
 * `agents/sync` has had a limiter since it was written. Agent create, agent
 * update and the dictionary/function/document writes had none, so a single
 * member looping any one of them could degrade the product for every other
 * tenant, and with the upload route could do it while making this process
 * buffer megabytes per request.
 *
 * Keyed on the workspace rather than the account, for the reason the sync
 * limiter gives: the budget being protected belongs to the workspace, and
 * keying on the caller would let its members multiply it between them.
 *
 * Deliberately loose. This is a backstop against a runaway client or a bored
 * member, not a quota — a person editing an agent hard does not come close,
 * and a limit that interrupts ordinary work would be worse than none because
 * it would be raised until it did nothing.
 */
export const writeLimiter = createRateLimiter({
  limit: 120,
  windowMs: 60_000,
  keyOf: (req) => workspaceOf(req).id,
});
