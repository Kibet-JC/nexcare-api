// Zod schemas for the Appointment module — the single source of truth for what
// the API accepts at the HTTP boundary (CLAUDE.md §4.1: validate every input).
//
// These power the `validate` middleware on each route and also export inferred
// TypeScript types the service layer consumes, so the contract and the types
// never drift apart. Mirrors src/modules/patient/patient.schema.ts.
import { z } from 'zod';

/** Mirrors the Prisma `AppointmentStatus` enum; kept in lockstep with schema.prisma. */
export const appointmentStatusSchema = z.enum([
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]);

// When an appointment is scheduled for. Clinical dates always carry a timezone
// (CLAUDE.md §4.2); we coerce the incoming ISO string into a Date.
const scheduledForSchema = z.coerce.date({
  message: 'scheduledFor must be a valid datetime',
});

/**
 * Body schema for booking an appointment. `patientId` and `scheduledFor` are
 * required; `durationMinutes` defaults to 30; the rest are optional. `.strict()`
 * rejects unknown keys so typos and unsupported fields fail loudly.
 */
export const createAppointmentSchema = z
  .object({
    patientId: z.string().trim().min(1, 'patientId is required'),
    scheduledFor: scheduledForSchema,
    durationMinutes: z.coerce
      .number()
      .int('durationMinutes must be a whole number')
      .positive('durationMinutes must be positive')
      .default(30),
    reason: z.string().trim().min(1).optional(),
    status: appointmentStatusSchema.optional(),
    notes: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Body schema for a partial update. Every field is optional, but at least one
 * must be supplied — an empty PATCH body is a client error, not a no-op.
 */
export const updateAppointmentSchema = createAppointmentSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'at least one field must be provided',
  });

/** Path-parameter schema. Appointment ids are cuids — non-empty opaque strings. */
export const idParamSchema = z
  .object({
    id: z.string().min(1, 'id is required'),
  })
  .strict();

/**
 * List query schema. Coerces the string query params into bounded numbers with
 * sane defaults so the list endpoint is always paginated, and supports optional
 * filtering by `patientId` and `status`.
 */
export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    patientId: z.string().trim().min(1).optional(),
    status: appointmentStatusSchema.optional(),
  })
  .strict();

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
