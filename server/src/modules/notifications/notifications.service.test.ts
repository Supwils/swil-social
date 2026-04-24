import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { Notification } from '../../models/notification.model';
import type { UserDocument } from '../../models/user.model';
import * as realtime from '../../realtime/io';
import type { NotificationDocument } from '../../models/notification.model';
import { buildUpdatedCursorPage, markRead } from './notifications.service';
import { decodeCursor } from '../../lib/pagination';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
  } as UserDocument;
}

describe('buildUpdatedCursorPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the next cursor from updatedAt rather than createdAt', () => {
    const docs = [
      {
        _id: new Types.ObjectId(),
        createdAt: new Date('2026-04-20T00:00:00.000Z'),
        updatedAt: new Date('2026-04-23T10:00:00.000Z'),
      },
      {
        _id: new Types.ObjectId(),
        createdAt: new Date('2026-04-19T00:00:00.000Z'),
        updatedAt: new Date('2026-04-23T09:00:00.000Z'),
      },
    ] as NotificationDocument[];

    const page = buildUpdatedCursorPage(docs, 1);
    const cursor = decodeCursor(page.nextCursor);

    expect(page.items).toHaveLength(1);
    expect(cursor?.t).toBe('2026-04-23T10:00:00.000Z');
    expect(cursor?.id).toBe(docs[0]._id.toString());
  });

  it('marks all notifications read without mutating their ordering timestamp', async () => {
    const viewer = makeUser();
    const updateMany = vi.spyOn(Notification, 'updateMany').mockResolvedValue({ acknowledged: true } as never);
    const emit = vi.spyOn(realtime, 'emitToUser').mockImplementation(() => undefined);

    await markRead(viewer, 'all');

    expect(updateMany).toHaveBeenCalledWith(
      { recipientId: viewer._id, read: false },
      { $set: { read: true, readAt: expect.any(Date) } },
      { timestamps: false },
    );
    expect(emit).toHaveBeenCalledWith(viewer._id, 'notification:read', { ids: 'all' });
  });

  it('marks specific notifications read with timestamps disabled', async () => {
    const viewer = makeUser();
    const ids = [new Types.ObjectId().toString(), new Types.ObjectId().toString()];
    const updateMany = vi.spyOn(Notification, 'updateMany').mockResolvedValue({ acknowledged: true } as never);

    await markRead(viewer, ids);

    expect(updateMany).toHaveBeenCalledWith(
      {
        recipientId: viewer._id,
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        read: false,
      },
      { $set: { read: true, readAt: expect.any(Date) } },
      { timestamps: false },
    );
  });
});
