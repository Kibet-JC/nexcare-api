import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // globalSetup runs ONCE in the main process: it provisions and migrates the
    // isolated nexcare_test database (tests/setup/global-setup.ts) so the suite
    // never touches nexcare_dev.
    globalSetup: ['./tests/setup/global-setup.ts'],
    // setupFiles run in EACH worker: tests/setup/reset-db.ts repoints
    // DATABASE_URL at nexcare_test (before env/prisma load) and registers the
    // global beforeEach that truncates every application table for isolation.
    setupFiles: ['./tests/setup/reset-db.ts'],
    // The global beforeEach truncates shared tables, so files must not run
    // against the same database concurrently — keep them serial.
    fileParallelism: false,
  },
});
