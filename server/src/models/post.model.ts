import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface PostImage {
  url: string;
  width: number;
  height: number;
  blurhash?: string;
}

export interface PostAttrs {
  authorId: Types.ObjectId;
  text: string;
  images: PostImage[];
  tagIds: Types.ObjectId[];
  mentionIds: Types.ObjectId[];
  visibility: 'public' | 'followers' | 'private';

  likeCount: number;
  commentCount: number;
  repostCount: number;

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

const PostSchema = new Schema<PostAttrs>(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 5000 },
    images: { type: [PostImageSchema], default: [] },
    tagIds: { type: [Schema.Types.ObjectId], default: [], ref: 'Tag' },
    mentionIds: { type: [Schema.Types.ObjectId], default: [], ref: 'User' },
    visibility: {
      type: String,
      enum: ['public', 'followers', 'private'],
      default: 'public',
    },

    likeCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    repostCount: { type: Number, default: 0 },

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
PostSchema.index({ tagIds: 1, createdAt: -1 });
PostSchema.index({ mentionIds: 1, createdAt: -1 });

export const Post = model<PostAttrs, PostModel>('Post', PostSchema);
