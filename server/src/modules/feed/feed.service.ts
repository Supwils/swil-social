import { Types } from 'mongoose';
import { Post, type PostDocument } from '../../models/post.model';
import { Follow } from '../../models/follow.model';
import { Tag } from '../../models/tag.model';
import { User, type UserDocument } from '../../models/user.model';
import { AppError } from '../../lib/errors';
import {
  type Cursor,
  type ScoreCursor,
  cursorFilterDesc,
  buildNextCursor,
  scoreCursorFilter,
  buildNextScoreCursor,
} from '../../lib/pagination';
import { hydratePosts } from '../posts/posts.service';
import { toPostDTO, toTagDTO, type PostDTOContext, type PostDTO, type TagDTO, type FeaturedTopicDTO } from '../../lib/dto';
import { TTLCache } from '../../lib/ttlCache';
import type { TagDocument } from '../../models/tag.model';

interface FeedPage {
  items: PostDocument[];
  nextCursor: string | null;
  ctxById: Map<string, PostDTOContext>;
}

/** Ranked feed — sorted by feedScore descending. Used for global / following / tag feeds. */
async function paginateByScore(
  filter: Record<string, unknown>,
  viewer: UserDocument | null,
  cursor: ScoreCursor | null,
  limit: number,
): Promise<FeedPage> {
  const docs = (await Post.find({ ...filter, ...scoreCursorFilter(cursor) })
    .sort({ feedScore: -1, _id: -1 })
    .limit(limit + 1)
    .lean()) as unknown as PostDocument[];
  const { items, nextCursor } = buildNextScoreCursor(docs, limit);
  const ctxById = await hydratePosts(items, viewer);
  return { items, nextCursor, ctxById };
}

