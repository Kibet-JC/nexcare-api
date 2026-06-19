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
import { appointmentRouter } from './modules/appointment/appointment.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
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

  // Auth domain (#11): login / refresh / logout. These endpoints are public by
  // necessity (they establish a session). Route-protecting middleware and RBAC
  // are owned by #12; this only issues and rotates tokens.
  app.use('/api/v1/auth', authRouter);

  // Patient domain (CLAUDE.md §4.2). Open for now; auth/audit/consent land in
  // later issues (#10/#12, #8, #13).
  app.use('/api/v1/patients', patientRouter);

  // Appointment domain (CLAUDE.md §4.2). Open for now; auth/audit/consent land
  // in later issues (#10/#12, #8, #13).
  app.use('/api/v1/appointments', appointmentRouter);

  // Unmatched routes -> 404 Problem Details.
  app.use(notFoundHandler);

  // Terminal error handler. MUST be last so it catches everything above.
  app.use(errorHandler);

  return app;
}
