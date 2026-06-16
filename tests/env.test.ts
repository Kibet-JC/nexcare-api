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

    const { env } = await import('../src/config/env.js');

    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces a provided PORT and keeps a valid LOG_LEVEL', async () => {
    process.env.PORT = '8080';
    process.env.LOG_LEVEL = 'debug';

    const { env } = await import('../src/config/env.js');

    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('returns a frozen env object', async () => {
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
});
