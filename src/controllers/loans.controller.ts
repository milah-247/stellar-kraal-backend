/**
 * src/controllers/loans.controller.ts
 *
 * Handles:
 *   GET  /api/loans            — market view (active loans for investors)
 *   GET  /api/loans/:id        — single loan (DB + optional on-chain fallback)
 *   GET  /api/loans/my         — borrower's own loans
 *   POST /api/loans/request    — borrower requests a new loan
 */

import { Request, Response, NextFunction } from 'express';
import { getLoanState } from '../services/soroban.service';
import prisma from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { LoanStatus } from '../types/domain';

const log = createLogger('loans-controller');

// ─── Market View (Investors) ──────────────────────────────────────────────────

/**
 * GET /api/loans
 *
 * Returns active loans visible to investors.
 * Supports pagination via ?page=1&limit=20
 */
export async function getMarketLoans(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10)));
    const skip = (page - 1) * limit;

    const [total, loans] = await Promise.all([
      prisma.loan.count({ where: { status: LoanStatus.ACTIVE } }),
      prisma.loan.findMany({
        where: { status: LoanStatus.ACTIVE },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          contractLoanId: true,
          principalUSDC: true,
          interestRateBps: true,
          durationDays: true,
          status: true,
          createdOnChainAt: true,
          borrower: {
            select: { publicKey: true, displayName: true },
          },
          livestock: {
            select: {
              animalId: true,
              appraisedValueUSDC: true,
              metadata: true,
              verificationStatus: true,
            },
          },
        },
      }),
    ]);

    const items = loans.map((l) => ({
      ...l,
      livestock: l.livestock
        ? { ...l.livestock, metadata: safeParseJson(l.livestock.metadata) }
        : null,
    }));

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      loans: items,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Single Loan ──────────────────────────────────────────────────────────────

/**
 * GET /api/loans/:id
 *
 * Returns the loan from the SQLite index first.
 * If ?realtime=true is passed, also fetches live on-chain state via
 * Soroban `get_loan_state` simulation and merges it into the response.
 */
export async function getLoanById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const realtime = req.query['realtime'] === 'true';

    const loan = await prisma.loan.findFirst({
      where: {
        OR: [
          { id },
          { contractLoanId: id },
        ],
      },
      include: {
        borrower: {
          select: { id: true, publicKey: true, displayName: true, role: true },
        },
        livestock: {
          select: {
            id: true,
            animalId: true,
            metadata: true,
            appraisedValueUSDC: true,
            verificationStatus: true,
          },
        },
      },
    });

    if (!loan) {
      res.status(404).json({ error: 'Loan not found' });
      return;
    }

    let onChainState: unknown = null;

    if (realtime) {
      try {
        onChainState = await getLoanState(loan.contractLoanId);
      } catch (err) {
        log.warn('On-chain state fetch failed', { loanId: id, err });
        // Non-fatal — return DB data with warning
      }
    }

    res.json({
      loan: {
        ...loan,
        livestock: loan.livestock
          ? { ...loan.livestock, metadata: safeParseJson(loan.livestock.metadata) }
          : null,
      },
      onChainState,
      syncWarning: realtime && !onChainState
        ? 'On-chain state unavailable; showing indexed data'
        : undefined,
    });
  } catch (err) {
    next(err);
  }
}

// ─── My Loans (Borrower) ─────────────────────────────────────────────────────

/**
 * GET /api/loans/my
 *
 * Returns the authenticated user's own loans.
 * Optionally filter by ?status=ACTIVE|REPAID|LIQUIDATED
 */
export async function getMyLoans(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.user!.sub;
    const statusFilter = req.query['status'] as LoanStatus | undefined;

    const validStatuses = Object.values(LoanStatus);
    const where = {
      borrowerId: userId,
      ...(statusFilter && validStatuses.includes(statusFilter)
        ? { status: statusFilter }
        : {}),
    };

    const loans = await prisma.loan.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        livestock: {
          select: {
            animalId: true,
            metadata: true,
            appraisedValueUSDC: true,
            verificationStatus: true,
          },
        },
      },
    });

    const items = loans.map((l) => ({
      ...l,
      livestock: l.livestock
        ? { ...l.livestock, metadata: safeParseJson(l.livestock.metadata) }
        : null,
    }));

    res.json({ count: items.length, loans: items });
  } catch (err) {
    next(err);
  }
}

// ─── Request Loan ─────────────────────────────────────────────────────────────

/**
 * POST /api/loans/request
 *
 * Borrower requests a new loan against their verified collateral.
 * The actual loan creation happens on-chain via the Soroban contract;
 * this endpoint validates preconditions and returns instructions for
 * the frontend to construct the on-chain call.
 *
 * Body: { livestockId: string; principalUSDC: number; durationDays: number }
 */
export async function requestLoan(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.user!.sub;
    const publicKey = req.user!.publicKey;

    const { livestockId, principalUSDC, durationDays } = req.body as {
      livestockId?: string;
      principalUSDC?: number;
      durationDays?: number;
    };

    if (!livestockId || typeof livestockId !== 'string') {
      res.status(400).json({ error: 'livestockId is required' });
      return;
    }
    if (typeof principalUSDC !== 'number' || principalUSDC <= 0) {
      res.status(400).json({ error: 'principalUSDC must be a positive number' });
      return;
    }
    if (typeof durationDays !== 'number' || durationDays < 1 || durationDays > 730) {
      res.status(400).json({ error: 'durationDays must be between 1 and 730' });
      return;
    }

    // Find the livestock
    const livestock = await prisma.livestock.findUnique({
      where: { id: livestockId },
    });

    if (!livestock) {
      res.status(404).json({ error: 'Livestock not found' });
      return;
    }
    if (livestock.ownerId !== userId) {
      res.status(403).json({ error: 'Forbidden: not the owner of this livestock' });
      return;
    }
    if (livestock.verificationStatus !== 'VERIFIED') {
      res.status(422).json({
        error: 'Livestock is not yet verified on-chain',
        verificationStatus: livestock.verificationStatus,
      });
      return;
    }

    // Check principal doesn't exceed collateral value
    if (livestock.appraisedValueUSDC !== null &&
      principalUSDC > livestock.appraisedValueUSDC) {
      res.status(422).json({
        error: 'Requested principal exceeds appraised collateral value',
        maxPrincipalUSDC: livestock.appraisedValueUSDC,
      });
      return;
    }

    // Check no active loan already exists for this livestock
    const activeLoan = await prisma.loan.findFirst({
      where: { livestockId: livestock.id, status: LoanStatus.ACTIVE },
    });
    if (activeLoan) {
      res.status(409).json({
        error: 'This livestock already has an active loan',
        loanId: activeLoan.id,
      });
      return;
    }

    // Return the parameters the frontend needs to call the Soroban contract
    res.json({
      message: 'Loan request validated. Submit the following parameters to the Soroban contract.',
      contractId: process.env['CONTRACT_ID'],
      functionName: 'create_loan',
      params: {
        borrower: publicKey,
        collateralId: livestock.animalId,
        principalUSDC,
        durationDays,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
