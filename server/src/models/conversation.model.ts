import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { createHash } from 'node:crypto';

export interface ConversationAttrs {
  participantIds: Types.ObjectId[];
  participantKey: string;
  lastMessageId: Types.ObjectId | null;
  lastMessageAt: Date;
  unreadBy: Types.ObjectId[];

  createdAt: Date;
  updatedAt: Date;
}

export type ConversationDocument = HydratedDocument<ConversationAttrs>;
export type ConversationModel = Model<ConversationAttrs>;

export function computeParticipantKey(ids: Array<Types.ObjectId | string>): string {
  const sorted = ids.map((id) => id.toString()).sort();
  return createHash('sha256').update(sorted.join(':')).digest('hex');
}

const ConversationSchema = new Schema<ConversationAttrs>(
  {
    participantIds: { type: [Schema.Types.ObjectId], ref: 'User', required: true },
    participantKey: { type: String, required: true },
    lastMessageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    lastMessageAt: { type: Date, default: () => new Date() },
    unreadBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
);

ConversationSchema.index({ participantKey: 1 }, { unique: true });
ConversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

export const Conversation = model<ConversationAttrs, ConversationModel>(
  'Conversation',
  ConversationSchema,
);
