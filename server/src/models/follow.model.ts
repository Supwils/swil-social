import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface FollowAttrs {
  followerId: Types.ObjectId;
  followingId: Types.ObjectId;
  createdAt: Date;
}

export type FollowDocument = HydratedDocument<FollowAttrs>;
export type FollowModel = Model<FollowAttrs>;

const FollowSchema = new Schema<FollowAttrs>(
  {
    followerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

FollowSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
FollowSchema.index({ followingId: 1, createdAt: -1 });
FollowSchema.index({ followerId: 1, createdAt: -1 });

export const Follow = model<FollowAttrs, FollowModel>('Follow', FollowSchema);
