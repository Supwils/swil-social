import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ApiKey } from '../models/apiKey.model';
import { User } from '../models/user.model';
import { optionalUser, requireUser } from './auth';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    session: {
      userId: undefined,
      destroy: vi.fn((cb?: () => void) => cb?.()),
    },
    ...overrides,
  } as unknown as Request;
}

describe('auth middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the active session user', async () => {
    const req = makeReq({ session: { userId: 'user-1', destroy: vi.fn() } as never });
    const next = vi.fn() as NextFunction;
    const user = { id: 'user-1', status: 'active' };

    vi.spyOn(User, 'findById').mockResolvedValue(user as never);

    await requireUser(req, {} as Response, next);

    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledWith();
  });

  it('destroys invalid sessions when the user can no longer be loaded', async () => {
    const destroy = vi.fn((cb?: () => void) => cb?.());
    const req = makeReq({ session: { userId: 'missing-user', destroy } as never });
    const next = vi.fn() as NextFunction;

    vi.spyOn(User, 'findById').mockResolvedValue(null);

    await optionalUser(req, {} as Response, next);

    expect(destroy).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it('prefers API key auth over session auth', async () => {
    const rawKey = 'sk-swil-test-key';
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const req = makeReq({
      headers: { authorization: `Bearer ${rawKey}` },
      session: { userId: 'session-user', destroy: vi.fn() } as never,
    });
    const next = vi.fn() as NextFunction;
    const apiUser = { id: 'api-user', status: 'active' };

    vi.spyOn(ApiKey, 'findOne').mockResolvedValue({
      _id: 'key-id',
      userId: 'api-user',
      keyHash,
    } as never);
    const userFind = vi.spyOn(User, 'findById').mockResolvedValue(apiUser as never);
    vi.spyOn(ApiKey, 'updateOne').mockResolvedValue({ acknowledged: true } as never);

    await requireUser(req, {} as Response, next);

    expect(userFind).toHaveBeenCalledTimes(1);
    expect(userFind).toHaveBeenCalledWith('api-user');
    expect(req.user).toBe(apiUser);
  });

  it('fails with unauthenticated when no auth context exists', async () => {
    const req = makeReq();
    const next = vi.fn() as NextFunction;

    await requireUser(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'UNAUTHENTICATED',
      status: 401,
    }));
  });
});
