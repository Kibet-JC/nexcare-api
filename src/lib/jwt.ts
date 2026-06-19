// Token primitives for authentication (#11).
//
// Two distinct token kinds, deliberately built from different mechanisms:
//
//  - Access token: a signed JWT (HS256) carrying minimal claims, verified
//    statelessly on every request. Short-lived (15m) so a leaked access token
//    has a small blast radius. It carries NO secret or PII — only `sub` (the
//    user id) and `role` (CLAUDE.md §4.2). Signed with env.JWT_ACCESS_SECRET.
//
//  - Refresh token: NOT a JWT. A cryptographically random opaque string the
//    client holds in an HttpOnly cookie. Only its SHA-256 hash is persisted
//    (see RefreshToken.tokenHash) — the raw value is never stored or logged, so
//    a database read cannot recover a usable token. Longer-lived (7d) and
//    rotated on every use.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env.js';
import type { SafeUser } from '../modules/user/user.service.js';

/** Access-token lifetime. Short by design: limits the window a leaked JWT works. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

/** Refresh-token lifetime. Drives both the DB `expiresAt` and the cookie Max-Age. */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** The claims we put in an access token. Minimal by design — no PII, no hash. */
export interface AccessTokenClaims {
  /** Subject: the authenticated user's id. */
  sub: string;
  /** The user's role, for downstream RBAC (#12). */
  role: Role;
}

/**
 * Sign a short-lived HS256 access token for `user`. Only the id and role go in;
 * never the password hash or any PII. The standard `exp` claim is set from the
 * TTL constant so verification rejects expired tokens automatically.
 */
export function signAccessToken(user: SafeUser): string {
  const claims: AccessTokenClaims = { sub: user.id, role: user.role };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Verify and decode an access token. Throws (jsonwebtoken's TokenExpiredError /
 * JsonWebTokenError) on an invalid, tampered, or expired token. Pinning the
 * algorithm to HS256 prevents algorithm-confusion attacks (e.g. `alg: none`).
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
  });
  // `decoded` is `string | JwtPayload`; our tokens are always object payloads.
  const payload = decoded as jwt.JwtPayload;
  return { sub: payload.sub as string, role: payload.role as Role };
}

/**
 * Generate a fresh opaque refresh token: 32 bytes of CSPRNG output, base64url
 * encoded. This is the raw value handed to the client; only its hash is stored.
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hash (hex) of a raw refresh token. Deterministic, so a presented token
 * can be looked up by hashing it and matching `RefreshToken.tokenHash`. A raw
 * token is high-entropy random, so a plain (unsalted) hash is sufficient here —
 * there is nothing to brute-force as there would be with a password.
 */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
