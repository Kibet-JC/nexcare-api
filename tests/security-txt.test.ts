import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('GET /.well-known/security.txt', () => {
  it('serves the disclosure contact as plain text', async () => {
    const app = createApp();

    const res = await request(app).get('/.well-known/security.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    // The two fields RFC 9116 makes mandatory.
    expect(res.text).toContain('Contact: mailto:security@elarahealthcare.co.ke');
    expect(res.text).toMatch(/^Expires: .+$/m);
  });

  it('advertises an Expires date that is still in the future', async () => {
    const app = createApp();

    const res = await request(app).get('/.well-known/security.txt');

    const expires = /^Expires: (.+)$/m.exec(res.text)?.[1];
    expect(expires).toBeDefined();
    const expiresAt = Date.parse(expires as string);
    expect(Number.isNaN(expiresAt)).toBe(false);
    // A lapsed security.txt is treated as invalid by scanners and researchers,
    // so this assertion is the tripwire that tells us to refresh the file.
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});
