/**
 * src/middleware/errorHandler.ts
 *
 * Central Express error handler.
 * Must be registered last (after all routes).
 *
 * Produces structured JSON error responses.
 * In production, internal details are hidden from the client.
 */

import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger';
import { env } from '../config/env';

const log = createLogger('error-handler');

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Create a well-typed API error.
 */
export function createApiError(
  message: string,
  statusCode = 500,
  code?: string,
): ApiError {
  const err = new Error(message) as ApiError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * 404 handler — must be registered before errorHandler, after all routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
  });
}

/**
 * Global error handler middleware.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  const isServerError = statusCode >= 500;

  if (isServerError) {
    log.error('Unhandled server error', {
      message: err.message,
      stack: err.stack,
      code: err.code,
    });
  } else {
    log.warn('Client error', { message: err.message, code: err.code, statusCode });
  }

  // In production don't leak internal error details
  const detail =
    isServerError && env.NODE_ENV === 'production'
      ? 'An internal error occurred'
      : err.message;

  res.status(statusCode).json({
    error: statusCodeText(statusCode),
    detail,
    ...(err.code && { code: err.code }),
  });
}

function statusCodeText(code: number): string {
  const map: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return map[code] ?? 'Error';
}
