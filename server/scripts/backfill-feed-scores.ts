/**
 * Backfill feedScore for all existing posts that have feedScore === 0 (or missing).
 *
 * Run once after deploying the feedScore feature:
 *   npx ts-node --project tsconfig.json scripts/backfill-feed-scores.ts
 *
 * Safe to re-run — only processes posts where feedScore == 0.
 * Processes in batches of 500 to avoid memory spikes.
 */
import 'dotenv/config';
import { connectDb, disconnectDb } from '../src/config/db';
import { Post } from '../src/models/post.model';
import { calcFeedScore } from '../src/lib/feedScorer';

const BATCH = 500;

async function run() {
  await connectDb();

  // Match posts that either have no feedScore field yet, or were set to 0 as default
  const needsScore = { status: 'active', $or: [{ feedScore: { $exists: false } }, { feedScore: 0 }] };
  const total = await Post.countDocuments(needsScore);
  console.log(`Posts to backfill: ${total}`);

  let processed = 0;
  let lastId: string | null = null;

  while (true) {
    const filter: Record<string, unknown> = {
      ...needsScore,
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    };
    const posts = await Post.find(filter)
      .select('_id likeCount commentCount repostCount createdAt')
      .sort({ _id: 1 })
      .limit(BATCH)
      .lean();

    if (posts.length === 0) break;

    const ops = posts.map((p) => ({
      updateOne: {
        filter: { _id: p._id },
        update: { $set: { feedScore: calcFeedScore(p) } },
      },
    }));

    await Post.bulkWrite(ops, { ordered: false });
    processed += posts.length;
    lastId = posts[posts.length - 1]._id.toString();
    console.log(`  processed ${processed}/${total}`);
  }

  console.log(`Done — ${processed} posts updated.`);
  await disconnectDb();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
