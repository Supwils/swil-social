import { Types } from 'mongoose';
import { Post, type PostDocument } from '../../models/post.model';
import { User, type UserDocument } from '../../models/user.model';
import { Tag, type TagDocument } from '../../models/tag.model';
import { Like } from '../../models/like.model';
import { AppError } from '../../lib/errors';
import { decodeCursor, buildNextCursor } from '../../lib/pagination';
import { translatePosts } from '../../lib/translate';
import { toPostDTO, type PostDTOContext, type PostDTO } from '../../lib/dto';
import type { SearchPostsQuery } from './posts.schemas';
import { hydratePosts } from './posts.hydrate';
import { assertVisibility } from './posts.write';

export async function getPostForViewer(
  postId: string,
  viewer: UserDocument | null,
): Promise<{ post: PostDocument; ctx: PostDTOContext }> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);

  const [author, tags, mentions, likedByMe] = await Promise.all([
    User.findById(post.authorId),
    post.tagIds.length ? Tag.find({ _id: { $in: post.tagIds } }) : Promise.resolve([] as TagDocument[]),
    post.mentionIds.length
      ? User.find({ _id: { $in: post.mentionIds } })
      : Promise.resolve([] as UserDocument[]),
    viewer
      ? Like.exists({ userId: viewer._id, targetType: 'post', targetId: post._id }).then(Boolean)
      : Promise.resolve(false),
  ]);
  if (!author) throw AppError.notFound('Author missing');

  let echoOfDto: PostDTO | undefined;
  if (post.echoOf) {
    const origPost = (await Post.findById(post.echoOf).lean()) as unknown as PostDocument | null;
    if (origPost) {
      const origAuthor = (await User.findById(origPost.authorId).lean()) as unknown as UserDocument | null;
      if (origAuthor) {
        echoOfDto = toPostDTO(origPost, { author: origAuthor, tags: [], mentions: [], likedByMe: false });
      }
    }
  }

  return { post, ctx: { author, tags, mentions, likedByMe, echoOf: echoOfDto } };
}

export async function getShowcasePosts(viewer: UserDocument | null, lang: string): Promise<PostDTO[]> {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3_600_000);

  const candidates = (await Post.find({
    status: 'active',
    visibility: 'public',
    echoOf: { $exists: false },
    createdAt: { $gte: sixtyDaysAgo },
  })
    .sort({ feedScore: -1, _id: -1 })
    .limit(120)
    .lean()) as unknown as PostDocument[];

  // Compute showcase score in memory:
  // - comments weighted 3× (vs 2× in feedScore) — active discussion = platform health
  // - image bonus 1.5× — visual richness matters for a public showcase
  // - softer time decay (1.1, 48h offset) — allows quality older content to surface
  const now = Date.now();
  const scored = candidates.map((p) => {
    const ageHours = (now - new Date(p.createdAt).getTime()) / 3_600_000;
    const engagement = p.likeCount + p.commentCount * 3 + p.repostCount * 2 + 1;
    const imageBonus = p.images.length > 0 ? 1.5 : 1.0;
    const score = (engagement * imageBonus) / Math.pow(ageHours + 48, 1.1);
    return { post: p, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Author diversity: cap at 2 posts per author
  const authorCount = new Map<string, number>();
  const diverse: PostDocument[] = [];
  for (const { post } of scored) {
    const aid = post.authorId.toString();
    const n = authorCount.get(aid) ?? 0;
    if (n < 2) {
      diverse.push(post);
      authorCount.set(aid, n + 1);
    }
  }

  // Tier-based Fisher-Yates shuffle for variety across refreshes
  const tierSize = Math.ceil(diverse.length / 3);
  const shuffled: PostDocument[] = [];
  for (let t = 0; t < 3; t++) {
    const tier = diverse.slice(t * tierSize, (t + 1) * tierSize);
    for (let i = tier.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tier[i], tier[j]] = [tier[j], tier[i]];
    }
    shuffled.push(...tier);
  }

  const posts = shuffled.slice(0, 24);
  const ctxMap = await hydratePosts(posts, viewer);
  await translatePosts(posts, ctxMap, lang);

  return posts
    .map((p) => {
      const ctx = ctxMap.get(p._id.toString());
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is PostDTO => x !== null);
}

export async function searchPosts(
  query: SearchPostsQuery,
  viewer: UserDocument | null,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const cursor = decodeCursor(query.cursor);
  const limit = query.limit ?? 20;

  const filter: Record<string, unknown> = { status: 'active' };
  if (query.q && query.q.trim()) {
    filter.$text = { $search: query.q.trim() };
  }
  if (cursor) {
    const t = new Date(cursor.t);
    const id = new Types.ObjectId(cursor.id);
    filter.$or = [
      { createdAt: { $lt: t } },
      { createdAt: t, _id: { $lt: id } },
    ];
  }

  const rawPosts = (await Post.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()) as unknown as PostDocument[];

  const { items: pagePosts, nextCursor } = buildNextCursor(rawPosts, limit);
  const ctxMap = await hydratePosts(pagePosts, viewer);

  const items = pagePosts
    .map((p) => {
      const ctx = ctxMap.get(p._id.toString());
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is PostDTO => x !== null);

  return { items, nextCursor };
}
