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

const app = createApp();

// Seeded fresh before each test; its id is the patient the bookings reference.
let patientId: string;

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
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "appointments", "patients" RESTART IDENTITY CASCADE',
    );

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
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('books an appointment for an existing patient (201)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments')
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
      .send({ ...validAppointment, patientId });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404 });
  });

  it('fetches an appointment by id (200)', async () => {
    const created = await request(app)
      .post('/api/v1/appointments')
      .send({ ...validAppointment, patientId });
    const { id } = created.body;

    const res = await request(app).get(`/api/v1/appointments/${id}`);

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
    await request(app)
      .post('/api/v1/appointments')
      .send({ ...validAppointment, patientId });
    await request(app)
      .post('/api/v1/appointments')
      .send({ ...validAppointment, patientId: other.id });

    const res = await request(app)
      .get('/api/v1/appointments')
      .query({ patientId });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].patientId).toBe(patientId);
  });

  it('updates an appointment status (200) and the change is reflected', async () => {
    const created = await request(app)
      .post('/api/v1/appointments')
      .send({ ...validAppointment, patientId });
    const { id } = created.body;

    const res = await request(app)
      .patch(`/api/v1/appointments/${id}`)
      .send({ status: 'COMPLETED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');

    const refetch = await request(app).get(`/api/v1/appointments/${id}`);
    expect(refetch.body.status).toBe('COMPLETED');
  });

  it('soft-deletes an appointment (204), then GET returns 404 but the row persists', async () => {
    const created = await request(app)
      .post('/api/v1/appointments')
      .send({ ...validAppointment, patientId });
    const { id } = created.body;

    const del = await request(app).delete(`/api/v1/appointments/${id}`);
    expect(del.status).toBe(204);

    // Invisible to the API...
    const res = await request(app).get(`/api/v1/appointments/${id}`);
    expect(res.status).toBe(404);

    // ...but the row is retained in the database with deletedAt set.
    const row = await prisma.appointment.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects a create missing patientId (400)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments')
      .send(validAppointment);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ title: 'Validation Failed', status: 400 });
  });
});
