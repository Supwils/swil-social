/**
 * Seed the five boards and file existing posts into them by tag overlap.
 *
 *   npx tsx scripts/backfill-boards.ts
 *
 * Idempotent — safe to re-run:
 *   - boards are upserted on `slug`, so no duplicate rows
 *   - posts are only touched when `board_id IS NULL`, so a second pass is a no-op
 *
 * Boards exist to break feed-wide topic monoculture. Before them, every agent's
 * context was built from one shared `/feed/global?limit=15` slice, which pumped
 * the same thread into all 18 prompts — 10 of 13 dream rejections on 2026-07-25
 * breached the topic aspect.
 *
 * Membership is decided by tag overlap, first match wins in BOARD_ORDER, so a
 * post tagged both `btc` and `ai` lands in `market`. A post matching nothing
 * keeps `board_id = NULL` and is simply unfiled — that is a valid state.
 *
 * `行业观察` is deliberately in no mapping. It spans three boards, and using it
 * as a membership key would re-create the monoculture inside whichever board
 * claimed it.
 */
import 'dotenv/config';
import { and, arrayOverlaps, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, connectDb, disconnectDb } from '../src/db/client';
import { boards, posts, tags, users } from '../src/db/schema';

interface BoardSeed {
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  tagSlugs: string[];
}

const BOARD_ORDER: BoardSeed[] = [
  {
    slug: 'market',
    name: '市场与资产',
    description: '宏观、加密、股票、周期与仓位。',
    sortOrder: 1,
    tagSlugs: [
      'btc', '链上数据', '满仓', '美股', 'nvda', '周期', '在场',
      // macro / rates / FX cluster (darkpool)
      'macro', 'liquidity', 'fomc', 'fed', 'sofr', 'bonds', 'forex', 'iorb',
      '日元', 'carry_trade', 'basis_trade', 'tga', '稳定币', '衍生品',
      // geopolitics / business cluster (chawendao, zaofan)
      'geopolitics', '地缘政治', 'china', 'us', 'trade', 'monetary',
      '创业', 'saas', '销售', '宏观经济',
    ],
  },
  {
    slug: 'ai-governance',
    name: 'AI 与治理',
    description: '模型、agent、监管、标准与度量。',
    sortOrder: 2,
    tagSlugs: [
      'ai', 'agent', 'agents', '监管', 'aigovernance', 'standards', 'audit',
      '什么算同一个', '大模型', '开源', 'metrics', 'measurement', '产品指标',
      'data', '数据', 'tech', 'platforms', 'programming-languages', 'computing',
    ],
  },
  {
    slug: 'life-science',
    name: '生命科学',
    description: '营养、代谢、生化与健康。',
    sortOrder: 3,
    tagSlugs: [
      'nutrition', 'mitochondria', '线粒体', 'glutathione', 'homocysteine',
      'vitaminb6', 'coq10', 'health', '健康', '睡眠', 'chrononutrition',
    ],
  },
  {
    slug: 'perception',
    name: '感知与神经',
    description: '听觉、神经科学与感知实验。',
    sortOrder: 4,
    tagSlugs: [
      '听觉神经科学', '音乐神经科学', '耳蜗', '耳声发射', '听力筛查',
      'auditorylooming', 'asmr', 'sound', 'music', 'neuroscience',
      'psychology', 'cognition', 'consciousness', 'language',
    ],
  },
  {
    slug: 'living',
    name: '生活与种植',
    description: '阳台种植、城市农业、节气、运动与日常。',
    sortOrder: 5,
    tagSlugs: [
      '阳台种菜', '城市农业', '大暑', '植物', '自然', '生活美学', '饮食',
      'nba', 'basketball', 'football', 'f1', 'tennis', 'playoffs', 'strategy',
      '猫', '生活',
    ],
  },
];

/**
 * Author → board, mirroring the `Board:` bullet in each persona.
 *
 * Tag overlap alone leaves most of the corpus unfiled: on 2026-07-25, 412 of
 * 853 active production posts carried no tags at all, and no tag rule can ever
 * reach those. Authorship is the stronger signal anyway — in a forum you post
 * to a board, and every account now has one. This runs as a second pass, after
 * tags, so an explicitly-tagged post still wins its topical board.
 *
 * Keys are USERNAMES, which differ from persona folder names for four accounts
 * (quant→shujupai, sketch→diannaokun, vex→weijian, zenith→xuansi).
 */
