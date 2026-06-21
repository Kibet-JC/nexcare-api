// Vitest globalSetup — runs ONCE in the main process before any test worker.
//
// This is where the isolated test database is provisioned and migrated, so the
// suite never touches nexcare_dev (the caveat from #6 where tests truncated the
// dev database). Two steps:
//
//   1. Connect to the server's maintenance `postgres` database and
//      `CREATE DATABASE nexcare_test` if it does not already exist. We use a
//      throwaway PrismaClient with a datasource override rather than the app
//      singleton, so this never imports/locks src/config/env.ts. `pg` is not a
//      dependency, so Prisma is our Postgres client here.
//   2. Shell out to `prisma migrate deploy` with DATABASE_URL pointed at the
//      test database, applying the committed migrations to it.
//
// NOTE: setting process.env here does NOT reach the test workers (globalSetup
// runs in a different process). Repointing DATABASE_URL for the workers happens
// in the setupFile (tests/setup/reset-db.ts), which runs inside each worker.
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  TEST_DATABASE_NAME,
  serverDatabaseUrl,
  testDatabaseUrl,
} from './test-db-url.js';

async function ensureTestDatabaseExists(): Promise<void> {
  // Datasource override ("db" matches the datasource block in schema.prisma)
  // points this client at the maintenance database, not at nexcare_dev.
  const admin = new PrismaClient({
    datasources: { db: { url: serverDatabaseUrl() } },
  });
  try {
    // CREATE DATABASE cannot run inside a transaction and Postgres has no
    // "IF NOT EXISTS" for it that plays nicely everywhere, so we just attempt
    // it and treat "already exists" (SQLSTATE 42P04) as success. The name is a
    // fixed constant, not user input, so interpolation here is safe.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
  } catch (error) {
    const code = (error as { code?: string; meta?: { code?: string } })?.meta?.code;
    const message = error instanceof Error ? error.message : String(error);
    const alreadyExists = code === '42P04' || /already exists/i.test(message);
    if (!alreadyExists) throw error;
  } finally {
    await admin.$disconnect();
  }
}

function migrateTestDatabase(): void {
  // Apply committed migrations to the test database. We pass DATABASE_URL only
  // for this child process; the main process env is left untouched.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  });
}

export default async function setup(): Promise<void> {
  await ensureTestDatabaseExists();
  migrateTestDatabase();
}
