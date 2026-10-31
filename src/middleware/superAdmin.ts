import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../lib/errors.js';
import { accountOf } from './auth.js';

/**
 * Admits only accounts carrying `isSuperAdmin`. Runs after `requireAuth`.
 *
 * The refusal is a 404, not a 403: to a customer the surface behind this does
 * not exist, and a 403 would say "there is something here you may not have".
 */
export function requireSuperAdmin(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!accountOf(req).isSuperAdmin) {
      next(new ApiError(404, 'NOT_FOUND', 'Not found.'));
      return;
    }
    next();
  };
}
