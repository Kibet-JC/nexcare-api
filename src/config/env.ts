// Validated, typed environment configuration with fail-fast behaviour.
//
// Every external boundary in NexCare is validated (CLAUDE.md §4.1) — the
// process environment is no exception. This module parses `process.env` once,
// at import time, against a Zod schema. If anything is missing or malformed the
// import throws immediately, so a misconfigured deploy fails on boot rather
// than at the first request that happens to need the bad value.
//
// Import this module's `env` export instead of reaching for `process.env`
// elsewhere: downstream code gets a typed, frozen object and never re-validates.
import 'dotenv/config';
import { z } from 'zod';

// dotenv is loaded via the side-effecting `dotenv/config` import above. By
// design it does NOT override variables already present in process.env, so real
// environment values (e.g. Railway in production) always win over a local .env.

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    // PostgreSQL connection string consumed by Prisma (see prisma/schema.prisma).
    // Required and non-empty: a missing or blank DATABASE_URL must fail the
    // process on boot rather than surfacing as an opaque connection error on the
    // first query. No default — the value differs per environment and a wrong
    // default would silently point at the wrong database.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').url(),
    // HS256 signing secret for short-lived JWT access tokens (#11). Required and
    // at least 32 chars so the key has enough entropy to resist brute force; a
    // missing or weak secret must fail the process on boot, never at first login.
    // Never logged (see lib/logger redaction) and never embedded in a token.
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    // Comma-separated EXACT browser origins allowed to call the API with
    // credentials (CORS). Parsed and hardened by the transform below.
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    // Sentry ingest DSN (H-7). OPTIONAL and off by default: unset means the
    // SDK is never even loaded (see lib/sentry.ts), which is the state
    // development, test and CI run in. An empty or whitespace-only value is
    // treated as unset — Railway variables are easy to blank, and a blank
    // string must mean "off", not "boot failure". A non-empty value that is not
    // a URL IS a boot failure: a typo'd DSN would otherwise fail silently at
    // the first 500, exactly when the reporting is needed.
    SENTRY_DSN: z.preprocess(
      (value) =>
        typeof value === 'string' && value.trim() === '' ? undefined : value,
      z
        .string()
        .url('SENTRY_DSN must be a valid DSN URL (https://<key>@<host>/<project>)')
        .optional(),
    ),
    // Version stamp for Sentry events. Explicit override first; otherwise the
    // commit SHA Railway injects into the running container. Both optional —
    // events are still useful without a release, just harder to bisect.
    SENTRY_RELEASE: z.string().optional(),
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  })
  .transform((cfg, ctx) => {
    // CORS allowlist hardening. The public API is called with credentials
    // (HttpOnly refresh cookie), so a sloppy origin here would hand every
    // browser session to an attacker's page. Rules, enforced at boot:
    //   - wildcards are forbidden anywhere, in any environment;
    //   - each entry must be an exact http(s) origin — scheme://host[:port],
    //     no path, no trailing slash (checked via URL#origin round-trip);
    //   - unset means the Vite dev origin in development/test, but an EMPTY
    //     list in production: cross-origin stays off until an origin is
    //     deliberately configured (fail closed), e.g. the Vercel URL later.
    const raw =
      cfg.CORS_ALLOWED_ORIGINS ??
      (cfg.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
    const origins = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (const origin of origins) {
      if (origin.includes('*')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `wildcard origins are forbidden (got "${origin}")`,
        });
        continue;
      }
      let isExactOrigin = false;
      try {
        const url = new URL(origin);
        isExactOrigin =
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.origin === origin;
      } catch {
        isExactOrigin = false;
      }
      if (!isExactOrigin) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `"${origin}" must be an exact http(s) origin (scheme://host[:port], no path or trailing slash)`,
        });
      }
    }

    return { ...cfg, CORS_ALLOWED_ORIGINS: Object.freeze(origins) };
  });

/** The validated shape of the process environment NexCare depends on. */
export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Turn Zod's issue list into a readable, one-line-per-variable summary so the
  // boot failure points straight at the offending variable(s).
  const details = parsed.error.issues
    .map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${details}`);
}

/** Typed, frozen environment configuration. Import this, not `process.env`. */
export const env: Readonly<Env> = Object.freeze(parsed.data);
