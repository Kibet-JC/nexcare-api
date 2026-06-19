// Zod schemas for the User module — the single source of truth for what the
// service accepts when creating a staff account (CLAUDE.md §4.1: validate every
// input). No HTTP route consumes these yet; login/register land in #11. These
// also export inferred TypeScript types the service layer consumes, so the
// contract and the types never drift apart.
import { z } from 'zod';

/** Mirrors the Prisma `Role` enum; kept in lockstep with prisma/schema.prisma. */
export const roleSchema = z.enum(['ADMIN', 'CLINICIAN', 'RECEPTIONIST']);

/**
 * Password strength policy. Enforced at account creation so weak credentials
 * never reach the hash: at least 12 characters with a lowercase letter, an
 * uppercase letter, a digit, and a symbol (any non-alphanumeric). The messages
 * describe the rule, never echo the submitted password (which is PII-adjacent
 * and must not be logged or returned — CLAUDE.md §4.2).
 */
export const passwordPolicy = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .regex(/[a-z]/, 'password must contain a lowercase letter')
  .regex(/[A-Z]/, 'password must contain an uppercase letter')
  .regex(/[0-9]/, 'password must contain a digit')
  .regex(/[^A-Za-z0-9]/, 'password must contain a symbol');

/**
 * Input schema for creating a user. Email is normalised to lowercase (the unique
 * login identity) and validated; password must satisfy the policy; name fields
 * are optional; role is optional and defaults to the least-privileged role at the
 * database layer (`User.role`). `.strict()` rejects unknown keys so typos and
 * unsupported fields fail loudly rather than being silently dropped.
 */
export const createUserSchema = z
  .object({
    email: z
      .email('email must be a valid email address')
      .trim()
      .toLowerCase(),
    password: passwordPolicy,
    firstName: z.string().trim().min(1).optional(),
    lastName: z.string().trim().min(1).optional(),
    role: roleSchema.optional(),
  })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
