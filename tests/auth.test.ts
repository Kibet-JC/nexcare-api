// Auth module integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// Exercises the full HTTP -> validate -> service -> Prisma -> Postgres path for
// login / refresh / logout via Supertest, including refresh-token rotation and
// reuse detection. Needs `docker compose up -d` (or CI's postgres service), the
// applied `add_refresh_token` migration, a valid DATABASE_URL, and a
// JWT_ACCESS_SECRET (>= 32 chars). refresh_tokens + users are truncated before
// each test (child table first for the FK) and a known user is seeded.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createUser } from '../src/modules/user/user.service.js';
import { verifyAccessToken, hashToken } from '../src/lib/jwt.js';

const app = createApp();

const credentials = {
  email: 'dr.mwangi@elarahealthcare.co.ke',
  password: 'StrongPassw0rd!',
} as const;

let userId: string;

/** Pull the raw refresh-token value out of a response's Set-Cookie header. */
function refreshCookieValue(res: request.Response): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const header = setCookie?.find((c) => c.startsWith('refreshToken='));
  if (!header) return undefined;
  const value = header.split(';', 1)[0]!.slice('refreshToken='.length);
  return value.length > 0 ? value : undefined;
}

/** The full Set-Cookie string for the refresh cookie (to assert its flags). */
function refreshCookieHeader(res: request.Response): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.find((c) => c.startsWith('refreshToken='));
}

describe('Auth API (/api/v1/auth)', () => {
  beforeEach(async () => {
    // The global setupFile (tests/setup/reset-db.ts) truncates every table
    // before each test; here we only seed the known user.
    const user = await createUser({ ...credentials, role: 'CLINICIAN' });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('logs in with correct credentials: 200, decodable access token, HttpOnly cookie', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(credentials);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    // Never leak the hash to callers.
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.user.email).toBe(credentials.email);

    // Access token carries exactly the minimal claims.
    const claims = verifyAccessToken(res.body.accessToken);
    expect(claims.sub).toBe(userId);
    expect(claims.role).toBe('CLINICIAN');

    // Refresh cookie is set and hardened.
    const cookie = refreshCookieHeader(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ ...credentials, password: 'WrongPassw0rd!' });

    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Invalid credentials');
    // No refresh cookie issued on failure.
    expect(refreshCookieValue(res)).toBeUndefined();
  });

  it('rotates the refresh token: new access token + new cookie, old token revoked', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login').send(credentials);
    const oldToken = refreshCookieValue(loginRes)!;

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${oldToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');

    const newToken = refreshCookieValue(res);
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(oldToken);

    // The presented (old) token is now revoked and chained to its successor.
    const oldRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(oldToken) },
    });
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(oldRow?.replacedByTokenId).not.toBeNull();
  });

  it('detects reuse: a revoked token revokes the entire chain and returns 401', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login').send(credentials);
    const oldToken = refreshCookieValue(loginRes)!;

    // First refresh rotates oldToken out (revokes it).
    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${oldToken}`)
      .expect(200);

    // Presenting the now-revoked oldToken again is treated as theft.
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${oldToken}`);

    expect(reuse.status).toBe(401);
    expect(reuse.body.detail).toBe('Invalid credentials');

    // Every one of the user's refresh tokens — including the freshly rotated
    // one — is now revoked.
    const active = await prisma.refreshToken.count({
      where: { userId, revokedAt: null },
    });
    expect(active).toBe(0);
  });

  it('logs out: 204, clears the cookie, and the token no longer refreshes', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login').send(credentials);
    const token = refreshCookieValue(loginRes)!;

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `refreshToken=${token}`);

    expect(logoutRes.status).toBe(204);
    // Cookie is cleared (expired immediately).
    const cleared = refreshCookieHeader(logoutRes);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    // The revoked token cannot be used to refresh.
    const afterLogout = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);
    expect(afterLogout.status).toBe(401);
  });
});
