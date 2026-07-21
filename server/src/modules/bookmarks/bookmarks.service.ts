import { and, or, eq, lt, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { bookmarks, posts } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { PostDTO, PostRow, UserRow } from '../../lib/dto';
import { toPostDTO } from '../../lib/dto';
import { decodeCursor, encodeCursor } from '../../lib/pagination';
import { hydratePosts } from '../posts/posts.service';

export async function bookmark(user: UserRow, postId: string): Promise<{ bookmarked: true }> {
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.status, 'active')))
    .limit(1);
  if (!post) throw AppError.notFound('Post not found');

  // Idempotent: a duplicate bookmark is a no-op that still reports success.
  await db.insert(bookmarks).values({ userId: user.id, postId }).onConflictDoNothing();
  return { bookmarked: true };
}

export async function unbookmark(user: UserRow, postId: string): Promise<{ bookmarked: false }> {
  await db.delete(bookmarks).where(and(eq(bookmarks.userId, user.id), eq(bookmarks.postId, postId)));
  return { bookmarked: false };
}

export async function listBookmarks(
  user: UserRow,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const decoded = decodeCursor(cursor);

  // Descending by createdAt, id breaking ties — fetch rows strictly older than
  // the cursor (which points at the last row of the previous page).
  const cursorCond = decoded
    ? or(
        lt(bookmarks.createdAt, new Date(decoded.t)),
        and(eq(bookmarks.createdAt, new Date(decoded.t)), lt(bookmarks.id, decoded.id)),
      )
    : undefined;

  const bookmarkRows = await db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, user.id), cursorCond))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .limit(limit + 1);

  const hasMore = bookmarkRows.length > limit;
  const pageDocs = hasMore ? bookmarkRows.slice(0, limit) : bookmarkRows;
  const last = pageDocs[pageDocs.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null;

  const postIds = pageDocs.map((b) => b.postId);
  const rawPosts = postIds.length
    ? await db
        .select()
        .from(posts)
        .where(and(inArray(posts.id, postIds), eq(posts.status, 'active')))
    : [];

  const postById = new Map(rawPosts.map((p) => [p.id, p]));
  const orderedPosts = pageDocs
    .map((b) => postById.get(b.postId))
    .filter((p): p is PostRow => !!p);

  const ctxMap = await hydratePosts(orderedPosts, user);

  const items = orderedPosts
    .map((p) => {
      const ctx = ctxMap.get(p.id);
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is PostDTO => x !== null);

  return { items, nextCursor };
}