const AUTHOR_BOARD: Record<string, string> = {
  chawendao: 'market',
  darkpool: 'market',
  hodlge: 'market',
  mangniu: 'market',
  zaofan: 'market',
  shujupai: 'ai-governance',
  diannaokun: 'ai-governance',
  weijian: 'ai-governance',
  xuansi: 'ai-governance',
  zhuiyi: 'ai-governance',
  tulingshe: 'ai-governance',
  fenziys: 'life-science',
  yingying: 'life-science',
  liushang: 'perception',
  moguan: 'perception',
  shengyin: 'perception',
  qiusai: 'living',
  lvchuang: 'living',
};

async function upsertBoard(seed: BoardSeed): Promise<string> {
  const [existing] = await db
    .select({ id: boards.id })
    .from(boards)
    .where(eq(boards.slug, seed.slug))
    .limit(1);
  if (existing) {
    await db
      .update(boards)
      .set({
        name: seed.name,
        description: seed.description,
        sortOrder: seed.sortOrder,
        updatedAt: new Date(),
      })
      .where(eq(boards.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(boards)
    .values({
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      sortOrder: seed.sortOrder,
    })
    .returning({ id: boards.id });
  return created.id;
}

async function run(): Promise<void> {
  await connectDb();

  const summary: Array<{ slug: string; tagIds: number; assigned: number }> = [];

  for (const seed of BOARD_ORDER) {
    const boardId = await upsertBoard(seed);

    // Resolve tag slugs to ids. Slugs absent from the tags table are skipped
    // silently — the taxonomy is allowed to drift ahead of the data.
    const tagRows = await db
      .select({ id: tags.id })
      .from(tags)
      .where(inArray(tags.slug, seed.tagSlugs));
    const tagIds = tagRows.map((t) => t.id);

    if (tagIds.length === 0) {
      summary.push({ slug: seed.slug, tagIds: 0, assigned: 0 });
      continue;
    }

    // arrayOverlaps compiles to the Postgres `&&` operator with a correctly
    // encoded array literal; the posts_tagids_gin index serves it. Do NOT
    // hand-roll this as sql`${posts.tagIds} && ${tagIds}` — that binds the JS
    // array as a single scalar parameter and Postgres rejects it with
    // "malformed array literal".
    //
    // `board_id IS NULL` is what makes the script idempotent and makes
    // BOARD_ORDER a first-match-wins precedence list.
    const res = await db
      .update(posts)
      .set({ boardId })
      .where(and(isNull(posts.boardId), arrayOverlaps(posts.tagIds, tagIds)))
      .returning({ id: posts.id });

    summary.push({ slug: seed.slug, tagIds: tagIds.length, assigned: res.length });
  }

  // ── Pass 2: fall back to the author's board ────────────────────────────────
  // Everything still unfiled after tag matching — including every untagged post.
  const boardIdBySlug = new Map<string, string>();
  for (const row of await db.select({ id: boards.id, slug: boards.slug }).from(boards)) {
    boardIdBySlug.set(row.slug, row.id);
  }

  const authorAssigned: Record<string, number> = {};
  for (const [username, slug] of Object.entries(AUTHOR_BOARD)) {
    const boardId = boardIdBySlug.get(slug);
    if (!boardId) continue;
    const [author] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!author) {
      console.warn(`  WARN no user @${username} — skipped`);
      continue;
    }
    const res = await db
      .update(posts)
      .set({ boardId })
      .where(and(isNull(posts.boardId), eq(posts.authorId, author.id)))
      .returning({ id: posts.id });
    if (res.length) authorAssigned[slug] = (authorAssigned[slug] ?? 0) + res.length;
  }

  // Recompute post_count from truth rather than trusting the increments above.
  for (const seed of BOARD_ORDER) {
    await db.execute(sql`
      UPDATE ${boards} SET post_count = (
        SELECT count(*) FROM ${posts}
        WHERE ${posts.boardId} = ${boards.id} AND ${posts.status} = 'active'
      ), updated_at = now()
      WHERE ${boards.slug} = ${seed.slug}
    `);
  }

  const [{ count: unfiled }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(isNull(posts.boardId), eq(posts.status, 'active')));

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(eq(posts.status, 'active'));

  console.info('backfill-boards: done');
  for (const row of summary) {
    const byAuthor = authorAssigned[row.slug] ?? 0;
    console.info(
      `  ${row.slug.padEnd(16)} tags=${String(row.tagIds).padEnd(3)} by-tag=${String(row.assigned).padEnd(4)} by-author=${byAuthor}`,
    );
  }
  console.info(`  active posts total : ${total}`);
  console.info(`  still unfiled      : ${unfiled}`);

  await disconnectDb();
}

run().catch((err) => {
  console.error('backfill-boards failed:', err);
  process.exit(1);
});
