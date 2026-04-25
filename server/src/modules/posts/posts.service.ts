import { Types } from 'mongoose';
import { Post, type PostDocument, type PostImage, type PostVideo } from '../../models/post.model';
import { User, type UserDocument } from '../../models/user.model';
import { Tag, type TagDocument } from '../../models/tag.model';
import { Follow } from '../../models/follow.model';
import { Like } from '../../models/like.model';
import { Bookmark } from '../../models/bookmark.model';
import { AppError } from '../../lib/errors';
import { extractTags, extractMentionUsernames } from '../../lib/extract';
import { uploadBufferToS3, uploadVideoBufferToS3, deleteFromS3 } from '../../config/s3';
import type { PostDTOContext, PostDTO } from '../../lib/dto';
import { toPostDTO } from '../../lib/dto';
import { decodeCursor, buildNextCursor } from '../../lib/pagination';
import { calcFeedScore, refreshFeedScore } from '../../lib/feedScorer';
import type { CreatePostInput, UpdatePostInput, SearchPostsQuery } from './posts.schemas';
import { createNotification } from '../notifications/notifications.service';

interface UploadedMedia {
  images: PostImage[];
  video: PostVideo | null;
  urls: string[];
}

export async function createPost(
  author: UserDocument,
  input: CreatePostInput,
  imageBuffers: Buffer[] = [],
  videoBuffer: Buffer | null = null,
): Promise<{ post: PostDocument; ctx: PostDTOContext }> {
  // Echo requires text (the user's own commentary)
  if (input.echoOf && !input.text.trim()) {
    throw AppError.validation('An echo must include your commentary');
  }

  const hasText = input.text.trim().length > 0;
  if (!hasText && imageBuffers.length === 0 && videoBuffer === null) {
    throw AppError.validation('A post must have text, at least one image, or a video');
  }

  if (imageBuffers.length > 0 && videoBuffer !== null) {
    throw AppError.validation('A post cannot contain both images and a video');
  }

  const MAX_IMG = 5 * 1024 * 1024;
  for (const buf of imageBuffers) {
    if (buf.length > MAX_IMG) throw AppError.validation('Image files may not exceed 5 MB');
  }

  const tags = extractTags(input.text);
  const mentionUsernames = extractMentionUsernames(input.text);

  const [tagDocs, mentionDocs, media] = await Promise.all([
    upsertTagsForPost(tags),
    mentionUsernames.length
      ? User.find({ username: { $in: mentionUsernames }, status: 'active' })
      : Promise.resolve([] as UserDocument[]),
    uploadPostMedia(imageBuffers, videoBuffer),
  ]);

  // Resolve echo target (prevent chain echo: A echoes B echoes C → A echoes C)
  let echoOfId: Types.ObjectId | null = null;
  let echoOriginal: PostDocument | null = null;
  if (input.echoOf) {
    const original = await Post.findById(input.echoOf);
    if (!original || original.status !== 'active') {
      throw AppError.notFound('Post not found');
    }
    echoOfId = (original.echoOf ?? original._id) as Types.ObjectId;
    echoOriginal = original;
  }

  const now = new Date();
  let post: PostDocument;
  try {
    post = await Post.create({
      authorId: author._id,
      text: input.text,
      images: media.images,
      video: media.video,
      tagIds: tagDocs.map((t) => t._id),
      mentionIds: mentionDocs.map((u) => u._id),
      visibility: input.visibility,
      ...(echoOfId ? { echoOf: echoOfId } : {}),
      feedScore: calcFeedScore({ likeCount: 0, commentCount: 0, repostCount: 0, createdAt: now }),
    });
  } catch (err) {
    await cleanupUploadedMedia(media.urls);
    throw err;
  }

  await Promise.all([
    User.updateOne({ _id: author._id }, { $inc: { postCount: 1 } }),
    tagDocs.length
      ? Tag.updateMany(
          { _id: { $in: tagDocs.map((t) => t._id) } },
          { $inc: { postCount: 1 }, $set: { lastUsedAt: new Date() } },
        )
      : Promise.resolve(null),
    // Increment echo (repost) counter on the original post and refresh its score
    echoOfId
      ? Post.updateOne({ _id: echoOfId }, { $inc: { repostCount: 1 } }).then(() => {
          refreshFeedScore(echoOfId!);
        })
      : Promise.resolve(null),
  ]);

  // Echo notification — notify original post's author
  if (echoOriginal && !echoOriginal.authorId.equals(author._id)) {
    await createNotification({
      recipientId: echoOriginal.authorId,
      actorId: author._id,
      type: 'echo',
      postId: echoOfId!,
    });
  }

  // Mention notifications — skip self
  for (const mentioned of mentionDocs) {
    if (mentioned._id.equals(author._id)) continue;
    await createNotification({
      recipientId: mentioned._id,
      actorId: author._id,
      type: 'mention',
      postId: post._id,
    });
  }

  return { post, ctx: { author, tags: tagDocs, mentions: mentionDocs, likedByMe: false } };
}

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

  let echoOfDto: import('../../lib/dto').PostDTO | undefined;
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

