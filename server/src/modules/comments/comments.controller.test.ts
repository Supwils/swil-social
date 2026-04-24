import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Response } from 'express';

const mocks = vi.hoisted(() => ({
  listForPost: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock('./comments.service', () => ({
  listForPost: mocks.listForPost,
  createComment: mocks.createComment,
  updateComment: mocks.updateComment,
  deleteComment: mocks.deleteComment,
}));

import { encodeCursor } from '../../lib/pagination';
import { AppError } from '../../lib/errors';
import type { CommentDTOContext } from '../../lib/dto';
import type { CommentDocument } from '../../models/comment.model';
import type { UserDocument } from '../../models/user.model';
import { create, listForPost, remove } from './comments.controller';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
    username: 'ada',
    usernameDisplay: 'ada',
    displayName: 'Ada',
    bio: '',
    headline: '',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    profileTags: [],
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    email: 'ada@example.com',
    emailVerified: true,
    preferences: {
      theme: 'system',
      language: 'en',
      emailNotifications: true,
      pushNotifications: true,
    },
    isAgent: false,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
  } as UserDocument;
}

function makeComment(authorId: Types.ObjectId): CommentDocument {
  return {
    _id: new Types.ObjectId(),
    postId: new Types.ObjectId(),
    parentId: null,
    authorId,
    text: 'hello',
    mentionIds: [],
    likeCount: 0,
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
  } as unknown as CommentDocument;
}

function makeCtx(author: UserDocument): CommentDTOContext {
  return {
    author,
    likedByMe: false,
  };
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
    end() {
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown; reqId: string };
}

describe('comments.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses paging params for listForPost', async () => {
    const author = makeUser();
    const comment = makeComment(author._id);
    const cursor = encodeCursor({ t: comment.createdAt.toISOString(), id: comment._id.toString() });
    mocks.listForPost.mockResolvedValue({
      items: [comment],
      nextCursor: null,
      ctxByCommentId: new Map([[comment._id.toString(), makeCtx(author)]]),
    });

    const req = {
      params: { id: comment.postId.toString() },
      query: { cursor, limit: '7' },
    };
    const res = makeRes();

    await listForPost(req as never, res);

    expect(mocks.listForPost).toHaveBeenCalledWith(
      comment.postId.toString(),
      null,
      { t: comment.createdAt.toISOString(), id: comment._id.toString() },
      7,
    );
    expect(res.payload).toMatchObject({
      data: {
        items: [{ id: comment._id.toString(), text: 'hello' }],
        nextCursor: null,
      },
    });
  });

  it('passes null parentId when creating a top-level comment', async () => {
    const author = makeUser();
    const comment = makeComment(author._id);
    mocks.createComment.mockResolvedValue({ comment, ctx: makeCtx(author) });

    const req = {
      user: author,
      params: { id: comment.postId.toString() },
      body: { text: 'hello' },
    };
    const res = makeRes();

    await create(req as never, res);

    expect(mocks.createComment).toHaveBeenCalledWith(
      author,
      comment.postId.toString(),
      'hello',
      null,
    );
    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({
      data: { comment: { id: comment._id.toString() } },
    });
  });

  it('rejects delete attempts from anonymous users', async () => {
    await expect(remove({ params: { id: new Types.ObjectId().toString() } } as never, makeRes()))
      .rejects
      .toMatchObject<AppError>({
        code: 'UNAUTHENTICATED',
        status: 401,
      });

    expect(mocks.deleteComment).not.toHaveBeenCalled();
  });
});
