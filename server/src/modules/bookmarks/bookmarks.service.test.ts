import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { bookmarks, posts, users } from '../../db/schema';
import type { PostRow, UserRow } from '../../lib/dto';
import { newId } from '../../lib/id';
import { resetDb } from '../../test/db-reset';
import { bookmark, listBookmarks, unbookmark } from './bookmarks.service';

async function seedUser(username: string): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.com`,
      displayName: username,
    })
    .returning();
  return u;
}

async function seedPost(
  authorId: string,
  over: Partial<typeof posts.$inferInsert> = {},
): Promise<PostRow> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'sample', ...over })
    .returning();
  return p;
}

async function seedBookmark(userId: string, postId: string, createdAt?: Date): Promise<void> {
  await db.insert(bookmarks).values({ userId, postId, ...(createdAt ? { createdAt } : {}) });
}

describe('bookmarks.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('bookmark', () => {
    it('creates a Bookmark for a valid active post', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const post = await seedPost(author.id);

      const r = await bookmark(viewer, post.id);
      expect(r).toEqual({ bookmarked: true });

      const rows = await db
        .select()
        .from(bookmarks)
        .where(and(eq(bookmarks.userId, viewer.id), eq(bookmarks.postId, post.id)));
      expect(rows).toHaveLength(1);
    });

    it('returns success on duplicate (already bookmarked) and stays idempotent', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const post = await seedPost(author.id);

      await bookmark(viewer, post.id);
      const r = await bookmark(viewer, post.id);
      expect(r).toEqual({ bookmarked: true });

      const rows = await db
        .select()
        .from(bookmarks)
        .where(and(eq(bookmarks.userId, viewer.id), eq(bookmarks.postId, post.id)));
      expect(rows).toHaveLength(1);
    });

    it('rejects an unknown post id', async () => {
      const viewer = await seedUser('viewer');

      await expect(bookmark(viewer, newId())).rejects.toMatchObject({ status: 404 });
      await expect(bookmark(viewer, 'not-an-id')).rejects.toMatchObject({ status: 404 });

      const rows = await db.select().from(bookmarks).where(eq(bookmarks.userId, viewer.id));
      expect(rows).toHaveLength(0);
    });

    it('rejects a non-active post', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const hidden = await seedPost(author.id, { status: 'deleted' });

      await expect(bookmark(viewer, hidden.id)).rejects.toMatchObject({ status: 404 });

      const rows = await db.select().from(bookmarks).where(eq(bookmarks.userId, viewer.id));
      expect(rows).toHaveLength(0);
    });

    it('rejects a private post the viewer cannot see', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const secret = await seedPost(author.id, { visibility: 'private' });

      await expect(bookmark(viewer, secret.id)).rejects.toMatchObject({ status: 404 });

      const rows = await db.select().from(bookmarks).where(eq(bookmarks.userId, viewer.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe('unbookmark', () => {
    it('deletes the bookmark for the viewer/post pair', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const post = await seedPost(author.id);
      await seedBookmark(viewer.id, post.id);

      const r = await unbookmark(viewer, post.id);
      expect(r).toEqual({ bookmarked: false });

      const rows = await db
        .select()
        .from(bookmarks)
        .where(and(eq(bookmarks.userId, viewer.id), eq(bookmarks.postId, post.id)));
      expect(rows).toHaveLength(0);
    });

    it('still returns success when nothing was bookmarked (idempotent)', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const post = await seedPost(author.id);

      await expect(unbookmark(viewer, post.id)).resolves.toEqual({ bookmarked: false });
    });
  });

  describe('listBookmarks', () => {
    it('preserves bookmark order (most recent first)', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const p1 = await seedPost(author.id, { text: 'p1' });
      const p2 = await seedPost(author.id, { text: 'p2' });
      const p3 = await seedPost(author.id, { text: 'p3' });

      // p1 newest, p2 middle, p3 oldest — expected order is p1, p2, p3.
      const base = Date.now();
      await seedBookmark(viewer.id, p1.id, new Date(base));
      await seedBookmark(viewer.id, p2.id, new Date(base - 1000));
      await seedBookmark(viewer.id, p3.id, new Date(base - 2000));

      const out = await listBookmarks(viewer, undefined, 10);
      expect(out.items.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id]);
      expect(out.nextCursor).toBeNull();
    });

    it('omits posts that later became invisible to the viewer', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');
      const pub = await seedPost(author.id, { text: 'public', visibility: 'public' });
      const secret = await seedPost(author.id, { text: 'secret', visibility: 'private' });
      await seedBookmark(viewer.id, pub.id);
      await seedBookmark(viewer.id, secret.id);

      const out = await listBookmarks(viewer, undefined, 10);
      expect(out.items.map((p) => p.id)).toEqual([pub.id]);
    });

    it('produces a cursor when there are more results than the limit', async () => {
      const author = await seedUser('author');
      const viewer = await seedUser('viewer');

      const base = Date.now();
      for (let i = 0; i < 11; i++) {
        const p = await seedPost(author.id, { text: `p${i}` });
        await seedBookmark(viewer.id, p.id, new Date(base - i * 1000));
      }

      const out = await listBookmarks(viewer, undefined, 10);
      expect(out.items.length).toBeLessThanOrEqual(10);
      expect(out.nextCursor).not.toBeNull();
    });
  });
});
