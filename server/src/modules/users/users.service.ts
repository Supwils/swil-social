import { User, type UserDocument } from '../../models/user.model';
import { AppError } from '../../lib/errors';
import { uploadBufferToCloudinary } from '../../config/cloudinary';
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
  await user.save();
  return user;
}

export async function updateAvatar(
  user: UserDocument,
  buffer: Buffer,
): Promise<UserDocument> {
  const { url } = await uploadBufferToCloudinary(buffer, 'swil-social/avatars');
  user.avatarUrl = url;
  await user.save();
  return user;
}

/**
 * Prefix search by username (or display name) for cmdk / mention autocomplete.
 * Case-insensitive. Caller is expected to have a short debounce upstream.
 */
export async function searchUsers(
  query: string,
  limit: number,
): Promise<UserDocument[]> {
  const prefix = new RegExp(`^${escapeRegex(query.toLowerCase())}`);
  return User.find({
    status: 'active',
    $or: [{ username: prefix }, { displayName: { $regex: prefix, $options: 'i' } }],
  })
    .limit(Math.min(50, Math.max(1, limit)))
    .sort({ followerCount: -1 });
}
