/**
 * src/lib/prisma.ts
 *
 * Prisma Client singleton — prevents multiple connections during hot-reload
 * in development (Next.js / ts-node-dev pattern).
 */

import { PrismaClient } from '@prisma/client';
import { createLogger } from './logger';

const log = createLogger('prisma');

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
  });

  client.$on('error', (e) => {
    log.error('Prisma error', { message: e.message, target: e.target });
  });

  client.$on('warn', (e) => {
    log.warn('Prisma warning', { message: e.message, target: e.target });
  });

  return client;
}

// In development, preserve the client across module hot-reloads
export const prisma: PrismaClient =
  global.__prisma ?? createPrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  global.__prisma = prisma;
}

export default prisma;
