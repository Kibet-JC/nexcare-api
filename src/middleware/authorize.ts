// Authorization middleware (#12) — enforces role-based access control.
//
// `requireRole(...roles)` returns middleware that allows the request only when
// the authenticated caller's role is in the allow-list, else 403 (RFC 7807).
// It assumes `authenticate` has already run and populated `req.user`: a missing
// `req.user` here means the route was wired without authentication, which is a
// programming error, so we fail closed with 403 rather than silently allowing.
//
// 401 vs 403 (deliberate split): 401 means "we don't know who you are" and is
// owned by authenticate.ts; 403 means "we know who you are and you may not do
// this". A caller who is authenticated but under-privileged gets 403, never 401.
import type { RequestHandler } from 'express';
import type { Role } from '@prisma/client';
import { HttpProblem } from '../lib/problem.js';

/**
 * Build middleware that permits the request only if `req.user.role` is one of
 * `roles`. Otherwise forwards a 403 Problem Details. `authenticate` must run
 * first to populate `req.user`.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      next(
        new HttpProblem(
          403,
          'Forbidden',
          'You do not have permission to perform this action',
        ),
      );
      return;
    }
    next();
  };
}
