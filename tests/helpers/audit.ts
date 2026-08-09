// Test helper for asserting on the audit trail without racing it.
//
// The audit middleware writes its row from a `res.on('finish')` handler, which
// fires AFTER the response is flushed. So a Supertest request resolving proves
// only that the client got its response — the Prisma insert may still be in
// flight. A bare `prisma.auditLog.findMany()` straight afterwards can therefore
// read before the write lands and see 0 rows instead of 1.
//
// `waitForAuditLogs` closes that gap on the test side only: it polls until the
// expected rows are actually visible in Postgres, or fails loudly at a bounded
// deadline. It changes no production behaviour — the middleware is untouched by
// this file. Polling the real table (rather than reaching into the app's
// in-process drain barrier) keeps the assertion honest end-to-end: it proves
// the row committed, not merely that a promise settled.
import type { AuditLog, Prisma } from '@prisma/client';
import { prisma } from '../../src/lib/prisma.js';

export interface WaitForAuditLogsOptions {
  /** Give up after this long. Generous enough for CI, short enough to fail fast. */
  timeoutMs?: number;
  /** Gap between polls. The first hit usually lands on the first or second try. */
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `audit_logs` until at least `expected` rows match `where`, then return
 * them. Throws at the deadline naming the filter, the expected count and the
 * actual count, so a genuine regression (the row is never written) fails with a
 * usable message instead of a bare `toHaveLength` mismatch.
 *
 * Callers should still assert the exact count afterwards where that matters —
 * this waits for "at least", so it can never mask a surplus row.
 */
export async function waitForAuditLogs(
  where: Prisma.AuditLogWhereInput,
  expected: number,
  { timeoutMs = 2000, intervalMs = 10 }: WaitForAuditLogsOptions = {},
): Promise<AuditLog[]> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const rows = await prisma.auditLog.findMany({ where });
    if (rows.length >= expected) return rows;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for ${String(expected)} ` +
          `audit row(s) matching ${JSON.stringify(where)} — found ${String(rows.length)}.`,
      );
    }
    await sleep(intervalMs);
  }
}
