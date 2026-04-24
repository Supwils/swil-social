import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Response } from 'express';

const mocks = vi.hoisted(() => ({
  like: vi.fn(),
  unlike: vi.fn(),
}));

vi.mock('./likes.service', () => ({
  like: mocks.like,
  unlike: mocks.unlike,
}));

import { AppError } from '../../lib/errors';
import type { UserDocument } from '../../models/user.model';
import { likeComment, likePost, unlikeComment, unlikePost } from './likes.controller';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
  } as UserDocument;
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    reqId: 'req-1',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown; reqId: string };
}

describe('likes.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('likes posts through the service and returns the payload', async () => {
    const user = makeUser();
    const id = new Types.ObjectId().toString();
    mocks.like.mockResolvedValue({ likeCount: 3, liked: true });

    const res = makeRes();
    await likePost({ user, params: { id } } as never, res);

    expect(mocks.like).toHaveBeenCalledWith(user, 'post', id);
    expect(res.payload).toEqual({
      data: { likeCount: 3, liked: true },
      meta: { requestId: 'req-1' },
    });
  });

  it('unlikes comments through the service and returns the payload', async () => {
    const user = makeUser();
    const id = new Types.ObjectId().toString();
    mocks.unlike.mockResolvedValue({ likeCount: 1, liked: false });

    const res = makeRes();
    await unlikeComment({ user, params: { id } } as never, res);

    expect(mocks.unlike).toHaveBeenCalledWith(user, 'comment', id);
    expect(res.payload).toEqual({
      data: { likeCount: 1, liked: false },
      meta: { requestId: 'req-1' },
    });
  });

  it('rejects anonymous post likes', async () => {
    await expect(likePost({ params: { id: new Types.ObjectId().toString() } } as never, makeRes()))
      .rejects
      .toMatchObject<AppError>({
        code: 'UNAUTHENTICATED',
        status: 401,
      });
    expect(mocks.like).not.toHaveBeenCalled();
  });

  it('rejects anonymous comment unlikes', async () => {
    await expect(
      unlikePost({ params: { id: new Types.ObjectId().toString() } } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(mocks.unlike).not.toHaveBeenCalled();
  });

  it('likes comments through the service', async () => {
    const user = makeUser();
    const id = new Types.ObjectId().toString();
    mocks.like.mockResolvedValue({ likeCount: 4, liked: true });

    const res = makeRes();
    await likeComment({ user, params: { id } } as never, res);

    expect(mocks.like).toHaveBeenCalledWith(user, 'comment', id);
    expect(res.statusCode).toBe(200);
  });

  it('unlikes posts through the service', async () => {
    const user = makeUser();
    const id = new Types.ObjectId().toString();
    mocks.unlike.mockResolvedValue({ likeCount: 0, liked: false });

    const res = makeRes();
    await unlikePost({ user, params: { id } } as never, res);

    expect(mocks.unlike).toHaveBeenCalledWith(user, 'post', id);
    expect(res.statusCode).toBe(200);
  });
});
