// Appointment module integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// These exercise the full HTTP -> validate -> service -> Prisma -> Postgres path
// via Supertest. They need `docker compose up -d` (or CI's postgres service), an
// applied `add_appointment` migration, and a valid DATABASE_URL. Both tables are
// truncated before each test (appointments first, then patients — FK order) so
// cases don't leak state into one another, then a patient fixture is seeded for
// the tests to reference.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createActor } from './helpers/auth.js';

const app = createApp();

// Seeded fresh before each test; its id is the patient the bookings reference.
let patientId: string;

// All appointment routes are now behind authenticate + requireRole (#12). An
// ADMIN actor satisfies every appointment route, so these existing happy paths
// keep exercising the handler logic, not the auth gate.
let authHeader: { Authorization: string };

// The ADMIN actor's user id, used as `grantedById` when seeding the consent the
// booking gate (#13) now requires.
let actorId: string;

// Grant a patient the ACTIVE DATA_PROCESSING consent that createAppointment now
// requires (#13), so the booking happy paths below still succeed. Writes the
// row directly — the consent routes have their own coverage in consent.test.ts.
function grantDataProcessingConsent(targetPatientId: string): Promise<unknown> {
  return prisma.consentRecord.create({
    data: {
      patientId: targetPatientId,
      grantedById: actorId,
      type: 'DATA_PROCESSING',
    },
  });
}

// A valid create body, completed with the seeded patientId inside each test.
const validAppointment = {
  scheduledFor: '2026-07-01T09:30:00.000Z',
  durationMinutes: 30,
  reason: 'Initial consultation',
};

describe('Appointment API (/api/v1/appointments)', () => {
  beforeEach(async () => {
    // CASCADE + correct FK order: appointments reference patients, so truncate
    // the child table first. RESTART IDENTITY keeps each test fully isolated.
    // Also clear users/audit_logs (the per-test actor + audited mutations) and
    // refresh_tokens (FK -> users) first.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs", "refresh_tokens", "consent_records", "appointments", "patients", "users" RESTART IDENTITY CASCADE',
    );
    const actor = await createActor('ADMIN');
    authHeader = actor.authHeader;
    actorId = actor.user.id;

    const patient = await prisma.patient.create({
      data: {
        firstName: 'Amani',
        lastName: 'Otieno',
        dateOfBirth: new Date('1990-05-14'),
        sex: 'FEMALE',
        phone: '+254712345678',
      },
    });
    patientId = patient.id;

    // The default patient carries an active DATA_PROCESSING consent so the
    // existing booking happy paths still pass under the new consent gate (#13).
    await grantDataProcessingConsent(patientId);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('books an appointment for an existing patient (201)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      patientId,
      durationMinutes: 30,
      reason: 'Initial consultation',
      status: 'SCHEDULED',
      deletedAt: null,
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
  });

  it('returns 404 (not 500) when booking for an unknown patientId', async () => {
    const res = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId: 'cldoesnotexist0000000000000' });

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404 });
    expect(res.body.detail).toMatch(/patient/i);
  });

  it('returns 404 when booking for a soft-deleted patient', async () => {
    await prisma.patient.update({
      where: { id: patientId },
      data: { deletedAt: new Date() },
    });

    const res = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404 });
  });

  it('returns 422 when booking for a patient with no active consent (#13)', async () => {
    // A fresh patient with NO consent on file; the gate must refuse the booking.
    const noConsent = await prisma.patient.create({
      data: {
        firstName: 'Cynthia',
        lastName: 'Wanjiru',
        dateOfBirth: new Date('1992-09-09'),
        sex: 'FEMALE',
      },
    });

    const res = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId: noConsent.id });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: 'Consent Required', status: 422 });
    expect(res.body.detail).toMatch(/consent/i);
  });

  it('fetches an appointment by id (200)', async () => {
    const created = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId });
    const { id } = created.body;

    const res = await request(app).get(`/api/v1/appointments/${id}`).set(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.patientId).toBe(patientId);
  });

  it('lists appointments filtered by patientId (200)', async () => {
    // A second patient with their own booking, to prove the filter excludes it.
    const other = await prisma.patient.create({
      data: {
        firstName: 'Brian',
        lastName: 'Kamau',
        dateOfBirth: new Date('1985-02-02'),
        sex: 'MALE',
      },
    });
    // The second patient also needs consent to be bookable under the #13 gate.
    await grantDataProcessingConsent(other.id);
    await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId });
    await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId: other.id });

    const res = await request(app)
      .get('/api/v1/appointments')
      .set(authHeader)
      .query({ patientId });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].patientId).toBe(patientId);
  });

  it('updates an appointment status (200) and the change is reflected', async () => {
    const created = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId });
    const { id } = created.body;

    const res = await request(app)
      .patch(`/api/v1/appointments/${id}`)
      .set(authHeader)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const refetch = await request(app).get(`/api/v1/appointments/${id}`).set(authHeader);
    expect(refetch.body.status).toBe('COMPLETED');
  });

  it('soft-deletes an appointment (204), then GET returns 404 but the row persists', async () => {
    const created = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send({ ...validAppointment, patientId });
    const { id } = created.body;

    const del = await request(app).delete(`/api/v1/appointments/${id}`).set(authHeader);
    expect(del.status).toBe(204);

    // Invisible to the API...
    const res = await request(app).get(`/api/v1/appointments/${id}`).set(authHeader);
    expect(res.status).toBe(404);

    // ...but the row is retained in the database with deletedAt set.
    const row = await prisma.appointment.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects a create missing patientId (400)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments')
      .set(authHeader)
      .send(validAppointment);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: 'Validation Failed', status: 400 });
  });
});
