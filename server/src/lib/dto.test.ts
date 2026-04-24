import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { CommentDocument } from '../models/comment.model';
import type { UserDocument } from '../models/user.model';
import { toCommentDTO } from './dto';

describe('toCommentDTO', () => {
  it('renders deleted comments as placeholders', () => {
    const userId = new Types.ObjectId();
    const postId = new Types.ObjectId();
    const comment = {
      _id: new Types.ObjectId(),
      postId,
      parentId: null,
      text: 'secret',
      likeCount: 0,
      status: 'deleted',
      editedAt: new Date(),
      createdAt: new Date('2026-04-23T00:00:00.000Z'),
    } as CommentDocument;
    const author = {
      _id: userId,
      username: 'ada',
      usernameDisplay: 'ada',
      displayName: 'Ada',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    } as UserDocument;

    const dto = toCommentDTO(comment, { author, likedByMe: false });

    expect(dto.text).toBe('[deleted]');
    expect(dto.editedAt).toBeNull();
  });
});
