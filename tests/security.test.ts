import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
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
