import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

async function loadHandlers(isProd = false) {
  vi.resetModules();
  const logger = {
    error: vi.fn(),
    debug: vi.fn(),
  };
  vi.doMock('../lib/logger', () => ({ logger }));
  vi.doMock('../config/env', () => ({ isProd }));
  const { AppError } = await import('../lib/errors');
  const mod = await import('./errorHandler');
  return { ...mod, logger, AppError };
}

describe('errorHandler', () => {
  it('builds a not-found AppError from the request method and path', async () => {
    const { notFoundHandler } = await loadHandlers();
    const next = vi.fn();

    notFoundHandler(
      { method: 'PATCH', originalUrl: '/api/v1/missing' } as Request,
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'NOT_FOUND',
        status: 404,
        message: 'Cannot PATCH /api/v1/missing',
      }),
    );
  });

  it('formats AppError responses and logs 4xx as debug', async () => {
    const { errorHandler, logger, AppError } = await loadHandlers();
    const req = { id: 'req-1' } as Request;
    const res = makeRes();
    const err = AppError.validation('Bad input', { field: 'required' });

    errorHandler(err, req, res, vi.fn());

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Bad input',
        fields: { field: 'required' },
        requestId: 'req-1',
      },
    });
  });

  it('returns the real message for unknown errors outside production', async () => {
    const { errorHandler, logger } = await loadHandlers(false);
    const req = { id: 'req-2' } as Request;
    const res = makeRes();

    errorHandler(new Error('explode'), req, res, vi.fn());

    expect(logger.error).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'explode',
        requestId: 'req-2',
      },
    });
  });

  it('hides unknown error details in production', async () => {
    const { errorHandler } = await loadHandlers(true);
    const res = makeRes();

    errorHandler(new Error('explode'), { id: 'req-3' } as Request, res, vi.fn());

    expect(res.payload).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Internal server error',
        requestId: 'req-3',
      },
    });
  });
});
