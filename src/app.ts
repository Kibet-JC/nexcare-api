// Express application factory. Exposing a `createApp()` factory (rather than a
// module-level app) keeps the app construction free of side effects, which is
// what lets the integration tests spin up an instance per file with Supertest
// and what keeps the listen/bootstrap concern in src/index.ts.
//
// helmet, cors, and rate limiting land in Issue #15; cookie-parser arrives here
// (#11) because auth reads the refresh-token cookie. This factory otherwise
// stays minimal until #15.
import express, { type Express, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/problem.js';
import { audit } from './middleware/audit.js';
import { authenticate } from './middleware/authenticate.js';
import { appointmentRouter } from './modules/appointment/appointment.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { consentRouter } from './modules/consent/consent.routes.js';
import { patientRouter } from './modules/patient/patient.routes.js';

export function createApp(): Express {
  const app = express();

  // Structured request/response logging, sharing the app-wide logger so
  // redaction rules apply to logged headers and bodies.
  app.use(pinoHttp({ logger }));

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

  // Liveness probe. Cheap, unauthenticated, no DB touch — just confirms the
  // process is up and serving. Versioned under /api/v1 like every endpoint.
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'nexcare-api',
      timestamp: new Date().toISOString(),
    });
  });

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
