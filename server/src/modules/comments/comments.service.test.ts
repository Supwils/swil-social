import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AppError } from '../../lib/errors';
import { Comment, type CommentDocument } from '../../models/comment.model';
import { Post } from '../../models/post.model';
import type { UserDocument } from '../../models/user.model';
import { createComment, deleteComment } from './comments.service';

function makeUser(id = new Types.ObjectId()): UserDocument {
  return {
    _id: id,
    id: id.toString(),
  } as UserDocument;
}

function makeComment(overrides: Partial<CommentDocument> = {}): CommentDocument {
  return {
    _id: new Types.ObjectId(),
    postId: new Types.ObjectId(),
    authorId: new Types.ObjectId(),
    parentId: null,
    text: 'hello',
    mentionIds: [],
    likeCount: 0,
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CommentDocument;
}

describe('comments.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects replies whose parent belongs to a different post', async () => {
    const actor = makeUser();
    const postId = new Types.ObjectId();
    const parent = makeComment({ postId: new Types.ObjectId() });

    vi.spyOn(Post, 'findById').mockResolvedValue({
      _id: postId,
      authorId: new Types.ObjectId(),
      status: 'active',
      visibility: 'public',
    } as never);
    vi.spyOn(Comment, 'findById').mockResolvedValue(parent);

    await expect(
      createComment(actor, postId.toString(), 'reply', parent._id.toString()),
    ).rejects.toMatchObject<AppError>({ code: 'NOT_FOUND', status: 404 });
  });

  it('soft deletes comments and decrements the parent post count', async () => {
    const actor = makeUser();
    const comment = makeComment({ authorId: actor._id });

    vi.spyOn(Comment, 'findById').mockResolvedValue(comment);
    const updateOne = vi.spyOn(Post, 'updateOne').mockResolvedValue({ acknowledged: true } as never);

    await deleteComment(actor, comment._id.toString());

    expect(comment.status).toBe('deleted');
    expect(comment.deletedAt).toBeInstanceOf(Date);
    expect(comment.save).toHaveBeenCalledOnce();
    expect(updateOne).toHaveBeenCalledWith({ _id: comment.postId }, { $inc: { commentCount: -1 } });
  });
});
