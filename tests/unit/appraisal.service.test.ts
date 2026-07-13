/**
 * tests/unit/appraisal.service.test.ts
 *
 * Unit tests for the Collateral Appraisal Oracle (ADR-005 / ADR-006).
 *
 * All tests run fully offline — no network calls, no database.
 */

import {
  appraiseLivestock,
  LivestockMetadata,
  AnimalType,
  HealthStatus,
} from '../../src/services/appraisal.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const primeCattle: LivestockMetadata = {
  type: 'CATTLE',
  breed: 'angus',
  weightKg: 450,
  ageMonths: 36,       // prime range
  healthStatus: 'EXCELLENT',
};

const youngGoat: LivestockMetadata = {
  type: 'GOAT',
  breed: 'boer',
  weightKg: 25,
  ageMonths: 3,        // very young
  healthStatus: 'GOOD',
};

const oldSheep: LivestockMetadata = {
  type: 'SHEEP',
  breed: 'dorper',
  weightKg: 60,
  ageMonths: 120,      // old (> primeEnd * 1.5)
  healthStatus: 'FAIR',
};

const poorPig: LivestockMetadata = {
  type: 'PIG',
  breed: 'local',
  weightKg: 80,
  ageMonths: 18,       // prime
  healthStatus: 'POOR',
};