/** Chronological feed — sorted by createdAt descending. Used for author profile pages. */
async function paginateByTime(
  filter: Record<string, unknown>,
  viewer: UserDocument | null,
  cursor: Cursor | null,
  limit: number,
): Promise<FeedPage> {
  const docs = (await Post.find({ ...filter, ...cursorFilterDesc(cursor) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()) as unknown as PostDocument[];
  const { items, nextCursor } = buildNextCursor(docs, limit);
  const ctxById = await hydratePosts(items, viewer);
  return { items, nextCursor, ctxById };
}

/**
 * Following feed: ranked posts from people the viewer follows + viewer's own posts.
 */
export async function following(
  viewer: UserDocument,
  cursor: ScoreCursor | null,
  limit: number,
): Promise<FeedPage> {
  const followingEdges = await Follow.find({ followerId: viewer._id }).select('followingId').lean();
  const authorIds: Types.ObjectId[] = [
    viewer._id,
    ...followingEdges.map((e) => e.followingId),
  ];
  return paginateByScore(
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
 * Global discovery feed: all public active posts ranked by score.
 */
export async function global(
  viewer: UserDocument | null,
  cursor: ScoreCursor | null,
  limit: number,
): Promise<FeedPage> {
  return paginateByScore(
    { status: 'active', visibility: 'public' },
    viewer,
    cursor,
    limit,
  );
}

/**
 * Posts bearing a tag, ranked by score.
 */
export async function byTag(
  slug: string,
  viewer: UserDocument | null,
  cursor: ScoreCursor | null,
  limit: number,
): Promise<FeedPage> {
  const tag = await Tag.findOne({ slug: slug.toLowerCase() });
  if (!tag) throw AppError.notFound('Tag not found');
  const allTagIds = [tag._id, ...(tag.aliasIds ?? [])];
  return paginateByScore(
    { status: 'active', visibility: 'public', tagIds: { $in: allTagIds } },
    viewer,
    cursor,
    limit,
  );
}

export interface AgentSummaryItem {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  agentBackend?: string;
  latestPostExcerpt: string | null;
  latestPostId: string | null;
}

export interface ExploreSummary {
  featuredPost: PostDTO | null;
  agents: AgentSummaryItem[];
  trendingTags: TagDTO[];
  featuredTopics: FeaturedTopicDTO[];
}

/**
 * Viewer-independent slice of /explore. Recomputed at most once per TTL window;
 * concurrent callers may each run the loader once (acceptable here).
 *
 * Cached fields are pure aggregates — featuredPost / pinned hydration stays
 * out of cache because it includes per-viewer likedByMe / bookmarkedByMe.
 */
interface ExploreCacheSlice {
  agentUsers: UserDocument[];
  trendingTagDocs: TagDocument[];
  featuredTagDocs: TagDocument[];
  featuredPostDoc: PostDocument | null;
  latestByAuthor: Map<string, { postId: string; text: string }>;
}

const exploreSliceCache = new TTLCache<'global', ExploreCacheSlice>(60_000);

async function loadExploreSlice(): Promise<ExploreCacheSlice> {
  const ago48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const agentUsers = (await User.find({ isAgent: true, status: 'active' })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()) as unknown as UserDocument[];
  const agentIds = agentUsers.map((u) => u._id);

  const [featuredPostDoc, trendingTagDocs, featuredTagDocs, latestPostDocs] = await Promise.all([
    Post.findOne({
      authorId: { $in: agentIds },
      status: 'active',
      visibility: 'public',
      createdAt: { $gte: ago48h },
    })
      .sort({ feedScore: -1 })
      .lean() as Promise<PostDocument | null>,
    Tag.find({ postCount: { $gt: 0 }, isAlias: { $ne: true } })
      .sort({ postCount: -1 })
      .limit(10)
      .lean() as unknown as Promise<TagDocument[]>,
    Tag.find({ featured: true, status: 'active' })
      .sort({ postCount: -1 })
      .limit(8)
      .lean() as unknown as Promise<TagDocument[]>,
    Post.aggregate([
      { $match: { authorId: { $in: agentIds }, status: 'active', visibility: 'public' } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$authorId', postId: { $first: '$_id' }, text: { $first: '$text' } } },
    ]) as Promise<Array<{ _id: Types.ObjectId; postId: Types.ObjectId; text: string }>>,
  ]);

  const latestByAuthor = new Map(
    latestPostDocs.map((d) => [d._id.toString(), { postId: d.postId.toString(), text: d.text }]),
  );

  return { agentUsers, trendingTagDocs, featuredTagDocs, featuredPostDoc, latestByAuthor };
}

export async function getExploreSummary(viewer: UserDocument): Promise<ExploreSummary> {
  const slice = await exploreSliceCache.getOrLoad('global', loadExploreSlice);
  const { agentUsers, trendingTagDocs, featuredTagDocs, featuredPostDoc, latestByAuthor } = slice;

  let featuredPost: PostDTO | null = null;
  if (featuredPostDoc) {
    const ctxMap = await hydratePosts([featuredPostDoc as PostDocument], viewer);
    const ctx = ctxMap.get((featuredPostDoc as PostDocument)._id.toString());
    if (ctx) featuredPost = toPostDTO(featuredPostDoc as PostDocument, ctx);
  }

  const agents: AgentSummaryItem[] = agentUsers.map((u) => {
    const latest = latestByAuthor.get(u._id.toString());
    return {
      id: u._id.toString(),
      username: u.username,
      usernameDisplay: u.usernameDisplay,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      headline: u.headline,
      ...(u.agentBackend ? { agentBackend: u.agentBackend } : {}),
      latestPostExcerpt: latest ? latest.text.slice(0, 120) : null,
      latestPostId: latest ? latest.postId : null,
    };
  });

  const trendingTags: TagDTO[] = trendingTagDocs.map((t) => toTagDTO(t));

  // Build featuredTopics with pinned posts
  const allPinnedIds = featuredTagDocs.flatMap((t) => t.pinnedPostIds ?? []);
  const pinnedPostMap = new Map<string, PostDTO>();
  if (allPinnedIds.length > 0) {
    const pinnedDocs = (await Post.find({
      _id: { $in: allPinnedIds },
      status: 'active',
      visibility: 'public',
    }).lean()) as unknown as PostDocument[];
    if (pinnedDocs.length > 0) {
      const ctxMap = await hydratePosts(pinnedDocs, viewer);
      for (const doc of pinnedDocs) {
        const ctx = ctxMap.get(doc._id.toString());
        if (ctx) pinnedPostMap.set(doc._id.toString(), toPostDTO(doc, ctx));
      }
    }
  }

  const featuredTopics: FeaturedTopicDTO[] = featuredTagDocs.map((t) => ({
    ...toTagDTO(t),
    pinnedPosts: (t.pinnedPostIds ?? [])
      .map((id) => pinnedPostMap.get(id.toString()))
      .filter((p): p is PostDTO => p !== undefined),
  }));

  return { featuredPost, agents, trendingTags, featuredTopics };
}

/**
 * Posts authored by a specific user — stays chronological (newest first).
 * Respects visibility from the viewer's perspective.
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

  return paginateByTime(
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
