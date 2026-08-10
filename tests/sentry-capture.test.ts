// What the error handler WOULD send to Sentry (H-7).
//
// tests/sentry.test.ts proves that nothing is sent while the DSN is unset —
// which is exactly why it cannot also prove that the right thing is sent when
// it is. That contract is pinned here instead, by substituting captureProblem
// with a spy: the rest of lib/sentry.ts (scrubbing, the off switch) stays real,
// and no client is ever constructed, so this file cannot contact Sentry either.
//
// The seam earns its place because the fields being asserted — the route
// pattern, the request ID — are derived in lib/problem.ts and would otherwise
// regress silently: with Sentry off, a wrong route tag has no observable effect
// anywhere in the suite.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/sentry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/sentry.js')>();
  return { ...actual, captureProblem: vi.fn() };
});

import express from 'express';
import request from 'supertest';
import { pinoHttp } from 'pino-http';
import { logger } from '../src/lib/logger.js';
import { HttpProblem, errorHandler, notFoundHandler } from '../src/lib/problem.js';
import { captureProblem } from '../src/lib/sentry.js';

const captured = vi.mocked(captureProblem);

/**
 * An app shaped like the real one at the points that matter: pino-http assigns
 * req.id (the correlation ID), and the failing route lives on a mounted router
 * so req.baseUrl and req.route.path are both populated, as in src/app.ts.
 */
function appWithFailingRouter(failure: Error): express.Express {
  const app = express();
  app.use(pinoHttp({ logger }));

  const router = express.Router({ mergeParams: true });
  router.post('/:patientId/consents', () => {
    throw failure;
  });
  app.use('/api/v1/patients', router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  captured.mockClear();
});

describe('what the error handler reports', () => {
  it('reports a 5xx with the parameterised route, method, status and request ID', async () => {
    const failure = new Error('prisma exploded');
    const res = await request(appWithFailingRouter(failure)).post(
      '/api/v1/patients/8f1e/consents',
    );

    expect(res.status).toBe(500);
    expect(captured).toHaveBeenCalledTimes(1);

    const [reportedError, context] = captured.mock.calls[0]!;
    expect(reportedError).toBe(failure);
    expect(context).toMatchObject({
      method: 'POST',
      // The pattern, NOT /api/v1/patients/8f1e/consents — one Sentry issue per
      // endpoint instead of one per patient.
      route: '/api/v1/patients/:patientId/consents',
      status: 500,
    });
    // pino-http's correlation ID, forwarded so an operator can pivot from the
    // Sentry event to that request's log lines.
    expect(context.requestId).toMatch(/^\d+$/);
  });

  it('does not report a 4xx', async () => {
    const app = express();
    app.get('/denied', () => {
      throw new HttpProblem(403, 'Forbidden', 'Patient 8f1e is outside your facility');
    });
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get('/denied');

    expect(res.status).toBe(403);
    expect(captured).not.toHaveBeenCalled();
  });

  it('does not report an unmatched route (404)', async () => {
    const res = await request(appWithFailingRouter(new Error('unused'))).get('/nope');

    expect(res.status).toBe(404);
    expect(captured).not.toHaveBeenCalled();
  });

  it('falls back to the path without its query string when no route matched', async () => {
    // An error raised in middleware, before routing: req.route is undefined, so
    // routeOf() falls back to the path — and must drop the query string, which
    // is where search terms (patient names) live.
    const app = express();
    app.use('/api/v1/patients', (_req, _res, next) => {
      next(new Error('token verification blew up'));
    });
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/patients?q=Jane%20Doe');

    expect(res.status).toBe(500);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0]![1]).toMatchObject({
      route: '/api/v1/patients',
      status: 500,
    });
  });
});
