import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';

// Integration test: no mocks (CLAUDE.md §4.2). This talks to a real Postgres
// using the shared Prisma client, proving the connection string, the generated
// client, and the running database all line up. It needs `docker compose up -d`
// (or CI's postgres service) and a valid DATABASE_URL; without them it fails,
// which is the point — it verifies real connectivity, not a stub.
describe('database connectivity', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('executes SELECT 1 against the live database', async () => {
    const rows = await prisma.$queryRaw<Array<{ result: number }>>`SELECT 1 AS result`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe(1);
  });
});
