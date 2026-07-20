// Express application factory. Exposing a `createApp()` factory (rather than a
// module-level app) keeps the app construction free of side effects, which is
// what lets the integration tests spin up an instance per file with Supertest
// and what keeps the listen/bootstrap concern in src/index.ts.
//
// helmet and rate limiting land here in Issue #15; cookie-parser arrived in #11
// because auth reads the refresh-token cookie. CORS arrived with the Phase 3
// frontend: an env-configured exact-origin allowlist (see config/env.ts).
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/problem.js';
import { audit } from './middleware/audit.js';
import { authenticate } from './middleware/authenticate.js';
import { apiRateLimiter, authRateLimiter } from './middleware/rate-limit.js';
import { appointmentRouter } from './modules/appointment/appointment.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { consentRouter } from './modules/consent/consent.routes.js';
import { patientRouter } from './modules/patient/patient.routes.js';

// Absolute path to the published security.txt. Resolved from this module's own
// URL rather than process.cwd() so it is correct however the process is
// started: src/app.ts -> <repo>/public, dist/app.js -> /app/public in the
// container. Both are one level up from the module's directory, so the same
// relative specifier works in dev and in production. The Dockerfile copies
// public/ into the runtime stage to keep that second path real.
const SECURITY_TXT_PATH = fileURLToPath(
  new URL('../public/.well-known/security.txt', import.meta.url),
);

