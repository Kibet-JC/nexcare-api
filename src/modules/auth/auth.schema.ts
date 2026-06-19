// Zod schema for the auth module (CLAUDE.md §4.1: validate every input).
//
// Login intentionally does NOT reuse the account-creation password policy: the
// policy describes what a *new* password must look like, but login must accept
// whatever an existing credential is and let the constant-time hash verify
// decide. We only require a non-empty string so an empty submission is a clean
// 400 rather than reaching argon2. Email is normalised to lowercase to match how
// users are stored (see user.service `findByEmail`).
import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.email('email must be a valid email address').trim().toLowerCase(),
    password: z.string().min(1, 'password is required'),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
