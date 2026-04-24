import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { Message } from '../../models/message.model';
import { Conversation } from '../../models/conversation.model';
import { User, type UserDocument } from '../../models/user.model';
import type { ConversationDocument } from '../../models/conversation.model';
import * as notifications from '../notifications/notifications.service';
import * as realtime from '../../realtime/io';
import { findOrCreateWith, markRead, send, unreadCount } from './messages.service';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
    username: 'user',
    status: 'active',
  } as UserDocument;
}

function leanable<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

describe('messages.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the raced conversation when create hits the unique key', async () => {
    const me = makeUser();
    const recipient = makeUser();
    recipient.username = 'bob';

    const existing = {
      _id: new Types.ObjectId(),
      participantIds: [me._id, recipient._id],
      participantKey: 'shared-key',
      lastMessageAt: new Date(),
      unreadBy: [],
    } as ConversationDocument;

    vi.spyOn(User, 'findOne').mockResolvedValue(recipient);
    vi.spyOn(Conversation, 'findOne')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    vi.spyOn(Conversation, 'create').mockRejectedValue({ code: 11000 });

    const out = await findOrCreateWith(me, recipient.username);

    expect(out).toEqual({ conversation: existing, created: false });
  });

  it('counts unread conversations for a viewer', async () => {
    const me = makeUser();
    const countDocs = vi.spyOn(Conversation, 'countDocuments').mockResolvedValue(3);

    const count = await unreadCount(me);

    expect(count).toBe(3);
    expect(countDocs).toHaveBeenCalledWith({
      participantIds: me._id,
      unreadBy: me._id,
    });
  });

  it('sends a message, updates unread state, and emits realtime events', async () => {
    const me = makeUser();
    const recipient = makeUser(new Types.ObjectId());
    const convo = {
      _id: new Types.ObjectId(),
      participantIds: [me._id, recipient._id],
      unreadBy: [],
    } as ConversationDocument;
    const message = {
      _id: new Types.ObjectId(),
      conversationId: convo._id,
      senderId: me._id,
      text: 'hello',
      readBy: [me._id],
      createdAt: new Date('2026-04-23T18:30:00.000Z'),
    };

    vi.spyOn(Conversation, 'findById').mockReturnValue(leanable(convo) as never);
    vi.spyOn(Message, 'create').mockResolvedValue(message as never);
    const updateOne = vi.spyOn(Conversation, 'updateOne').mockResolvedValue({ acknowledged: true } as never);
    const emitToConversation = vi.spyOn(realtime, 'emitToConversation').mockImplementation(() => undefined);
    const emitToUser = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await send(me, convo._id.toString(), 'hello');

    expect(updateOne).toHaveBeenCalledWith(
      { _id: convo._id },
      {
        $set: { lastMessageId: message._id, lastMessageAt: message.createdAt },
        $addToSet: { unreadBy: { $each: [recipient._id] } },
      },
    );
    expect(emitToConversation).toHaveBeenCalledWith(convo._id.toString(), 'message', out);
    expect(emitToUser).toHaveBeenCalledWith(recipient._id, 'conversation:update', {
      conversationId: convo._id.toString(),
    });
    expect(notify).toHaveBeenCalledWith({
      recipientId: recipient._id,
      actorId: me._id,
      type: 'message',
      messageId: message._id,
      conversationId: convo._id,
    });
  });

  it('marks a conversation read and emits the read receipt event', async () => {
    const me = makeUser();
    const convo = {
      _id: new Types.ObjectId(),
      participantIds: [me._id, new Types.ObjectId()],
      unreadBy: [me._id],
    } as ConversationDocument;

    vi.spyOn(Conversation, 'findById').mockReturnValue(leanable(convo) as never);
    const updateOne = vi.spyOn(Conversation, 'updateOne').mockResolvedValue({ acknowledged: true } as never);
    const updateMany = vi.spyOn(Message, 'updateMany').mockResolvedValue({ acknowledged: true } as never);
    const emit = vi.spyOn(realtime, 'emitToConversation').mockImplementation(() => undefined);

    await markRead(me, convo._id.toString());

    expect(updateOne).toHaveBeenCalledWith({ _id: convo._id }, { $pull: { unreadBy: me._id } });
    expect(updateMany).toHaveBeenCalledWith(
      {
        conversationId: convo._id,
        readBy: { $ne: me._id },
      },
      { $addToSet: { readBy: me._id } },
    );
    expect(emit).toHaveBeenCalledWith(convo._id.toString(), 'message:read', {
      conversationId: convo._id.toString(),
      userId: me.id,
      at: expect.any(String),
    });
  });
});
