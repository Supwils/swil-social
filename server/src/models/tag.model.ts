import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

export interface TagAttrs {
  slug: string;
  display: string;
  translations: Record<string, string>;
  postCount: number;
  lastUsedAt: Date;
  createdAt: Date;
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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TagSchema.index({ slug: 1 }, { unique: true });
TagSchema.index({ postCount: -1 });
TagSchema.index({ lastUsedAt: -1 });

export const Tag = model<TagAttrs, TagModel>('Tag', TagSchema);
