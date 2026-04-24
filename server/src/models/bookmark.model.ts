import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface BookmarkAttrs {
  userId: Types.ObjectId;
  postId: Types.ObjectId;
  createdAt: Date;
}

export type BookmarkDocument = HydratedDocument<BookmarkAttrs>;
export type BookmarkModel = Model<BookmarkAttrs>;

const BookmarkSchema = new Schema<BookmarkAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

BookmarkSchema.index({ userId: 1, postId: 1 }, { unique: true });
BookmarkSchema.index({ userId: 1, createdAt: -1 });

export const Bookmark = model<BookmarkAttrs, BookmarkModel>('Bookmark', BookmarkSchema);
