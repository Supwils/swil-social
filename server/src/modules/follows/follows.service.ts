import { Types } from 'mongoose';
import { Follow, type FollowDocument } from '../../models/follow.model';
import { User, type UserDocument } from '../../models/user.model';
import { AppError } from '../../lib/errors';
import {
  type Cursor,
  cursorFilterDesc,
  buildNextCursor,
} from '../../lib/pagination';
import type { UserLiteDTO } from '../../lib/dto';
import { toUserLiteDTO } from '../../lib/dto';
import { createNotification } from '../notifications/notifications.service';

async function findUserByUsername(username: string): Promise<UserDocument> {
  const user = await User.findOne({ username: username.toLowerCase(), status: 'active' });
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function follow(
  follower: UserDocument,
  targetUsername: string,
): Promise<void> {
  const target = await findUserByUsername(targetUsername);
  if (target._id.equals(follower._id)) {
    throw AppError.validation('Cannot follow yourself');
  }

  try {
    await Follow.create({ followerId: follower._id, followingId: target._id });
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e.code === 11000) throw AppError.conflict('Already following this user');
    throw err;
  }

  await Promise.all([
    User.updateOne({ _id: follower._id }, { $inc: { followingCount: 1 } }),
    User.updateOne({ _id: target._id }, { $inc: { followerCount: 1 } }),
  ]);

  await createNotification({
    recipientId: target._id,
    actorId: follower._id,
    type: 'follow',
  });
}

export async function unfollow(
  follower: UserDocument,
  targetUsername: string,
): Promise<void> {
  const target = await findUserByUsername(targetUsername);
  if (target._id.equals(follower._id)) return;

  const deleted = await Follow.findOneAndDelete({
    followerId: follower._id,
    followingId: target._id,
  });
  if (!deleted) return;

  await Promise.all([
    User.updateOne({ _id: follower._id }, { $inc: { followingCount: -1 } }),
    User.updateOne({ _id: target._id }, { $inc: { followerCount: -1 } }),
  ]);
}

type Direction = 'following' | 'followers';

async function listEdges(
  username: string,
  direction: Direction,
  cursor: Cursor | null,
  limit: number,
): Promise<{ items: UserLiteDTO[]; nextCursor: string | null }> {
  const user = await findUserByUsername(username);

  const edgeFilter =
    direction === 'following'
      ? { followerId: user._id }
      : { followingId: user._id };

  const docs = await Follow.find({ ...edgeFilter, ...cursorFilterDesc(cursor) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);

  const { items, nextCursor } = buildNextCursor(docs, limit);

  const peerIds = items.map((e: FollowDocument) =>
    direction === 'following' ? e.followingId : e.followerId,
  );
  const users = peerIds.length
    ? await User.find({
        _id: { $in: peerIds as Types.ObjectId[] },
        status: 'active',
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  const ordered: UserLiteDTO[] = items
    .map((e) => {
      const pid = direction === 'following' ? e.followingId : e.followerId;
      const u = byId.get(pid.toString());
      return u ? toUserLiteDTO(u) : null;
    })
    .filter((x): x is UserLiteDTO => x !== null);

  return { items: ordered, nextCursor };
}

export const listFollowing = (u: string, c: Cursor | null, l: number) =>
  listEdges(u, 'following', c, l);
export const listFollowers = (u: string, c: Cursor | null, l: number) =>
  listEdges(u, 'followers', c, l);

export async function isFollowing(
  follower: UserDocument,
  targetUsername: string,
): Promise<boolean> {
  const target = await findUserByUsername(targetUsername);
  const hit = await Follow.exists({
    followerId: follower._id,
    followingId: target._id,
  });
  return Boolean(hit);
}
