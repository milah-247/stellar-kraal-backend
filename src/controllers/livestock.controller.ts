/**
 * src/controllers/livestock.controller.ts
 *
 * Handles:
 *   POST /api/livestock/register   — register livestock, trigger appraisal oracle
 *   GET  /api/livestock/my-kraal   — farmer's own verified collateral
 *   GET  /api/livestock/:id        — single livestock record
 *   PATCH /api/livestock/:id       — update metadata (owner or admin)
 */

import { Request, Response, NextFunction } from 'express';
import { appraiseLivestock, LivestockMetadata } from '../services/appraisal.service';
import { mintCollateral } from '../services/soroban.service';
import prisma from '../lib/prisma';
import { createLogger } from '../lib/logger';
import { VerificationStatus } from '../types/domain';

const log = createLogger('livestock-controller');

// ─── Register ─────────────────────────────────────────────────────────────────

/**
 * POST /api/livestock/register
 *
 * Accepts livestock metadata, runs the off-chain appraisal oracle,
 * then submits a `mint_collateral` Soroban transaction.
 *
 * Body:
 * {
 *   animalId: string         // Farmer's own tag/earmark
 *   type: AnimalType
 *   breed: string
 *   weightKg: number
 *   ageMonths: number
 *   healthStatus: HealthStatus
 *   imageUrl?: string
 *   location?: string
 * }
 */
export async function registerLivestock(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.user!.sub;
    const publicKey = req.user!.publicKey;

    const {
      animalId,
      type,
      breed,
      weightKg,
      ageMonths,
      healthStatus,
      imageUrl,
      location,
    } = req.body as Partial<LivestockMetadata & { animalId: string }>;

    // ── Validation ───────────────────────────────────────────────────────────
    if (!animalId || typeof animalId !== 'string') {
      res.status(400).json({ error: 'animalId is required' });
      return;
    }
    if (!type || !['CATTLE', 'GOAT', 'SHEEP', 'PIG', 'DONKEY'].includes(type)) {
      res.status(400).json({ error: 'type must be one of CATTLE, GOAT, SHEEP, PIG, DONKEY' });
      return;
    }
    if (!breed || typeof breed !== 'string') {
      res.status(400).json({ error: 'breed is required' });
      return;
    }
    if (typeof weightKg !== 'number' || weightKg <= 0) {
      res.status(400).json({ error: 'weightKg must be a positive number' });
      return;
    }
    if (typeof ageMonths !== 'number' || ageMonths < 0) {
      res.status(400).json({ error: 'ageMonths must be a non-negative number' });
      return;
    }
    if (!healthStatus || !['EXCELLENT', 'GOOD', 'FAIR', 'POOR'].includes(healthStatus)) {
      res.status(400).json({ error: 'healthStatus must be one of EXCELLENT, GOOD, FAIR, POOR' });
      return;
    }

    // Check for duplicate animalId
    const existing = await prisma.livestock.findUnique({ where: { animalId } });
    if (existing) {
      res.status(409).json({ error: 'Animal ID already registered', livestockId: existing.id });
      return;
    }

    const metadata: LivestockMetadata = {
      type,
      breed,
      weightKg,
      ageMonths,
      healthStatus,
      ...(imageUrl && { imageUrl }),
      ...(location && { location }),
    };

    // ── Appraise ─────────────────────────────────────────────────────────────
    log.info('Starting appraisal', { animalId, type, breed });
    const appraisal = await appraiseLivestock(metadata);

    // ── Create DB record (PENDING while we await on-chain confirmation) ──────
    const livestock = await prisma.livestock.create({
      data: {
        animalId,
        ownerId: userId,
        metadata: JSON.stringify(metadata),
        appraisedValueUSDC: appraisal.collateralValueUSDC,
        verificationStatus: VerificationStatus.APPRAISED,
      },
    });

    // ── Submit to Soroban (async — don't block the response) ─────────────────
    mintCollateral(animalId, publicKey, appraisal.collateralValueUSDC)
      .then(async (txHash) => {
        await prisma.livestock.update({
          where: { id: livestock.id },
          data: {
            verificationStatus: VerificationStatus.VERIFIED,
            appraisalTxHash: txHash,
          },
        });
        log.info('Collateral minted on-chain', { animalId, txHash });
      })
      .catch((err: unknown) => {
        log.error('mint_collateral failed', { animalId, err });
        prisma.livestock
          .update({
            where: { id: livestock.id },
            data: { verificationStatus: VerificationStatus.REJECTED },
          })
          .catch(() => undefined);
      });

    res.status(201).json({
      message: 'Livestock registered and appraised. On-chain verification pending.',
      livestock: {
        id: livestock.id,
        animalId: livestock.animalId,
        verificationStatus: livestock.verificationStatus,
        appraisedValueUSDC: livestock.appraisedValueUSDC,
      },
      appraisal,
    });
  } catch (err) {
    next(err);
  }
}

