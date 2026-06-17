// Zod schemas for the Patient module — the single source of truth for what the
// API accepts at the HTTP boundary (CLAUDE.md §4.1: validate every input).
//
// These power the `validate` middleware on each route and also export inferred
// TypeScript types the service layer consumes, so the contract and the types
// never drift apart.
import { z } from 'zod';

/** Mirrors the Prisma `Sex` enum; kept in lockstep with prisma/schema.prisma. */
export const sexSchema = z.enum(['MALE', 'FEMALE', 'OTHER']);

// E.164 phone string, e.g. +254712345678 (CLAUDE.md §4.2). Optional at
// registration — many walk-in patients have no phone on file.
const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'phone must be E.164 format, e.g. +254712345678');

// A date of birth must be a real calendar date in the past — no future births.
const dateOfBirthSchema = z.coerce
  .date({ message: 'dateOfBirth must be a valid date' })
  .max(new Date(), { message: 'dateOfBirth must be in the past' });

/**
 * Body schema for creating a patient. `firstName`/`lastName`/`dateOfBirth`/`sex`
 * are required; contact identifiers are optional. `.strict()` rejects unknown
 * keys so typos and unsupported fields fail loudly rather than being dropped.
 */
export const createPatientSchema = z
  .object({
    firstName: z.string().trim().min(1, 'firstName is required'),
    lastName: z.string().trim().min(1, 'lastName is required'),
    dateOfBirth: dateOfBirthSchema,
    sex: sexSchema,
    phone: phoneSchema.optional(),
    nationalId: z.string().trim().min(1).optional(),
    email: z.email('email must be a valid email address').optional(),
  })
  .strict();

/**
 * Body schema for a partial update. Every field is optional, but at least one
 * must be supplied — an empty PATCH body is a client error, not a no-op.
 */
export const updatePatientSchema = createPatientSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'at least one field must be provided',
  });

/** Path-parameter schema. Patient ids are cuids — non-empty opaque strings. */
export const idParamSchema = z
  .object({
    id: z.string().min(1, 'id is required'),
  })
  .strict();

/**
 * List query schema. Coerces the string query params into bounded numbers with
 * sane defaults so the list endpoint is always paginated and can't be asked for
 * an unbounded page.
 */
export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
