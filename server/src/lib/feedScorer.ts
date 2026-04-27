import { Types } from 'mongoose';
import { Post } from '../models/post.model';

/**
 * HackerNews-style gravity score.
 *
 * score = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
 *
 * - New posts start ~0.35 and naturally decay.
 * - Engagement slows decay, but gravity wins fast: a 24h-old post needs
 *   ~40+ likes to outrank a fresh zero-engagement post (verified in test).
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

// Pending post IDs waiting for score refresh — deduped and flushed as a single bulkWrite
const _pending = new Set<string>();
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_DELAY_MS = 2_000;

function _flush(): void {
  _flushTimer = null;
  const ids = [..._pending].map((id) => new Types.ObjectId(id));
  _pending.clear();
  Post.find({ _id: { $in: ids } })
    .select('likeCount commentCount repostCount createdAt')
    .lean()
    .then((posts) => {
      if (!posts.length) return;
      const ops = posts.map((p) => ({
        updateOne: {
          filter: { _id: p._id },
          update: { $set: { feedScore: calcFeedScore(p as Parameters<typeof calcFeedScore>[0]) } },
        },
      }));
      return Post.bulkWrite(ops);
    })
    .catch(() => undefined);
}

/**
 * Fire-and-forget score refresh — safe to call after any engagement event.
 * Calls are batched into a single bulkWrite every 2 seconds to reduce DB pressure
 * under concurrent engagement bursts.
 */
export function refreshFeedScore(postId: Types.ObjectId): void {
  _pending.add(postId.toString());
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flush, BATCH_DELAY_MS);
  }
}
