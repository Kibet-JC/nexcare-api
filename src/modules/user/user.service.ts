// User service — the data-access layer for staff authentication accounts.
//
// All persistence goes through the shared Prisma singleton (CLAUDE.md §4.2:
// never `new PrismaClient()`). This issue (#10) adds the model and service only;
// no HTTP route, auth middleware, JWT, or RBAC enforcement lives here — those
// arrive in #11 (login) and #12 (RBAC).
//
// Security (CLAUDE.md §4.2): passwords are hashed with argon2id and the resulting
// `passwordHash` is NEVER logged or returned to a caller. `createUser` runs the
// input through the password policy, hashes, persists, and returns a "safe user"
// with `passwordHash` stripped. `findByEmail` is the one path that returns the
// hash — for internal auth use only (login verification in #11), never to expose.
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpProblem } from '../../lib/problem.js';
import { hashPassword } from '../../lib/password.js';
import { createUserSchema, type CreateUserInput } from './user.schema.js';

/** A user with the secret hash removed — the only shape ever returned to callers. */
export type SafeUser = Omit<User, 'passwordHash'>;

/**
 * Strip `passwordHash` from a user row. Use this everywhere a user is returned
 * to a caller so the hash never leaves the service boundary (CLAUDE.md §4.2).
 */
export function toSafeUser(user: User): SafeUser {
  // Destructure the hash out and return the rest — no field is ever mutated in
  // place, and the hash is dropped rather than nulled so it can't leak.
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

/**
 * Create a staff account. Validates the input against the schema (email
 * normalised to lowercase, password against the policy), hashes the password
 * with argon2id, and persists. A duplicate email violates the unique constraint
 * and surfaces as a clean 409 Conflict rather than a raw Prisma error.
 *
 * Returns the safe user (no `passwordHash`).
 */
export async function createUser(input: CreateUserInput): Promise<SafeUser> {
  // Validate here too (not only at a future HTTP boundary) so every caller —
  // the seed, tests, later jobs — gets the same policy enforcement and the same
  // normalised email.
  const { password, ...rest } = createUserSchema.parse(input);

  const passwordHash = await hashPassword(password);

  try {
    const user = await prisma.user.create({
      data: { ...rest, passwordHash },
    });
    return toSafeUser(user);
  } catch (error) {
    // P2002 = unique constraint violation; here that can only be `email`.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new HttpProblem(
        409,
        'Conflict',
        'A user with that email already exists',
      );
    }
    throw error;
  }
}

/**
 * Look up a user by email (normalised to lowercase to match how rows are
 * stored). Returns the FULL record INCLUDING `passwordHash` — for internal auth
 * use only (login verification in #11). Never hand this result straight to a
 * caller outside the auth flow; run it through `toSafeUser` first. Returns null
 * when no user matches.
 */
export function findByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
}

/**
 * Look up an ACTIVE user by id and return the safe user (no `passwordHash`).
 * "Active" means the row exists, is not soft-deleted (`deletedAt` null), and is
 * enabled (`isActive` true) — the exact gate the authenticate middleware (#12)
 * applies to a presented access token's `sub`. A token whose subject no longer
 * satisfies all three is treated as unauthenticated, so a single combined query
 * is sufficient (the caller maps a null result to 401). Returns null otherwise.
 */
export async function findActiveById(id: string): Promise<SafeUser | null> {
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null, isActive: true },
  });
  return user ? toSafeUser(user) : null;
}
