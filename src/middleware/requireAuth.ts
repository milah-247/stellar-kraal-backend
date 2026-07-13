/**
 * src/middleware/requireAuth.ts
 *
 * JWT authentication middleware.
 * Extracts the Bearer token from the Authorization header, verifies it,
 * and attaches the decoded payload to req.user.
 *
 * Optional role-based guard factory: requireRole('ADMIN')
 */

import { Request, Response, NextFunction } from 'express';
import { verifyJwt, TokenPayload } from '../services/auth.service';
import { createLogger } from '../lib/logger';
import { Role } from '../types/domain';

const log = createLogger('auth-middleware');

// Extend Express Request to carry the verified user
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/**
 * requireAuth — validates the JWT on every protected request.
 *
 * Responds 401 if the token is absent, malformed, or expired.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7); // remove "Bearer "

  try {
    const payload = verifyJwt(token);
    req.user = payload;
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token';
    log.warn('Auth failure', { reason: message, path: req.path });
    res.status(401).json({ error: 'Unauthorized', detail: message });
  }
}

/**
 * requireRole — role-based guard. Must be used after requireAuth.
 *
 * @example router.get('/admin', requireAuth, requireRole('ADMIN'), handler)
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!roles.includes(req.user.role as Role)) {
      log.warn('Forbidden: insufficient role', {
        userId: req.user.sub,
        requiredRoles: roles,
        actualRole: req.user.role,
      });
      res.status(403).json({
        error: 'Forbidden',
        detail: `Required role: ${roles.join(' or ')}`,
      });
      return;
    }

    next();
  };
}
