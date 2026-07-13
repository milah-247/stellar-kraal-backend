/**
 * tests/integration/loans.routes.test.ts
 *
 * Integration tests for loan market, loan detail, and loan request endpoints.
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
  mintCollateral: jest.fn().mockResolvedValue('mock-tx-hash'),
  getLoanState: jest.fn().mockResolvedValue({
    loanId: 'on-chain-loan-001',
    borrower: 'GBORROWER',
    principalUSDC: 500,
    interestRateBps: 500,
    status: 'ACTIVE',
    durationDays: 90,
  }),
}));

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: Application;
let farmerToken: string;
let farmerId: string;

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

  const keypair = Keypair.random();
  const user = await prisma.user.create({
    data: { publicKey: keypair.publicKey(), role: 'FARMER' },
  });
  farmerId = user.id;
  farmerToken = issueJwt({ sub: user.id, publicKey: user.publicKey, role: user.role });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createVerifiedLivestock(ownerId: string): Promise<string> {
  const livestock = await prisma.livestock.create({
    data: {
      animalId: `TAG-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ownerId,
      metadata: JSON.stringify({
        type: 'CATTLE',
        breed: 'angus',
        weightKg: 450,
        ageMonths: 36,
        healthStatus: 'GOOD',
      }),
      appraisedValueUSDC: 1000.0,
      verificationStatus: 'VERIFIED',
    },
  });
  return livestock.id;
}

async function createActiveLoan(borrowerId: string, livestockId: string): Promise<string> {
  const loan = await prisma.loan.create({
    data: {
      contractLoanId: `LOAN-${Date.now()}`,
      borrowerId,
      livestockId,
      principalUSDC: 500.0,
      interestRateBps: 500,
      durationDays: 90,
      status: 'ACTIVE',
    },
  });
  return loan.id;
}

// ─── GET /api/loans ───────────────────────────────────────────────────────────

describe('GET /api/loans', () => {
  it('returns 200 with pagination envelope when no loans exist', async () => {
    const res = await request(app).get('/api/loans');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
      loans: [],
    });
  });

  it('returns active loans with borrower and livestock data', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    await createActiveLoan(farmerId, livestockId);

    const res = await request(app).get('/api/loans');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0]).toHaveProperty('borrower');
    expect(res.body.loans[0]).toHaveProperty('livestock');
  });

  it('respects pagination: page and limit params', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    // Create 3 loans
    for (let i = 0; i < 3; i++) {
      await prisma.loan.create({
        data: {
          contractLoanId: `LOAN-PAGINATE-${i}`,
          borrowerId: farmerId,
          livestockId,
          principalUSDC: 100 + i,
          interestRateBps: 500,
          durationDays: 90,
          status: 'ACTIVE',
        },
      });
    }

    const res = await request(app).get('/api/loans').query({ page: 1, limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.loans).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.totalPages).toBe(2);
  });

  it('does not include REPAID loans in the market view', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    await prisma.loan.create({
      data: {
        contractLoanId: 'LOAN-REPAID',
        borrowerId: farmerId,
        livestockId,
        principalUSDC: 200,
        interestRateBps: 500,
        durationDays: 90,
        status: 'REPAID',
      },
    });

    const res = await request(app).get('/api/loans');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('returns parsed livestock metadata (object, not string)', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    await createActiveLoan(farmerId, livestockId);

    const res = await request(app).get('/api/loans');
    expect(res.status).toBe(200);
    expect(typeof res.body.loans[0].livestock.metadata).toBe('object');
  });
});

// ─── GET /api/loans/:id ───────────────────────────────────────────────────────

describe('GET /api/loans/:id', () => {
  it('returns a loan by its internal database id', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    const loanId = await createActiveLoan(farmerId, livestockId);

    const res = await request(app).get(`/api/loans/${loanId}`);

    expect(res.status).toBe(200);
    expect(res.body.loan.id).toBe(loanId);
    expect(res.body.loan.status).toBe('ACTIVE');
  });

  it('returns a loan by its contractLoanId', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    const loan = await prisma.loan.create({
      data: {
        contractLoanId: 'CONTRACT-ID-LOOKUP',
        borrowerId: farmerId,
        livestockId,
        principalUSDC: 300,
        interestRateBps: 500,
        durationDays: 60,
        status: 'ACTIVE',
      },
    });

    const res = await request(app).get(`/api/loans/${loan.contractLoanId}`);

    expect(res.status).toBe(200);
    expect(res.body.loan.contractLoanId).toBe('CONTRACT-ID-LOOKUP');
  });

  it('returns 404 for non-existent id', async () => {
    const res = await request(app).get('/api/loans/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('includes onChainState when ?realtime=true', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    const loanId = await createActiveLoan(farmerId, livestockId);

    const res = await request(app).get(`/api/loans/${loanId}`).query({ realtime: 'true' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('onChainState');
    // Mock returns a non-null state
    expect(res.body.onChainState).not.toBeNull();
  });

  it('returns syncWarning when realtime requested but onChainState is null', async () => {
    const { getLoanState } = jest.requireMock('../../src/services/soroban.service') as {
      getLoanState: jest.Mock;
    };
    getLoanState.mockResolvedValueOnce(null);

    const livestockId = await createVerifiedLivestock(farmerId);
    const loanId = await createActiveLoan(farmerId, livestockId);

    const res = await request(app).get(`/api/loans/${loanId}`).query({ realtime: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.onChainState).toBeNull();
    expect(res.body.syncWarning).toMatch(/unavailable/i);
  });
});

// ─── GET /api/loans/my ────────────────────────────────────────────────────────

describe('GET /api/loans/my', () => {
  it('returns the authenticated borrower\'s own loans', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    await createActiveLoan(farmerId, livestockId);

    const res = await request(app)
      .get('/api/loans/my')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.loans[0].borrowerId).toBe(farmerId);
  });

  it('does not return loans belonging to other users', async () => {
    const otherKeypair = Keypair.random();
    const otherUser = await prisma.user.create({
      data: { publicKey: otherKeypair.publicKey(), role: 'FARMER' },
    });
    const otherLivestockId = await createVerifiedLivestock(otherUser.id);
    await createActiveLoan(otherUser.id, otherLivestockId);

    const res = await request(app)
      .get('/api/loans/my')
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('filters by status when ?status=REPAID is provided', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    await createActiveLoan(farmerId, livestockId); // ACTIVE
    await prisma.loan.create({
      data: {
        contractLoanId: 'REPAID-LOAN',
        borrowerId: farmerId,
        livestockId,
        principalUSDC: 100,
        interestRateBps: 300,
        durationDays: 30,
        status: 'REPAID',
      },
    });

    const res = await request(app)
      .get('/api/loans/my')
      .query({ status: 'REPAID' })
      .set('Authorization', `Bearer ${farmerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.loans[0].status).toBe('REPAID');
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/loans/my');
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/loans/request ─────────────────────────────────────────────────

describe('POST /api/loans/request', () => {
  it('returns 200 with Soroban call params when preconditions are met', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);

    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ livestockId, principalUSDC: 500, durationDays: 90 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contractId');
    expect(res.body).toHaveProperty('functionName', 'create_loan');
    expect(res.body.params.principalUSDC).toBe(500);
    expect(res.body.params.durationDays).toBe(90);
  });

  it('returns 400 when livestockId is missing', async () => {
    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ principalUSDC: 500, durationDays: 90 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/livestockId/i);
  });

  it('returns 400 when principalUSDC is missing or non-positive', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);

    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ livestockId, principalUSDC: 0, durationDays: 90 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/principalUSDC/i);
  });

  it('returns 400 when durationDays is out of range', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);

    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ livestockId, principalUSDC: 100, durationDays: 800 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/durationDays/i);
  });

  it('returns 422 when livestock is not yet VERIFIED', async () => {
    const pending = await prisma.livestock.create({
      data: {
        animalId: 'PENDING-ANIMAL',
        ownerId: farmerId,
        metadata: JSON.stringify({ type: 'GOAT' }),
        appraisedValueUSDC: 200,
        verificationStatus: 'PENDING',
      },
    });

    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ livestockId: pending.id, principalUSDC: 100, durationDays: 30 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not yet verified/i);
  });

  it('returns 422 when principal exceeds appraised collateral value', async () => {
    const livestockId = await createVerifiedLivestock(farmerId); // valued at 1000

    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ livestockId, principalUSDC: 9999, durationDays: 90 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/exceeds.*collateral/i);
  });

  it('returns 409 when an active loan already exists for the livestock', async () => {
    const livestockId = await createVerifiedLivestock(farmerId);
    await createActiveLoan(farmerId, livestockId);

    const res = await request(app)
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ livestockId, principalUSDC: 200, durationDays: 30 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has an active loan/i);
  });

  it('returns 403 when a different farmer tries to borrow against livestock they do not own', async () => {
    // Create livestock owned by farmer 1
    const livestockId = await createVerifiedLivestock(farmerId);

    // Log in as farmer 2
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
      .post('/api/loans/request')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ livestockId, principalUSDC: 100, durationDays: 30 });

    expect(res.status).toBe(403);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post('/api/loans/request')
      .send({ livestockId: 'any', principalUSDC: 100, durationDays: 30 });

    expect(res.status).toBe(401);
  });
});
