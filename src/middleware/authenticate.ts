// Authentication middleware (#12) — proves who is making the request.
//
// Reads the `Authorization: Bearer <token>` header, verifies the JWT access
// token statelessly (HS256, via the #11 helper), then re-loads the subject from
// the database. The DB record — not the token — is authoritative for the role
// and for account state: a token is valid for 15 minutes, but an account can be
// disabled or offboarded inside that window, so we re-check `isActive` and
// `deletedAt` on every request rather than trusting the (possibly stale) claims.
//
// Every failure mode collapses to a single generic 401 (RFC 7807) that reveals
// nothing about WHY: missing header, malformed token, expired token, unknown
// subject, soft-deleted user, or disabled account all look identical to a
// caller. Authorization (role checks) is a separate concern owned by
// authorize.ts and always runs AFTER this.
import type { RequestHandler } from 'express';
import type { Role } from '@prisma/client';
import { HttpProblem } from '../lib/problem.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { findActiveById } from '../modules/user/user.service.js';

/** The minimal identity attached to an authenticated request. */
export interface AuthenticatedUser {
  id: string;
  /** Authoritative role taken from the DB record, NOT the token claim. */
  role: Role;
}

// Make `req.user` visible to downstream handlers and the audit middleware.
// Optional because it is only present after `authenticate` has run on a route.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/** The same opaque 401 for every authentication failure — never leak the cause. */
function unauthorized(): HttpProblem {
  return new HttpProblem(401, 'Unauthorized', 'Authentication required');
}

/**
 * Extract the bearer token from an `Authorization` header. Returns null when the
 * header is absent or not a well-formed `Bearer <token>` pair.
 */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Require a valid access token. On success attaches `req.user = { id, role }`
 * (role from the authoritative DB record) and calls next(); on any failure
 * forwards a generic 401 Problem Details to the error handler.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req.header('authorization'));
  if (!token) {
    next(unauthorized());
    return;
  }

  let sub: string;
  try {
    // Throws on a tampered, malformed, or expired token (pinned to HS256).
    ({ sub } = verifyAccessToken(token));
  } catch {
    next(unauthorized());
    return;
  }

  // The token is genuine, but the account behind it must still be active. This
  // re-read is what makes disabling/offboarding a user take effect immediately
  // rather than after the access token expires.
  const user = await findActiveById(sub);
  if (!user) {
    next(unauthorized());
    return;
  }

  req.user = { id: user.id, role: user.role };
  next();
};
