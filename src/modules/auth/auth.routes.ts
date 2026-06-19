// Auth HTTP routes — mounted at /api/v1/auth (see src/app.ts).
//
// Thin by design (like the other routers): validate, delegate to the service,
// and own the one HTTP-specific concern the service can't — the refresh cookie.
// Express 5 awaits async handlers and forwards rejections to the terminal error
// handler, so a thrown HttpProblem(401) becomes an RFC 7807 response with no
// try/catch here.
//
// This issue (#11) adds ONLY login/refresh/logout. It deliberately does NOT add
// middleware that protects other routes, a /me endpoint, or any role checks —
// those belong to RBAC (#12). helmet/cors/rate-limiting belong to #15.
import { Router, type CookieOptions } from 'express';
import { validate } from '../../lib/validate.js';
import { env } from '../../config/env.js';
import { REFRESH_TOKEN_TTL_SECONDS } from '../../lib/jwt.js';
import { loginSchema, type LoginInput } from './auth.schema.js';
import { login, refresh, logout } from './auth.service.js';

/** The cookie that carries the raw refresh token. */
const REFRESH_COOKIE = 'refreshToken';

// Cookie hardening (issue security rules):
//  - httpOnly: unreadable from JS, so XSS can't exfiltrate the token.
//  - sameSite 'strict': the cookie is never sent on cross-site requests (CSRF).
//  - secure in production only: HTTPS-only there; left off in dev/test where
//    requests are plain HTTP (a Secure cookie would otherwise be dropped).
//  - path scoped to /api/v1/auth: the browser only attaches it to auth calls,
//    not to every API request.
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: env.NODE_ENV === 'production',
  path: '/api/v1/auth',
  maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000, // express expects milliseconds
};

export const authRouter: Router = Router();

// Authenticate with email + password. On success: set the refresh cookie and
// return the access token plus the safe user. On failure: a generic 401.
authRouter.post('/login', validate(loginSchema, 'body'), async (req, res) => {
  const { email, password } = req.body as LoginInput;
  const { accessToken, user, refreshToken } = await login(email, password);

  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
  res.status(200).json({ accessToken, user });
});

// Rotate the refresh token presented via the cookie. Issues a new access token
// and a new refresh cookie; the old refresh token is revoked. A missing cookie,
// or any rejected token, is a generic 401.
authRouter.post('/refresh', async (req, res) => {
  const rawToken: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    res.status(401).type('application/problem+json').json({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid credentials',
      instance: req.originalUrl,
    });
    return;
  }

  const { accessToken, user, refreshToken } = await refresh(rawToken);

  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
  res.status(200).json({ accessToken, user });
});

// End the session. Revokes the presented refresh token (if any) and clears the
// cookie. Always 204 — logout is idempotent and reveals nothing.
authRouter.post('/logout', async (req, res) => {
  const rawToken: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof rawToken === 'string' && rawToken.length > 0) {
    await logout(rawToken);
  }

  // Clear with the same attributes the cookie was set with so the browser
  // actually removes it (path/sameSite/secure must match).
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: '/api/v1/auth',
  });
  res.status(204).end();
});
