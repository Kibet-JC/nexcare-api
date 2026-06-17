// Reusable Zod validation middleware.
//
// Every external boundary is validated (CLAUDE.md §4.1). This factory wraps a
// Zod schema as Express middleware: it parses the chosen request source and, on
// failure, throws an RFC 7807 HttpProblem(400) carrying a field-by-field issue
// list so clients get actionable, uniform validation errors. On success it
// hands the parsed (and coerced) value back to downstream handlers so they
// consume validated data, not raw input.
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { HttpProblem } from './problem.js';

/** Which part of the request to validate. */
export type ValidationSource = 'body' | 'params' | 'query';

// Express 5's `req.query` is a read-only getter that re-parses on every access,
// so a validated/coerced query object cannot be written back onto it (unlike
// `body` and `params`). We stash the parsed query here instead; handlers read
// `req.validatedQuery` to get the coerced values (e.g. numeric limit/offset).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validatedQuery?: unknown;
    }
  }
}

/**
 * Build middleware that validates `req[source]` against `schema`. The parsed
 * result is handed downstream: `body`/`params` are replaced in place, while the
 * validated `query` is exposed on `req.validatedQuery` (see note above).
 */
export function validate(schema: ZodType, source: ValidationSource): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      // Flatten Zod's issue list into a readable "field: message" summary. We
      // surface field paths (no values) so the response stays free of any PII
      // the caller may have submitted.
      const detail = result.error.issues
        .map((issue) => {
          const path = issue.path.join('.') || '(root)';
          return `${path}: ${issue.message}`;
        })
        .join('; ');

      next(new HttpProblem(400, 'Validation Failed', detail));
      return;
    }

    if (source === 'query') {
      req.validatedQuery = result.data;
    } else {
      req[source] = result.data;
    }

    next();
  };
}
