// Error tracking (H-7). Three properties are under test, in order of how much
// damage their absence would do:
//
//   1. Adding Sentry did not change the wire format. A thrown route error is
//      still RFC 7807 problem+json with no stack and no internal message.
//   2. With no DSN, nothing leaves the process. Asserted at the network layer,
//      not just by trusting the enabled-flag.
//   3. The beforeSend scrubber actually removes personal data, and keeps the
//      four fields an operator triages on.
//
// Note what is NOT here: no test initialises Sentry with a real DSN. The suite
// must never contact Sentry (initSentry() also hard-refuses under
// NODE_ENV=test), so the scrubber is tested through its exported function
// rather than by round-tripping an event through a live client.
import { describe, it, expect, vi, afterEach } from 'vitest';
import https from 'node:https';
import express from 'express';
import request from 'supertest';
import type { ErrorEvent } from '@sentry/node';
import { HttpProblem, errorHandler, notFoundHandler } from '../src/lib/problem.js';
import { initSentry, isSentryEnabled, scrubEvent } from '../src/lib/sentry.js';

/** An app whose only route throws, wired to the real error pipeline. */
function appThatThrows(error: Error): express.Express {
  const app = express();
  app.get('/patients/42', () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sentry error tracking', () => {
  it('leaves a thrown route error as an RFC 7807 problem with no stack or internal detail', async () => {
    // The message carries both an internal detail and a phone number: neither
    // may appear in the response, with or without Sentry configured.
    const res = await request(
      appThatThrows(new Error('connection to nexcare_dev failed for +254712345678')),
    ).get('/patients/42');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/patients/42',
    });
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toMatch(/nexcare_dev|254712345678|at .*\(/);
  });

  it('still returns the declared problem for a 4xx, which is never reported', async () => {
    const res = await request(
      appThatThrows(new HttpProblem(403, 'Forbidden', 'You may not access this resource')),
    ).get('/patients/42');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'You may not access this resource',
      instance: '/patients/42',
    });
  });

  it('stays fully disabled and sends nothing when no DSN is configured', async () => {
    // Spy on the egress paths a Sentry transport could use. `http.request` is
    // deliberately NOT spied: supertest itself drives the app over plain HTTP,
    // so it would register its own calls. A Sentry DSN is always https, and the
    // SDK's fetch-based transport would show up on globalThis.fetch.
    const httpsRequest = vi.spyOn(https, 'request');
    const httpsGet = vi.spyOn(https, 'get');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const enabled = await initSentry();
    expect(enabled).toBe(false);
    expect(isSentryEnabled()).toBe(false);

    // Force a 500 through the real error handler; captureProblem runs and must
    // no-op rather than queue anything.
    const res = await request(appThatThrows(new Error('boom'))).get('/patients/42');
    expect(res.status).toBe(500);

    expect(httpsRequest).not.toHaveBeenCalled();
    expect(httpsGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The assertion above runs under NODE_ENV=test, where BOTH guards in
  // initSentry() would refuse. These two cases pin each guard down separately,
  // by re-importing the module against a mutated environment (the pattern
  // tests/env.test.ts uses, because config/env.ts validates at import time).
  // Neither case can reach the network: both assert the SDK was never loaded.
  describe('the off switch, guard by guard', () => {
    const ORIGINAL_ENV = process.env;

    afterEach(() => {
      process.env = ORIGINAL_ENV;
      vi.resetModules();
    });

    async function freshSentry(overrides: NodeJS.ProcessEnv) {
      vi.resetModules();
      process.env = { ...ORIGINAL_ENV, ...overrides };
      return import('../src/lib/sentry.js');
    }

    it('stays off outside the test environment when SENTRY_DSN is unset', async () => {
      const sentry = await freshSentry({ NODE_ENV: 'development', SENTRY_DSN: undefined });

      expect(await sentry.initSentry()).toBe(false);
      expect(sentry.isSentryEnabled()).toBe(false);
    });

    it('refuses to initialise under NODE_ENV=test even when a DSN is present', async () => {
      // Guards a real foot-gun: a developer with SENTRY_DSN in their .env must
      // not ship errors to the production project from `pnpm test`.
      const sentry = await freshSentry({
        NODE_ENV: 'test',
        SENTRY_DSN: 'https://publickey@o0.ingest.de.sentry.io/0',
      });

      expect(await sentry.initSentry()).toBe(false);
      expect(sentry.isSentryEnabled()).toBe(false);
    });

    it('treats a blank SENTRY_DSN as unset rather than a boot failure', async () => {
      // Blanking a Railway variable is the ordinary way to turn Sentry off; it
      // must not crash the process on boot.
      const sentry = await freshSentry({ NODE_ENV: 'development', SENTRY_DSN: '   ' });

      expect(await sentry.initSentry()).toBe(false);
      expect(sentry.isSentryEnabled()).toBe(false);
    });
  });

  describe('scrubEvent (the beforeSend hook)', () => {
    /** An event carrying every category of personal data we refuse to send. */
    function dirtyEvent(): ErrorEvent {
      return {
        event_id: 'abc123',
        message: 'no patient with ID 23456789 or phone +254712345678',
        server_name: 'nexcare-api-production-7f9c',
        user: { id: 'usr_1', email: 'jane.doe@example.com', ip_address: '41.90.1.2' },
        breadcrumbs: [{ message: 'POST /api/v1/patients {"phone":"0712345678"}' }],
        request: {
          method: 'POST',
          url: 'https://api.elara.co.ke/api/v1/patients?q=Jane%20Doe',
          query_string: 'q=Jane%20Doe',
          data: { nationalId: '23456789', phone: '+254712345678', givenName: 'Jane' },
          cookies: { refreshToken: 'rt_secret_value' },
          headers: {
            authorization: 'Bearer eyJhbGciOi.secret.value',
            cookie: 'refreshToken=rt_secret_value',
            'user-agent': 'curl/8.4.0',
          },
        },
        tags: {
          'http.method': 'POST',
          'http.route': '/api/v1/patients/:patientId',
          'http.status_code': '500',
          request_id: '42',
        },
        exception: {
          values: [
            {
              type: 'PrismaClientKnownRequestError',
              value: 'Unique constraint failed on phone 0712345678',
            },
          ],
        },
        contexts: {
          response: { status_code: 500, headers: { 'set-cookie': 'refreshToken=rt' } },
        },
      } as unknown as ErrorEvent;
    }

    it('removes every carrier of personal data', () => {
      const scrubbed = scrubEvent(dirtyEvent());

      expect(scrubbed.user).toBeUndefined();
      expect(scrubbed.server_name).toBeUndefined();
      expect(scrubbed.breadcrumbs).toBeUndefined();
      // request is rebuilt as method + path: body, cookies, headers and the
      // query string (which carries search terms) are all gone.
      expect(scrubbed.request).toEqual({
        method: 'POST',
        url: 'https://api.elara.co.ke/api/v1/patients',
      });
    });

    it('masks national IDs, phone numbers and emails wherever they survive', () => {
      const scrubbed = scrubEvent(dirtyEvent());
      const serialised = JSON.stringify(scrubbed);

      expect(serialised).not.toMatch(/23456789/); // national ID
      expect(serialised).not.toMatch(/712345678/); // phone, either format
      expect(serialised).not.toMatch(/jane\.doe@example\.com/); // email
      expect(serialised).not.toMatch(/rt_secret_value|eyJhbGciOi/); // credentials
      expect(scrubbed.message).toBe('no patient with ID [REDACTED] or phone [REDACTED]');
      expect(scrubbed.exception?.values?.[0]?.value).toBe(
        'Unique constraint failed on phone [REDACTED]',
      );
    });

    it('keeps route, method, status and request ID', () => {
      const scrubbed = scrubEvent(dirtyEvent());

      expect(scrubbed.tags).toEqual({
        'http.method': 'POST',
        'http.route': '/api/v1/patients/:patientId',
        'http.status_code': '500',
        request_id: '42',
      });
      expect(scrubbed.event_id).toBe('abc123');
      expect(scrubbed.exception?.values?.[0]?.type).toBe('PrismaClientKnownRequestError');
    });

    it('survives an event with no request, user or exception', () => {
      // beforeSend must not throw on a sparse event: a throw there would take
      // out the send path for every event, not just this one.
      const scrubbed = scrubEvent({ event_id: 'bare' } as unknown as ErrorEvent);

      expect(scrubbed).toEqual({ event_id: 'bare' });
    });
  });
});
