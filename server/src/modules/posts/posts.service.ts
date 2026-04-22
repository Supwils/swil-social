import { Types } from 'mongoose';
import { Post, type PostDocument, type PostImage } from '../../models/post.model';
import { User, type UserDocument } from '../../models/user.model';
import { Tag, type TagDocument } from '../../models/tag.model';
import { Follow } from '../../models/follow.model';
import { Like } from '../../models/like.model';
import { AppError } from '../../lib/errors';
import { extractTags, extractMentionUsernames } from '../../lib/extract';
import { uploadBufferToCloudinary } from '../../config/cloudinary';
import type { PostDTOContext } from '../../lib/dto';
import type { CreatePostInput, UpdatePostInput } from './posts.schemas';
import { createNotification } from '../notifications/notifications.service';

export async function createPost(
  author: UserDocument,
  input: CreatePostInput,
  imageBuffers: Buffer[] = [],
): Promise<{ post: PostDocument; ctx: PostDTOContext }> {
  const tags = extractTags(input.text);
  const mentionUsernames = extractMentionUsernames(input.text);

  const [tagDocs, mentionDocs, images] = await Promise.all([
    upsertTagsForPost(tags),
    mentionUsernames.length
      ? User.find({ username: { $in: mentionUsernames }, status: 'active' })
      : Promise.resolve([] as UserDocument[]),
    uploadImages(imageBuffers),
  ]);

  const post = await Post.create({
    authorId: author._id,
    text: input.text,
    images,
    tagIds: tagDocs.map((t) => t._id),
    mentionIds: mentionDocs.map((u) => u._id),
    visibility: input.visibility,
  });

  await Promise.all([
    User.updateOne({ _id: author._id }, { $inc: { postCount: 1 } }),
    tagDocs.length
      ? Tag.updateMany(
          { _id: { $in: tagDocs.map((t) => t._id) } },
          { $inc: { postCount: 1 }, $set: { lastUsedAt: new Date() } },
        )
      : Promise.resolve(null),
  ]);

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

  return { post, ctx: { author, tags, mentions, likedByMe } };
}

export async function updatePost(
  postId: string,
  actor: UserDocument,
  patch: UpdatePostInput,
): Promise<{ post: PostDocument; ctx: PostDTOContext }> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (!post.authorId.equals(actor._id)) throw AppError.forbidden('Not your post');

  if (patch.text !== undefined && patch.text !== post.text) {
    post.text = patch.text;
    const tags = extractTags(patch.text);
    const mentionUsernames = extractMentionUsernames(patch.text);
    const [tagDocs, mentionDocs] = await Promise.all([
      upsertTagsForPost(tags),
      mentionUsernames.length
        ? User.find({ username: { $in: mentionUsernames }, status: 'active' })
        : Promise.resolve([] as UserDocument[]),
    ]);
    post.tagIds = tagDocs.map((t) => t._id);
    post.mentionIds = mentionDocs.map((u) => u._id);
  }
  if (patch.visibility !== undefined) post.visibility = patch.visibility;
  post.editedAt = new Date();
  await post.save();

  return getPostForViewer(post.id, actor);
}

export async function deletePost(postId: string, actor: UserDocument): Promise<void> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (!post.authorId.equals(actor._id)) throw AppError.forbidden('Not your post');

  post.status = 'deleted';
  post.deletedAt = new Date();
  await post.save();

  await User.updateOne({ _id: actor._id }, { $inc: { postCount: -1 } });
  if (post.tagIds.length) {
    await Tag.updateMany({ _id: { $in: post.tagIds } }, { $inc: { postCount: -1 } });
  }
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

async function uploadImages(buffers: Buffer[]): Promise<PostImage[]> {
  if (buffers.length === 0) return [];
  const uploads = await Promise.all(
    buffers.map((b) => uploadBufferToCloudinary(b, 'swil-social/posts')),
  );
  return uploads.map((u) => ({ url: u.url, width: u.width, height: u.height }));
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

  const [authors, tags, mentions, likes] = await Promise.all([
    User.find({ _id: { $in: Array.from(authorIds).map((id) => new Types.ObjectId(id)) } }),
    tagIds.size
      ? Tag.find({ _id: { $in: Array.from(tagIds).map((id) => new Types.ObjectId(id)) } })
      : Promise.resolve([] as TagDocument[]),
    mentionIds.size
      ? User.find({ _id: { $in: Array.from(mentionIds).map((id) => new Types.ObjectId(id)) } })
      : Promise.resolve([] as UserDocument[]),
    viewer && posts.length
      ? Like.find({
          userId: viewer._id,
          targetType: 'post',
          targetId: { $in: posts.map((p) => p._id) },
        }).select('targetId')
      : Promise.resolve([] as Array<{ targetId: Types.ObjectId }>),
  ]);

  const authorById = new Map(authors.map((u) => [u.id, u]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const mentionById = new Map(mentions.map((u) => [u.id, u]));
  const likedSet = new Set(likes.map((l) => l.targetId.toString()));

  const out = new Map<string, PostDTOContext>();
  for (const p of posts) {
    const author = authorById.get(p.authorId.toString());
    if (!author) continue;
    out.set(p.id, {
      author,
      tags: p.tagIds.map((t) => tagById.get(t.toString())).filter((x): x is TagDocument => !!x),
      mentions: p.mentionIds
        .map((m) => mentionById.get(m.toString()))
        .filter((x): x is UserDocument => !!x),
      likedByMe: likedSet.has(p.id),
    });
  }
  return out;
}
