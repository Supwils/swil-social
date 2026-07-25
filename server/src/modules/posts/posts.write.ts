import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, tags, follows } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { assertAgentDailyQuota } from '../../lib/agentQuota';
import { extractTags, extractMentionUsernames } from '../../lib/extract';
import { deleteFromS3 } from '../../config/s3';
import type { PostDTOContext, PostRow, UserRow } from '../../lib/dto';
import { calcFeedScore, refreshFeedScore } from '../../lib/feedScorer';
import type { CreatePostInput, UpdatePostInput } from './posts.schemas';
import { createNotification } from '../notifications/notifications.service';
import { emitToUser } from '../../realtime/io';
import { uploadPostMedia, cleanupUploadedMedia } from './posts.media';
import { upsertTagsForPost, syncTagCounts } from './posts.tags';
import { getPostForViewer } from './posts.read';
import { assertBoardExists } from '../boards/boards.service';

export async function createPost(
  author: UserRow,
  input: CreatePostInput,
  imageBuffers: Buffer[] = [],
  videoBuffer: Buffer | null = null,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  await assertAgentDailyQuota(author, 'post');

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

  // Fail before any media work if the caller named a board that does not exist.
  if (input.boardId) await assertBoardExists(input.boardId);

  const MAX_IMG = 5 * 1024 * 1024;
  for (const buf of imageBuffers) {
    if (buf.length > MAX_IMG) throw AppError.validation('Image files may not exceed 5 MB');
  }

  const tagNames = extractTags(input.text);
  const mentionUsernames = extractMentionUsernames(input.text);

  const [tagDocs, mentionDocs, media] = await Promise.all([
    upsertTagsForPost(tagNames),
    mentionUsernames.length
      ? db
          .select()
          .from(users)
          .where(and(inArray(users.username, mentionUsernames), eq(users.status, 'active')))
      : Promise.resolve([] as UserRow[]),
    uploadPostMedia(imageBuffers, videoBuffer),
  ]);

  // Resolve echo target (prevent chain echo: A echoes B echoes C → A echoes C)
  let echoOfId: string | null = null;
  let echoOriginal: PostRow | null = null;
  if (input.echoOf) {
    const [original] = await db.select().from(posts).where(eq(posts.id, input.echoOf)).limit(1);
    if (!original || original.status !== 'active') {
      throw AppError.notFound('Post not found');
    }
    echoOfId = original.echoOf ?? original.id;
    echoOriginal = original;
  }

  const now = new Date();
  let post: PostRow;
  try {
    post = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(posts)
        .values({
          authorId: author.id,
          text: input.text,
          images: media.images,
          video: media.video,
          tagIds: tagDocs.map((t) => t.id),
          mentionIds: mentionDocs.map((u) => u.id),
          visibility: input.visibility,
          boardId: input.boardId ?? null,
          ...(echoOfId ? { echoOf: echoOfId } : {}),
          feedScore: calcFeedScore({ likeCount: 0, commentCount: 0, repostCount: 0, createdAt: now }),
        })
        .returning();

      await tx
        .update(users)
        .set({ postCount: sql`${users.postCount} + 1` })
        .where(eq(users.id, author.id));

      if (tagDocs.length) {
        await tx
          .update(tags)
          .set({ postCount: sql`${tags.postCount} + 1`, lastUsedAt: new Date() })
          .where(
            inArray(
              tags.id,
              tagDocs.map((t) => t.id),
            ),
          );
      }

      if (echoOfId) {
        await tx
          .update(posts)
          .set({ repostCount: sql`${posts.repostCount} + 1` })
          .where(eq(posts.id, echoOfId));
      }

      return created;
    });
  } catch (err) {
    await cleanupUploadedMedia(media.urls);
    throw err;
  }

  if (echoOfId) {
    refreshFeedScore(echoOfId);
  }

  // Notifications — fire concurrently
  const notifJobs: Promise<void>[] = [];
  if (echoOriginal && echoOriginal.authorId !== author.id) {
    notifJobs.push(
      createNotification({
        recipientId: echoOriginal.authorId,
        actorId: author.id,
        type: 'echo',
        postId: echoOfId!,
      }),
    );
  }
  for (const mentioned of mentionDocs) {
    if (mentioned.id === author.id) continue;
    notifJobs.push(
      createNotification({
        recipientId: mentioned.id,
        actorId: author.id,
        type: 'mention',
        postId: post.id,
      }),
    );
  }
  await Promise.all(notifJobs);

  // Notify followers about the new post (fire-and-forget, never blocks creation)
  void (async () => {
    try {
      const followers = await db
        .select({ followerId: follows.followerId })
        .from(follows)
        .where(eq(follows.followingId, author.id));
      for (const f of followers) {
        emitToUser(f.followerId, 'post:new', {
          authorUsername: author.username,
          authorDisplayName: author.displayName,
          postId: post.id,
        });
      }
    } catch {
      /* non-critical */
    }
  })();

  return { post, ctx: { author, tags: tagDocs, mentions: mentionDocs, likedByMe: false } };
}

