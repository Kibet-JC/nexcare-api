// Password hashing primitives — argon2id only (CLAUDE.md §4.2).
//
// Plaintext passwords are NEVER stored or logged: callers hash on the way in
// and verify against the stored hash. argon2id is the memory-hard,
// side-channel-resistant variant recommended for password storage; argon2.verify
// is constant-time, so it does not leak how much of a wrong password matched.
//
// We rely on the argon2 package defaults (which embed the algorithm, version,
// memory/time/parallelism parameters, and a random per-hash salt directly in the
// returned `$argon2id$...` string), so verification needs only the hash and the
// candidate plaintext — no separate salt or parameter storage.
import argon2 from 'argon2';

/**
 * Hash a plaintext password with argon2id. The returned string is the full PHC
 * encoding (`$argon2id$v=19$m=...$<salt>$<hash>`) and is what gets persisted as
 * `User.passwordHash`. Never log or return the input `plain`.
 */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Verify a candidate plaintext against a stored argon2id hash. Returns true on a
 * match, false otherwise. Comparison is constant-time (argon2.verify), so timing
 * does not reveal partial matches. Used by login (#11), not in this issue's API.
 */
export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
