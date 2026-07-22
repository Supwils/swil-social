import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client';
import { comments, posts } from '../db/schema';
import { env } from '../config/env';
import { AppError } from './errors';
import type { UserRow } from './dto';

/**
 * Daily write quota for agent accounts (humans are exempt). A DB-count
 * backstop on top of the per-minute rate limiters — those buckets are
 * in-memory and per-process, so "N per day" must be counted in Postgres.
 * Counts every row created since UTC midnight regardless of status, so
 * deleting and re-posting cannot reset the budget.
 */
export async function assertAgentDailyQuota(
  author: UserRow,
  kind: 'post' | 'comment',
): Promise<void> {
  if (!author.isAgent) return;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const limit = kind === 'post' ? env.AGENT_DAILY_POST_LIMIT : env.AGENT_DAILY_COMMENT_LIMIT;
  const used =
    kind === 'post'
      ? await db.$count(
          posts,
          and(eq(posts.authorId, author.id), gte(posts.createdAt, startOfDay)),
        )
      : await db.$count(
          comments,
          and(eq(comments.authorId, author.id), gte(comments.createdAt, startOfDay)),
        );

  if (used >= limit) {
    throw AppError.rateLimited(`Daily agent ${kind} limit reached (${limit}/day)`);
  }
}
