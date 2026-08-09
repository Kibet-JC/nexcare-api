// Vitest setupFile — runs in EVERY test worker, before the test files.
//
// Order matters. The first import repoints DATABASE_URL at nexcare_test BEFORE
// any of the imports below (or any test file) can pull in src/config/env.ts or
// the Prisma singleton, which would otherwise lock onto nexcare_dev. See
// ./use-test-db.ts for why this lives in its own side-effecting module.
import './use-test-db.js';

import { beforeEach } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { auditWritesSettled } from '../../src/middleware/audit.js';

// Centralized per-test isolation (replaces the per-file TRUNCATE blocks that
// previously lived in each integration test). We discover the application
// tables from information_schema rather than hard-coding them, so adding a model
// needs no change here. `_prisma_migrations` is Prisma's bookkeeping and must
// survive, otherwise the schema would look unmigrated.
let cachedTables: string[] | null = null;

async function applicationTables(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;
  cachedTables = rows.map((r) => r.tablename);
  return cachedTables;
}

beforeEach(async () => {
  // Drain any audit write still in flight from the PREVIOUS test before we
  // truncate. The middleware writes on response `finish`, so a test that
  // mutates without asserting on the audit trail (patient/appointment/…) can
  // leave an insert pending when it ends. Files run serially
  // (fileParallelism: false), so that straggler would otherwise land AFTER this
  // TRUNCATE and surface as a phantom row in an unrelated test. Waiting here
  // makes "every test starts from an empty database" actually true.
  await auditWritesSettled();

  const tables = await applicationTables();
  if (tables.length === 0) return;
  // One TRUNCATE across all tables: RESTART IDENTITY resets sequences and
  // CASCADE follows foreign keys, so order is irrelevant and every test starts
  // from an empty, deterministic database.
  const quoted = tables.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
});
