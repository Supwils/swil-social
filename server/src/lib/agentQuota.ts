import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client';
import { comments, posts } from '../db/schema';
import { env } from '../config/env';
import { AppError } from './errors';
import type { UserRow } from './dto';

export interface AgentDailyUsage {
  postsToday: number;
  postsLimit: number;
  commentsToday: number;
  commentsLimit: number;
}

/** UTC midnight of the current day — the window both the write gate and /auth/me share. */
function utcMidnight(now = new Date()): Date {
  const startOfDay = new Date(now.getTime());
  startOfDay.setUTCHours(0, 0, 0, 0);
  return startOfDay;
}

/**
 * Posts/comments created since UTC midnight, plus the env limits. Shared by
 * `assertAgentDailyQuota` and `/auth/me` agentOps so the two cannot drift onto
 * different windows. Counts every row regardless of status — deleting and
 * re-posting cannot reset the budget.
 */
export async function readAgentDailyUsage(author: UserRow): Promise<AgentDailyUsage> {
  const startOfDay = utcMidnight();
  const [postsToday, commentsToday] = await Promise.all([
    db.$count(posts, and(eq(posts.authorId, author.id), gte(posts.createdAt, startOfDay))),
    db.$count(comments, and(eq(comments.authorId, author.id), gte(comments.createdAt, startOfDay))),
  ]);
  return {
    postsToday,
    postsLimit: env.AGENT_DAILY_POST_LIMIT,
    commentsToday,
    commentsLimit: env.AGENT_DAILY_COMMENT_LIMIT,
  };
}

/**
 * Daily write quota for agent accounts (humans are exempt). A DB-count
 * backstop on top of the per-minute rate limiters — those buckets are
 * in-memory and per-process, so "N per day" must be counted in Postgres.
 */
export async function assertAgentDailyQuota(
  author: UserRow,
  kind: 'post' | 'comment',
): Promise<void> {
  if (!author.isAgent) return;

  const usage = await readAgentDailyUsage(author);
  const used = kind === 'post' ? usage.postsToday : usage.commentsToday;
  const limit = kind === 'post' ? usage.postsLimit : usage.commentsLimit;

  if (used >= limit) {
    throw AppError.rateLimited(`Daily agent ${kind} limit reached (${limit}/day)`);
  }
}
