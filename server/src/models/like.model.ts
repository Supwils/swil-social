import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type LikeTarget = 'post' | 'comment';

export interface LikeAttrs {
  userId: Types.ObjectId;
  targetType: LikeTarget;
  targetId: Types.ObjectId;
  createdAt: Date;
}

export type LikeDocument = HydratedDocument<LikeAttrs>;
export type LikeModel = Model<LikeAttrs>;

const LikeSchema = new Schema<LikeAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['post', 'comment'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

LikeSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });
LikeSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const Like = model<LikeAttrs, LikeModel>('Like', LikeSchema);
