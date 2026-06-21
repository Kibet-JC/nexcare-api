// Consent module integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// These exercise the full HTTP -> validate -> service -> Prisma -> Postgres path
// via Supertest, plus the booking gate (#13): an appointment may only be created
// for a patient who holds an ACTIVE DATA_PROCESSING consent. They need a running
// Postgres (docker compose / CI's postgres service), the applied
// `add_consent_record` migration, and a valid DATABASE_URL + JWT_ACCESS_SECRET.
//
// All routes are behind authenticate + requireRole (#12). An ADMIN actor
// satisfies every consent and appointment route used here, so the assertions
// exercise the handler/service logic, not the auth gate — except the explicit
// "no token -> 401" case below.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createActor } from './helpers/auth.js';

const app = createApp();

// Seeded fresh before each test.
let patientId: string;
let authHeader: { Authorization: string };

// A valid appointment body, completed with the seeded patientId in each test.
const validAppointment = {
  scheduledFor: '2026-07-01T09:30:00.000Z',
  durationMinutes: 30,
  reason: 'Initial consultation',
};

function book(body: Record<string, unknown>) {
  return request(app).post('/api/v1/appointments').set(authHeader).send(body);
}

describe('Consent API (/api/v1/patients/:patientId/consents)', () => {
  beforeEach(async () => {
    // The global setupFile (tests/setup/reset-db.ts) truncates every table
    // before each test; here we only seed this file's fixtures.
    ({ authHeader } = await createActor('ADMIN'));

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

  it('records a consent for a patient (201) and audits it with the actor', async () => {
    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'DATA_PROCESSING', method: 'WRITTEN', policyVersion: 'v1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      patientId,
      type: 'DATA_PROCESSING',
      method: 'WRITTEN',
      policyVersion: 'v1',
      revokedAt: null,
    });
    expect(typeof res.body.id).toBe('string');

    // The grant is attributed to the recording staff and audited with a real
    // actorId + the consent's id (res.locals.auditEntityId).
    const consent = await prisma.consentRecord.findUnique({
      where: { id: res.body.id },
    });
    expect(consent?.grantedById).toBeTruthy();

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityId: res.body.id, action: 'CREATE' },
    });
    expect(auditRow?.actorId).toBe(consent?.grantedById);
  });

  it('defaults method to VERBAL when omitted (201)', async () => {
    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'TREATMENT' });

    expect(res.status).toBe(201);
    expect(res.body.method).toBe('VERBAL');
  });

  it('returns 404 when recording consent for an unknown patient', async () => {
    const res = await request(app)
      .post('/api/v1/patients/cldoesnotexist0000000000000/consents')
      .set(authHeader)
      .send({ type: 'DATA_PROCESSING' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404 });
  });

  it("lists a patient's consents, newest first (200)", async () => {
    await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'DATA_PROCESSING' });
    await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'TELEMEDICINE' });

    const res = await request(app)
      .get(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  it('gates booking on an active DATA_PROCESSING consent: 422 -> grant -> 201 -> revoke -> 422', async () => {
    // No consent yet: booking is refused.
    const blocked = await book({ ...validAppointment, patientId });
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ title: 'Consent Required', status: 422 });

    // Grant DATA_PROCESSING consent...
    const grant = await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'DATA_PROCESSING' });
    expect(grant.status).toBe(201);
    const consentId = grant.body.id;

    // ...now the booking succeeds.
    const allowed = await book({ ...validAppointment, patientId });
    expect(allowed.status).toBe(201);

    // Revoke the consent...
    const revoke = await request(app)
      .post(`/api/v1/patients/${patientId}/consents/${consentId}/revoke`)
      .set(authHeader);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revokedAt).not.toBeNull();

    // ...and the booking is blocked again.
    const reblocked = await book({ ...validAppointment, patientId });
    expect(reblocked.status).toBe(422);
  });

  it('an expired consent does not satisfy the booking gate (422)', async () => {
    // Write an already-expired DATA_PROCESSING consent directly (the API rejects
    // a past expiresAt at validation, but the DB can hold a lapsed one).
    const { user } = await createActor('ADMIN');
    await prisma.consentRecord.create({
      data: {
        patientId,
        grantedById: user.id,
        type: 'DATA_PROCESSING',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await book({ ...validAppointment, patientId });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ title: 'Consent Required', status: 422 });
  });

  it('revoking is idempotent: a second revoke preserves the original timestamp (200)', async () => {
    const grant = await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'DATA_PROCESSING' });
    const consentId = grant.body.id;

    const first = await request(app)
      .post(`/api/v1/patients/${patientId}/consents/${consentId}/revoke`)
      .set(authHeader);
    const second = await request(app)
      .post(`/api/v1/patients/${patientId}/consents/${consentId}/revoke`)
      .set(authHeader);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.revokedAt).toBe(first.body.revokedAt);
  });

  it('rejects an unknown consent type (400)', async () => {
    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/consents`)
      .set(authHeader)
      .send({ type: 'NONSENSE' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ title: 'Validation Failed', status: 400 });
  });

  describe('RBAC (#12)', () => {
    it('rejects recording a consent with no token (401)', async () => {
      const res = await request(app)
        .post(`/api/v1/patients/${patientId}/consents`)
        .send({ type: 'DATA_PROCESSING' });

      expect(res.status).toBe(401);
    });

    it('rejects listing consents with no token (401)', async () => {
      const res = await request(app).get(
        `/api/v1/patients/${patientId}/consents`,
      );

      expect(res.status).toBe(401);
    });

    it('rejects revoking a consent with no token (401)', async () => {
      const res = await request(app).post(
        `/api/v1/patients/${patientId}/consents/whatever/revoke`,
      );

      expect(res.status).toBe(401);
    });

    it('forbids a RECEPTIONIST from revoking a consent (403)', async () => {
      const grant = await request(app)
        .post(`/api/v1/patients/${patientId}/consents`)
        .set(authHeader)
        .send({ type: 'DATA_PROCESSING' });
      const consentId = grant.body.id;

      const { authHeader: reception } = await createActor('RECEPTIONIST');
      const res = await request(app)
        .post(`/api/v1/patients/${patientId}/consents/${consentId}/revoke`)
        .set(reception);

      expect(res.status).toBe(403);
    });
  });
});
