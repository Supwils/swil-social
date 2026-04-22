import { Types } from 'mongoose';
import {
  Conversation,
  type ConversationDocument,
  computeParticipantKey,
} from '../../models/conversation.model';
import { Message, type MessageDocument } from '../../models/message.model';
import { User, type UserDocument } from '../../models/user.model';
import { AppError } from '../../lib/errors';
import {
  type Cursor,
  cursorFilterDesc,
  buildNextCursor,
} from '../../lib/pagination';
import {
  toMessageDTO,
  toConversationDTO,
  type ConversationDTO,
  type MessageDTO,
} from '../../lib/dto';
import { emitToUser, emitToConversation, conversationRoom } from '../../realtime/io';
import { createNotification } from '../notifications/notifications.service';

/* ---------- conversations ---------- */

export async function findOrCreateWith(
  me: UserDocument,
  recipientUsername: string,
): Promise<{ conversation: ConversationDocument; created: boolean }> {
  const recipient = await User.findOne({
    username: recipientUsername.toLowerCase(),
    status: 'active',
  });
  if (!recipient) throw AppError.notFound('User not found');
  if (recipient._id.equals(me._id)) {
    throw AppError.validation('Cannot message yourself');
  }

  const participantIds = [me._id, recipient._id];
  const key = computeParticipantKey(participantIds);

  const existing = await Conversation.findOne({ participantKey: key });
  if (existing) return { conversation: existing, created: false };

  const convo = await Conversation.create({
    participantIds,
    participantKey: key,
    lastMessageAt: new Date(),
  });
  return { conversation: convo, created: true };
}

export async function listForViewer(
  viewer: UserDocument,
  cursor: Cursor | null,
  limit: number,
): Promise<{ items: ConversationDTO[]; nextCursor: string | null }> {
  const docs = await Conversation.find({
    participantIds: viewer._id,
    ...cursorFilterDesc(cursor, 'lastMessageAt'),
  })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(limit + 1);

  // buildNextCursor uses createdAt; we sort by lastMessageAt so compute cursors from that field.
  const pageSlice = docs.length > limit ? docs.slice(0, limit) : docs;
  const hasMore = docs.length > limit;

  const participantIds = new Set<string>();
  const lastMessageIds = new Set<string>();
  for (const c of pageSlice) {
    for (const id of c.participantIds) participantIds.add(id.toString());
    if (c.lastMessageId) lastMessageIds.add(c.lastMessageId.toString());
  }

  const [users, messages] = await Promise.all([
    User.find({
      _id: { $in: Array.from(participantIds).map((id) => new Types.ObjectId(id)) },
    }),
    lastMessageIds.size
      ? Message.find({
          _id: { $in: Array.from(lastMessageIds).map((id) => new Types.ObjectId(id)) },
        })
      : Promise.resolve([] as MessageDocument[]),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const msgById = new Map(messages.map((m) => [m.id, m]));

  const items: ConversationDTO[] = pageSlice.map((c) => {
    const people = c.participantIds
      .map((pid) => userById.get(pid.toString()))
      .filter((x): x is UserDocument => Boolean(x));
    let lastMessage: MessageDTO | null = null;
    if (c.lastMessageId) {
      const m = msgById.get(c.lastMessageId.toString());
      if (m) {
        const sender = userById.get(m.senderId.toString());
        if (sender) lastMessage = toMessageDTO(m, sender);
      }
    }
    return toConversationDTO(c, people, viewer.id, lastMessage);
  });

  const nextCursor = hasMore && pageSlice.length > 0
    ? encodeLastMessageCursor(pageSlice[pageSlice.length - 1])
    : null;

  return { items, nextCursor };
}

function encodeLastMessageCursor(c: ConversationDocument): string {
  return Buffer.from(
    JSON.stringify({ t: c.lastMessageAt.toISOString(), id: c.id }),
    'utf8',
  ).toString('base64url');
}

/* ---------- messages ---------- */

export async function listMessages(
  viewer: UserDocument,
  conversationId: string,
  cursor: Cursor | null,
  limit: number,
): Promise<{ items: MessageDTO[]; nextCursor: string | null }> {
  const convo = await assertMember(viewer, conversationId);

  const filter = {
    conversationId: convo._id,
    deletedFor: { $ne: viewer._id },
    ...cursorFilterDesc(cursor),
  };
  const docs = await Message.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);
  const { items, nextCursor } = buildNextCursor(docs, limit);

  const senderIds = Array.from(new Set(items.map((m) => m.senderId.toString())));
  const senders = await User.find({
    _id: { $in: senderIds.map((id) => new Types.ObjectId(id)) },
  });
  const byId = new Map(senders.map((u) => [u.id, u]));

  const hydrated: MessageDTO[] = items
    .map((m) => {
      const s = byId.get(m.senderId.toString());
      return s ? toMessageDTO(m, s) : null;
    })
    .filter((x): x is MessageDTO => x !== null);

  return { items: hydrated, nextCursor };
}

export async function send(
  sender: UserDocument,
  conversationId: string,
  text: string,
): Promise<MessageDTO> {
  const convo = await assertMember(sender, conversationId);

  const message = await Message.create({
    conversationId: convo._id,
    senderId: sender._id,
    text,
    readBy: [sender._id],
  });

  const otherIds = convo.participantIds.filter((id) => !id.equals(sender._id));

  await Conversation.updateOne(
    { _id: convo._id },
    {
      $set: { lastMessageId: message._id, lastMessageAt: message.createdAt },
      $addToSet: { unreadBy: { $each: otherIds } },
    },
  );

  const dto = toMessageDTO(message, sender);
  emitToConversation(convo.id, 'message', dto);
  // Notify each other participant individually (their `user:<id>` room) for
  // inbox badges and toasts when they're not currently in the thread.
  for (const otherId of otherIds) {
    emitToUser(otherId, 'conversation:update', { conversationId: convo.id });
    await createNotification({
      recipientId: otherId,
      actorId: sender._id,
      type: 'message',
      messageId: message._id,
      conversationId: convo._id,
    });
  }
  return dto;
}

export async function markRead(viewer: UserDocument, conversationId: string): Promise<void> {
  const convo = await assertMember(viewer, conversationId);

  await Promise.all([
    Conversation.updateOne({ _id: convo._id }, { $pull: { unreadBy: viewer._id } }),
    Message.updateMany(
      {
        conversationId: convo._id,
        readBy: { $ne: viewer._id },
      },
      { $addToSet: { readBy: viewer._id } },
    ),
  ]);

  emitToConversation(convo.id, 'message:read', {
    conversationId: convo.id,
    userId: viewer.id,
    at: new Date().toISOString(),
  });
}

async function assertMember(
  viewer: UserDocument,
  conversationId: string,
): Promise<ConversationDocument> {
  if (!Types.ObjectId.isValid(conversationId)) throw AppError.notFound('Conversation not found');
  const convo = await Conversation.findById(conversationId);
  if (!convo || !convo.participantIds.some((id) => id.equals(viewer._id))) {
    throw AppError.notFound('Conversation not found');
  }
  // Ensure room exists server-side so future emits land even if client didn't join yet.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  conversationRoom;
  return convo;
}
