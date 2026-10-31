import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { WorkspaceRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ApiError } from '../lib/errors.js';
import { accountOf } from './auth.js';

/**
 * Resolves the caller's membership in `:workspaceId` and attaches
 * { workspace, role }. A non-member, a missing workspace and a deleted one all
 * yield the same 403 — a 404, or a separate answer for a deleted workspace,
 * would leak which workspace ids exist.
 *
 * The one exception is a super admin with no membership row, who is let in
 * as an ADMIN of any live workspace and gets a 404 for a missing or deleted
 * one. See the bypass below for why that does not weaken the rule above.
 */
export function requireMembership(minimumRole?: 'ADMIN'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const account = accountOf(req);
      const workspaceId = req.params.workspaceId ?? req.params.id;

      if (!workspaceId) {
        throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
      }

      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_accountId: { workspaceId, accountId: account.id } },
        include: { workspace: true },
      });

      if (member) {
        // One question — may this caller see this workspace — so one refusal.
        // The membership row survives the soft delete, so without the second
        // clause every scoped route goes on answering for a workspace that is
        // gone.
        if (member.workspace.deletedAt) {
          throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
        }
        if (minimumRole === 'ADMIN' && member.role !== 'ADMIN') {
          throw new ApiError(403, 'FORBIDDEN', 'This action requires workspace admin access.');
        }
        req.workspace = member.workspace;
        req.role = member.role;
        req.superAdmin = false;
        next();
        return;
      }

      if (!account.isSuperAdmin) {
        // A non-member and a missing workspace yield the same 403 — a 404
        // would leak which workspace ids exist.
        throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
      }

      // The super admin bypass. A real membership above always wins, so the
      // flag is not a promotion inside workspaces the account belongs to —
      // but read that as a presentation rule, NOT a containment boundary. It
      // holds within one request and not across two: anyone may leave a
      // workspace, so a flagged account pinned to MEMBER can delete its own
      // membership and arrive here on the next request. That is fine — the
      // flag already grants this everywhere — and `members.routes.ts` records
      // the step so the trail does not begin mid-escalation.
      //
      // The 404 here does not weaken the no-leak rule: that rule hides ids
      // from customers, and this caller is staff.
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!workspace || workspace.deletedAt) {
        throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
      }

      req.workspace = workspace;
      req.role = 'ADMIN';
      req.superAdmin = true;
      recordSuperAdminWrite(req, res);
      next();
    })().catch(next);
  };
}

/**
 * Writes one audit row, fire-and-forget.
 *
 * The request has already been served by the time any caller reaches this, so
 * it cannot be "record first, then act" — and an audit table outage must not
 * take live campaign operations down with it. A failed insert is an error
 * line naming who and where, which is the most that can be said of it.
 */
export function recordSuperAdminAction(row: {
  accountId: string;
  workspaceId: string | null;
  method: string;
  path: string;
  status: number;
}): void {
  void prisma.superAdminAction.create({ data: row }).catch((err: unknown) => {
    logger.error({ err, ...row }, 'super admin audit write failed');
  });
}

/**
 * Records a bypassed mutating request once the response is done with.
 *
 * `close`, not `finish`: `finish` only fires when the response flushed, so a
 * client that hung up mid-write — after the handler had already mutated —
 * would leave no row. `close` fires either way: after `finish` on success,
 * and alone on an abort. On an abort it can fire while the handler is still
 * running, before anything was written, and `res.statusCode` is then just the
 * default 200 — recording that would claim the write was served. So the row
 * carries 499 (nginx's "client closed request") whenever the response never
 * finished, and the real status only when it did.
 */
function recordSuperAdminWrite(req: Request, res: Response): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;

  const account = accountOf(req);
  const workspaceId = req.workspace?.id ?? null;
  const path = req.originalUrl.split('?')[0];

  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    recordSuperAdminAction({
      accountId: account.id,
      workspaceId,
      method: req.method,
      path,
      status: res.writableFinished ? res.statusCode : 499,
    });
  };

  res.once('close', record);

  // The close we were too late for. Everything above this hook is awaited —
  // the Clerk lookup, the account upsert, two queries — and `once` does not
  // replay an event that already fired, so a client that hung up during any
  // of it would leave no row while the handler ran on and committed. That is
  // an audit trail the actor can switch off from their own client, so the
  // catch-up is not a tidy-up: it is the control working at all.
  if (res.destroyed) record();
}

export function workspaceOf(req: Request) {
  const workspace = req.workspace;
  if (!workspace) throw new Error('requireMembership must run before this handler');
  return workspace;
}

export function roleOf(req: Request): WorkspaceRole {
  const role = req.role;
  if (!role) throw new Error('requireMembership must run before this handler');
  return role;
}

/** True when the caller reached this workspace through the super admin bypass. */
export function isSuperAdminHere(req: Request): boolean {
  return req.superAdmin === true;
}

/**
 * Asserts the caller OWNS `:workspaceId`, rather than merely administering it.
 *
 * A separate middleware and not a parameter on `requireMembership`, because
 * "is an admin here" and "is the owner" are two questions and that function
 * answers only the first. It runs after it and reads what it attached, so
 * `workspaceOf` throwing is the same contract every handler already has.
 *
 * Deliberately stricter than the rename sitting beside it on the same router.
 * An invited ADMIN may do everything inside a workspace that its owner can —
 * that equivalence is the documented permission model — but the account billed
 * for this workspace's DIDs and its calls is the owner's, and somebody they
 * invited must not be able to erase it out from under them. The refusal is the
 * plain FORBIDDEN every other role failure gives: nothing here is worth a code
 * of its own, because there is no remedy but asking the owner.
 *
 * A super admin passes: owner parity is the whole point of the flag, and the
 * audit row says who did it.
 */
export function requireOwner(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const account = accountOf(req);
    const workspace = workspaceOf(req);

    if (workspace.ownerAccountId !== account.id && !isSuperAdminHere(req)) {
      next(new ApiError(403, 'FORBIDDEN', 'Only the workspace owner can do this.'));
      return;
    }

    next();
  };
}
