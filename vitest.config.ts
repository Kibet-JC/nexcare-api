import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests run against a single shared Postgres (CLAUDE.md §4.2 —
    // no mocks). Each suite TRUNCATEs its tables in `beforeEach`, so running
    // test files in parallel would let one file wipe another's rows mid-test.
    // Run files serially to keep that real-DB state isolated per file.
    fileParallelism: false,
  },
});
