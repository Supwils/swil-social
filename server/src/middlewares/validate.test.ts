import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { validate } from './validate';

function makeReq(partial: Partial<Request>): Request {
  return partial as Request;
}

describe('validate middleware', () => {
  it('replaces the source payload with parsed schema output', () => {
    const req = makeReq({ query: { limit: '5' } });
    const next = vi.fn() as NextFunction;
    const middleware = validate(z.object({ limit: z.coerce.number().int() }), 'query');

    middleware(req, {} as Response, next);

    expect(req.query).toEqual({ limit: 5 });
    expect(next).toHaveBeenCalledWith();
  });

  it('returns a field map for validation errors', () => {
    const req = makeReq({ body: { ids: ['bad'] } });
    const next = vi.fn() as NextFunction;
    const middleware = validate(
      z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1) }),
    );

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      status: 400,
      fields: { 'ids.0': 'Invalid' },
    }));
  });
});
