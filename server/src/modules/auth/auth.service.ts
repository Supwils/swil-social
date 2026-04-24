import bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import mongoose from 'mongoose';
import { User, type UserDocument } from '../../models/user.model';
import { ApiKey, type ApiKeyDocument } from '../../models/apiKey.model';
import { AppError } from '../../lib/errors';
import type { RegisterInput, LoginInput } from './auth.schemas';

const BCRYPT_COST = 12;

export async function register(input: RegisterInput): Promise<UserDocument> {
  const username = input.username.toLowerCase();
  const email = input.email.toLowerCase();

  const existing = await User.findOne({
    $or: [{ username }, { email }],
  }).lean();
  if (existing) {
    const fields: Record<string, string> = {};
    if (existing.username === username) fields.username = 'Already taken';
    if (existing.email === email) fields.email = 'Already taken';
    throw AppError.conflict('Account already exists', fields);
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  const user = await User.create({
    username,
    usernameDisplay: input.username,
    email,
    emailVerified: false,
    passwordHash,
    authProviders: [{ provider: 'local' }],
    displayName: input.displayName ?? input.username,
    isAgent: input.isAgent ?? false,
  });

  return user;
}

export async function authenticate(input: LoginInput): Promise<UserDocument> {
  const identifier = input.usernameOrEmail.toLowerCase().trim();
  const user = await User.findOne({
    $or: [{ username: identifier }, { email: identifier }],
  });

  if (!user || !user.passwordHash) {
    throw AppError.unauthenticated('Invalid username or password');
  }
  if (user.status !== 'active') {
    throw AppError.forbidden('Account is not active');
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    throw AppError.unauthenticated('Invalid username or password');
  }

  user.lastSeenAt = new Date();
  await user.save();
  return user;
}

export async function changePassword(
  user: UserDocument,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!user.passwordHash) {
    throw AppError.forbidden('This account has no password set');
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw AppError.unauthenticated('Current password is incorrect');

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await user.save();
}

export async function destroyOtherSessions(userId: string, currentSid: string): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('sessions');
  // connect-mongo uses string session IDs as _id; cast silences the ObjectId default.
  await col.deleteMany({
    _id: { $ne: currentSid as unknown as never },
    session: { $regex: new RegExp(`"userId"\\s*:\\s*"${userId}"`) },
  });
}

// ---------- API Keys ----------

export async function createApiKey(
  user: UserDocument,
  name: string,
): Promise<{ key: string; doc: ApiKeyDocument }> {
  const rawKey = `sk-swil-${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const doc = await ApiKey.create({ userId: user._id, name, keyHash });
  return { key: rawKey, doc };
}

export async function listApiKeys(user: UserDocument): Promise<ApiKeyDocument[]> {
  return ApiKey.find({ userId: user._id }).sort({ createdAt: -1 });
}

export async function revokeApiKey(user: UserDocument, keyId: string): Promise<void> {
  const doc = await ApiKey.findById(keyId);
  if (!doc) throw AppError.notFound('API key not found');
  if (!doc.userId.equals(user._id)) throw AppError.forbidden('Not your API key');
  await doc.deleteOne();
}
