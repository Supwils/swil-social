import { Types } from 'mongoose';
import { Post, type PostDocument } from '../../models/post.model';
import { Follow } from '../../models/follow.model';
import { Tag } from '../../models/tag.model';
import { User, type UserDocument } from '../../models/user.model';
import { AppError } from '../../lib/errors';
import {
  type Cursor,
  cursorFilterDesc,
  buildNextCursor,
} from '../../lib/pagination';
import { hydratePosts } from '../posts/posts.service';
import type { PostDTOContext } from '../../lib/dto';

interface FeedPage {
  items: PostDocument[];
  nextCursor: string | null;
  ctxById: Map<string, PostDTOContext>;
}

async function paginate(
  filter: Record<string, unknown>,
  viewer: UserDocument | null,
  cursor: Cursor | null,
  limit: number,
): Promise<FeedPage> {
  const docs = await Post.find({ ...filter, ...cursorFilterDesc(cursor) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);
  const { items, nextCursor } = buildNextCursor(docs, limit);
  const ctxById = await hydratePosts(items, viewer);
  return { items, nextCursor, ctxById };
}

/**
 * Following feed: posts from people the viewer follows + viewer's own posts.
 */
export async function following(
  viewer: UserDocument,
  cursor: Cursor | null,
  limit: number,
): Promise<FeedPage> {
  const followingEdges = await Follow.find({ followerId: viewer._id }).select('followingId');
  const authorIds: Types.ObjectId[] = [
    viewer._id,
    ...followingEdges.map((e) => e.followingId),
  ];
  return paginate(
    {
      authorId: { $in: authorIds },
      status: 'active',
      visibility: { $in: ['public', 'followers'] },
    },
    viewer,
    cursor,
    limit,
  );
}

/**
 * Global discovery feed: all public active posts reverse-chron.
 */
export async function global(
  viewer: UserDocument | null,
  cursor: Cursor | null,
  limit: number,
): Promise<FeedPage> {
  return paginate(
    { status: 'active', visibility: 'public' },
    viewer,
    cursor,
    limit,
  );
}

/**
 * Posts bearing a tag.
 */
export async function byTag(
  slug: string,
  viewer: UserDocument | null,
  cursor: Cursor | null,
  limit: number,
): Promise<FeedPage> {
  const tag = await Tag.findOne({ slug: slug.toLowerCase() });
  if (!tag) throw AppError.notFound('Tag not found');
  return paginate(
    { status: 'active', visibility: 'public', tagIds: tag._id },
    viewer,
    cursor,
    limit,
  );
}

/**
 * Posts authored by a specific user, respecting visibility from the viewer's angle.
 */
export async function byAuthor(
  username: string,
  viewer: UserDocument | null,
  cursor: Cursor | null,
  limit: number,
): Promise<FeedPage> {
  const author = await User.findOne({ username: username.toLowerCase(), status: 'active' });
  if (!author) throw AppError.notFound('User not found');

  const allowedVisibilities: Array<'public' | 'followers' | 'private'> = ['public'];
  if (viewer) {
    if (viewer._id.equals(author._id)) {
      allowedVisibilities.push('followers', 'private');
    } else {
      const follows = await Follow.exists({
        followerId: viewer._id,
        followingId: author._id,
      });
      if (follows) allowedVisibilities.push('followers');
    }
  }

  return paginate(
    {
      authorId: author._id,
      status: 'active',
      visibility: { $in: allowedVisibilities },
    },
    viewer,
    cursor,
    limit,
  );
}
