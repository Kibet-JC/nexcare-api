// RFC 7807 Problem Details for HTTP APIs.
//
// Every error response from NexCare is serialised as `application/problem+json`
// with a stable shape so clients (and the Elara Healthcare web app) can handle
// failures uniformly. Stack traces are NEVER placed in the response body — they
// are logged server-side via pino and stay there. See CLAUDE.md §4.2.
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { logger } from './logger.js';
import { captureProblem } from './sentry.js';

/**
 * The RFC 7807 problem object shape returned to clients.
 * `type` defaults to "about:blank" when there is no problem-specific URI.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/**
 * An error that already knows its HTTP semantics. Throw this from handlers and
 * services to produce a well-formed Problem Details response.
 */
export class HttpProblem extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly type: string;

  constructor(
    status: number,
    title: string,
    detail?: string,
    type = 'about:blank',
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.type = type;
  }
}

/**
 * 404 handler. Mounted after all routes so any unmatched path becomes a
 * Problem Details response rather than Express's default HTML page.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    new HttpProblem(
      404,
      'Not Found',
      `No route matches ${req.method} ${req.originalUrl}`,
    ),
  );
};

/**
 * The route that failed, preferring Express's parameterised pattern
 * (`/api/v1/patients/:patientId/consents`) over the concrete path so Sentry
 * groups every failure of one endpoint into a single issue instead of one issue
 * per patient — and so patient identifiers stay out of issue titles.
 *
 * Reconstruction is needed because `req.route.path` holds only the tail the
 * matched router saw (`/:patientId/consents`): Express restores `req.baseUrl`
 * to '' as the error unwinds out of the router, so it cannot supply the mount
 * prefix by the time this runs. The pattern's segments are therefore swapped
 * over the same number of trailing segments of the concrete path.
 *
 * Falls back to the concrete path — minus its query string, which is where
 * search terms live — whenever no route matched (an error raised in middleware
 * before routing) or the pattern is longer than the path it supposedly matched.
 */
function routeOf(req: Request): string {
  const [pathname = req.originalUrl] = req.originalUrl.split('?');
  const pattern: unknown = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern !== 'string' || pattern.length === 0) return pathname;

  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  if (patternSegments.length > pathSegments.length) return pathname;

  const prefix = pathSegments.slice(0, pathSegments.length - patternSegments.length);
  return `/${[...prefix, ...patternSegments].join('/')}`;
}

/**
 * The per-request correlation ID pino-http assigns (it also stamps it on every
 * log line), so an operator can pivot from a Sentry event straight to the
 * request's log entries. Read defensively: it is attached by middleware, not
 * guaranteed by Express's own types.
 */
function requestIdOf(req: Request): string | undefined {
  const id: unknown = (req as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

/**
 * Terminal error handler. Must be mounted LAST. Converts any thrown error into
 * an `application/problem+json` body, logs the full error (stack included) for
 * operators, and leaks nothing sensitive to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const problem: ProblemDetails =
    err instanceof HttpProblem
      ? {
          type: err.type,
          title: err.title,
          status: err.status,
          detail: err.detail,
          instance: req.originalUrl,
        }
      : {
          // Unknown errors are 500s. We deliberately do not echo the message —
          // it may contain internal detail — only a generic title.
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          instance: req.originalUrl,
        };

  // Full error (with stack) goes to the logs only, never the response body.
  if (problem.status >= 500) {
    logger.error({ err, req: { method: req.method, url: req.originalUrl } }, 'request failed');
    // Server faults are also reported to Sentry (H-7) — a no-op unless a DSN is
    // configured, see lib/sentry.ts. 5xx only: a 4xx is a caller mistake, not a
    // defect, and `HttpProblem.detail` on a 4xx is the field most likely to
    // quote patient-identifying input back. Deliberately BEFORE the response is
    // written, but synchronous and non-throwing, so it cannot alter or delay
    // the Problem Details body below.
    captureProblem(err, {
      method: req.method,
      route: routeOf(req),
      status: problem.status,
      requestId: requestIdOf(req),
    });
  } else {
    logger.warn(
      { err, req: { method: req.method, url: req.originalUrl } },
      'request rejected',
    );
  }

  res.status(problem.status).type('application/problem+json').json(problem);
};
