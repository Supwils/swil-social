import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface ApiKeyAttrs {
  userId: Types.ObjectId;
  name: string;
  keyHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export type ApiKeyDocument = HydratedDocument<ApiKeyAttrs>;
export type ApiKeyModel = Model<ApiKeyAttrs>;

const ApiKeySchema = new Schema<ApiKeyAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, maxlength: 100 },
    keyHash: { type: String, required: true, unique: true, index: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const ApiKey = model<ApiKeyAttrs, ApiKeyModel>('ApiKey', ApiKeySchema);
