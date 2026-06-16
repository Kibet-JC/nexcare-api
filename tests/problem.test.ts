import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { HttpProblem, errorHandler, notFoundHandler } from '../src/lib/problem.js';

describe('RFC 7807 Problem Details', () => {
  it('serialises a thrown HttpProblem as application/problem+json with no stack', async () => {
    // Minimal app exercising the error pipeline: a route that throws, then the
    // shared notFound + error handlers. Express 5 forwards thrown errors to the
    // error middleware automatically.
    const app = express();
    app.get('/boom', () => {
      throw new HttpProblem(403, 'Forbidden', 'You may not access this resource');
    });
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app).get('/boom');

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'You may not access this resource',
      instance: '/boom',
    });
    // No stack trace must ever leak into the response body.
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(/);
  });

  it('returns a 404 Problem for an unknown route', async () => {
    const app = createApp();

    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      title: 'Not Found',
      status: 404,
    });
    expect(res.body).not.toHaveProperty('stack');
  });
});