const unknownBreedDonkey: LivestockMetadata = {
  type: 'DONKEY',
  breed: 'exotic',     // not in breed table → premium 1.0
  weightKg: 200,
  ageMonths: 60,       // prime
  healthStatus: 'GOOD',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function appraise(meta: LivestockMetadata) {
  return appraiseLivestock(meta);
}

// ─── Core appraisal logic ─────────────────────────────────────────────────────

describe('appraiseLivestock – core pricing', () => {
  it('returns a positive marketValueUSDC for a prime cattle', async () => {
    const result = await appraise(primeCattle);
    expect(result.marketValueUSDC).toBeGreaterThan(0);
  });

  it('collateralValueUSDC is strictly less than marketValueUSDC (LTV haircut)', async () => {
    const result = await appraise(primeCattle);
    expect(result.collateralValueUSDC).toBeLessThan(result.marketValueUSDC);
  });

  it('EXCELLENT health gives the highest LTV ratio (0.75)', async () => {
    const result = await appraise(primeCattle);
    expect(result.ltvRatio).toBe(0.75);
  });

  it('GOOD health gives LTV 0.70', async () => {
    const result = await appraise(youngGoat);
    expect(result.ltvRatio).toBe(0.70);
  });

  it('FAIR health gives LTV 0.60', async () => {
    const result = await appraise(oldSheep);
    expect(result.ltvRatio).toBe(0.60);
  });

  it('POOR health gives LTV 0.45', async () => {
    const result = await appraise(poorPig);
    expect(result.ltvRatio).toBe(0.45);
  });

  it('collateralValueUSDC matches marketValueUSDC × ltvRatio (within float rounding)', async () => {
    const result = await appraise(primeCattle);
    const expected = parseFloat((result.marketValueUSDC * result.ltvRatio).toFixed(2));
    expect(result.collateralValueUSDC).toBeCloseTo(expected, 1);
  });

  it('returns a confidence score between 0 and 1', async () => {
    const result = await appraise(primeCattle);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('includes breakdown fields', async () => {
    const result = await appraise(primeCattle);
    expect(result.breakdown).toMatchObject({
      basePrice: expect.any(Number),
      weightAdjustment: expect.any(Number),
      ageMultiplier: expect.any(Number),
      healthMultiplier: expect.any(Number),
    });
  });
});

// ─── Age multiplier ───────────────────────────────────────────────────────────

describe('appraiseLivestock – age discounts', () => {
  it('very young cattle (< 12 months) gets 0.60 age multiplier', async () => {
    const meta: LivestockMetadata = { ...primeCattle, ageMonths: 5 };
    const result = await appraise(meta);
    expect(result.breakdown.ageMultiplier).toBe(0.60);
  });

  it('juvenile cattle (12–23 months) gets 0.80 age multiplier', async () => {
    const meta: LivestockMetadata = { ...primeCattle, ageMonths: 18 };
    const result = await appraise(meta);
    expect(result.breakdown.ageMultiplier).toBe(0.80);
  });

  it('prime cattle (24–84 months) gets 1.00 age multiplier', async () => {
    const result = await appraise(primeCattle); // ageMonths: 36
    expect(result.breakdown.ageMultiplier).toBe(1.00);
  });

  it('mature cattle (85–126 months) gets 0.85 age multiplier', async () => {
    const meta: LivestockMetadata = { ...primeCattle, ageMonths: 100 };
    const result = await appraise(meta);
    expect(result.breakdown.ageMultiplier).toBe(0.85);
  });

  it('old cattle (> 126 months) gets 0.65 age multiplier', async () => {
    const meta: LivestockMetadata = { ...primeCattle, ageMonths: 150 };
    const result = await appraise(meta);
    expect(result.breakdown.ageMultiplier).toBe(0.65);
  });

  it('old sheep (ageMonths: 120) receives 0.65 age multiplier', async () => {
    // primeEnd = 60, primeEnd * 1.5 = 90 → 120 > 90 → old
    const result = await appraise(oldSheep);
    expect(result.breakdown.ageMultiplier).toBe(0.65);
  });
});

// ─── Health multiplier ────────────────────────────────────────────────────────

describe('appraiseLivestock – health multipliers', () => {
  const base: LivestockMetadata = { ...primeCattle, ageMonths: 36 };

  it('EXCELLENT health multiplier is 1.00', async () => {
    const result = await appraise({ ...base, healthStatus: 'EXCELLENT' });
    expect(result.breakdown.healthMultiplier).toBe(1.00);
  });

  it('GOOD health multiplier is 0.90', async () => {
    const result = await appraise({ ...base, healthStatus: 'GOOD' });
    expect(result.breakdown.healthMultiplier).toBe(0.90);
  });

  it('FAIR health multiplier is 0.75', async () => {
    const result = await appraise({ ...base, healthStatus: 'FAIR' });
    expect(result.breakdown.healthMultiplier).toBe(0.75);
  });

  it('POOR health multiplier is 0.50', async () => {
    const result = await appraise({ ...base, healthStatus: 'POOR' });
    expect(result.breakdown.healthMultiplier).toBe(0.50);
  });

  it('POOR health gives significantly lower collateral than EXCELLENT', async () => {
    const excellent = await appraise({ ...base, healthStatus: 'EXCELLENT' });
    const poor = await appraise({ ...base, healthStatus: 'POOR' });
    expect(poor.collateralValueUSDC).toBeLessThan(excellent.collateralValueUSDC);
  });
});

// ─── Breed premium ────────────────────────────────────────────────────────────

describe('appraiseLivestock – breed premiums', () => {
  it('Angus cattle is priced higher than local breed (same weight/age/health)', async () => {
    const angus = await appraise({ ...primeCattle, breed: 'angus' });
    const local = await appraise({ ...primeCattle, breed: 'local' });
    expect(angus.marketValueUSDC).toBeGreaterThan(local.marketValueUSDC);
  });

  it('Boer goat is priced higher than local goat', async () => {
    const boer = await appraise({ ...youngGoat, breed: 'boer', ageMonths: 24 });
    const local = await appraise({ ...youngGoat, breed: 'local', ageMonths: 24 });
    expect(boer.marketValueUSDC).toBeGreaterThan(local.marketValueUSDC);
  });

  it('unknown breed falls back to 1.0 premium (no error)', async () => {
    const result = await appraise(unknownBreedDonkey);
    expect(result.marketValueUSDC).toBeGreaterThan(0);
  });
});

// ─── Weight scaling ───────────────────────────────────────────────────────────

describe('appraiseLivestock – weight scaling', () => {
  it('heavier animal has higher market value (same type/breed/age/health)', async () => {
    const light = await appraise({ ...primeCattle, weightKg: 200 });
    const heavy = await appraise({ ...primeCattle, weightKg: 600 });
    expect(heavy.marketValueUSDC).toBeGreaterThan(light.marketValueUSDC);
  });

  it('market value scales linearly with weight (ceteris paribus)', async () => {
    const w200 = await appraise({ ...primeCattle, weightKg: 200 });
    const w400 = await appraise({ ...primeCattle, weightKg: 400 });
    // Allow 1% tolerance for float rounding
    expect(w400.marketValueUSDC).toBeCloseTo(w200.marketValueUSDC * 2, 0);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('appraiseLivestock – input validation', () => {
  it('throws for weightKg <= 0', async () => {
    await expect(appraise({ ...primeCattle, weightKg: 0 })).rejects.toThrow(
      'weightKg must be positive',
    );
  });

  it('throws for negative weightKg', async () => {
    await expect(appraise({ ...primeCattle, weightKg: -10 })).rejects.toThrow(
      'weightKg must be positive',
    );
  });

  it('throws for negative ageMonths', async () => {
    await expect(appraise({ ...primeCattle, ageMonths: -1 })).rejects.toThrow(
      'ageMonths must be non-negative',
    );
  });

  it('accepts ageMonths = 0 (newborn)', async () => {
    // Should not throw; very young multiplier applies
    const result = await appraise({ ...primeCattle, ageMonths: 0 });
    expect(result.marketValueUSDC).toBeGreaterThan(0);
  });
});

// ─── Multi-species sanity ─────────────────────────────────────────────────────

describe('appraiseLivestock – multi-species', () => {
  const types: AnimalType[] = ['CATTLE', 'GOAT', 'SHEEP', 'PIG', 'DONKEY'];

  it.each(types)('%s: returns valid appraisal result', async (type) => {
    const meta: LivestockMetadata = {
      type,
      breed: 'local',
      weightKg: 100,
      ageMonths: 24,
      healthStatus: 'GOOD',
    };
    const result = await appraise(meta);
    expect(result.marketValueUSDC).toBeGreaterThan(0);
    expect(result.collateralValueUSDC).toBeGreaterThan(0);
    expect(result.ltvRatio).toBeGreaterThan(0);
    expect(result.ltvRatio).toBeLessThanOrEqual(1);
  });
});

// ─── Numerical precision ──────────────────────────────────────────────────────

describe('appraiseLivestock – numerical precision', () => {
  it('marketValueUSDC is rounded to 2 decimal places', async () => {
    const result = await appraise(primeCattle);
    const rounded = parseFloat(result.marketValueUSDC.toFixed(2));
    expect(result.marketValueUSDC).toBe(rounded);
  });

  it('collateralValueUSDC is rounded to 2 decimal places', async () => {
    const result = await appraise(primeCattle);
    const rounded = parseFloat(result.collateralValueUSDC.toFixed(2));
    expect(result.collateralValueUSDC).toBe(rounded);
  });

  it('breakdown.basePrice is rounded to 2 decimal places', async () => {
    const result = await appraise(primeCattle);
    const rounded = parseFloat(result.breakdown.basePrice.toFixed(2));
    expect(result.breakdown.basePrice).toBe(rounded);
  });
});

// ─── ADR-006: Oracle aggregation ─────────────────────────────────────────────

describe('appraiseLivestock – oracle aggregation (ADR-006)', () => {
  it('still returns a result when secondary oracle is unavailable (null response)', async () => {
    // The stub marketFeedOracle always returns null — the internal oracle
    // should be sufficient to produce a valid result.
    const result = await appraise(primeCattle);
    expect(result.marketValueUSDC).toBeGreaterThan(0);
  });

  it('confidence reflects fraction of available oracles (1/2 = 0.5)', async () => {
    // Internal oracle: available; market-feed: null → 1 out of 2
    const result = await appraise(primeCattle);
    expect(result.confidence).toBe(0.5);
  });
});
