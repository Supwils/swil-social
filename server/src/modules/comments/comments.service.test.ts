import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, comments } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { AppError } from '../../lib/errors';
import type { PostRow, UserRow } from '../../lib/dto';
import { createComment, deleteComment } from './comments.service';

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `user${seq}`,
      usernameDisplay: `user${seq}`,
      email: `user${seq}@example.com`,
      displayName: `User ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

async function seedPost(authorId: string, over: Partial<typeof posts.$inferInsert> = {}): Promise<PostRow> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'body', visibility: 'public', ...over })
    .returning();
  return p;
}

describe('comments.service', () => {
  beforeEach(resetDb);

  it('rejects replies whose parent belongs to a different post', async () => {
    const actor = await seedUser();
    const targetPost = await seedPost(actor.id);
    const otherPost = await seedPost(actor.id);
    const [parent] = await db
      .insert(comments)
      .values({ postId: otherPost.id, authorId: actor.id, text: 'root' })
      .returning();

    await expect(
      createComment(actor, targetPost.id, 'reply', parent.id),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'NOT_FOUND', status: 404 });
  });

  it('soft deletes comments and decrements the parent post count', async () => {
    const actor = await seedUser();
    const post = await seedPost(actor.id, { commentCount: 1 });
    const [comment] = await db
      .insert(comments)
      .values({ postId: post.id, authorId: actor.id, text: 'hello' })
      .returning();

    await deleteComment(actor, comment.id);

    const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
    expect(row.status).toBe('deleted');
    expect(row.deletedAt).toBeInstanceOf(Date);

    const [postRow] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(postRow.commentCount).toBe(0);
  });
});
