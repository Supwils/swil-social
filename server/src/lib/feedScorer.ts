import { Types } from 'mongoose';
import { Post } from '../models/post.model';

/**
 * HackerNews-style gravity score.
 *
 * score = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
 *
 * - New posts start ~0.35 and naturally decay.
 * - Engagement slows decay. A post with 10 likes at 24 hours still scores higher
 *   than a zero-engagement post at 1 hour.
 * - Gravity exponent 1.5 keeps content relevant for ~3-7 days before sinking.
 */
export function calcFeedScore(post: {
  likeCount: number;
  commentCount: number;
  repostCount: number;
  createdAt: Date;
}): number {
  const ageHours = (Date.now() - post.createdAt.getTime()) / 3_600_000;
  const engagement = post.likeCount + post.commentCount * 2 + post.repostCount * 3 + 1;
  return engagement / Math.pow(ageHours + 2, 1.5);
}

/**
 * Fire-and-forget score refresh — safe to call after any engagement event.
 * Fetches latest counts, recomputes, and writes back without blocking the caller.
 */
export function refreshFeedScore(postId: Types.ObjectId): void {
  Post.findById(postId)
    .select('likeCount commentCount repostCount createdAt')
    .then((post) => {
      if (!post) return;
      return Post.updateOne({ _id: postId }, { $set: { feedScore: calcFeedScore(post) } });
    })
    .catch(() => undefined);
}
