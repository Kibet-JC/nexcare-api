// Seed script integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// These verify the dev seed both works (it inserts patients and appointments)
// and is safe (it refuses to run in production before touching any data). They
// need `docker compose up -d` (or CI's postgres service), the migrations
// applied, and a valid DATABASE_URL.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { seedDatabase } from '../prisma/seed.js';
import { prisma } from '../src/lib/prisma.js';

describe('seedDatabase', () => {
  afterEach(async () => {
    // Keep the suite isolated: clear the three tables the seed touches. CASCADE
    // + FK order (children before parents) and RESTART IDENTITY mirror the seed.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs", "appointments", "patients" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('populates patients and appointments', async () => {
    const summary = await seedDatabase();

    expect(summary.patients).toBeGreaterThan(0);
    expect(summary.appointments).toBeGreaterThan(0);

    const patients = await prisma.patient.count();
    const appointments = await prisma.appointment.count();
    expect(patients).toBe(summary.patients);
    expect(appointments).toBe(summary.appointments);
  });

  it('refuses to run when NODE_ENV is "production"', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedDatabase()).rejects.toThrow(/production/i);
      // The guard must fire before any data is touched.
      expect(await prisma.patient.count()).toBe(0);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
