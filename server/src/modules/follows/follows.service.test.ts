import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { follows, users } from '../../db/schema';
import type { UserRow } from '../../lib/dto';
import { resetDb } from '../../test/db-reset';
import { decodeCursor } from '../../lib/pagination';
import * as notifications from '../notifications/notifications.service';
import {
  follow,
  isFollowing,
  listFollowers,
  listFollowing,
  unfollow,
} from './follows.service';

async function seedUser(username: string): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.com`,
      displayName: username,
    })
    .returning();
  return u;
}

describe('follows.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects following yourself', async () => {
    const me = await seedUser('ada');

    await expect(follow(me, me.username)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('maps duplicate edges to a conflict error', async () => {
    const me = await seedUser('ada');
    const target = await seedUser('bob');
    vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    await follow(me, target.username);

    await expect(follow(me, target.username)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('sends a follow notification after a successful follow', async () => {
    const me = await seedUser('ada');
    const target = await seedUser('bob');
    const notify = vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    await follow(me, target.username);

    expect(notify).toHaveBeenCalledWith({
      recipientId: target.id,
      actorId: me.id,
      type: 'follow',
    });

    // The edge is persisted and both counters are bumped atomically.
    const [edge] = await db
      .select()
      .from(follows)
      .where(and(eq(follows.followerId, me.id), eq(follows.followingId, target.id)));
    expect(edge).toBeDefined();

    const [meRow] = await db.select().from(users).where(eq(users.id, me.id));
    const [targetRow] = await db.select().from(users).where(eq(users.id, target.id));
    expect(meRow.followingCount).toBe(1);
    expect(targetRow.followerCount).toBe(1);
  });

  it('treats unfollow as idempotent when no edge exists', async () => {
    const me = await seedUser('ada');
    const target = await seedUser('bob');

    await expect(unfollow(me, target.username)).resolves.toBeUndefined();

    // Counters are untouched when there was nothing to remove.
    const [meRow] = await db.select().from(users).where(eq(users.id, me.id));
    const [targetRow] = await db.select().from(users).where(eq(users.id, target.id));
    expect(meRow.followingCount).toBe(0);
    expect(targetRow.followerCount).toBe(0);
  });

  it('throws when following a user that does not exist', async () => {
    const me = await seedUser('ada');
    await expect(follow(me, 'ghost')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('removes an existing edge and decrements both counters', async () => {
    const me = await seedUser('ada');
    const target = await seedUser('bob');
    vi.spyOn(notifications, 'createNotification').mockResolvedValue(undefined);

    await follow(me, target.username);
    await unfollow(me, target.username);

    const [meRow] = await db.select().from(users).where(eq(users.id, me.id));
    const [targetRow] = await db.select().from(users).where(eq(users.id, target.id));
    expect(meRow.followingCount).toBe(0);
    expect(targetRow.followerCount).toBe(0);

    const edges = await db
      .select()
      .from(follows)
      .where(and(eq(follows.followerId, me.id), eq(follows.followingId, target.id)));
    expect(edges).toHaveLength(0);
  });

  it('treats unfollowing yourself as a no-op', async () => {
    const me = await seedUser('ada');
    await expect(unfollow(me, me.username)).resolves.toBeUndefined();
  });

  // ── listFollowing / listFollowers ─────────────────────────────────────────

  it('lists following newest-first and paginates by cursor', async () => {
    const me = await seedUser('ada');
    const b = await seedUser('bob');
    const c = await seedUser('cid');
    const d = await seedUser('dan');
    const base = Date.parse('2026-01-01T00:00:00Z');
    await db.insert(follows).values([
      { followerId: me.id, followingId: b.id, createdAt: new Date(base) },
      { followerId: me.id, followingId: c.id, createdAt: new Date(base + 1000) },
      { followerId: me.id, followingId: d.id, createdAt: new Date(base + 2000) },
    ]);

    const page1 = await listFollowing(me.username, null, 2);
    expect(page1.items.map((u) => u.username)).toEqual(['dan', 'cid']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listFollowing(me.username, decodeCursor(page1.nextCursor), 2);
    expect(page2.items.map((u) => u.username)).toEqual(['bob']);
    expect(page2.nextCursor).toBeNull();
  });

  it('lists followers newest-first', async () => {
    const target = await seedUser('ada');
    const b = await seedUser('bob');
    const c = await seedUser('cid');
    const base = Date.parse('2026-01-01T00:00:00Z');
    await db.insert(follows).values([
      { followerId: b.id, followingId: target.id, createdAt: new Date(base) },
      { followerId: c.id, followingId: target.id, createdAt: new Date(base + 1000) },
    ]);

    const res = await listFollowers(target.username, null, 10);
    expect(res.items.map((u) => u.username)).toEqual(['cid', 'bob']);
    expect(res.nextCursor).toBeNull();
  });

  it('returns an empty page when the user follows nobody', async () => {
    const me = await seedUser('ada');
    const res = await listFollowing(me.username, null, 10);
    expect(res.items).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it('filters following by a search term on username or display name', async () => {
    const me = await seedUser('ada');
    const alice = await seedUser('alice');
    const bob = await seedUser('bob');
    await db.insert(follows).values([
      { followerId: me.id, followingId: alice.id },
      { followerId: me.id, followingId: bob.id },
    ]);

    const res = await listFollowing(me.username, null, 10, 'ali');
    expect(res.items.map((u) => u.username)).toEqual(['alice']);
    expect(res.nextCursor).toBeNull();
  });

  it('returns empty for a search when the user follows nobody', async () => {
    const me = await seedUser('ada');
    const res = await listFollowing(me.username, null, 10, 'x');
    expect(res.items).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  // ── isFollowing (both directions) ─────────────────────────────────────────

  it('reports isFollowing per direction of the edge', async () => {
    const a = await seedUser('ada');
    const b = await seedUser('bob');
    await db.insert(follows).values({ followerId: a.id, followingId: b.id });

    expect(await isFollowing(a, b.username)).toBe(true);
    expect(await isFollowing(b, a.username)).toBe(false);
  });

  it('throws when checking isFollowing against an unknown user', async () => {
    const a = await seedUser('ada');
    await expect(isFollowing(a, 'ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
