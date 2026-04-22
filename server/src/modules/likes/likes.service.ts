import { Types } from 'mongoose';
import { Like, type LikeTarget } from '../../models/like.model';
import { Post } from '../../models/post.model';
import { Comment } from '../../models/comment.model';
import { AppError } from '../../lib/errors';
import type { UserDocument } from '../../models/user.model';
import { createNotification } from '../notifications/notifications.service';

/**
 * Idempotent like/unlike.
 *
 * Returns the authoritative new count. Uses unique index `(userId, targetType, targetId)`
 * to avoid double-like races.
 */

async function assertTargetExists(targetType: LikeTarget, targetId: string): Promise<void> {
  if (!Types.ObjectId.isValid(targetId)) throw AppError.notFound('Target not found');
  const _id = new Types.ObjectId(targetId);
  if (targetType === 'post') {
    const post = await Post.findOne({ _id, status: 'active' }).select('_id');
    if (!post) throw AppError.notFound('Post not found');
  } else {
    const comment = await Comment.findOne({ _id, status: 'active' }).select('_id');
    if (!comment) throw AppError.notFound('Comment not found');
  }
}

async function incTargetCount(
  targetType: LikeTarget,
  targetId: Types.ObjectId,
  delta: number,
): Promise<number> {
  if (targetType === 'post') {
    const doc = await Post.findByIdAndUpdate(
      targetId,
      { $inc: { likeCount: delta } },
      { new: true },
    ).select('likeCount');
    return doc?.likeCount ?? 0;
  }
  const doc = await Comment.findByIdAndUpdate(
    targetId,
    { $inc: { likeCount: delta } },
    { new: true },
  ).select('likeCount');
  return doc?.likeCount ?? 0;
}

export async function like(
  user: UserDocument,
  targetType: LikeTarget,
  targetId: string,
): Promise<{ likeCount: number; liked: true }> {
  await assertTargetExists(targetType, targetId);
  const target = new Types.ObjectId(targetId);
  try {
    await Like.create({ userId: user._id, targetType, targetId: target });
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e.code === 11000) {
      const current = await getCountDirect(targetType, target);
      return { likeCount: current, liked: true };
    }
    throw err;
  }
  const likeCount = await incTargetCount(targetType, target, 1);

  // Notify author — best-effort, never throws
  if (targetType === 'post') {
    const post = await Post.findById(target).select('authorId');
    if (post) {
      await createNotification({
        recipientId: post.authorId,
        actorId: user._id,
        type: 'like',
        postId: post._id,
      });
    }
  } else {
    const comment = await Comment.findById(target).select('authorId postId');
    if (comment) {
      await createNotification({
        recipientId: comment.authorId,
        actorId: user._id,
        type: 'like',
        postId: comment.postId,
        commentId: comment._id,
      });
    }
  }

  return { likeCount, liked: true };
}

export async function unlike(
  user: UserDocument,
  targetType: LikeTarget,
  targetId: string,
): Promise<{ likeCount: number; liked: false }> {
  if (!Types.ObjectId.isValid(targetId)) throw AppError.notFound('Target not found');
  const target = new Types.ObjectId(targetId);
  const deleted = await Like.findOneAndDelete({
    userId: user._id,
    targetType,
    targetId: target,
  });
  if (!deleted) {
    const current = await getCountDirect(targetType, target);
    return { likeCount: current, liked: false };
  }
  const likeCount = await incTargetCount(targetType, target, -1);
  return { likeCount: Math.max(0, likeCount), liked: false };
}

async function getCountDirect(targetType: LikeTarget, targetId: Types.ObjectId): Promise<number> {
  if (targetType === 'post') {
    const p = await Post.findById(targetId).select('likeCount');
    return p?.likeCount ?? 0;
  }
  const c = await Comment.findById(targetId).select('likeCount');
  return c?.likeCount ?? 0;
}
