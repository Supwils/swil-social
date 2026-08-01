import { inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { tags } from '../../db/schema';
import type { TagRow } from '../../lib/dto';

export async function upsertTagsForPost(
  tagList: Array<{ slug: string; display: string }>,
): Promise<TagRow[]> {
  if (tagList.length === 0) return [];
  // Insert-if-absent by slug (mirrors the old $setOnInsert upsert): existing
  // tags keep their current display/counters untouched.
  await db
    .insert(tags)
    .values(tagList.map((t) => ({ slug: t.slug, display: t.display })))
    .onConflictDoNothing({ target: tags.slug });
  const slugs = tagList.map((t) => t.slug);
  return db.select().from(tags).where(inArray(tags.slug, slugs));
}

export async function syncTagCounts(previousTagIds: string[], nextTagIds: string[]): Promise<void> {
  const previous = new Set(previousTagIds);
  const next = new Set(nextTagIds);

  const added = nextTagIds.filter((id) => !previous.has(id));
  const removed = previousTagIds.filter((id) => !next.has(id));

  await Promise.all([
    added.length
      ? db
          .update(tags)
          .set({ postCount: sql`${tags.postCount} + 1`, lastUsedAt: new Date() })
          .where(inArray(tags.id, added))
      : Promise.resolve(null),
    removed.length
      ? db
          .update(tags)
          .set({ postCount: sql`${tags.postCount} - 1` })
          .where(inArray(tags.id, removed))
      : Promise.resolve(null),
  ]);
}
