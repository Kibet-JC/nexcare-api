// Zod schemas for the Consent module — the single source of truth for what the
// API accepts at the HTTP boundary (CLAUDE.md §4.1: validate every input).
//
// These power the `validate` middleware on each consent route and also export
// inferred TypeScript types the service layer consumes, so the contract and the
// types never drift apart. Mirrors src/modules/patient/patient.schema.ts.
import { z } from 'zod';

/** Mirrors the Prisma `ConsentType` enum; kept in lockstep with schema.prisma. */
export const consentTypeSchema = z.enum([
  'DATA_PROCESSING',
  'TREATMENT',
  'TELEMEDICINE',
]);

/** Mirrors the Prisma `ConsentMethod` enum; kept in lockstep with schema.prisma. */
export const consentMethodSchema = z.enum(['VERBAL', 'WRITTEN', 'ELECTRONIC']);

// An expiry, when supplied, must be a real datetime in the future — a consent
// that is already expired at the moment it is recorded would never be active.
const expiresAtSchema = z.coerce
  .date({ message: 'expiresAt must be a valid datetime' })
  .min(new Date(), { message: 'expiresAt must be in the future' });

/**
 * Body schema for recording a consent. `type` is required; `method` defaults to
 * VERBAL at the database layer (so it is optional here); `expiresAt` and
 * `policyVersion` are optional. `.strict()` rejects unknown keys so typos and
 * unsupported fields fail loudly rather than being silently dropped.
 */
export const createConsentSchema = z
  .object({
    type: consentTypeSchema,
    method: consentMethodSchema.optional(),
    expiresAt: expiresAtSchema.optional(),
    policyVersion: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Path-parameter schema for the patient-scoped collection. The router mounts at
 * /api/v1/patients/:patientId/consents with { mergeParams: true }, so
 * `patientId` is read from the parent route here.
 */
export const patientIdParamSchema = z
  .object({
    patientId: z.string().min(1, 'patientId is required'),
  })
  .strict();

/** Path-parameter schema for a single consent under a patient. */
export const consentIdParamSchema = z
  .object({
    patientId: z.string().min(1, 'patientId is required'),
    consentId: z.string().min(1, 'consentId is required'),
  })
  .strict();

export type CreateConsentInput = z.infer<typeof createConsentSchema>;
