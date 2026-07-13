/**
 * tests/integration/livestock.routes.test.ts
 *
 * Integration tests for livestock registration and management endpoints.
 * Soroban calls (mintCollateral) are mocked to prevent live RPC usage.
 */

import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../../src/app';
import prisma from '../../src/lib/prisma';
import { issueJwt } from '../../src/services/auth.service';
import type { Application } from 'express';

// ─── Mock Soroban ─────────────────────────────────────────────────────────────
jest.mock('../../src/services/soroban.service', () => ({
  startEventPoller: jest.fn(),
  stopEventPoller: jest.fn(),
  mintCollateral: jest.fn().mockResolvedValue('mock-tx-hash-abc'),
  getLoanState: jest.fn().mockResolvedValue(null),
}));

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: Application;
let farmerToken: string;
let farmerId: string;
let farmerPublicKey: string;

beforeAll(async () => {
  app = createApp();
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.loan.deleteMany();
  await prisma.livestock.deleteMany();
  await prisma.user.deleteMany();

  // Create a farmer user and token for each test
  const keypair = Keypair.random();
  farmerPublicKey = keypair.publicKey();

  const user = await prisma.user.create({
    data: { publicKey: farmerPublicKey, role: 'FARMER' },
  });
  farmerId = user.id;

  farmerToken = issueJwt({
    sub: user.id,
    publicKey: user.publicKey,
    role: user.role,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    animalId: `TAG-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'CATTLE',
    breed: 'angus',
    weightKg: 450,
    ageMonths: 36,
    healthStatus: 'GOOD',
    location: 'Northern Cape, ZA',
    ...overrides,
  };
}

// ─── POST /api/livestock/register ────────────────────────────────────────────

describe('POST /api/livestock/register', () => {
  it('returns 201 with appraisal data on valid registration', async () => {
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(validPayload());

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('livestock');
    expect(res.body).toHaveProperty('appraisal');
    expect(res.body.livestock.verificationStatus).toBe('APPRAISED');
    expect(res.body.appraisal.marketValueUSDC).toBeGreaterThan(0);
    expect(res.body.appraisal.collateralValueUSDC).toBeGreaterThan(0);
  });

  it('persists the livestock record in the database', async () => {
    const payload = validPayload();
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    expect(res.status).toBe(201);

    const record = await prisma.livestock.findUnique({
      where: { animalId: payload.animalId as string },
    });
    expect(record).not.toBeNull();
    expect(record?.ownerId).toBe(farmerId);
    expect(record?.appraisedValueUSDC).toBeGreaterThan(0);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/api/livestock/register')
      .send(validPayload());

    expect(res.status).toBe(401);
  });

  it('returns 400 when animalId is missing', async () => {
    const { animalId: _removed, ...payload } = validPayload();
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/animalId/i);
  });

  it('returns 400 for invalid animal type', async () => {
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(validPayload({ type: 'DRAGON' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/i);
  });

  it('returns 400 for weightKg = 0', async () => {
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(validPayload({ weightKg: 0 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weightKg/i);
  });

  it('returns 400 for negative ageMonths', async () => {
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(validPayload({ ageMonths: -5 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ageMonths/i);
  });

  it('returns 400 for invalid healthStatus', async () => {
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(validPayload({ healthStatus: 'ZOMBIE' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/healthStatus/i);
  });

  it('returns 409 when animalId is already registered', async () => {
    const payload = validPayload();

    // Register once
    await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    // Attempt duplicate
    const res = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });
});

// ─── GET /api/livestock/my-kraal ─────────────────────────────────────────────

describe('GET /api/livestock/my-kraal', () => {
  it('returns empty list when the farmer has no livestock', async () => {
    const res = await request(app)
      .get('/api/livestock/my-kraal')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.livestock).toHaveLength(0);
    expect(res.body.count).toBe(0);
  });

  it('returns livestock belonging to the authenticated farmer', async () => {
    const payload = validPayload();
    await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    const res = await request(app)
      .get('/api/livestock/my-kraal')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.livestock[0].animalId).toBe(payload.animalId);
  });

  it('returns parsed metadata (object, not string)', async () => {
    await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(validPayload());

    const res = await request(app)
      .get('/api/livestock/my-kraal')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.livestock[0].metadata).toBe('object');
  });

  it('does not return another farmer\'s livestock', async () => {
    // Create a second farmer and register livestock under them
    const otherKeypair = Keypair.random();
    const otherUser = await prisma.user.create({
      data: { publicKey: otherKeypair.publicKey(), role: 'FARMER' },
    });
    const otherToken = issueJwt({
      sub: otherUser.id,
      publicKey: otherUser.publicKey,
      role: otherUser.role,
    });

    await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(validPayload({ animalId: 'OTHER-FARMER-ANIMAL' }));

    // First farmer should still see 0
    const res = await request(app)
      .get('/api/livestock/my-kraal')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/livestock/my-kraal');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/livestock/:id ───────────────────────────────────────────────────

describe('GET /api/livestock/:id', () => {
  it('returns a livestock record by its internal id', async () => {
    const payload = validPayload();
    const createRes = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    const id = createRes.body.livestock.id as string;

    const res = await request(app)
      .get(`/api/livestock/${id}`)
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.livestock.id).toBe(id);
    expect(res.body.livestock.animalId).toBe(payload.animalId);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request(app)
      .get('/api/livestock/nonexistent-id-xyz')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(404);
  });
});

// ─── PATCH /api/livestock/:id ────────────────────────────────────────────────

describe('PATCH /api/livestock/:id', () => {
  it('allows owner to update imageUrl and location', async () => {
    const payload = validPayload();
    const createRes = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    const id = createRes.body.livestock.id as string;

    const res = await request(app)
      .patch(`/api/livestock/${id}`)
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ imageUrl: 'https://example.com/cow.jpg', location: 'Cape Town' });

    expect(res.status).toBe(200);
    const meta = res.body.livestock.metadata as { imageUrl?: string; location?: string };
    expect(meta.imageUrl).toBe('https://example.com/cow.jpg');
    expect(meta.location).toBe('Cape Town');
  });

  it('returns 403 when non-owner tries to update', async () => {
    const payload = validPayload();
    const createRes = await request(app)
      .post('/api/livestock/register')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send(payload);

    const id = createRes.body.livestock.id as string;

    // Create a different farmer
    const otherKeypair = Keypair.random();
    const otherUser = await prisma.user.create({
      data: { publicKey: otherKeypair.publicKey(), role: 'FARMER' },
    });
    const otherToken = issueJwt({
      sub: otherUser.id,
      publicKey: otherUser.publicKey,
      role: otherUser.role,
    });

    const res = await request(app)
      .patch(`/api/livestock/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ location: 'Intruder Location' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent livestock id', async () => {
    const res = await request(app)
      .patch('/api/livestock/does-not-exist')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ location: 'Nowhere' });

    expect(res.status).toBe(404);
  });
});
