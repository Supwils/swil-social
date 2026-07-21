/**
 * Backfill feedScore for all existing posts that have feedScore === 0.
 *
 *   npx tsx scripts/backfill-feed-scores.ts
 *
 * Safe to re-run — only processes posts where feedScore == 0.
 * Processes in batches to avoid memory spikes.
 */
import 'dotenv/config';
import { and, eq, gt, asc, inArray } from 'drizzle-orm';
import { db, connectDb, disconnectDb } from '../src/db/client';
import { posts } from '../src/db/schema';
import { calcFeedScore } from '../src/lib/feedScorer';

const BATCH = 500;

async function run(): Promise<void> {
  await connectDb();

  let processed = 0;
  let lastId: string | null = null;

  for (;;) {
    const conds = [eq(posts.status, 'active'), eq(posts.feedScore, 0)];
    if (lastId) conds.push(gt(posts.id, lastId));

    const rows = await db
      .select({
        id: posts.id,
        likeCount: posts.likeCount,
        commentCount: posts.commentCount,
        repostCount: posts.repostCount,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(and(...conds))
      .orderBy(asc(posts.id))
      .limit(BATCH);

    if (rows.length === 0) break;

    await Promise.all(
      rows.map((p) =>
        db.update(posts).set({ feedScore: calcFeedScore(p) }).where(inArray(posts.id, [p.id])),
      ),
    );
    processed += rows.length;
    lastId = rows[rows.length - 1].id;
    // eslint-disable-next-line no-console
    console.log(`  processed ${processed}`);
  }

  // eslint-disable-next-line no-console
  console.log(`Done — ${processed} posts updated.`);
  await disconnectDb();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