// ─── My Kraal ─────────────────────────────────────────────────────────────────

/**
 * GET /api/livestock/my-kraal
 *
 * Returns the authenticated farmer's own livestock records.
 * Defaults to verified collateral; pass ?all=true to include pending/rejected.
 */
export async function getMyKraal(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.user!.sub;
    const showAll = req.query['all'] === 'true';

    const livestock = await prisma.livestock.findMany({
      where: {
        ownerId: userId,
        ...(!showAll && {
          verificationStatus: {
            in: [VerificationStatus.VERIFIED, VerificationStatus.APPRAISED],
          },
        }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        animalId: true,
        metadata: true,
        appraisedValueUSDC: true,
        appraisalTxHash: true,
        verificationStatus: true,
        createdAt: true,
        updatedAt: true,
        loans: {
          where: { status: 'ACTIVE' },
          select: { id: true, contractLoanId: true, principalUSDC: true },
        },
      },
    });

    // Parse metadata JSON
    const items = livestock.map((l) => ({
      ...l,
      metadata: safeParseJson(l.metadata),
    }));

    res.json({ count: items.length, livestock: items });
  } catch (err) {
    next(err);
  }
}

// ─── Get Single ──────────────────────────────────────────────────────────────

/**
 * GET /api/livestock/:id
 */
export async function getLivestockById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;

    const livestock = await prisma.livestock.findUnique({
      where: { id },
      include: {
        owner: {
          select: { id: true, publicKey: true, displayName: true },
        },
        loans: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            contractLoanId: true,
            principalUSDC: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    if (!livestock) {
      res.status(404).json({ error: 'Livestock not found' });
      return;
    }

    res.json({
      livestock: {
        ...livestock,
        metadata: safeParseJson(livestock.metadata),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Update ──────────────────────────────────────────────────────────────────

/**
 * PATCH /api/livestock/:id
 *
 * Owner can update imageUrl, location only after initial registration.
 * Admins can update verificationStatus.
 */
export async function updateLivestock(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const userId = req.user!.sub;
    const isAdmin = req.user!.role === 'ADMIN';

    const livestock = await prisma.livestock.findUnique({ where: { id } });
    if (!livestock) {
      res.status(404).json({ error: 'Livestock not found' });
      return;
    }

    if (!isAdmin && livestock.ownerId !== userId) {
      res.status(403).json({ error: 'Forbidden: not the owner' });
      return;
    }

    const currentMeta = safeParseJson(livestock.metadata) as Record<string, unknown>;
    const { imageUrl, location, verificationStatus } = req.body as {
      imageUrl?: string;
      location?: string;
      verificationStatus?: VerificationStatus;
    };

    const updatedMeta = {
      ...currentMeta,
      ...(imageUrl !== undefined && { imageUrl }),
      ...(location !== undefined && { location }),
    };

    const updated = await prisma.livestock.update({
      where: { id },
      data: {
        metadata: JSON.stringify(updatedMeta),
        ...(isAdmin && verificationStatus !== undefined && { verificationStatus }),
      },
    });

    res.json({
      livestock: {
        ...updated,
        metadata: safeParseJson(updated.metadata),
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
