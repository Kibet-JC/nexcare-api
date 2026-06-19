// Auth service — the credential and token logic behind login / refresh / logout
// (#11). The HTTP layer (auth.routes) stays thin: it validates input, calls
// these functions, and translates the returned raw refresh token into a cookie.
//
// Security model (CLAUDE.md §4.2 and the issue's security rules):
//  - Login failures are ALWAYS a generic 401 — never reveal whether the email
//    was unknown, the account disabled, or the password wrong (no enumeration).
//  - Refresh tokens are opaque random strings; only their SHA-256 hash is stored
//    (RefreshToken.tokenHash). The raw token never touches the DB or the logs.
//  - Rotation: each successful refresh revokes the presented token and issues a
//    fresh one, chained via `replacedByTokenId`.
//  - Reuse detection: presenting an already-revoked token is treated as theft —
//    every one of that user's refresh tokens is revoked and the call fails 401.
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { HttpProblem } from '../../lib/problem.js';
import { verifyPassword } from '../../lib/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../../lib/jwt.js';
import { findByEmail, toSafeUser, type SafeUser } from '../user/user.service.js';

/** What login/refresh hand back. `refreshToken` is the RAW value — the route
 *  puts it in the HttpOnly cookie and never returns it in the JSON body. */
export interface AuthResult {
  accessToken: string;
  user: SafeUser;
  /** Raw opaque refresh token. Cookie-only; never logged, never in the body. */
  refreshToken: string;
}

/** The single, generic credential error. Identical for every failure mode so a
 *  caller cannot distinguish unknown email from wrong password from disabled. */
function invalidCredentials(): HttpProblem {
  return new HttpProblem(401, 'Unauthorized', 'Invalid credentials');
}

/** Persist a freshly generated refresh token (hash only) for a user and return
 *  the raw value to hand to the client. */
async function issueRefreshToken(userId: string): Promise<string> {
  const raw = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(raw),
      userId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  });
  return raw;
}

/**
 * Verify credentials and start a session. Returns an access token, the safe user
 * (no passwordHash), and a raw refresh token. Any failure — unknown email,
 * disabled/soft-deleted account, or wrong password — yields the same generic 401.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await findByEmail(email);

  // Unknown, disabled, or soft-deleted accounts fail exactly like a wrong
  // password. We still run the hash verify for a real user so login does the
  // constant-time work argon2 provides.
  if (!user || !user.isActive || user.deletedAt) {
    throw invalidCredentials();
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    throw invalidCredentials();
  }

  const safeUser = toSafeUser(user);
  const accessToken = signAccessToken(safeUser);
  const refreshToken = await issueRefreshToken(user.id);

  logger.info({ userId: user.id }, 'user logged in');
  return { accessToken, user: safeUser, refreshToken };
}

/**
 * Rotate a refresh token. On success the presented token is revoked, a new one
 * is issued (chained via `replacedByTokenId`), and a fresh access token returns.
 *
 * Failure modes, all 401:
 *  - token not recognised or expired -> plain 401.
 *  - token already revoked -> REUSE DETECTED: revoke the user's entire token set
 *    (theft response) before failing.
 */
export async function refresh(rawToken: string): Promise<AuthResult> {
  const tokenHash = hashToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw invalidCredentials();
  }

  // Reuse detection: a revoked token presented again means either the legitimate
  // client replayed an old token or an attacker stole one. Either way, treat the
  // whole chain as compromised and revoke every active token for the user.
  if (existing.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn(
      { userId: existing.userId },
      'refresh token reuse detected — revoked all user tokens',
    );
    throw invalidCredentials();
  }

  // Expired tokens are spent; reject without rotating.
  if (existing.expiresAt.getTime() <= Date.now()) {
    throw invalidCredentials();
  }

  // The owning account may have been disabled or removed since the token issued.
  const user = await prisma.user.findUnique({ where: { id: existing.userId } });
  if (!user || !user.isActive || user.deletedAt) {
    throw invalidCredentials();
  }

  // Rotate atomically: mint the successor, then revoke + chain the old token so
  // we never leave a window where both are valid or neither is recorded.
  const newRaw = generateRefreshToken();
  await prisma.$transaction(async (tx) => {
    const created = await tx.refreshToken.create({
      data: {
        tokenHash: hashToken(newRaw),
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenId: created.id },
    });
  });

  const safeUser = toSafeUser(user);
  const accessToken = signAccessToken(safeUser);

  logger.info({ userId: user.id }, 'refresh token rotated');
  return { accessToken, user: safeUser, refreshToken: newRaw };
}

/**
 * End a session. Revokes the presented refresh token if it exists and is still
 * active. Idempotent and silent: an unknown or already-revoked token is not an
 * error (logout always succeeds from the client's perspective).
 */
export async function logout(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    logger.info('refresh token revoked on logout');
  }
}
