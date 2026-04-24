import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Response } from 'express';

const mocks = vi.hoisted(() => ({
  createPost: vi.fn(),
  getPostForViewer: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
}));

vi.mock('./posts.service', () => ({
  createPost: mocks.createPost,
  getPostForViewer: mocks.getPostForViewer,
  updatePost: mocks.updatePost,
  deletePost: mocks.deletePost,
}));

import { AppError } from '../../lib/errors';
import type { PostDTOContext } from '../../lib/dto';
import type { PostDocument } from '../../models/post.model';
import type { UserDocument } from '../../models/user.model';
import { create, getById, remove, update } from './posts.controller';

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

function makePost(authorId: Types.ObjectId): PostDocument {
  return {
    _id: new Types.ObjectId(),
    authorId,
    text: 'Hello world',
    images: [],
    video: null,
    tagIds: [],
    mentionIds: [],
    visibility: 'public',
    likeCount: 0,
    commentCount: 0,
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
  } as unknown as PostDocument;
}

function makeCtx(author: UserDocument): PostDTOContext {
  return {
    author,
    tags: [],
    mentions: [],
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

describe('posts.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('maps uploaded images and video buffers into createPost', async () => {
    const author = makeUser();
    const post = makePost(author._id);
    const ctx = makeCtx(author);
    const imageA = Buffer.from('image-a');
    const imageB = Buffer.from('image-b');
    const video = Buffer.from('video');

    mocks.createPost.mockResolvedValue({ post, ctx });

    const req = {
      user: author,
      body: { text: 'Hello world', visibility: 'public' },
      files: {
        images: [{ buffer: imageA }, { buffer: imageB }],
        video: [{ buffer: video }],
      },
    };
    const res = makeRes();

    await create(req as never, res);

    expect(mocks.createPost).toHaveBeenCalledWith(
      author,
      req.body,
      [imageA, imageB],
      video,
    );
    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({
      data: {
        post: {
          id: post._id.toString(),
          text: 'Hello world',
        },
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('passes anonymous viewers through on getById', async () => {
    const author = makeUser();
    const post = makePost(author._id);
    const ctx = makeCtx(author);
    mocks.getPostForViewer.mockResolvedValue({ post, ctx });

    const req = { params: { id: post._id.toString() } };
    const res = makeRes();

    await getById(req as never, res);

    expect(mocks.getPostForViewer).toHaveBeenCalledWith(post._id.toString(), null);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      data: { post: { id: post._id.toString() } },
    });
  });

  it('forwards update payloads for authenticated users', async () => {
    const author = makeUser();
    const post = makePost(author._id);
    const ctx = makeCtx(author);
    mocks.updatePost.mockResolvedValue({ post, ctx });

    const req = {
      user: author,
      params: { id: post._id.toString() },
      body: { text: 'Updated text', visibility: 'followers' },
    };
    const res = makeRes();

    await update(req as never, res);

    expect(mocks.updatePost).toHaveBeenCalledWith(post._id.toString(), author, req.body);
    expect(res.payload).toMatchObject({
      data: { post: { id: post._id.toString() } },
    });
  });

  it('rejects delete attempts from anonymous users', async () => {
    await expect(remove({ params: { id: new Types.ObjectId().toString() } } as never, makeRes()))
      .rejects
      .toMatchObject<AppError>({
        code: 'UNAUTHENTICATED',
        status: 401,
      });

    expect(mocks.deletePost).not.toHaveBeenCalled();
  });
});
