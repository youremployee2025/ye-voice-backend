import type { Account, Workspace, WorkspaceRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth — the Account behind the authenticated Clerk user. */
      account?: Account;
      /** Set by requireMembership — the workspace named in the route. */
      workspace?: Workspace;
      /** Set by requireMembership — the caller's role in that workspace. */
      role?: WorkspaceRole;
      /**
       * Set by requireMembership when the caller reached this workspace through
       * the super admin bypass rather than a membership row.
       */
      superAdmin?: boolean;
    }
  }
}

export {};
