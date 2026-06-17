// Express application factory. Exposing a `createApp()` factory (rather than a
// module-level app) keeps the app construction free of side effects, which is
// what lets the integration tests spin up an instance per file with Supertest
// and what keeps the listen/bootstrap concern in src/index.ts.
//
// Security middleware (helmet, cors, cookie-parser, rate limiting) lands in
// Issue #15; this factory intentionally stays minimal until then.
import express, { type Express, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/problem.js';
import { appointmentRouter } from './modules/appointment/appointment.routes.js';
import { patientRouter } from './modules/patient/patient.routes.js';

export function createApp(): Express {
  const app = express();

  // Structured request/response logging, sharing the app-wide logger so
  // redaction rules apply to logged headers and bodies.
  app.use(pinoHttp({ logger }));

  // JSON body parsing for all routes.
  app.use(express.json());

  // Liveness probe. Cheap, unauthenticated, no DB touch — just confirms the
  // process is up and serving. Versioned under /api/v1 like every endpoint.
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'nexcare-api',
      timestamp: new Date().toISOString(),
    });
  });

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
