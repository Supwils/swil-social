import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({
  bookmarkCreate: vi.fn(),
  bookmarkDeleteOne: vi.fn(),
  bookmarkFind: vi.fn(),
  postFindOne: vi.fn(),
  postFind: vi.fn(),
  hydratePosts: vi.fn(),
}));

vi.mock('../../models/bookmark.model', () => ({
  Bookmark: {
    create: mocks.bookmarkCreate,
    deleteOne: mocks.bookmarkDeleteOne,
    find: mocks.bookmarkFind,
  },
}));

vi.mock('../../models/post.model', () => ({
  Post: {
    findOne: mocks.postFindOne,
    find: mocks.postFind,
  },
}));

vi.mock('../posts/posts.service', () => ({
  hydratePosts: mocks.hydratePosts,
}));

import { bookmark, unbookmark, listBookmarks } from './bookmarks.service';
import type { UserDocument } from '../../models/user.model';

const viewer = { _id: new Types.ObjectId() } as UserDocument;

// Minimal post shape that satisfies toPostDTO (called inside listBookmarks)
function makePost(id: Types.ObjectId) {
  return {
    _id: id,
    authorId: new Types.ObjectId(),
    text: 'sample',
    images: [],
    tagIds: [],
    mentionIds: [],
    visibility: 'public',
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Minimal author shape for hydratePosts ctx
function makeCtx() {
  return {
    author: {
      _id: new Types.ObjectId(),
      username: 'u',
      displayName: 'U',
      avatarUrl: '',
      isAgent: false,
    },
    tags: [],
    mentions: [],
    likedByMe: false,
  };
}

describe('bookmarks.service', () => {
  beforeEach(() => {
    mocks.postFindOne.mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('bookmark', () => {
    it('creates a Bookmark for a valid active post', async () => {
      mocks.bookmarkCreate.mockResolvedValue({});
      const postId = new Types.ObjectId().toString();
      const r = await bookmark(viewer, postId);
      expect(r).toEqual({ bookmarked: true });
      expect(mocks.bookmarkCreate).toHaveBeenCalledOnce();
    });

    it('returns success on duplicate-key (already bookmarked)', async () => {
      mocks.bookmarkCreate.mockRejectedValue({ code: 11000 });
      const postId = new Types.ObjectId().toString();
      const r = await bookmark(viewer, postId);
      expect(r).toEqual({ bookmarked: true });
    });

    it('rethrows non-duplicate errors', async () => {
      mocks.bookmarkCreate.mockRejectedValue(new Error('write conflict'));
      const postId = new Types.ObjectId().toString();
      await expect(bookmark(viewer, postId)).rejects.toThrow('write conflict');
    });

    it('rejects an invalid ObjectId early', async () => {
      await expect(bookmark(viewer, 'not-an-id')).rejects.toMatchObject({ status: 404 });
      expect(mocks.postFindOne).not.toHaveBeenCalled();
    });

    it('rejects a missing or non-active post', async () => {
      mocks.postFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
      await expect(bookmark(viewer, new Types.ObjectId().toString())).rejects.toMatchObject({
        status: 404,
      });
      expect(mocks.bookmarkCreate).not.toHaveBeenCalled();
    });
  });

  describe('unbookmark', () => {
    it('deletes the bookmark for the viewer/post pair', async () => {
      mocks.bookmarkDeleteOne.mockResolvedValue({ deletedCount: 1 });
      const postId = new Types.ObjectId().toString();
      const r = await unbookmark(viewer, postId);
      expect(r).toEqual({ bookmarked: false });
      expect(mocks.bookmarkDeleteOne).toHaveBeenCalledWith({
        userId: viewer._id,
        postId: expect.any(Types.ObjectId),
      });
    });

    it('still returns success when nothing was bookmarked (idempotent)', async () => {
      mocks.bookmarkDeleteOne.mockResolvedValue({ deletedCount: 0 });
      const postId = new Types.ObjectId().toString();
      await expect(unbookmark(viewer, postId)).resolves.toEqual({ bookmarked: false });
    });
  });

  describe('listBookmarks', () => {
    it('preserves bookmark order (most recent first) when posts come back unsorted', async () => {
      const p1 = new Types.ObjectId();
      const p2 = new Types.ObjectId();
      const p3 = new Types.ObjectId();
      // Bookmarks: p1, p2, p3 — newest first
      const chain = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          { _id: new Types.ObjectId(), createdAt: new Date(), postId: p1 },
          { _id: new Types.ObjectId(), createdAt: new Date(), postId: p2 },
          { _id: new Types.ObjectId(), createdAt: new Date(), postId: p3 },
        ]),
      };
      mocks.bookmarkFind.mockReturnValue(chain);
      // Posts come back in DB order, possibly different from bookmark order
      mocks.postFind.mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          makePost(p3),
          makePost(p1),
          makePost(p2),
        ]),
      });
      // hydratePosts returns one ctx per post id
      mocks.hydratePosts.mockResolvedValue(
        new Map([
          [p1.toString(), makeCtx()],
          [p2.toString(), makeCtx()],
          [p3.toString(), makeCtx()],
        ]),
      );

      const out = await listBookmarks(viewer, undefined, 10);
      expect(out.items.map((p) => p.id)).toEqual([p1.toString(), p2.toString(), p3.toString()]);
      expect(out.nextCursor).toBeNull();
    });

    it('produces a cursor when there are more results than the limit', async () => {
      const ids = Array.from({ length: 11 }, () => new Types.ObjectId());
      const docs = ids.map((id) => ({
        _id: new Types.ObjectId(),
        createdAt: new Date(),
        postId: id,
      }));
      mocks.bookmarkFind.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(docs),
      });
      mocks.postFind.mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          ids.slice(0, 10).map((id) => makePost(id)),
        ),
      });
      const ctxMap = new Map(
        ids.slice(0, 10).map((id) => [
          id.toString(),
          makeCtx(),
        ]),
      );
      mocks.hydratePosts.mockResolvedValue(ctxMap);

      const out = await listBookmarks(viewer, undefined, 10);
      expect(out.items.length).toBeLessThanOrEqual(10);
      expect(out.nextCursor).not.toBeNull();
    });
  });
});
