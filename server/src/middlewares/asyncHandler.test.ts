import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { asyncHandler } from './asyncHandler';

describe('asyncHandler', () => {
  it('invokes the wrapped async function', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const next = vi.fn();
    const handler = asyncHandler(fn);

    handler({} as Request, {} as Response, next as NextFunction);
    await Promise.resolve();

    expect(fn).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards rejected promises to next', async () => {
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);
    const next = vi.fn();
    const handler = asyncHandler(fn);

    handler({} as Request, {} as Response, next as NextFunction);
    await Promise.resolve();
    await Promise.resolve();

    expect(next).toHaveBeenCalledWith(err);
  });
});