export async function updatePost(
  postId: string,
  actor: UserRow,
  patch: UpdatePostInput,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (post.authorId !== actor.id) throw AppError.forbidden('Not your post');

  const updates: Partial<typeof posts.$inferInsert> = {};
  let tagSync: { previous: string[]; next: string[] } | null = null;

  if (patch.text !== undefined && patch.text !== post.text) {
    const previousTagIds = [...post.tagIds];
    updates.text = patch.text;
    const tagNames = extractTags(patch.text);
    const mentionUsernames = extractMentionUsernames(patch.text);
    const [tagDocs, mentionDocs] = await Promise.all([
      upsertTagsForPost(tagNames),
      mentionUsernames.length
        ? db
            .select()
            .from(users)
            .where(and(inArray(users.username, mentionUsernames), eq(users.status, 'active')))
        : Promise.resolve([] as UserRow[]),
    ]);
    const nextTagIds = tagDocs.map((t) => t.id);
    updates.tagIds = nextTagIds;
    updates.mentionIds = mentionDocs.map((u) => u.id);
    tagSync = { previous: previousTagIds, next: nextTagIds };
  }
  if (patch.visibility !== undefined) updates.visibility = patch.visibility;
  updates.editedAt = new Date();

  await db.update(posts).set(updates).where(eq(posts.id, postId));
  if (tagSync) await syncTagCounts(tagSync.previous, tagSync.next);

  return getPostForViewer(postId, actor);
}

export async function deletePost(postId: string, actor: UserRow): Promise<void> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  if (post.authorId !== actor.id) throw AppError.forbidden('Not your post');

  await db
    .update(posts)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(posts.id, postId));

  await Promise.all([
    db
      .update(users)
      .set({ postCount: sql`${users.postCount} - 1` })
      .where(eq(users.id, actor.id)),
    post.tagIds.length
      ? db
          .update(tags)
          .set({ postCount: sql`${tags.postCount} - 1` })
          .where(inArray(tags.id, post.tagIds))
      : Promise.resolve(null),
    ...post.images.map((img) => deleteFromS3(img.url)),
    post.video ? deleteFromS3(post.video.url) : Promise.resolve(),
  ]);
}

/**
 * Assert the viewer is allowed to read this post given its visibility setting.
 * Throws NOT_FOUND (not FORBIDDEN) to avoid leaking existence of private posts.
 */
export async function assertVisibility(post: PostRow, viewer: UserRow | null): Promise<void> {
  if (post.visibility === 'public') return;
  if (!viewer) throw AppError.notFound('Post not found');
  if (post.authorId === viewer.id) return;
  if (post.visibility === 'private') throw AppError.notFound('Post not found');
  if (post.visibility === 'followers') {
    const [f] = await db
      .select({ id: follows.id })
      .from(follows)
      .where(and(eq(follows.followerId, viewer.id), eq(follows.followingId, post.authorId)))
      .limit(1);
    if (!f) throw AppError.notFound('Post not found');
  }
}
