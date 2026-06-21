// Rate limiting — the brute-force / abuse defence deferred from #3 (CLAUDE.md
// §4.2: express-rate-limit is part of the locked stack). Two limiters are wired
// in src/app.ts: a broad API limiter and a strict limiter on the auth surface.
//
// Design notes:
//  - Limit hits return RFC 7807 (`application/problem+json`, 429) like every
//    other error in NexCare, via a custom handler that delegates to HttpProblem
//    through the terminal error handler (lib/problem.ts). express-rate-limit's
//    default handler would send plain text, which would break the contract.
//  - standardHeaders advertises the limit via the `RateLimit-*` headers (the
//    draft standard); the legacy `X-RateLimit-*` headers are suppressed.
//  - In the test environment the limiters SKIP entirely: the shared integration
//    suite makes many auth calls and would otherwise trip the strict limiter.
//    The limiter behaviour itself is proven in tests/security.test.ts, which
//    builds its own low-limit limiter with skip disabled.
//  - Client IP keying relies on Express's `trust proxy` setting (configured in
//    src/app.ts to 1 in production, off otherwise) so that behind Railway's
//    proxy (#16) the real client IP is used, and in dev a spoofed
//    X-Forwarded-For cannot be used to evade or poison the limits.
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../config/env.js';
import { HttpProblem } from '../lib/problem.js';

interface RateLimiterOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per IP within the window. */
  max: number;
  /** Human-readable detail placed in the 429 Problem Details body. */
  detail: string;
  /**
   * Whether to skip the limiter when NODE_ENV === 'test'. Defaults to true so
   * the shared integration suite is never throttled; the dedicated rate-limit
   * test passes `false` to exercise the real limiting path.
   */
  skipInTest?: boolean;
}

/**
 * Factory over express-rate-limit that bakes in NexCare's conventions: RFC 7807
 * 429 responses, the draft standard headers, and test-environment skipping.
 */
export function createRateLimiter(
  options: RateLimiterOptions,
): RateLimitRequestHandler {
  const { windowMs, max, detail, skipInTest = true } = options;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Forward a well-formed Problem Details error to the terminal handler so the
    // body is `application/problem+json` with status 429.
    handler: (_req, _res, next) => {
      next(new HttpProblem(429, 'Too Many Requests', detail));
    },
    skip: () => skipInTest && env.NODE_ENV === 'test',
  });
}

/**
 * Broad limiter for the whole API surface: 100 requests / minute / IP. Catches
 * runaway clients and crude scraping without getting in the way of normal use.
 */
export const apiRateLimiter: RateLimitRequestHandler = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  detail: 'API rate limit exceeded. Please retry later.',
});

/**
 * Strict limiter for the auth surface (login / refresh): 10 requests /
 * 15 minutes / IP. Tight enough to blunt credential brute-forcing while leaving
 * room for a legitimate user fumbling their password a few times.
 */
export const authRateLimiter: RateLimitRequestHandler = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  detail: 'Too many authentication attempts. Please retry later.',
});
