// Patient module integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// These exercise the full HTTP -> validate -> service -> Prisma -> Postgres path
// via Supertest. They need `docker compose up -d` (or CI's postgres service), an
// applied `add_patient` migration, and a valid DATABASE_URL. The patients table
// is truncated before each test so cases don't leak state into one another.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createActor } from './helpers/auth.js';

const app = createApp();

// A valid create body reused across tests.
const validPatient = {
  firstName: 'Amani',
  lastName: 'Otieno',
  dateOfBirth: '1990-05-14',
  sex: 'FEMALE',
  phone: '+254712345678',
};

// All patient routes are now behind authenticate + requireRole (#12). An ADMIN
// actor (created per-test) satisfies every patient route, so these existing
// happy paths keep exercising the handler logic, not the auth gate.
let authHeader: { Authorization: string };

describe('Patient API (/api/v1/patients)', () => {
  beforeEach(async () => {
    // RESTART IDENTITY/CASCADE keep each test isolated. Also truncate users +
    // audit_logs: the per-test actor inserts a user row, and mutating requests
    // now append audit rows. refresh_tokens (FK -> users) first for safety.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs", "refresh_tokens", "patients", "users" RESTART IDENTITY CASCADE',
    );
    ({ authHeader } = await createActor('ADMIN'));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a patient (201) and returns the persisted row', async () => {
    const res = await request(app).post('/api/v1/patients').set(authHeader).send(validPatient);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      firstName: 'Amani',
      lastName: 'Otieno',
      sex: 'FEMALE',
      phone: '+254712345678',
      deletedAt: null,
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });

  it('fetches a patient by id (200)', async () => {
    const created = await request(app).post('/api/v1/patients').set(authHeader).send(validPatient);
    const { id } = created.body;

    const res = await request(app).get(`/api/v1/patients/${id}`).set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.firstName).toBe('Amani');
  });

  it('lists patients and includes a created one (200)', async () => {
    const created = await request(app).post('/api/v1/patients').set(authHeader).send(validPatient);

    const res = await request(app).get('/api/v1/patients').set(authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(created.body.id);
  });

  it('updates a patient (200) and the change is reflected', async () => {
    const created = await request(app).post('/api/v1/patients').set(authHeader).send(validPatient);
    const { id } = created.body;

    const res = await request(app)
      .patch(`/api/v1/patients/${id}`)
      .set(authHeader)
      .send({ lastName: 'Otieno-Mwangi' });

    expect(res.status).toBe(200);
    expect(res.body.lastName).toBe('Otieno-Mwangi');
    // Unchanged fields are untouched.
    expect(res.body.firstName).toBe('Amani');

    const refetch = await request(app).get(`/api/v1/patients/${id}`).set(authHeader);
    expect(refetch.body.lastName).toBe('Otieno-Mwangi');
  });

  it('soft-deletes a patient (204), then GET returns 404 but the row persists', async () => {
    const created = await request(app).post('/api/v1/patients').set(authHeader).send(validPatient);
    const { id } = created.body;

    const del = await request(app).delete(`/api/v1/patients/${id}`).set(authHeader);
    expect(del.status).toBe(204);

    // Invisible to the API...
    const res = await request(app).get(`/api/v1/patients/${id}`).set(authHeader);
    expect(res.status).toBe(404);

    // ...but the row is retained in the database with deletedAt set.
    const row = await prisma.patient.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects a create missing firstName (400)', async () => {
    const { firstName: _omit, ...body } = validPatient;

    const res = await request(app).post('/api/v1/patients').set(authHeader).send(body);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: 'Validation Failed', status: 400 });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .get('/api/v1/patients/cldoesnotexist0000000000000')
      .set(authHeader);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404 });
  });
});
