import { Types } from 'mongoose';
import { Comment, type CommentDocument } from '../../models/comment.model';
import { Post } from '../../models/post.model';
import { User, type UserDocument } from '../../models/user.model';
import { Like } from '../../models/like.model';
import { AppError } from '../../lib/errors';
import {
  type Cursor,
  cursorFilterAsc,
  buildNextCursor,
} from '../../lib/pagination';
import { assertVisibility } from '../posts/posts.service';
import type { CommentDTOContext } from '../../lib/dto';
import { createNotification } from '../notifications/notifications.service';
import { refreshFeedScore } from '../../lib/feedScorer';
import { extractMentionUsernames } from '../../lib/extract';

export async function listForPost(
  postId: string,
  viewer: UserDocument | null,
  cursor: Cursor | null,
  limit: number,
): Promise<{
  items: CommentDocument[];
  nextCursor: string | null;
  ctxByCommentId: Map<string, CommentDTOContext>;
}> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);

  const filter = {
    postId: post._id,
    status: { $in: ['active', 'deleted'] },
    ...cursorFilterAsc(cursor),
  };
  const docs = (await Comment.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean()) as unknown as CommentDocument[];

  const { items, nextCursor } = buildNextCursor(docs, limit);

  const authorIds = Array.from(new Set(items.map((c) => c.authorId.toString())));
  const authors = (await User.find({
    _id: { $in: authorIds.map((id) => new Types.ObjectId(id)) },
  }).lean()) as unknown as UserDocument[];
  const authorById = new Map(authors.map((u) => [u._id.toString(), u]));

  let likedIds = new Set<string>();
  if (viewer && items.length) {
    const likes = (await Like.find({
      userId: viewer._id,
      targetType: 'comment',
      targetId: { $in: items.map((c) => c._id) },
    }).select('targetId').lean()) as unknown as Array<{ _id: Types.ObjectId; targetId: Types.ObjectId }>;
    likedIds = new Set(likes.map((l) => l.targetId.toString()));
  }

  const ctxByCommentId = new Map<string, CommentDTOContext>();
  for (const c of items) {
    const author = authorById.get(c.authorId.toString());
    if (!author) continue;
    ctxByCommentId.set(c._id.toString(), { author, likedByMe: likedIds.has(c._id.toString()) });
  }

  return { items, nextCursor, ctxByCommentId };
}

export async function createComment(
  actor: UserDocument,
  postId: string,
  text: string,
  parentId: string | null,
): Promise<{ comment: CommentDocument; ctx: CommentDTOContext }> {
  const post = await Post.findById(postId);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, actor);

  let parent: CommentDocument | null = null;
  if (parentId) {
    parent = await Comment.findById(parentId);
    if (!parent || parent.status !== 'active' || !parent.postId.equals(post._id)) {
      throw AppError.notFound('Parent comment not found');
    }
  }

  const mentionUsernames = extractMentionUsernames(text);
  const mentionUsers = mentionUsernames.length
    ? await User.find({ username: { $in: mentionUsernames }, status: 'active' }).select('_id')
    : [];

  const comment = await Comment.create({
    postId: post._id,
    authorId: actor._id,
    parentId: parent ? parent._id : null,
    text,
    mentionIds: mentionUsers.map((u) => u._id),
  });

  await Post.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } });
  refreshFeedScore(post._id);

  // Notifications — fire concurrently
  const notifJobs: Promise<void>[] = [];
  notifJobs.push(
    createNotification(
      parent
        ? {
            recipientId: parent.authorId,
            actorId: actor._id,
            type: 'reply',
            postId: post._id,
            commentId: comment._id,
          }
        : {
            recipientId: post.authorId,
            actorId: actor._id,
            type: 'comment',
            postId: post._id,
            commentId: comment._id,
          },
    ),
  );

  // Mention notifications — skip if already notified as post/parent author
  const alreadyNotified = new Set<string>();
  alreadyNotified.add(actor.id);
  alreadyNotified.add(parent ? parent.authorId.toString() : post.authorId.toString());
  for (const u of mentionUsers) {
    if (alreadyNotified.has(u._id.toString())) continue;
    notifJobs.push(
      createNotification({
        recipientId: u._id,
        actorId: actor._id,
        type: 'mention',
        postId: post._id,
        commentId: comment._id,
      }),
    );
  }
  await Promise.all(notifJobs);

  return { comment, ctx: { author: actor, likedByMe: false } };
}

export async function updateComment(
  actor: UserDocument,
  commentId: string,
  text: string,
): Promise<{ comment: CommentDocument; ctx: CommentDTOContext }> {
  const comment = await Comment.findById(commentId);
  if (!comment || comment.status !== 'active') throw AppError.notFound('Comment not found');
  if (!comment.authorId.equals(actor._id)) throw AppError.forbidden('Not your comment');

  comment.text = text;
  comment.editedAt = new Date();
  await comment.save();

  return { comment, ctx: { author: actor } };
}

export async function deleteComment(actor: UserDocument, commentId: string): Promise<void> {
  const comment = await Comment.findById(commentId);
  if (!comment || comment.status !== 'active') throw AppError.notFound('Comment not found');
  if (!comment.authorId.equals(actor._id)) throw AppError.forbidden('Not your comment');

  comment.status = 'deleted';
  comment.deletedAt = new Date();
  await comment.save();

  await Post.updateOne({ _id: comment.postId }, { $inc: { commentCount: -1 } });
  refreshFeedScore(comment.postId);
}
