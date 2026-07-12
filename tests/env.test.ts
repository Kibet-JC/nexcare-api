import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// env.ts validates `process.env` at IMPORT time, so each case must import the
// module fresh against a freshly-mutated environment. vi.resetModules() drops
// the module cache and a dynamic `await import(...)` re-runs the validation.
// The original environment is restored after every test.

const ORIGINAL_ENV = process.env;

describe('config/env', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clone so per-test mutations never leak into other tests.
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('applies defaults when the relevant vars are absent', async () => {
    delete process.env.PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);

    const { env } = await import('../src/config/env.js');

    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces a provided PORT and keeps a valid LOG_LEVEL', async () => {
    process.env.PORT = '8080';
    process.env.LOG_LEVEL = 'debug';
    process.env.DATABASE_URL =
      'postgresql://nexcare:nexcare@localhost:5432/nexcare_dev?schema=public';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);

    const { env } = await import('../src/config/env.js');

    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('returns a frozen env object', async () => {
    process.env.DATABASE_URL =
      'postgresql://nexcare:nexcare@localhost:5432/nexcare_dev?schema=public';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);

    const { env } = await import('../src/config/env.js');

    expect(Object.isFrozen(env)).toBe(true);
  });

  it('throws on a non-numeric PORT', async () => {
    process.env.PORT = 'abc';

    await expect(import('../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });

  it('throws on an invalid LOG_LEVEL enum value', async () => {
    process.env.LOG_LEVEL = 'verbose';

    await expect(import('../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });

  it('fails fast when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;

    await expect(import('../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });

  it('fails fast when DATABASE_URL is not a valid URL', async () => {
    process.env.DATABASE_URL = 'not-a-url';

    await expect(import('../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });

  // CORS allowlist hardening: exact origins only, wildcards rejected at boot,
  // fail-closed default in production. See the transform in src/config/env.ts.

  it('parses a comma-separated CORS origin list into exact origins', async () => {
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    process.env.CORS_ALLOWED_ORIGINS =
      'http://localhost:5173, https://app.elara.example';

    const { env } = await import('../src/config/env.js');

    expect(env.CORS_ALLOWED_ORIGINS).toEqual([
      'http://localhost:5173',
      'https://app.elara.example',
    ]);
    expect(Object.isFrozen(env.CORS_ALLOWED_ORIGINS)).toBe(true);
  });

  it('defaults the CORS allowlist to the Vite dev origin outside production', async () => {
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    delete process.env.CORS_ALLOWED_ORIGINS;

    const { env } = await import('../src/config/env.js');

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('defaults the CORS allowlist to EMPTY in production (fail closed)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    delete process.env.CORS_ALLOWED_ORIGINS;

    const { env } = await import('../src/config/env.js');

    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('rejects a wildcard CORS origin at boot', async () => {
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    process.env.CORS_ALLOWED_ORIGINS = '*';

    await expect(import('../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects a wildcard buried in an otherwise-valid list', async () => {
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173,https://*.vercel.app';

    await expect(import('../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects a CORS entry that is not an exact origin (path, trailing slash, bad scheme)', async () => {
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);

    for (const bad of [
      'http://localhost:5173/app',
      'http://localhost:5173/',
      'ftp://localhost:5173',
      'localhost:5173',
    ]) {
      vi.resetModules();
      process.env.CORS_ALLOWED_ORIGINS = bad;

      await expect(import('../src/config/env.js')).rejects.toThrow(
        /Invalid environment configuration/,
      );
    }
  });
});
