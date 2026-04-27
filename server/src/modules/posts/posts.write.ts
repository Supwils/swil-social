import { Types } from 'mongoose';
import { Post, type PostDocument } from '../../models/post.model';
import { User, type UserDocument } from '../../models/user.model';
import { Tag } from '../../models/tag.model';
import { Follow } from '../../models/follow.model';
import { AppError } from '../../lib/errors';
import { extractTags, extractMentionUsernames } from '../../lib/extract';
import { deleteFromS3 } from '../../config/s3';
import type { PostDTOContext } from '../../lib/dto';
import { calcFeedScore, refreshFeedScore } from '../../lib/feedScorer';
import type { CreatePostInput, UpdatePostInput } from './posts.schemas';
import { createNotification } from '../notifications/notifications.service';
import { emitToUser } from '../../realtime/io';
import { uploadPostMedia, cleanupUploadedMedia } from './posts.media';
import { upsertTagsForPost, syncTagCounts } from './posts.tags';
import { getPostForViewer } from './posts.read';

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
    const original = (await Post.findById(input.echoOf).lean()) as unknown as PostDocument | null;
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
    echoOfId
      ? Post.updateOne({ _id: echoOfId }, { $inc: { repostCount: 1 } }).then(() => {
          refreshFeedScore(echoOfId!);
        })
      : Promise.resolve(null),
  ]);

  // Notifications — fire concurrently
  const notifJobs: Promise<void>[] = [];
  if (echoOriginal && !echoOriginal.authorId.equals(author._id)) {
    notifJobs.push(
      createNotification({
        recipientId: echoOriginal.authorId,
        actorId: author._id,
        type: 'echo',
        postId: echoOfId!,
      }),
    );
  }
  for (const mentioned of mentionDocs) {
    if (mentioned._id.equals(author._id)) continue;
    notifJobs.push(
      createNotification({
        recipientId: mentioned._id,
        actorId: author._id,
        type: 'mention',
        postId: post._id,
      }),
    );
  }
  await Promise.all(notifJobs);

  // Notify followers about the new post (fire-and-forget, never blocks creation)
  void (async () => {
    try {
      const followers = await Follow.find({ followingId: author._id })
        .select('followerId').lean();
      for (const f of followers) {
        emitToUser(f.followerId, 'post:new', {
          authorUsername: author.username,
          authorDisplayName: author.displayName,
          postId: post._id.toString(),
        });
      }
    } catch { /* non-critical */ }
  })();

  return { post, ctx: { author, tags: tagDocs, mentions: mentionDocs, likedByMe: false } };
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
