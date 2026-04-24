import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { Comment } from '../../models/comment.model';
import { Like } from '../../models/like.model';
import { Post } from '../../models/post.model';
import type { UserDocument } from '../../models/user.model';
import * as notifications from '../notifications/notifications.service';
import { like, unlike } from './likes.service';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
  } as UserDocument;
}

function selectable<T>(value: T) {
  return {
    select: vi.fn().mockResolvedValue(value),
  };
}

describe('likes.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the existing count when a like races with a duplicate insert', async () => {
    const actor = makeUser();
    const targetId = new Types.ObjectId();

    vi.spyOn(Post, 'findOne').mockReturnValue(selectable({ _id: targetId }) as never);
    vi.spyOn(Like, 'create').mockRejectedValue({ code: 11000 });
    vi.spyOn(Post, 'findById').mockReturnValue(selectable({ likeCount: 4 }) as never);

    const out = await like(actor, 'post', targetId.toString());

    expect(out).toEqual({ likeCount: 4, liked: true });
  });

  it('notifies the target owner after a successful post like', async () => {
    const actor = makeUser();
    const ownerId = new Types.ObjectId();
    const targetId = new Types.ObjectId();

    vi.spyOn(Post, 'findOne').mockReturnValue(selectable({ _id: targetId }) as never);
    vi.spyOn(Like, 'create').mockResolvedValue({} as never);
    vi.spyOn(Post, 'findByIdAndUpdate').mockReturnValue(selectable({ likeCount: 1 }) as never);
    vi.spyOn(Post, 'findById').mockReturnValue(selectable({ _id: targetId, authorId: ownerId }) as never);
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await like(actor, 'post', targetId.toString());

    expect(out).toEqual({ likeCount: 1, liked: true });
    expect(notify).toHaveBeenCalledWith({
      recipientId: ownerId,
      actorId: actor._id,
      type: 'like',
      postId: targetId,
    });
  });

  it('treats unlike as idempotent when the edge is already gone', async () => {
    const actor = makeUser();
    const targetId = new Types.ObjectId();

    vi.spyOn(Like, 'findOneAndDelete').mockResolvedValue(null);
    vi.spyOn(Post, 'findById').mockReturnValue(selectable({ likeCount: 2 }) as never);

    const out = await unlike(actor, 'post', targetId.toString());

    expect(out).toEqual({ likeCount: 2, liked: false });
  });

  it('notifies comment owners when liking a comment', async () => {
    const actor = makeUser();
    const targetId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const ownerId = new Types.ObjectId();

    vi.spyOn(Comment, 'findOne').mockReturnValue(selectable({ _id: targetId }) as never);
    vi.spyOn(Like, 'create').mockResolvedValue({} as never);
    vi.spyOn(Comment, 'findByIdAndUpdate').mockReturnValue(selectable({ likeCount: 3 }) as never);
    vi.spyOn(Comment, 'findById').mockReturnValue(
      selectable({ _id: targetId, postId, authorId: ownerId }) as never,
    );
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    const out = await like(actor, 'comment', targetId.toString());

    expect(out).toEqual({ likeCount: 3, liked: true });
    expect(notify).toHaveBeenCalledWith({
      recipientId: ownerId,
      actorId: actor._id,
      type: 'like',
      postId,
      commentId: targetId,
    });
  });
});
