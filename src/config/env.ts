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

const envSchema = z.object({
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
