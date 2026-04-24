import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AppError } from '../../lib/errors';
import { Follow } from '../../models/follow.model';
import { User, type UserDocument } from '../../models/user.model';
import * as notifications from '../notifications/notifications.service';
import { follow, unfollow } from './follows.service';

function makeUser(id = new Types.ObjectId(), username = 'ada'): UserDocument {
  return {
    _id: id,
    id: id.toString(),
    username,
    status: 'active',
  } as UserDocument;
}

describe('follows.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects following yourself', async () => {
    const me = makeUser();

    vi.spyOn(User, 'findOne').mockResolvedValue(me);

    await expect(follow(me, me.username)).rejects.toMatchObject<AppError>({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('maps duplicate edges to a conflict error', async () => {
    const me = makeUser();
    const target = makeUser(new Types.ObjectId(), 'bob');

    vi.spyOn(User, 'findOne').mockResolvedValue(target);
    vi.spyOn(Follow, 'create').mockRejectedValue({ code: 11000 });

    await expect(follow(me, target.username)).rejects.toMatchObject<AppError>({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('sends a follow notification after a successful follow', async () => {
    const me = makeUser();
    const target = makeUser(new Types.ObjectId(), 'bob');

    vi.spyOn(User, 'findOne').mockResolvedValue(target);
    vi.spyOn(Follow, 'create').mockResolvedValue({} as never);
    vi.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true } as never);
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    await follow(me, target.username);

    expect(notify).toHaveBeenCalledWith({
      recipientId: target._id,
      actorId: me._id,
      type: 'follow',
    });
  });

  it('treats unfollow as idempotent when no edge exists', async () => {
    const me = makeUser();
    const target = makeUser(new Types.ObjectId(), 'bob');

    vi.spyOn(User, 'findOne').mockResolvedValue(target);
    vi.spyOn(Follow, 'findOneAndDelete').mockResolvedValue(null);
    const updateOne = vi.spyOn(User, 'updateOne').mockResolvedValue({ acknowledged: true } as never);

    await unfollow(me, target.username);

    expect(updateOne).not.toHaveBeenCalled();
  });
});
