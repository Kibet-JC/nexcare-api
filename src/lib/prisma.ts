// Shared PrismaClient instance for the whole process.
//
// PrismaClient holds a database connection pool, so the app must create exactly
// one. Under `tsx watch` (and Vitest's module reloading) a module can be
// re-evaluated many times; a fresh `new PrismaClient()` each time would leak
// pools and eventually exhaust Postgres connections. Caching the instance on
// `globalThis` survives those reloads so we keep a single pool.
//
// In production the module is evaluated once, so the global cache is a no-op
// there — we only populate it outside production to keep the watch/test loop
// from accumulating clients.
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** The single, shared Prisma client. Import this; never `new PrismaClient()`. */
export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
