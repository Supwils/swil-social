import { Types } from 'mongoose';
import { Tag, type TagDocument } from '../../models/tag.model';

export async function upsertTagsForPost(
  tags: Array<{ slug: string; display: string }>,
): Promise<TagDocument[]> {
  if (tags.length === 0) return [];
  const ops = tags.map((t) => ({
    updateOne: {
      filter: { slug: t.slug },
      update: { $setOnInsert: { slug: t.slug, display: t.display } },
      upsert: true,
    },
  }));
  await Tag.bulkWrite(ops);
  return Tag.find({ slug: { $in: tags.map((t) => t.slug) } });
}

export async function syncTagCounts(
  previousTagIds: string[],
  nextTagIds: string[],
): Promise<void> {
  const previous = new Set(previousTagIds);
  const next = new Set(nextTagIds);

  const added = nextTagIds.filter((id) => !previous.has(id));
  const removed = previousTagIds.filter((id) => !next.has(id));

  await Promise.all([
    added.length
      ? Tag.updateMany(
          { _id: { $in: added.map((id) => new Types.ObjectId(id)) } },
          { $inc: { postCount: 1 }, $set: { lastUsedAt: new Date() } },
        )
      : Promise.resolve(null),
    removed.length
      ? Tag.updateMany(
          { _id: { $in: removed.map((id) => new Types.ObjectId(id)) } },
          { $inc: { postCount: -1 } },
        )
      : Promise.resolve(null),
  ]);
}
