// Consent service — the data-access layer for the Consent module (#13).
//
// All persistence goes through the shared Prisma singleton (CLAUDE.md §4.2:
// never `new PrismaClient()`). The HTTP layer (routes) stays thin; the business
// rules — patient existence, append-only revocation, and the active-consent
// test that gates appointment booking — live here so every caller (the consent
// routes and the appointment service) gets the same guarantees.
//
// Consent is append-only (CLAUDE.md §4.2): a grant is one row, and a revocation
// stamps `revokedAt`/`revokedById` on that row rather than deleting it, so the
// full consent history is retained for audit.
import type { ConsentRecord, ConsentType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpProblem } from '../../lib/problem.js';
import type { CreateConsentInput } from './consent.schema.js';

/** Only active (non-soft-deleted) patients may have consent recorded against them. */
const ACTIVE_PATIENT = { deletedAt: null } as const;

/**
 * Guard that a patient exists and is active. Throws 404 (not a raw FK error) so
 * recording consent against a missing/soft-deleted patient fails gracefully.
 */
async function assertPatientActive(patientId: string): Promise<void> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, ...ACTIVE_PATIENT },
  });

  if (!patient) {
    throw new HttpProblem(
      404,
      'Not Found',
      `No patient with id ${patientId}; cannot record consent`,
    );
  }
}

/**
 * Record a consent for a patient. `actorId` is the staff member capturing it
 * (`grantedById`), so the act is attributable. Verifies the patient is active
 * first so a bad patientId 404s rather than 500-ing on a foreign-key error.
 */
export async function recordConsent(
  patientId: string,
  actorId: string,
  input: CreateConsentInput,
): Promise<ConsentRecord> {
  await assertPatientActive(patientId);

  return prisma.consentRecord.create({
    data: {
      patientId,
      grantedById: actorId,
      type: input.type,
      method: input.method,
      expiresAt: input.expiresAt,
      policyVersion: input.policyVersion,
    },
  });
}

/** Return a patient's consent records, newest grant first. */
export function listConsentsForPatient(
  patientId: string,
): Promise<ConsentRecord[]> {
  return prisma.consentRecord.findMany({
    where: { patientId },
    orderBy: { grantedAt: 'desc' },
  });
}

/**
 * Revoke a consent: stamp `revokedAt`/`revokedById`. Throws 404 if no such
 * consent exists for the patient. Idempotent-safe: revoking an already-revoked
 * consent preserves the original revocation timestamp (a no-op), so a repeated
 * call never rewrites history.
 */
export async function revokeConsent(
  patientId: string,
  consentId: string,
  actorId: string,
): Promise<ConsentRecord> {
  const consent = await prisma.consentRecord.findFirst({
    where: { id: consentId, patientId },
  });

  if (!consent) {
    throw new HttpProblem(
      404,
      'Not Found',
      `No consent with id ${consentId} for patient ${patientId}`,
    );
  }

  // Already revoked: return as-is so the call is idempotent and the original
  // revoker/timestamp survive.
  if (consent.revokedAt) {
    return consent;
  }

  return prisma.consentRecord.update({
    where: { id: consentId },
    data: { revokedAt: new Date(), revokedById: actorId },
  });
}

/**
 * Whether the patient currently holds an ACTIVE consent of `type`: a record
 * that is not revoked and has not expired (`expiresAt` null = no expiry). This
 * is the gate the appointment service applies before booking (#13).
 */
export async function hasActiveConsent(
  patientId: string,
  type: ConsentType,
): Promise<boolean> {
  const now = new Date();

  const active = await prisma.consentRecord.findFirst({
    where: {
      patientId,
      type,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  return active !== null;
}
