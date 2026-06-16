// RFC 7807 Problem Details for HTTP APIs.
//
// Every error response from NexCare is serialised as `application/problem+json`
// with a stable shape so clients (and the Elara Healthcare web app) can handle
// failures uniformly. Stack traces are NEVER placed in the response body — they
// are logged server-side via pino and stay there. See CLAUDE.md §4.2.
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from './logger.js';

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
  } else {
    logger.warn(
      { err, req: { method: req.method, url: req.originalUrl } },
      'request rejected',
    );
  }

  res.status(problem.status).type('application/problem+json').json(problem);
};
