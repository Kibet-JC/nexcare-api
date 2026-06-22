// Production admin password rotation.
//
// create-admin.ts can only bootstrap the FIRST admin and is a no-op once the
// account exists. That leaves no supported way to rotate an existing admin's
// password after a suspected compromise or routine credential rotation. This
// script fills exactly that gap and nothing more.
//
// It reads ADMIN_EMAIL and NEW_ADMIN_PASSWORD from the environment, finds the
// matching user, validates the new password against the SAME password policy as
// account creation, hashes it with argon2id, and writes the new hash. In the
// same transaction it revokes every one of that user's refresh tokens, so any
// session established with the old credentials cannot survive the rotation.
//
// Neither value is ever logged: missing-input errors name the variables, never
// echo them, and success logs the email plus a revoked-token count only — never
// the password or the resulting hash (CLAUDE.md §4.1, §4.2).
//
// This file lives under src/ so tsconfig.build.json compiles it to
// dist/scripts/set-admin-password.js and the production image can run it with
// node — the runtime image ships compiled JS only, never .ts source or tsx.
//
// Run on Railway as a one-off:  node dist/scripts/set-admin-password.js
// (with ADMIN_EMAIL / NEW_ADMIN_PASSWORD set in the environment).
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../lib/password.js';
import { passwordPolicy } from '../modules/user/user.schema.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

async function setAdminPassword(): Promise<void> {
  // Email is the lookup key; lowercase it to match how accounts are stored
  // (User.email is the lowercased login identity). The password is read raw —
  // surrounding whitespace is a legitimate part of a password and the policy
  // validates it as-is.
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const newPassword = process.env.NEW_ADMIN_PASSWORD;

  // Fail fast and loudly if either input is missing. We never invent a default —
  // that would silently set a known password on a real account. The message
  // names the variables but never echoes their values.
  if (!email || !newPassword) {
    throw new Error(
      'ADMIN_EMAIL and NEW_ADMIN_PASSWORD must both be set to rotate the admin password.',
    );
  }

  // Validate against the same policy as account creation so a weak password is
  // rejected here, before hashing — never reaching the database. parse throws a
  // ZodError whose messages describe the rule, not the submitted password.
  passwordPolicy.parse(newPassword);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (!user) {
    // No such account — surface it clearly rather than silently doing nothing.
    // The email is an identifier, not a secret, so it is safe to name.
    throw new Error(`No user found for email ${email} — nothing to rotate.`);
  }

  const passwordHash = await hashPassword(newPassword);

  // One transaction: the new hash and the session revocation land together or
  // not at all, so we never leave the account with a new password but still-live
  // old sessions (or vice versa). revokeMany only touches tokens that are still
  // active (revokedAt = null) so the count reflects sessions actually killed.
  const revoked = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    const { count } = await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return count;
  });

  // Identifiers only (CLAUDE.md §4.1) — never the password or hash.
  logger.info(
    { userId: user.id, email: user.email, revokedTokens: revoked },
    'admin password rotated',
  );
}

// Always release the database pool, then surface any failure as a non-zero exit
// so the one-off command fails visibly in the Railway logs.
async function main(): Promise<void> {
  try {
    await setAdminPassword();
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error({ err: error }, 'admin password rotation failed');
    process.exitCode = 1;
  });
}
