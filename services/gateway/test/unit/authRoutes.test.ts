import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { loginHandler } from '../../src/authRoutes.js';
import { verifyToken } from '../../src/auth.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/auth/login', loginHandler);
  return app;
}

describe('POST /auth/login', () => {
  it('returns a token, echoed bidder_id, and expires_in for a valid bidder_id', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ bidder_id: 'bidder-7' });

    expect(res.status).toBe(200);
    expect(res.body.bidder_id).toBe('bidder-7');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.expires_in).toBe('2h');
  });

  it('issues a token that verifyToken accepts and attributes to the right bidder', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ bidder_id: 'bidder-9' });

    const result = verifyToken(res.body.token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.bidder_id).toBe('bidder-9');
  });

  it('rejects a missing bidder_id with 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bidder_id/);
  });

  it('rejects a bidder_id containing disallowed characters with 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ bidder_id: 'not a valid id!' });
    expect(res.status).toBe(400);
  });

  it('rejects a bidder_id longer than 64 characters with 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ bidder_id: 'a'.repeat(65) });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string bidder_id with 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ bidder_id: 12345 });
    expect(res.status).toBe(400);
  });

  it('respects JWT_EXPIRY when set, reflecting it in expires_in', async () => {
    const original = process.env.JWT_EXPIRY;
    process.env.JWT_EXPIRY = '30m';
    try {
      const app = buildApp();
      const res = await request(app).post('/auth/login').send({ bidder_id: 'bidder-1' });
      expect(res.body.expires_in).toBe('30m');
    } finally {
      if (original === undefined) delete process.env.JWT_EXPIRY;
      else process.env.JWT_EXPIRY = original;
    }
  });
});
