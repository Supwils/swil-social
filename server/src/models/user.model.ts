import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

export interface UserAttrs {
  username: string;
  usernameDisplay: string;
  email: string;
  emailVerified: boolean;
  passwordHash: string | null;
  authProviders: Array<{ provider: 'google' | 'local'; providerId?: string }>;

  displayName: string;
  bio: string;
  headline: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  location: string | null;
  website: string | null;
  birthdate: Date | null;

  followerCount: number;
  followingCount: number;
  postCount: number;

  preferences: {
    theme: 'system' | 'light' | 'dark';
    language: 'en' | 'zh';
    emailNotifications: boolean;
    pushNotifications: boolean;
  };

  status: 'active' | 'suspended' | 'deleted';
  deletedAt: Date | null;
  lastSeenAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<UserAttrs>;
export type UserModel = Model<UserAttrs>;

const AuthProviderSchema = new Schema(
  {
    provider: { type: String, enum: ['google', 'local'], required: true },
    providerId: { type: String },
  },
  { _id: false },
);

const PreferencesSchema = new Schema(
  {
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    language: { type: String, enum: ['en', 'zh'], default: 'en' },
    emailNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: true },
  },
  { _id: false },
);

const UserSchema = new Schema<UserAttrs>(
  {
    username: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
      match: /^[a-z0-9_]+$/,
    },
    usernameDisplay: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, default: null },
    authProviders: { type: [AuthProviderSchema], default: [] },

    displayName: { type: String, default: '', trim: true, maxlength: 80 },
    bio: { type: String, default: '', maxlength: 280 },
    headline: { type: String, default: '', maxlength: 80 },
    avatarUrl: { type: String, default: null },
    coverUrl: { type: String, default: null },
    location: { type: String, default: null, maxlength: 80 },
    website: { type: String, default: null, maxlength: 200 },
    birthdate: { type: Date, default: null },

    followerCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    postCount: { type: Number, default: 0 },

    preferences: { type: PreferencesSchema, default: () => ({}) },

    status: {
      type: String,
      enum: ['active', 'suspended', 'deleted'],
      default: 'active',
    },
    deletedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

UserSchema.index({ username: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index(
  { 'authProviders.provider': 1, 'authProviders.providerId': 1 },
  { sparse: true },
);
UserSchema.index({ status: 1, lastSeenAt: -1 });

UserSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    delete r.passwordHash;
    delete r._id;
    return r;
  },
});

export const User = model<UserAttrs, UserModel>('User', UserSchema);
