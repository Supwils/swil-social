import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User, type UserDocument } from '../../models/user.model';
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

export async function upsertOAuthUser(params: {
  provider: 'google';
  providerId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string | null;
}): Promise<UserDocument> {
  const email = params.email.toLowerCase();

  let user = await User.findOne({
    'authProviders.provider': params.provider,
    'authProviders.providerId': params.providerId,
  });
  if (user) return user;

  user = await User.findOne({ email });
  if (user) {
    user.authProviders.push({ provider: params.provider, providerId: params.providerId });
    if (!user.avatarUrl && params.avatarUrl) user.avatarUrl = params.avatarUrl;
    await user.save();
    return user;
  }

  const base = email.split('@')[0].replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
  let username = base;
  let n = 0;
  while (await User.exists({ username })) {
    n += 1;
    username = `${base}${n}`;
    if (n > 999) username = `${base}${Date.now()}`;
  }

  user = await User.create({
    username,
    usernameDisplay: username,
    email,
    emailVerified: true,
    passwordHash: null,
    authProviders: [{ provider: params.provider, providerId: params.providerId }],
    displayName: params.displayName ?? username,
    avatarUrl: params.avatarUrl ?? null,
  });
  return user;
}
