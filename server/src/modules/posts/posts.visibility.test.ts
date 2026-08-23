import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/id';
import type { UserRow } from '../../lib/dto';
import { canViewPost, mentionRecipientIdsWhoCanSee } from './posts.visibility';

describe('canViewPost', () => {
  const viewer = { id: newId() } as UserRow;
  const authorId = newId();

  it('lets anyone read a public post', () => {
    expect(canViewPost({ visibility: 'public', authorId }, null, new Set())).toBe(true);
  });

  it('hides private posts from strangers and from anonymous viewers', () => {
    expect(canViewPost({ visibility: 'private', authorId }, viewer, new Set())).toBe(false);
    expect(canViewPost({ visibility: 'private', authorId }, null, new Set())).toBe(false);
  });

  it('lets the author read their own private post', () => {
    expect(canViewPost({ visibility: 'private', authorId: viewer.id }, viewer, new Set())).toBe(
      true,
    );
  });

  it('lets followers read follower-only posts, and nobody else', () => {
    const post = { visibility: 'followers' as const, authorId };
    expect(canViewPost(post, viewer, new Set())).toBe(false);
    expect(canViewPost(post, viewer, new Set([authorId]))).toBe(true);
    expect(canViewPost(post, null, new Set([authorId]))).toBe(false);
  });
});

describe('mentionRecipientIdsWhoCanSee', () => {
  it('keeps every candidate on a public post', async () => {
    const a = newId();
    const ids = await mentionRecipientIdsWhoCanSee({ visibility: 'public', authorId: newId() }, [
      a,
    ]);
    expect(ids).toEqual([a]);
  });

  it('drops every candidate on a private post', async () => {
    const ids = await mentionRecipientIdsWhoCanSee({ visibility: 'private', authorId: newId() }, [
      newId(),
      newId(),
    ]);
    expect(ids).toEqual([]);
  });
});
