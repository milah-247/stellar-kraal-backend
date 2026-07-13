/**
 * src/server.ts
 *
 * Application entry point.
 * Binds the Express app to a TCP port and starts the Soroban event poller.
 *
 * Run via: node dist/server.js  or  ts-node-dev src/server.ts
 */

import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import prisma from './lib/prisma';
import { startEventPoller, stopEventPoller } from './services/soroban.service';

const app = createApp();

async function start(): Promise<void> {
  // Verify database connectivity before accepting traffic
  await prisma.$connect();
  logger.info('Database connection established');

  const server = app.listen(env.PORT, () => {
    logger.info(`StellarKraal API listening`, {
      port: env.PORT,
      env: env.NODE_ENV,
      network: env.STELLAR_NETWORK,
      rpc: env.RPC_URL,
    });
  });

  // Start the Soroban event indexer
  startEventPoller();

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully…`);

    stopEventPoller();

    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Server closed. Bye.');
      process.exit(0);
    });

    // Force exit if shutdown takes too long
    setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

start().catch((err) => {
  logger.error('Failed to start server', { message: (err as Error).message });
  process.exit(1);
});
