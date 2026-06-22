// One-off production admin bootstrap.
//
// The dev seed (prisma/seed.ts) deliberately refuses to run when
// NODE_ENV=production — it truncates tables and must never touch a real
// clinical database. That leaves a gap: a fresh production deploy has no way to
// create its first staff account. This script fills exactly that gap and
// nothing more.
//
// It reads ADMIN_EMAIL and ADMIN_PASSWORD from the environment, creates a single
// ADMIN user through the user service (so the password goes through the same
// argon2id hashing and the same password policy as every other account), and
// exits. It is the SUPPORTED path for creating the first production admin —
// unlike the seed, it intentionally does NOT refuse in production; that is its
// whole purpose.
//
// Idempotent: run it twice and the second run is a no-op. createUser surfaces a
// duplicate email as a 409 Conflict, which we treat as "already bootstrapped"
// and exit 0, so a redeploy that re-runs the bootstrap never fails.
//
// This file lives under src/ so tsconfig.build.json compiles it to
// dist/scripts/create-admin.js and the production image can run it with node —
// the runtime image ships compiled JS only, never .ts source or tsx.
//
// Run on Railway as a one-off:  pnpm create-admin:prod
// (with ADMIN_EMAIL / ADMIN_PASSWORD set in the environment).
import { fileURLToPath } from 'node:url';
import { createUser } from '../modules/user/user.service.js';
import { HttpProblem } from '../lib/problem.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

async function createAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;

  // Fail fast and loudly if the bootstrap inputs are missing. We never invent a
  // default password — that would silently create a known-credentials admin on
  // a real database. ADMIN_PASSWORD is read raw (not trimmed): surrounding
  // whitespace is a legitimate part of a password and the policy validates it.
  if (!email || !password) {
    throw new Error(
      'ADMIN_EMAIL and ADMIN_PASSWORD must both be set to bootstrap the admin user.',
    );
  }

  try {
    // role is explicit: this is the first ADMIN, not the least-privileged
    // default. The service validates the email and enforces the password policy
    // before hashing with argon2id; a weak password fails here, never reaching
    // the database.
    const user = await createUser({ email, password, role: 'ADMIN' });
    // Log identifiers only (CLAUDE.md §4.1) — never the password or hash.
    logger.info(
      { userId: user.id, email: user.email, role: user.role },
      'admin user created',
    );
  } catch (error) {
    // A 409 means an account with this email already exists — the database is
    // already bootstrapped. Treat that as success so re-running the one-off (or
    // a redeploy that triggers it again) is a safe no-op rather than a failure.
    if (error instanceof HttpProblem && error.status === 409) {
      logger.info({ email }, 'admin user already exists — nothing to do');
      return;
    }
    throw error;
  }
}

// Always release the database pool, then surface any failure as a non-zero exit
// so the one-off command fails visibly in the Railway logs.
async function main(): Promise<void> {
  try {
    await createAdmin();
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'admin bootstrap failed');
    process.exitCode = 1;
  });
}
