import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface PostImage {
  url: string;
  width: number;
  height: number;
  blurhash?: string;
}

export interface PostVideo {
  url: string;
  width: number;
  height: number;
  durationSec?: number;
}

export interface PostAttrs {
  authorId: Types.ObjectId;
  text: string;
  images: PostImage[];
  video: PostVideo | null;
  tagIds: Types.ObjectId[];
  mentionIds: Types.ObjectId[];
  visibility: 'public' | 'followers' | 'private';

  echoOf?: Types.ObjectId;

  likeCount: number;
  commentCount: number;
  repostCount: number;
  feedScore: number;

  translations: Record<string, string>;

  status: 'active' | 'hidden' | 'deleted';
  editedAt: Date | null;
  deletedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type PostDocument = HydratedDocument<PostAttrs>;
export type PostModel = Model<PostAttrs>;

const PostImageSchema = new Schema<PostImage>(
  {
    url: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    blurhash: { type: String },
  },
  { _id: false },
);

const PostVideoSchema = new Schema<PostVideo>(
  {
    url: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    durationSec: { type: Number },
  },
  { _id: false },
);

const PostSchema = new Schema<PostAttrs>(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: false, default: '', maxlength: 5000 },
    images: { type: [PostImageSchema], default: [] },
    video: { type: PostVideoSchema, default: null },
    tagIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Tag' },
    mentionIds: { type: [Schema.Types.ObjectId], default: [], ref: 'User' },
    visibility: {
      type: String,
      enum: ['public', 'followers', 'private'],
      default: 'public',
    },

    echoOf: { type: Schema.Types.ObjectId, ref: 'Post', default: null },

    likeCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    repostCount: { type: Number, default: 0 },
    feedScore: { type: Number, default: 0 },

    translations: { type: Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ['active', 'hidden', 'deleted'],
      default: 'active',
    },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

PostSchema.index({ authorId: 1, createdAt: -1 });
PostSchema.index({ status: 1, createdAt: -1 });
PostSchema.index({ status: 1, visibility: 1, feedScore: -1 });
PostSchema.index({ tagIds: 1, feedScore: -1 });
PostSchema.index({ tagIds: 1, createdAt: -1 });
PostSchema.index({ mentionIds: 1, createdAt: -1 });
PostSchema.index({ text: 'text' });

export const Post = model<PostAttrs, PostModel>('Post', PostSchema);
