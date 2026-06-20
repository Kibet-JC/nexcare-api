// RBAC integration tests (#12) — real Postgres, no mocks (CLAUDE.md §4.2).
//
// Exercises the two new middleware end-to-end through the HTTP layer: the
// authenticate gate (401 when identity can't be proven) and the requireRole
// gate (403 when an authenticated caller lacks the role). Needs `docker compose
// up -d` (or CI's postgres service), the applied migrations, a valid
// DATABASE_URL, and a JWT_ACCESS_SECRET. Relevant tables are truncated per-test.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createActor } from './helpers/auth.js';

const app = createApp();

// A patient row to target with DELETE. Created directly (not via the API) so a
// failed authorization can't be confused with a missing resource.
async function seedPatient(): Promise<string> {
  const patient = await prisma.patient.create({
    data: {
      firstName: 'Amani',
      lastName: 'Otieno',
      dateOfBirth: new Date('1990-05-14'),
      sex: 'FEMALE',
      phone: '+254712345678',
    },
  });
  return patient.id;
}

describe('RBAC (authenticate + requireRole)', () => {
  beforeEach(async () => {
    // FK order: refresh_tokens -> users, appointments -> patients. CASCADE +
    // RESTART IDENTITY isolate each test.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs", "refresh_tokens", "appointments", "patients", "users" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects a protected route with NO token (401)', async () => {
    const res = await request(app).get('/api/v1/patients');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: 'Unauthorized', status: 401 });
  });

  it('rejects a protected route with a garbage token (401)', async () => {
    const res = await request(app)
      .get('/api/v1/patients')
      .set({ Authorization: 'Bearer not-a-real-jwt' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 401 });
  });

  it('forbids a RECEPTIONIST from DELETE /patients/:id (403)', async () => {
    const id = await seedPatient();
    const { authHeader } = await createActor('RECEPTIONIST');

    const res = await request(app)
      .delete(`/api/v1/patients/${id}`)
      .set(authHeader);

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: 'Forbidden', status: 403 });

    // The row was NOT soft-deleted — authorization stopped before the handler.
    const row = await prisma.patient.findUnique({ where: { id } });
    expect(row?.deletedAt).toBeNull();
  });

  it('allows an ADMIN to DELETE /patients/:id (204)', async () => {
    const id = await seedPatient();
    const { authHeader } = await createActor('ADMIN');

    const res = await request(app)
      .delete(`/api/v1/patients/${id}`)
      .set(authHeader);

    expect(res.status).toBe(204);

    // Soft-deleted: the row persists with deletedAt set.
    const row = await prisma.patient.findUnique({ where: { id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('returns the caller (no passwordHash) from GET /auth/me with a valid token (200)', async () => {
    const { user, authHeader } = await createActor('CLINICIAN');

    const res = await request(app).get('/api/v1/auth/me').set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user.role).toBe('CLINICIAN');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });
});
