import { Types } from 'mongoose';
import {
  Notification,
  type NotificationDocument,
  type NotificationType,
} from '../../models/notification.model';
import { User, type UserDocument } from '../../models/user.model';
import { Post } from '../../models/post.model';
import { Comment } from '../../models/comment.model';
import {
  type Cursor,
  cursorFilterDesc,
  encodeCursor,
} from '../../lib/pagination';
import { emitToUser } from '../../realtime/io';
import { logger } from '../../lib/logger';
import type { NotificationDTO, UserLiteDTO } from '../../lib/dto';
import { toUserLiteDTO } from '../../lib/dto';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CreateInput {
  recipientId: Types.ObjectId;
  actorId: Types.ObjectId;
  type: NotificationType;
  postId?: Types.ObjectId | null;
  commentId?: Types.ObjectId | null;
  messageId?: Types.ObjectId | null;
  conversationId?: Types.ObjectId | null;
}

/**
 * Create a notification with 24h dedup. Within the window, the existing doc
 * matching (recipient, actor, type, target) is bumped forward instead of
 * inserting a new one. Fire-and-forget: never throws — notifications are a
 * nice-to-have that shouldn't block the write they react to.
 */
export async function createNotification(input: CreateInput): Promise<void> {
  if (input.recipientId.equals(input.actorId)) return; // never self-notify

  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const filter = {
    recipientId: input.recipientId,
    actorId: input.actorId,
    type: input.type,
    postId: input.postId ?? null,
    commentId: input.commentId ?? null,
    messageId: input.messageId ?? null,
    conversationId: input.conversationId ?? null,
    createdAt: { $gte: since },
  };

  try {
    const doc = await Notification.findOneAndUpdate(
      filter,
      {
        $set: {
          read: false,
          readAt: null,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          recipientId: input.recipientId,
          actorId: input.actorId,
          type: input.type,
          postId: input.postId ?? null,
          commentId: input.commentId ?? null,
          messageId: input.messageId ?? null,
          conversationId: input.conversationId ?? null,
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (!doc) return;
    const dto = await hydrateOne(doc);
    if (dto) emitToUser(input.recipientId, 'notification', dto);
  } catch (err) {
    logger.error({ err, input }, 'createNotification failed');
  }
}

export async function list(
  viewer: UserDocument,
  cursor: Cursor | null,
  limit: number,
  unreadOnly: boolean,
): Promise<{ items: NotificationDTO[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = {
    recipientId: viewer._id,
    ...cursorFilterDesc(cursor, 'updatedAt'),
  };
  if (unreadOnly) filter.read = false;

  const docs = (await Notification.find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()) as unknown as NotificationDocument[];

  const { items, nextCursor } = buildUpdatedCursorPage(docs, limit);
  const hydrated = await hydrateMany(items);
  return { items: hydrated, nextCursor };
}

export async function unreadCount(viewer: UserDocument): Promise<number> {
  return Notification.countDocuments({ recipientId: viewer._id, read: false });
}

export async function clearAll(viewer: UserDocument): Promise<void> {
  await Notification.deleteMany({ recipientId: viewer._id });
  emitToUser(viewer._id, 'notification:read', { ids: 'all' });
}

export async function markRead(viewer: UserDocument, ids: string[] | 'all'): Promise<void> {
  if (ids === 'all') {
    await Notification.updateMany(
      { recipientId: viewer._id, read: false },
      { $set: { read: true, readAt: new Date() } },
      { timestamps: false },
    );
  } else if (ids.length) {
    await Notification.updateMany(
      {
        recipientId: viewer._id,
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        read: false,
      },
      { $set: { read: true, readAt: new Date() } },
      { timestamps: false },
    );
  }
  emitToUser(viewer._id, 'notification:read', { ids });
}

/* ---------- hydration ---------- */

async function hydrateOne(doc: NotificationDocument): Promise<NotificationDTO | null> {
  const actor = await User.findById(doc.actorId);
  if (!actor) return null;
  const post = doc.postId
    ? await Post.findById(doc.postId).select('text')
    : null;
  const comment = doc.commentId
    ? await Comment.findById(doc.commentId).select('text')
    : null;
  return toNotificationDTO(doc, toUserLiteDTO(actor), post?.text, comment?.text);
}

async function hydrateMany(docs: NotificationDocument[]): Promise<NotificationDTO[]> {
  if (docs.length === 0) return [];

  const actorIds = Array.from(new Set(docs.map((d) => d.actorId.toString())));
  const postIds = Array.from(
    new Set(docs.map((d) => d.postId?.toString()).filter((x): x is string => Boolean(x))),
  );
  const commentIds = Array.from(
    new Set(docs.map((d) => d.commentId?.toString()).filter((x): x is string => Boolean(x))),
  );

  const [actors, posts, comments] = (await Promise.all([
    User.find({ _id: { $in: actorIds.map((id) => new Types.ObjectId(id)) } }).lean(),
    postIds.length
      ? Post.find({ _id: { $in: postIds.map((id) => new Types.ObjectId(id)) } }).select('text').lean()
      : Promise.resolve([]),
    commentIds.length
      ? Comment.find({ _id: { $in: commentIds.map((id) => new Types.ObjectId(id)) } }).select('text').lean()
      : Promise.resolve([]),
  ])) as unknown as [UserDocument[], { _id: Types.ObjectId; text: string }[], { _id: Types.ObjectId; text: string }[]];

  const actorById = new Map<string, UserLiteDTO>(
    actors.map((u) => [u._id.toString(), toUserLiteDTO(u)]),
  );
  const postById = new Map(posts.map((p) => [p._id.toString(), p.text]));
  const commentById = new Map(comments.map((c) => [c._id.toString(), c.text]));

  return docs
    .map((d) => {
      const actor = actorById.get(d.actorId.toString());
      if (!actor) return null;
      return toNotificationDTO(
        d,
        actor,
        d.postId ? postById.get(d.postId.toString()) : undefined,
        d.commentId ? commentById.get(d.commentId.toString()) : undefined,
      );
    })
    .filter((x): x is NotificationDTO => x !== null);
}

function toNotificationDTO(
  doc: NotificationDocument,
  actor: UserLiteDTO,
  postText?: string,
  commentText?: string,
): NotificationDTO {
  return {
    id: doc._id.toString(),
    type: doc.type,
    actor,
    post: doc.postId
      ? { id: doc.postId.toString(), textPreview: preview(postText) }
      : undefined,
    comment: doc.commentId
      ? { id: doc.commentId.toString(), textPreview: preview(commentText) }
      : undefined,
    message: doc.messageId && doc.conversationId
      ? { id: doc.messageId.toString(), conversationId: doc.conversationId.toString() }
      : undefined,
    read: doc.read,
    createdAt: doc.updatedAt.toISOString(),
  };
}

function preview(text: string | undefined): string {
  if (!text) return '';
  return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
}

export function buildUpdatedCursorPage(
  docs: NotificationDocument[],
  limit: number,
): { items: NotificationDocument[]; nextCursor: string | null } {
  if (docs.length <= limit) {
    return { items: docs, nextCursor: null };
  }
  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: encodeCursor({ t: last.updatedAt.toISOString(), id: last._id.toString() }),
  };
}
