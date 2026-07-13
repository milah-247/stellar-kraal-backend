/**
 * tests/unit/middleware.test.ts
 *
 * Unit tests for requireAuth and requireRole middleware.
 * Uses a minimal mock Express request/response/next pattern.
 */

import { Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../src/middleware/requireAuth';
import { issueJwt } from '../../src/services/auth.service';
import { Role } from '../../src/types/domain';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/test',
    ...overrides,
  } as unknown as Request;
}

function mockRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

function mockNext(): NextFunction {
  return jest.fn();
}

// ─── requireAuth ─────────────────────────────────────────────────────────────

describe('requireAuth middleware', () => {
  const validPayload = {
    sub: 'user-001',
    publicKey: 'GCFARMERPUBLICKEY',
    role: 'FARMER' as Role,
  };

  it('calls next() when a valid Bearer token is provided', () => {
    const token = issueJwt(validPayload);
    const req = mockReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const { res, status } = mockRes();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error argument
    expect(status).not.toHaveBeenCalled();
  });

  it('attaches the decoded user payload to req.user', () => {
    const token = issueJwt(validPayload);
    const req = mockReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const { res } = mockRes();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(req.user).toBeDefined();
    expect(req.user!.sub).toBe(validPayload.sub);
    expect(req.user!.publicKey).toBe(validPayload.publicKey);
    expect(req.user!.role).toBe(validPayload.role);
  });

  it('returns 401 when the Authorization header is missing', () => {
    const req = mockReq({ headers: {} });
    const { res, status, json } = mockRes();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('returns 401 when the Authorization header does not start with Bearer', () => {
    const req = mockReq({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    const { res, status } = mockRes();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 401 for an expired token', () => {
    const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
    const expired = jwt.sign(
      validPayload,
      process.env['JWT_SECRET']!,
      { expiresIn: -1 },
    );

    const req = mockReq({
      headers: { authorization: `Bearer ${expired}` },
    });
    const { res, status } = mockRes();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 401 for a tampered token', () => {
    const token = issueJwt(validPayload);
    const [h, b, s] = token.split('.');
    const tampered = `${h}.${b}.${s}XXX`;

    const req = mockReq({
      headers: { authorization: `Bearer ${tampered}` },
    });
    const { res, status } = mockRes();
    const next = mockNext();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});

// ─── requireRole ─────────────────────────────────────────────────────────────

describe('requireRole middleware', () => {
  function reqWithUser(role: Role): Request {
    return mockReq({
      user: { sub: 'user-001', publicKey: 'GPUBKEY', role },
    } as unknown as Partial<Request>);
  }

  it('calls next() when user has the required role', () => {
    const handler = requireRole('FARMER');
    const req = reqWithUser('FARMER');
    const { res, status } = mockRes();
    const next = mockNext();

    handler(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('calls next() when user has any of multiple allowed roles', () => {
    const handler = requireRole('FARMER', 'ADMIN');
    const req = reqWithUser('ADMIN');
    const { res, status } = mockRes();
    const next = mockNext();

    handler(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('returns 403 when user does not have the required role', () => {
    const handler = requireRole('ADMIN');
    const req = reqWithUser('FARMER');
    const { res, status, json } = mockRes();
    const next = mockNext();

    handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Forbidden' }),
    );
  });

  it('returns 401 when req.user is not set', () => {
    const handler = requireRole('FARMER');
    const req = mockReq(); // no user
    const { res, status } = mockRes();
    const next = mockNext();

    handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────

describe('errorHandler middleware', () => {
  const { errorHandler, createApiError, notFoundHandler } = require('../../src/middleware/errorHandler') as typeof import('../../src/middleware/errorHandler');

  it('responds with the correct status code from ApiError', () => {
    const err = createApiError('Not found', 404, 'RESOURCE_NOT_FOUND');
    const req = mockReq();
    const { res, status, json } = mockRes();
    const next = mockNext();

    // errorHandler has 4 params — need _next
    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }),
    );
  });

  it('defaults to 500 for an error without statusCode', () => {
    const err = new Error('Something went wrong');
    const req = mockReq();
    const { res, status } = mockRes();
    const next = mockNext();

    errorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('notFoundHandler returns 404 with the path', () => {
    const req = mockReq({ originalUrl: '/api/unknown' });
    const { res, status, json } = mockRes();

    notFoundHandler(req, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/unknown' }),
    );
  });
});