export function createApp(): Express {
  const app = express();

  // Trust exactly one proxy hop in production so the rate limiter and request
  // logging key on the real client IP behind Railway's edge proxy (#16). Left
  // OFF in dev/test: trusting X-Forwarded-For there would let a client spoof its
  // IP to evade or poison the per-IP limits.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // Security headers (#15). Mounted first so every response — including the
  // health probe and any error — carries helmet's hardened headers, and so
  // Express's `X-Powered-By` header is stripped before anything else runs.
  // Mounted AFTER the `trust proxy` setting above, which the rate limiter
  // downstream relies on to key per-IP budgets on the real client address.
  //
  // Two of helmet's defaults are tuned for this service:
  //
  // CSP — NexCare serves JSON only, never HTML, so the policy is a deny-all
  // floor rather than a browser rendering policy. `useDefaults: false` drops
  // helmet's script/style/img allowances (meaningless here, and they only
  // widen what a reflected-content bug could reach): `default-src 'none'`
  // denies every fetch class, `frame-ancestors 'none'` blocks framing of any
  // response, `base-uri 'none'` blocks <base> injection. Cheap defence in
  // depth for the case where a response is ever rendered as a document.
  //
  // HSTS — production only. The header pins a browser to HTTPS for a year, so
  // emitting it from a dev or test server (plain HTTP on localhost) would
  // poison the developer's browser for every other localhost service on that
  // host. Railway terminates TLS at its edge, which is where the pin belongs.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
        },
      },
      hsts:
        env.NODE_ENV === 'production'
          ? { maxAge: 31536000, includeSubDomains: true }
          : false,
    }),
  );

  // Structured request/response logging, sharing the app-wide logger so
  // redaction rules apply to logged headers and bodies.
  app.use(pinoHttp({ logger }));

  // Cross-origin access for the browser client. The allowlist comes from
  // CORS_ALLOWED_ORIGINS, validated at boot (config/env.ts): exact origins
  // only, wildcards rejected, empty in production until deliberately set.
  // The header always reflects the single matched origin — never `*`, which
  // the credentialed-request spec forbids anyway. credentials:true is what
  // lets the browser attach the HttpOnly refresh cookie. Mount position is
  // deliberate on both sides: AFTER pinoHttp so the OPTIONS preflights this
  // middleware terminates still appear in the request logs (forensic
  // visibility for cross-origin probing), but AHEAD of the rate limiters so
  // preflights (cached 10 min via maxAge) stay cheap and don't eat into a
  // client's per-IP budget — an OPTIONS flood bypassing the limiter is
  // acceptable because preflight does no work and touches no data.
  // Non-allowlisted origins simply get no CORS grant headers (the browser
  // blocks the response); non-browser callers without an Origin header are
  // unaffected.
  app.use(
    cors({
      origin: [...env.CORS_ALLOWED_ORIGINS],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  // JSON body parsing for all routes.
  app.use(express.json());

  // Cookie parsing (#11): populates req.cookies so the auth router can read the
  // HttpOnly refresh-token cookie. Cookie headers are redacted in the logger.
  app.use(cookieParser());

  // Audit trail (CLAUDE.md §4.1, Issue #8). Registered before the routers so it
  // observes every mutating request across all endpoints; it writes one
  // AuditLog row on response finish and stores no PII. The health probe below
  // is a GET, so it is never audited.
  app.use(audit);

  // Broad API rate limit (#15): 100 req/min/IP across the whole versioned
  // surface, the abuse backstop for runaway clients and crude scraping. Skipped
  // in the test environment (see middleware/rate-limit.ts) so the integration
  // suite is never throttled.
  app.use('/api/v1', apiRateLimiter);

  // Liveness probe. Cheap, unauthenticated, no DB touch — just confirms the
  // process is up and serving. Versioned under /api/v1 like every endpoint.
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'nexcare-api',
      timestamp: new Date().toISOString(),
    });
  });

  // Security disclosure contact (RFC 9116). Deliberately unversioned and
  // unauthenticated: the RFC fixes the path at /.well-known/security.txt, so it
  // cannot live under /api/v1, and a researcher must be able to find the
  // reporting address without credentials. Content is served from the file on
  // disk rather than an inlined string so public/.well-known/security.txt stays
  // the single source of truth for the Expires date. Mounted here beside the
  // health probe — the other cheap, public, unversioned GET.
  app.get('/.well-known/security.txt', (_req: Request, res: Response) => {
    // dotfiles:'allow' is required, not cosmetic: send() defaults to 'ignore'
    // and refuses any path containing a dot-segment, so the `.well-known`
    // directory the RFC mandates would 404 even though the file is present.
    res.sendFile(SECURITY_TXT_PATH, {
      dotfiles: 'allow',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  });

  // Strict auth rate limit (#15): 10 req/15min/IP on the credential-bearing
  // endpoints, the brute-force defence. Mounted ahead of the auth router and
  // scoped to login/refresh only, so logout and /me keep the general limit.
  // Skipped in the test environment like the general limiter.
  app.use('/api/v1/auth/login', authRateLimiter);
  app.use('/api/v1/auth/refresh', authRateLimiter);

  // Auth domain (#11/#12): login / refresh / logout are public by necessity
  // (they establish a session); the router protects only its own /me route.
  app.use('/api/v1/auth', authRouter);

  // Patient domain (CLAUDE.md §4.2). `authenticate` at the mount means every
  // patient route requires a valid access token; per-route `requireRole` (#12)
  // then enforces the role policy. Consent lands later (#13).
  app.use('/api/v1/patients', authenticate, patientRouter);

  // Consent domain (#13). Nested under a patient: a consent always belongs to
  // one patient. Authenticated at the mount; the router's { mergeParams: true }
  // exposes :patientId, and per-route `requireRole` enforces the consent policy.
  // An ACTIVE DATA_PROCESSING consent here is what the appointment service
  // requires before a booking may be created (Kenya Data Protection Act, 2019).
  app.use('/api/v1/patients/:patientId/consents', authenticate, consentRouter);

  // Appointment domain (CLAUDE.md §4.2). Authenticated at the mount; per-route
  // `requireRole` (#12) enforces the role policy. Consent lands later (#13).
  app.use('/api/v1/appointments', authenticate, appointmentRouter);

  // Unmatched routes -> 404 Problem Details.
  app.use(notFoundHandler);

  // Terminal error handler. MUST be last so it catches everything above.
  app.use(errorHandler);

  return app;
}
