import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

// CORS behaviour tests. NODE_ENV=test leaves CORS_ALLOWED_ORIGINS unset, so
// the app runs with the schema's non-production default — the Vite dev origin.
// Env-level hardening (wildcard rejection, exact-origin shape) is covered in
// env.test.ts; this file asserts the HTTP behaviour those values produce.

const DEV_ORIGIN = 'http://localhost:5173';
const EVIL_ORIGIN = 'https://evil.example';

describe('CORS', () => {
  it('answers preflight for an allowed origin with exact-origin and credentials headers', async () => {
    const app = createApp();

    const res = await request(app)
      .options('/api/v1/patients')
      .set('Origin', DEV_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(DEV_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(res.headers['access-control-allow-headers']).toMatch(/content-type/i);
    // Browsers may cache the preflight, cutting OPTIONS round-trips.
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('reflects the exact allowed origin on simple requests — never a wildcard', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', DEV_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(DEV_ORIGIN);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('sends Vary: Origin so caches never serve one origin’s grant to another', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', DEV_ORIGIN);

    expect(res.headers.vary).toMatch(/origin/i);
  });

  it('omits all CORS headers for a non-allowlisted origin on simple requests', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', EVIL_ORIGIN);

    // The request itself still succeeds server-side (standard CORS semantics);
    // withholding Access-Control-Allow-Origin is what makes the browser block
    // it. Note: the cors package still emits Allow-Credentials unconditionally,
    // but without a matching Allow-Origin the browser grants nothing — ACAO is
    // the security-bearing header, so that is the one we pin.
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('grants nothing on preflight from a non-allowlisted origin', async () => {
    const app = createApp();

    const res = await request(app)
      .options('/api/v1/patients')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves non-browser requests (no Origin header) untouched', async () => {
    const app = createApp();

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS with a multi-origin allowlist', () => {
  // env.ts freezes its config at import time, so exercising a different
  // allowlist over HTTP needs a fresh module graph: mutate process.env, drop
  // the module cache, and dynamically re-import createApp. Same pattern as
  // env.test.ts. The static `createApp` import above keeps its own (default)
  // env and is unaffected.
  const DEV = 'http://localhost:5173';
  const PROD = 'https://app.elara.example';
  const ORIGINAL = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    vi.resetModules();
    process.env.CORS_ALLOWED_ORIGINS = `${DEV},${PROD}`;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = ORIGINAL;
    }
    vi.resetModules();
  });

  it('reflects whichever allowlisted origin made the request — and only those', async () => {
    const { createApp: createAppFresh } = await import('../src/app.js');
    const app = createAppFresh();

    const fromDev = await request(app).get('/api/v1/health').set('Origin', DEV);
    expect(fromDev.headers['access-control-allow-origin']).toBe(DEV);

    const fromProd = await request(app)
      .get('/api/v1/health')
      .set('Origin', PROD);
    expect(fromProd.headers['access-control-allow-origin']).toBe(PROD);
    expect(fromProd.headers['access-control-allow-credentials']).toBe('true');

    // A third origin still gets nothing: the list is an allowlist, not a hint.
    const fromElsewhere = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(
      fromElsewhere.headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});
