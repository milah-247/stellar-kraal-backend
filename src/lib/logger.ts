/**
 * src/lib/logger.ts
 *
 * Structured JSON logger using Winston.
 * In development the console transport uses colorized, human-readable format.
 * In production a JSON transport is used for log aggregators (Datadog, CloudWatch, etc.).
 */

import winston from 'winston';
import { env } from '../config/env';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// ─── Development format ──────────────────────────────────────────────────────

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}] ${message}${metaStr}${stack ? `\n${stack}` : ''}`;
  }),
);

// ─── Production format ───────────────────────────────────────────────────────

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

// ─── Logger instance ─────────────────────────────────────────────────────────

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: env.NODE_ENV === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'stellarkraal-api' },
  transports: [
    new winston.transports.Console({
      silent: env.NODE_ENV === 'test',
    }),
  ],
  exitOnError: false,
});

// ─── Child logger factory ────────────────────────────────────────────────────

/**
 * Create a child logger with a fixed module label.
 * Usage: const log = createLogger('auth-service')
 */
export function createLogger(module: string): winston.Logger {
  return logger.child({ module });
}