export async function updatePost(
  postId: string,
  actor: UserDocument,
  patch: UpdatePostInput,
): Promise<{ post: PostDocument; ctx: PostDTOContext }> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (!post.authorId.equals(actor._id)) throw AppError.forbidden('Not your post');

  let tagSync: { previous: string[]; next: string[] } | null = null;

  if (patch.text !== undefined && patch.text !== post.text) {
    const previousTagIds = post.tagIds.map((id) => id.toString());
    post.text = patch.text;
    const tags = extractTags(patch.text);
    const mentionUsernames = extractMentionUsernames(patch.text);
    const [tagDocs, mentionDocs] = await Promise.all([
      upsertTagsForPost(tags),
      mentionUsernames.length
        ? User.find({ username: { $in: mentionUsernames }, status: 'active' })
        : Promise.resolve([] as UserDocument[]),
    ]);
    const nextTagIds = tagDocs.map((t) => t._id);
    post.tagIds = nextTagIds;
    post.mentionIds = mentionDocs.map((u) => u._id);
    tagSync = { previous: previousTagIds, next: nextTagIds.map((id) => id.toString()) };
  }
  if (patch.visibility !== undefined) post.visibility = patch.visibility;
  post.editedAt = new Date();
  await post.save();
  if (tagSync) await syncTagCounts(tagSync.previous, tagSync.next);

  return getPostForViewer(post._id.toString(), actor);
}

export async function deletePost(postId: string, actor: UserDocument): Promise<void> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (!post.authorId.equals(actor._id)) throw AppError.forbidden('Not your post');

  post.status = 'deleted';
  post.deletedAt = new Date();
  await post.save();

  await Promise.all([
    User.updateOne({ _id: actor._id }, { $inc: { postCount: -1 } }),
    post.tagIds.length
      ? Tag.updateMany({ _id: { $in: post.tagIds } }, { $inc: { postCount: -1 } })
      : Promise.resolve(null),
    // Delete media from S3 (non-fatal — logged inside deleteFromS3)
    ...post.images.map((img) => deleteFromS3(img.url)),
    post.video ? deleteFromS3(post.video.url) : Promise.resolve(),
  ]);
}

/**
 * Assert the viewer is allowed to read this post given its visibility setting.
 * Throws NOT_FOUND (not FORBIDDEN) to avoid leaking existence of private posts.
 */
export async function assertVisibility(
  post: PostDocument,
  viewer: UserDocument | null,
): Promise<void> {
  if (post.visibility === 'public') return;
  if (!viewer) throw AppError.notFound('Post not found');
  if (post.authorId.equals(viewer._id)) return;
  if (post.visibility === 'private') throw AppError.notFound('Post not found');
  if (post.visibility === 'followers') {
    const follows = await Follow.exists({
      followerId: viewer._id,
      followingId: post.authorId,
    });
    if (!follows) throw AppError.notFound('Post not found');
  }
}

async function upsertTagsForPost(
  tags: Array<{ slug: string; display: string }>,
): Promise<TagDocument[]> {
  if (tags.length === 0) return [];
  const ops = tags.map((t) => ({
    updateOne: {
      filter: { slug: t.slug },
      update: { $setOnInsert: { slug: t.slug, display: t.display } },
      upsert: true,
    },
  }));
  await Tag.bulkWrite(ops);
  return Tag.find({ slug: { $in: tags.map((t) => t.slug) } });
}

async function syncTagCounts(previousTagIds: string[], nextTagIds: string[]): Promise<void> {
  const previous = new Set(previousTagIds);
  const next = new Set(nextTagIds);

  const added = nextTagIds.filter((id) => !previous.has(id));
  const removed = previousTagIds.filter((id) => !next.has(id));

  await Promise.all([
    added.length
      ? Tag.updateMany(
          { _id: { $in: added.map((id) => new Types.ObjectId(id)) } },
          { $inc: { postCount: 1 }, $set: { lastUsedAt: new Date() } },
        )
      : Promise.resolve(null),
    removed.length
      ? Tag.updateMany(
          { _id: { $in: removed.map((id) => new Types.ObjectId(id)) } },
          { $inc: { postCount: -1 } },
        )
      : Promise.resolve(null),
  ]);
}

async function uploadPostMedia(
  imageBuffers: Buffer[],
  videoBuffer: Buffer | null,
): Promise<UploadedMedia> {
  const images: PostImage[] = [];
  const urls: string[] = [];

  try {
    for (const buffer of imageBuffers) {
      const uploaded = await uploadBufferToS3(buffer, 'posts');
      images.push({ url: uploaded.url, width: uploaded.width, height: uploaded.height });
      urls.push(uploaded.url);
    }

    let video: PostVideo | null = null;
    if (videoBuffer) {
      const uploaded = await uploadVideoBufferToS3(videoBuffer, 'posts');
      video = {
        url: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
      };
      urls.push(uploaded.url);
    }

    return { images, video, urls };
  } catch (err) {
    await cleanupUploadedMedia(urls);
    throw err;
  }
}

