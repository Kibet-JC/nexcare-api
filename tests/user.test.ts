// User module integration tests — real Postgres, no mocks (CLAUDE.md §4.2).
//
// These exercise the user service against a real database: argon2id hashing,
// the password policy, duplicate-email handling, and — critically — that the
// passwordHash never leaves the service boundary. They need `docker compose up
// -d` (or CI's postgres service), an applied `add_user` migration, and a valid
// DATABASE_URL. The users table is truncated before each test for isolation.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { verifyPassword } from '../src/lib/password.js';
import { createUser, findByEmail } from '../src/modules/user/user.service.js';
import { HttpProblem } from '../src/lib/problem.js';

// A valid create input reused across tests. The password satisfies the policy.
const validUser = {
  email: 'Nurse.Wanjiru@ElaraHealthcare.co.ke',
  password: 'StrongPassw0rd!',
  firstName: 'Wanjiru',
  lastName: 'Kamau',
} as const;

describe('User service', () => {
  beforeEach(async () => {
    // users has no FKs yet; TRUNCATE still gives each test a clean, isolated table.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores an argon2id hash, not the plaintext, and normalises the email', async () => {
    const safeUser = await createUser(validUser);

    // The row carries the hash; fetch it directly to inspect (findByEmail is the
    // internal auth path that includes passwordHash).
    const stored = await findByEmail(validUser.email);
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored?.passwordHash).not.toBe(validUser.password);
    // Email is normalised to lowercase and is the lookup key.
    expect(stored?.email).toBe('nurse.wanjiru@elarahealthcare.co.ke');
    expect(safeUser.email).toBe('nurse.wanjiru@elarahealthcare.co.ke');
    // Default role is the least-privileged one.
    expect(stored?.role).toBe('RECEPTIONIST');
  });

  it('never returns passwordHash from createUser', async () => {
    const safeUser = await createUser(validUser);

    expect(safeUser).not.toHaveProperty('passwordHash');
    // Sanity: it still returns the useful, non-secret fields.
    expect(safeUser.email).toBe('nurse.wanjiru@elarahealthcare.co.ke');
    expect(typeof safeUser.id).toBe('string');
  });

  it('verifyPassword is true for the correct password and false for a wrong one', async () => {
    await createUser(validUser);
    const stored = await findByEmail(validUser.email);

    expect(stored).not.toBeNull();
    await expect(
      verifyPassword(stored!.passwordHash, validUser.password),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(stored!.passwordHash, 'WrongPassw0rd!'),
    ).resolves.toBe(false);
  });

  it('rejects weak passwords (too short / missing character classes)', async () => {
    const weak = [
      'Short1!', // too short (< 12)
      'alllowercase1!', // no uppercase
      'ALLUPPERCASE1!', // no lowercase
      'NoDigitsHere!!', // no digit
      'NoSymbols12345', // no symbol
    ];

    for (const password of weak) {
      await expect(
        createUser({ ...validUser, password }),
      ).rejects.toThrow();
    }

    // None of the rejected attempts should have written a row.
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects a duplicate email with a 409 Conflict', async () => {
    await createUser(validUser);

    // Same email in different case still collides (stored lowercased + unique).
    const promise = createUser({
      ...validUser,
      email: 'NURSE.WANJIRU@elarahealthcare.co.ke',
    });

    await expect(promise).rejects.toBeInstanceOf(HttpProblem);
    await expect(promise).rejects.toMatchObject({ status: 409 });
    // Only the original row exists.
    expect(await prisma.user.count()).toBe(1);
  });

  it('findByEmail returns null for an unknown email', async () => {
    await expect(findByEmail('nobody@elarahealthcare.co.ke')).resolves.toBeNull();
  });
});
