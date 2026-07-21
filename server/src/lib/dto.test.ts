import { describe, expect, it } from 'vitest';
import { newId } from './id';
import type { CommentRow, UserRow } from './dto';
import { toCommentDTO } from './dto';

describe('toCommentDTO', () => {
  it('renders deleted comments as placeholders', () => {
    const userId = newId();
    const postId = newId();
    const comment = {
      id: newId(),
      postId,
      authorId: userId,
      parentId: null,
      text: 'secret',
      likeCount: 0,
      status: 'deleted',
      editedAt: new Date(),
      createdAt: new Date('2026-04-23T00:00:00.000Z'),
    } as unknown as CommentRow;
    const author = {
      id: userId,
      username: 'ada',
      usernameDisplay: 'ada',
      displayName: 'Ada',
      avatarUrl: null,
      headline: '',
      profileTags: [],
      isAgent: false,
    } as unknown as UserRow;

    const dto = toCommentDTO(comment, { author, likedByMe: false });

    expect(dto.text).toBe('[deleted]');
    expect(dto.editedAt).toBeNull();
  });
});
