import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { errorHandler } from '../src/lib/problem.js';
import { createRateLimiter } from '../src/middleware/rate-limit.js';

describe('security headers (helmet)', () => {
  it('sets hardened headers on responses and removes x-powered-by', async () => {
    const app = createApp();

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    // helmet hardens content-type sniffing...
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // ...and strips Express's framework-fingerprinting header.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets a deny-all CSP suited to a JSON API', async () => {
    const app = createApp();

    const res = await request(app).get('/api/v1/health');

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // useDefaults:false — helmet's HTML-oriented allowances must not leak in.
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('img-src');
  });

  it('omits HSTS outside production', async () => {
    // A year-long HTTPS pin emitted from a plain-HTTP local server would poison
    // the developer's browser for every other service on localhost, so the
    // header must be production-only. Read the app's own validated env rather
    // than process.env: NODE_ENV is 'test' under vitest but 'development' when
    // a local .env is exported into the shell, and both must behave the same.
    expect(env.NODE_ENV).not.toBe('production');

    const app = createApp();

    const res = await request(app).get('/api/v1/health');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('pins HTTPS for a year in production', async () => {
    // The case above only proves the header is ABSENT here; on its own it would
    // stay green if the `hsts` option were deleted outright, so the production
    // half of the requirement needs its own case. env.ts validates and freezes
    // process.env at IMPORT time, so the only way to reach that branch is the
    // fresh-import dance tests/env.test.ts already uses: drop the module cache,
    // mutate a cloned environment, re-import.
    const originalEnv = process.env;
    vi.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'production' };

    try {
      const { createApp: createProductionApp } = await import('../src/app.js');

      const res = await request(createProductionApp()).get('/api/v1/health');

      const hsts = res.headers['strict-transport-security'];
      expect(hsts).toBeDefined();
      expect(hsts).toContain('max-age=31536000'); // one year, in seconds
      expect(hsts).toContain('includeSubDomains');
      // `preload` is deliberately absent: entry on the browser preload list is
      // effectively irreversible, and it is not Railway's edge domain we would
      // want pinned there anyway.
      expect(hsts).not.toContain('preload');
    } finally {
      // Restore the real environment and drop the production-flavoured modules
      // so no later test file inherits them.
      process.env = originalEnv;
      vi.resetModules();
    }
  });
});

describe('rate limiting', () => {
  // The real limiters skip in the test environment (so the shared auth suite is
  // never throttled), so we prove the limiting path against a purpose-built
  // limiter with a low max and skipInTest disabled, mounted on a tiny app.
  it('returns an RFC 7807 429 once the limit is exceeded', async () => {
    const max = 3;
    const app = express();
    app.use(
      createRateLimiter({
        windowMs: 60 * 1000,
        max,
        detail: 'Too many requests in the test window.',
        skipInTest: false,
      }),
    );
    app.get('/ping', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use(errorHandler);

    // The first `max` requests pass.
    for (let i = 0; i < max; i += 1) {
      const ok = await request(app).get('/ping');
      expect(ok.status).toBe(200);
    }

    // The next one trips the limiter.
    const limited = await request(app).get('/ping');

    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.body).toMatchObject({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many requests in the test window.',
    });
  });
});
