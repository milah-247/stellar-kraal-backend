/**
 * src/types/domain.ts
 *
 * Domain string-literal types for Role, VerificationStatus, and LoanStatus.
 * These mirror the Prisma schema String fields with documented allowed values.
 *
 * SQLite does not support native Prisma enums; we use string fields in the
 * database and enforce these types at the application layer.
 */

export type Role = 'FARMER' | 'INVESTOR' | 'ADMIN';

export type VerificationStatus = 'PENDING' | 'APPRAISED' | 'VERIFIED' | 'REJECTED';

export type LoanStatus = 'ACTIVE' | 'REPAID' | 'LIQUIDATED' | 'DEFAULTED';

// Convenience objects for switch statements and comparisons
export const Role = {
  FARMER: 'FARMER' as const,
  INVESTOR: 'INVESTOR' as const,
  ADMIN: 'ADMIN' as const,
};

export const VerificationStatus = {
  PENDING: 'PENDING' as const,
  APPRAISED: 'APPRAISED' as const,
  VERIFIED: 'VERIFIED' as const,
  REJECTED: 'REJECTED' as const,
};

export const LoanStatus = {
  ACTIVE: 'ACTIVE' as const,
  REPAID: 'REPAID' as const,
  LIQUIDATED: 'LIQUIDATED' as const,
  DEFAULTED: 'DEFAULTED' as const,
};
