import { Types } from 'mongoose';
import { Bookmark } from '../../models/bookmark.model';
import { Post } from '../../models/post.model';
import { AppError } from '../../lib/errors';
import type { UserDocument } from '../../models/user.model';
import type { PostDTO } from '../../lib/dto';
import { toPostDTO } from '../../lib/dto';
import { decodeCursor, buildNextCursor } from '../../lib/pagination';
import { hydratePosts } from '../posts/posts.service';
import type { PostDocument } from '../../models/post.model';

export async function bookmark(
  user: UserDocument,
  postId: string,
): Promise<{ bookmarked: true }> {
  if (!Types.ObjectId.isValid(postId)) throw AppError.notFound('Post not found');
  const post = await Post.findOne({ _id: postId, status: 'active' }).select('_id');
  if (!post) throw AppError.notFound('Post not found');

  try {
    await Bookmark.create({ userId: user._id, postId: new Types.ObjectId(postId) });
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 11000) return { bookmarked: true };
    throw err;
  }
  return { bookmarked: true };
}

export async function unbookmark(
  user: UserDocument,
  postId: string,
): Promise<{ bookmarked: false }> {
  await Bookmark.deleteOne({ userId: user._id, postId: new Types.ObjectId(postId) });
  return { bookmarked: false };
}

export async function listBookmarks(
  user: UserDocument,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const decoded = decodeCursor(cursor);

  const filter: Record<string, unknown> = { userId: user._id };
  if (decoded) {
    const t = new Date(decoded.t);
    const id = new Types.ObjectId(decoded.id);
    filter.$or = [
      { createdAt: { $lt: t } },
      { createdAt: t, _id: { $lt: id } },
    ];
  }

  const bookmarkDocs = await Bookmark.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const { items: pageDocs, nextCursor } = buildNextCursor(
    bookmarkDocs as Array<{ createdAt: Date; _id: Types.ObjectId; postId: Types.ObjectId }>,
    limit,
  );

  const postIds = pageDocs.map((b) => b.postId);
  const rawPosts = (await Post.find({
    _id: { $in: postIds },
    status: 'active',
  }).lean()) as unknown as PostDocument[];

  const postById = new Map(rawPosts.map((p) => [p._id.toString(), p]));
  const orderedPosts = pageDocs
    .map((b) => postById.get(b.postId.toString()))
    .filter((p): p is PostDocument => !!p);

  const ctxMap = await hydratePosts(orderedPosts, user);

  const items = orderedPosts
    .map((p) => {
      const ctx = ctxMap.get(p._id.toString());
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is PostDTO => x !== null);

  return { items, nextCursor };
}
