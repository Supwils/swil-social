import { Types } from 'mongoose';
import { Post, type PostDocument } from '../../models/post.model';
import { User, type UserDocument } from '../../models/user.model';
import { Tag, type TagDocument } from '../../models/tag.model';
import { Like } from '../../models/like.model';
import { Bookmark } from '../../models/bookmark.model';
import { toPostDTO, type PostDTOContext, type PostDTO } from '../../lib/dto';

/**
 * Hydrate a list of posts to their DTO contexts in a single round-trip per
 * relation. Avoids N+1 on feed endpoints. Echo-of originals are also batch-
 * loaded (one extra round-trip covers all echoes in the page).
 */
export async function hydratePosts(
  posts: PostDocument[],
  viewer: UserDocument | null,
): Promise<Map<string, PostDTOContext>> {
  const authorIds = new Set<string>();
  const tagIds = new Set<string>();
  const mentionIds = new Set<string>();
  for (const p of posts) {
    authorIds.add(p.authorId.toString());
    p.tagIds.forEach((t) => tagIds.add(t.toString()));
    p.mentionIds.forEach((m) => mentionIds.add(m.toString()));
  }

  const [authors, tags, mentions, likes, bookmarks] = (await Promise.all([
    User.find({ _id: { $in: Array.from(authorIds).map((id) => new Types.ObjectId(id)) } }).lean(),
    tagIds.size
      ? Tag.find({ _id: { $in: Array.from(tagIds).map((id) => new Types.ObjectId(id)) } }).lean()
      : Promise.resolve([] as TagDocument[]),
    mentionIds.size
      ? User.find({ _id: { $in: Array.from(mentionIds).map((id) => new Types.ObjectId(id)) } }).lean()
      : Promise.resolve([] as UserDocument[]),
    viewer && posts.length
      ? Like.find({
          userId: viewer._id,
          targetType: 'post',
          targetId: { $in: posts.map((p) => p._id) },
        }).select('targetId').lean()
      : Promise.resolve([] as Array<{ _id: Types.ObjectId; targetId: Types.ObjectId }>),
    viewer && posts.length
      ? Bookmark.find({
          userId: viewer._id,
          postId: { $in: posts.map((p) => p._id) },
        }).select('postId').lean()
      : Promise.resolve([] as Array<{ _id: Types.ObjectId; postId: Types.ObjectId }>),
  ])) as unknown as [
    UserDocument[],
    TagDocument[],
    UserDocument[],
    Array<{ _id: Types.ObjectId; targetId: Types.ObjectId }>,
    Array<{ _id: Types.ObjectId; postId: Types.ObjectId }>,
  ];

  const authorById = new Map(authors.map((u) => [u._id.toString(), u]));
  const tagById = new Map(tags.map((t) => [t._id.toString(), t]));
  const mentionById = new Map(mentions.map((u) => [u._id.toString(), u]));
  const likedSet = new Set(likes.map((l) => l.targetId.toString()));
  const bookmarkedSet = new Set(bookmarks.map((b) => b.postId.toString()));

  // Batch-load echoOf original posts
  const echoOfIds = posts
    .filter((p) => p.echoOf)
    .map((p) => p.echoOf as Types.ObjectId);

  const echoOfDtoById = new Map<string, PostDTO>();

  if (echoOfIds.length) {
    const origPosts = (await Post.find({
      _id: { $in: echoOfIds },
      status: { $in: ['active', 'deleted'] },
    }).lean()) as unknown as PostDocument[];

    const origAuthorIdSet = new Set(origPosts.map((p) => p.authorId.toString()));
    const origAuthors = (await User.find({
      _id: { $in: Array.from(origAuthorIdSet).map((id) => new Types.ObjectId(id)) },
    }).lean()) as unknown as UserDocument[];
    const origAuthorById = new Map(origAuthors.map((u) => [u._id.toString(), u]));

    for (const orig of origPosts) {
      const origAuthor = origAuthorById.get(orig.authorId.toString());
      if (!origAuthor) continue;
      echoOfDtoById.set(
        orig._id.toString(),
        toPostDTO(orig, { author: origAuthor, tags: [], mentions: [], likedByMe: false }),
      );
    }
  }

  const out = new Map<string, PostDTOContext>();
  for (const p of posts) {
    const author = authorById.get(p.authorId.toString());
    if (!author) continue;
    out.set(p._id.toString(), {
      author,
      tags: p.tagIds.map((t) => tagById.get(t.toString())).filter((x): x is TagDocument => !!x),
      mentions: p.mentionIds
        .map((m) => mentionById.get(m.toString()))
        .filter((x): x is UserDocument => !!x),
      likedByMe: likedSet.has(p._id.toString()),
      bookmarkedByMe: bookmarkedSet.has(p._id.toString()),
      echoOf: p.echoOf ? echoOfDtoById.get(p.echoOf.toString()) : undefined,
    });
  }
  return out;
}
