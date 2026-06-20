// Test helper for authenticated requests (#12).
//
// Most route tests now run behind `authenticate` + `requireRole`, so they need a
// real staff account and a matching access token. `createActor` persists a user
// with the requested role and signs an access token for it with the SAME #11
// JWT helper the app uses, so the token verifies exactly as a login-issued one
// would. Tests attach `authHeader` to every protected request.
//
// Real Postgres, no mocks (CLAUDE.md §4.2): the user is a genuine row, which is
// also what lets the authenticate middleware re-load it on each request.
import type { Role } from '@prisma/client';
import { createUser, type SafeUser } from '../../src/modules/user/user.service.js';
import { signAccessToken } from '../../src/lib/jwt.js';

/** What a test needs to act as a given role: the row, a token, and the header. */
export interface Actor {
  user: SafeUser;
  accessToken: string;
  authHeader: { Authorization: string };
}

// Monotonic suffix so each actor gets a unique email even within one test,
// since the users table is truncated per-test but may seed several actors.
let counter = 0;

/**
 * Create a staff account with `role` (default ADMIN) and an access token signed
 * for it. The password satisfies the account policy; the email is unique per
 * call. Returns `{ user, accessToken, authHeader }` where
 * `authHeader = { Authorization: `Bearer ${accessToken}` }`.
 */
export async function createActor(role: Role = 'ADMIN'): Promise<Actor> {
  counter += 1;
  const user = await createUser({
    email: `actor.${role.toLowerCase()}.${counter}@elarahealthcare.co.ke`,
    password: 'StrongPassw0rd!',
    role,
  });

  const accessToken = signAccessToken(user);
  return {
    user,
    accessToken,
    authHeader: { Authorization: `Bearer ${accessToken}` },
  };
}
