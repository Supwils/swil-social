import { describe, expect, it, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AppError } from '../../lib/errors';
import * as dto from '../../lib/dto';
import * as authService from './auth.service';
import * as ctrl from './auth.controller';

function makeResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  const session = {
    userId: undefined as string | undefined,
    regenerate: (cb: (err?: unknown) => void) => cb(),
    save: (cb: (err?: unknown) => void) => cb(),
    destroy: (cb: (err?: unknown) => void) => cb(),
  };

  return {
    body: {},
    params: {},
    query: {},
    sessionID: 'sid-current',
    session,
    ...overrides,
  } as unknown as Request;
}

function makeUser() {
  const id = new Types.ObjectId();
  return {
    _id: id,
    id: id.toString(),
  };
}

describe('auth.controller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a user and persists the new session', async () => {
    const req = makeRequest({
      body: { username: 'ada', email: 'ada@example.com', password: 'password123' },
    });
    const res = makeResponse();
    const user = makeUser();

    vi.spyOn(authService, 'register').mockResolvedValue(user as never);
    vi.spyOn(dto, 'toUserDTO').mockReturnValue({ id: user.id } as never);

    await ctrl.register(req, res);

    expect(authService.register).toHaveBeenCalledWith(req.body);
    expect(req.session.userId).toBe(user.id);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      data: { user: { id: user.id } },
      meta: { requestId: undefined },
    });
  });

  it('logs out by destroying the session and clearing the cookie', async () => {
    const req = makeRequest();
    const res = makeResponse();

    await ctrl.logout(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith('sid');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('throws on /me when no authenticated user is attached', async () => {
    const req = makeRequest({ user: undefined });
    const res = makeResponse();

    await expect(ctrl.me(req, res)).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });

  it('changes password, destroys other sessions, and rotates the current session', async () => {
    const user = makeUser();
    const req = makeRequest({
      user: user as never,
      body: { currentPassword: 'old-password', newPassword: 'new-password-123' },
    });
    const res = makeResponse();

    vi.spyOn(authService, 'changePassword').mockResolvedValue(undefined);
    vi.spyOn(authService, 'destroyOtherSessions').mockResolvedValue(undefined);

    await ctrl.changePassword(req, res);

    expect(authService.changePassword).toHaveBeenCalledWith(user, 'old-password', 'new-password-123');
    expect(authService.destroyOtherSessions).toHaveBeenCalledWith(user.id, 'sid-current');
    expect(req.session.userId).toBe(user.id);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});
