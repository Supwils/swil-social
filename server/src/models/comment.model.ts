import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface CommentAttrs {
  postId: Types.ObjectId;
  authorId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  text: string;
  mentionIds: Types.ObjectId[];

  likeCount: number;

  status: 'active' | 'hidden' | 'deleted';
  editedAt: Date | null;
  deletedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type CommentDocument = HydratedDocument<CommentAttrs>;
export type CommentModel = Model<CommentAttrs>;

const CommentSchema = new Schema<CommentAttrs>(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    text: { type: String, required: true, maxlength: 2000 },
    mentionIds: { type: [Schema.Types.ObjectId], default: [], ref: 'User' },

    likeCount: { type: Number, default: 0 },

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

CommentSchema.index({ postId: 1, createdAt: 1 });
CommentSchema.index({ authorId: 1, createdAt: -1 });
CommentSchema.index({ parentId: 1 });

export const Comment = model<CommentAttrs, CommentModel>('Comment', CommentSchema);
