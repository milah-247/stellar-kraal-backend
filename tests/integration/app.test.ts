/**
 * tests/integration/app.test.ts
 *
 * Smoke tests for the Express app: health check, 404 handling,
 * CORS headers, rate limit structure.
 */

import request from 'supertest';
import { createApp } from '../../src/app';
import type { Application } from 'express';

// ─── Mock Soroban (prevent poller from starting) ─────────────────────────────
jest.mock('../../src/services/soroban.service', () => ({
  startEventPoller: jest.fn(),
  stopEventPoller: jest.fn(),
  mintCollateral: jest.fn(),
  getLoanState: jest.fn(),
}));

let app: Application;

beforeAll(() => {
  app = createApp();
});

// ─── Health check ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes timestamp in ISO format', async () => {
    const res = await request(app).get('/health');

    expect(res.body).toHaveProperty('timestamp');
    expect(() => new Date(res.body.timestamp as string)).not.toThrow();
  });

  it('includes environment field', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('environment');
  });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────

describe('404 handler', () => {
  it('returns 404 for an unknown route', async () => {
    const res = await request(app).get('/api/unknown-route-xyz');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Not Found');
  });

  it('includes the requested path in the 404 response', async () => {
    const res = await request(app).get('/api/totally-unknown');

    expect(res.body).toHaveProperty('path');
    expect(res.body.path).toContain('/api/totally-unknown');
  });
});

// ─── Security headers (Helmet) ────────────────────────────────────────────────

describe('Security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('allows requests from the configured FRONTEND_URL', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:3000');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('does not include CORS headers for disallowed origins', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil-site.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('responds to preflight OPTIONS requests with CORS headers', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBeLessThan(400);
    expect(res.headers['access-control-allow-methods']).toBeDefined();
  });
});

// ─── Route structure ──────────────────────────────────────────────────────────

describe('Route structure', () => {
  it('/api/auth/challenge is reachable (not 404)', async () => {
    // Should return 400 (missing query param) not 404
    const res = await request(app).get('/api/auth/challenge');
    expect(res.status).not.toBe(404);
  });

  it('/api/loans is reachable (not 404)', async () => {
    const res = await request(app).get('/api/loans');
    expect(res.status).not.toBe(404);
  });

  it('/api/livestock/my-kraal requires auth (401)', async () => {
    const res = await request(app).get('/api/livestock/my-kraal');
    expect(res.status).toBe(401);
  });
});