async function cleanupUploadedMedia(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await Promise.all(urls.map((url) => deleteFromS3(url)));
}

/**
 * Hydrate a list of posts to their DTO contexts in a single round-trip per relation.
 * Avoids N+1 on feed endpoints.
 */
export async function hydratePosts(
  posts: PostDocument[],
  viewer: UserDocument | null,
): Promise<Map<string, PostDTOContext>> {
  const authorIds = new Set<string>();
  const tagIds = new Set<string>();
  const mentionIds = new Set<string>();
  for (const p of posts) {
    authorIds.add(p.authorId.toString());
    p.tagIds.forEach((t) => tagIds.add(t.toString()));
    p.mentionIds.forEach((m) => mentionIds.add(m.toString()));
  }

  const [authors, tags, mentions, likes, bookmarks] = (await Promise.all([
    User.find({ _id: { $in: Array.from(authorIds).map((id) => new Types.ObjectId(id)) } }).lean(),
    tagIds.size
      ? Tag.find({ _id: { $in: Array.from(tagIds).map((id) => new Types.ObjectId(id)) } }).lean()
      : Promise.resolve([] as TagDocument[]),
    mentionIds.size
      ? User.find({ _id: { $in: Array.from(mentionIds).map((id) => new Types.ObjectId(id)) } }).lean()
      : Promise.resolve([] as UserDocument[]),
    viewer && posts.length
      ? Like.find({
          userId: viewer._id,
          targetType: 'post',
          targetId: { $in: posts.map((p) => p._id) },
        }).select('targetId').lean()
      : Promise.resolve([] as Array<{ _id: Types.ObjectId; targetId: Types.ObjectId }>),
    viewer && posts.length
      ? Bookmark.find({
          userId: viewer._id,
          postId: { $in: posts.map((p) => p._id) },
        }).select('postId').lean()
      : Promise.resolve([] as Array<{ _id: Types.ObjectId; postId: Types.ObjectId }>),
  ])) as unknown as [UserDocument[], TagDocument[], UserDocument[], Array<{ _id: Types.ObjectId; targetId: Types.ObjectId }>, Array<{ _id: Types.ObjectId; postId: Types.ObjectId }>];

  const authorById = new Map(authors.map((u) => [u._id.toString(), u]));
  const tagById = new Map(tags.map((t) => [t._id.toString(), t]));
  const mentionById = new Map(mentions.map((u) => [u._id.toString(), u]));
  const likedSet = new Set(likes.map((l) => l.targetId.toString()));
  const bookmarkedSet = new Set(bookmarks.map((b) => b.postId.toString()));

  // Batch-load echoOf original posts (1 extra round-trip covers all echoes in this page)
  const echoOfIds = posts
    .filter((p) => p.echoOf)
    .map((p) => p.echoOf as Types.ObjectId);

  const echoOfDtoById = new Map<string, import('../../lib/dto').PostDTO>();

  if (echoOfIds.length) {
    const origPosts = (await Post.find({
      _id: { $in: echoOfIds },
      status: { $in: ['active', 'deleted'] },
    }).lean()) as unknown as PostDocument[];

    const origAuthorIdSet = new Set(origPosts.map((p) => p.authorId.toString()));
    const origAuthors = (await User.find({
      _id: { $in: Array.from(origAuthorIdSet).map((id) => new Types.ObjectId(id)) },
    }).lean()) as unknown as UserDocument[];
    const origAuthorById = new Map(origAuthors.map((u) => [u._id.toString(), u]));

    for (const orig of origPosts) {
      const origAuthor = origAuthorById.get(orig.authorId.toString());
      if (!origAuthor) continue;
      echoOfDtoById.set(
        orig._id.toString(),
        toPostDTO(orig, { author: origAuthor, tags: [], mentions: [], likedByMe: false }),
      );
    }
  }

  const out = new Map<string, PostDTOContext>();
  for (const p of posts) {
    const author = authorById.get(p.authorId.toString());
    if (!author) continue;
    out.set(p._id.toString(), {
      author,
      tags: p.tagIds.map((t) => tagById.get(t.toString())).filter((x): x is TagDocument => !!x),
      mentions: p.mentionIds
        .map((m) => mentionById.get(m.toString()))
        .filter((x): x is UserDocument => !!x),
      likedByMe: likedSet.has(p._id.toString()),
      bookmarkedByMe: bookmarkedSet.has(p._id.toString()),
      echoOf: p.echoOf ? echoOfDtoById.get(p.echoOf.toString()) : undefined,
    });
  }
  return out;
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
