// Audit middleware integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// These exercise the full HTTP -> audit middleware -> Prisma -> Postgres path
// via Supertest. They need `docker compose up -d` (or CI's postgres service),
// the applied `add_audit_log` migration, and a valid DATABASE_URL. All three
// tables are truncated before each test so cases don't leak state.
//
// What we assert: every mutating request writes exactly one audit row, reads
// write none, and NO PII (e.g. the patient's name) ever reaches the audit table
// (Kenya Data Protection Act, 2019).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createActor } from './helpers/auth.js';

const app = createApp();

// A patient whose name we later assert never appears in any audit row.
const validPatient = {
  firstName: 'Wanjiku',
  lastName: 'Kamau',
  dateOfBirth: '1988-03-09',
  sex: 'FEMALE',
  phone: '+254712345678',
};

// The acting user for every request below. Its id is what the audit trail must
// now record as actorId, the seam from #8 filled by authenticate (#12).
let authHeader: { Authorization: string };
let actorId: string;

describe('Audit middleware (/api/v1)', () => {
  beforeEach(async () => {
    // One TRUNCATE for all tables. RESTART IDENTITY/CASCADE keep each test
    // isolated; CASCADE also clears the patient->appointment FK chain. users +
    // refresh_tokens (FK -> users, child first) are cleared for the per-test
    // actor created next.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs", "refresh_tokens", "appointments", "patients", "users" RESTART IDENTITY CASCADE',
    );
    const actor = await createActor('ADMIN');
    authHeader = actor.authHeader;
    actorId = actor.user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('writes one CREATE audit row for a patient POST (201)', async () => {
    const res = await request(app)
      .post('/api/v1/patients')
      .set(authHeader)
      .send(validPatient);
    expect(res.status).toBe(201);

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'CREATE',
      entity: 'patient',
      entityId: res.body.id,
      method: 'POST',
      path: '/api/v1/patients',
      statusCode: 201,
      // The actor is now resolved by authenticate (#12) — no longer null.
      actorId,
    });
  });

  it('writes a DELETE audit row for a patient DELETE (204)', async () => {
    const created = await request(app)
      .post('/api/v1/patients')
      .set(authHeader)
      .send(validPatient);
    const { id } = created.body;

    const del = await request(app).delete(`/api/v1/patients/${id}`).set(authHeader);
    expect(del.status).toBe(204);

    const deleteRows = await prisma.auditLog.findMany({
      where: { action: 'DELETE' },
    });
    expect(deleteRows).toHaveLength(1);
    expect(deleteRows[0]).toMatchObject({
      action: 'DELETE',
      entity: 'patient',
      // entityId is recovered from the path :id even with no res.locals hook.
      entityId: id,
      method: 'DELETE',
      statusCode: 204,
      // The acting ADMIN is recorded as the actor (#12).
      actorId,
    });
  });

  it('writes NO audit row for a read (GET)', async () => {
    const created = await request(app)
      .post('/api/v1/patients')
      .set(authHeader)
      .send(validPatient);

    // Reads must never be audited: list + fetch-by-id.
    await request(app).get('/api/v1/patients').set(authHeader);
    await request(app).get(`/api/v1/patients/${created.body.id}`).set(authHeader);

    // Only the single CREATE from the POST above should exist.
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('CREATE');
  });

  it('stores no PII — the patient name appears in no audit row', async () => {
    const created = await request(app)
      .post('/api/v1/patients')
      .set(authHeader)
      .send(validPatient);
    await request(app)
      .patch(`/api/v1/patients/${created.body.id}`)
      .set(authHeader)
      .send({ lastName: 'Kamau-Njoroge' });
    await request(app).delete(`/api/v1/patients/${created.body.id}`).set(authHeader);

    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(3); // CREATE + UPDATE + DELETE

    // Serialise every audit row and assert no name/PII leaked into any field.
    const haystack = JSON.stringify(rows);
    expect(haystack).not.toContain(validPatient.firstName);
    expect(haystack).not.toContain(validPatient.lastName);
    expect(haystack).not.toContain('Kamau-Njoroge');
    expect(haystack).not.toContain(validPatient.phone);
  });
});
