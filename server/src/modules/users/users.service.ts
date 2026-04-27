import { User, type UserDocument } from '../../models/user.model';
import { AppError } from '../../lib/errors';
import { uploadBufferToS3, deleteFromS3 } from '../../config/s3';
import type { FilterQuery } from 'mongoose';
import type { UpdateMeInput } from './users.schemas';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findByUsername(username: string): Promise<UserDocument> {
  const user = await User.findOne({
    username: username.toLowerCase(),
    status: 'active',
  });
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function updateMe(
  user: UserDocument,
  patch: UpdateMeInput,
): Promise<UserDocument> {
  if (patch.displayName !== undefined) user.displayName = patch.displayName;
  if (patch.bio !== undefined) user.bio = patch.bio;
  if (patch.headline !== undefined) user.headline = patch.headline;
  if (patch.location !== undefined) user.location = patch.location;
  if (patch.website !== undefined) user.website = patch.website;
  if (patch.birthdate !== undefined) user.birthdate = patch.birthdate as Date | null;
  if (patch.preferences) {
    const current = user.preferences as unknown as {
      toObject?: () => Record<string, unknown>;
    } & Record<string, unknown>;
    const base = typeof current.toObject === 'function' ? current.toObject() : current;
    user.preferences = { ...base, ...patch.preferences } as typeof user.preferences;
  }
  if (patch.profileTags !== undefined) {
    user.profileTags = patch.profileTags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  }
  if (patch.agentBackend !== undefined) user.agentBackend = patch.agentBackend;
  await user.save();
  return user;
}

export async function updateAvatar(
  user: UserDocument,
  buffer: Buffer,
): Promise<UserDocument> {
  const oldUrl = user.avatarUrl;
  const { url } = await uploadBufferToS3(buffer, 'avatars');
  user.avatarUrl = url;
  await user.save();
  // Delete old avatar after save succeeds
  if (oldUrl) void deleteFromS3(oldUrl);
  return user;
}

/**
 * Search users by username/displayName prefix and/or profile tag.
 * If neither query nor tag is provided, returns top users by followerCount.
 */
export async function searchUsers(
  query: string | undefined,
  tag: string | undefined,
  limit: number,
): Promise<UserDocument[]> {
  const filter: FilterQuery<UserDocument> = { status: 'active' };
  if (query) {
    const prefix = new RegExp(`^${escapeRegex(query.toLowerCase())}`);
    filter.$or = [
      { username: prefix },
      { displayName: { $regex: new RegExp(`^${escapeRegex(query)}`, 'i') } },
    ];
  }
  if (tag) {
    filter.profileTags = { $regex: new RegExp(`^${escapeRegex(tag)}$`, 'i') };
  }
  return (await User.find(filter)
    .limit(Math.min(50, Math.max(1, limit)))
    .sort({ followerCount: -1 })
    .lean()) as unknown as UserDocument[];
}

export async function getPopularProfileTags(): Promise<Array<{ tag: string; count: number }>> {
  const result = await User.aggregate([
    { $match: { status: 'active', profileTags: { $exists: true, $ne: [] } } },
    { $unwind: '$profileTags' },
    { $group: { _id: '$profileTags', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);
  return result.map((r) => ({ tag: r._id as string, count: r.count as number }));
}
