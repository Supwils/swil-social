import { Schema, Types, model, type HydratedDocument, type Model } from 'mongoose';

export interface TagAttrs {
  slug: string;
  display: string;
  translations: Record<string, string>;
  postCount: number;
  lastUsedAt: Date;
  createdAt: Date;
  description?: string;
  coverImage?: string;
  featured?: boolean;
  status?: 'active' | 'archived';
  pinnedPostIds?: Types.ObjectId[];
  aliasIds?: Types.ObjectId[];
  isAlias?: boolean;
}

export type TagDocument = HydratedDocument<TagAttrs>;
export type TagModel = Model<TagAttrs>;

const TagSchema = new Schema<TagAttrs>(
  {
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 64 },
    display: { type: String, required: true, trim: true, maxlength: 64 },
    translations: { type: Schema.Types.Mixed, default: {} },
    postCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: () => new Date() },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    coverImage: { type: String, default: '' },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    pinnedPostIds: { type: [Schema.Types.ObjectId], default: [] },
    aliasIds: { type: [Schema.Types.ObjectId], default: [] },
    isAlias: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TagSchema.index({ slug: 1 }, { unique: true });
TagSchema.index({ postCount: -1 });
TagSchema.index({ lastUsedAt: -1 });
TagSchema.index({ featured: 1 }, { sparse: true });

export const Tag = model<TagAttrs, TagModel>('Tag', TagSchema);
