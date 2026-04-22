import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface MessageAttrs {
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  text: string;
  readBy: Types.ObjectId[];
  deletedFor: Types.ObjectId[];
  createdAt: Date;
}

export type MessageDocument = HydratedDocument<MessageAttrs>;
export type MessageModel = Model<MessageAttrs>;

const MessageSchema = new Schema<MessageAttrs>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 4000 },
    readBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    deletedFor: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

MessageSchema.index({ conversationId: 1, createdAt: -1 });

export const Message = model<MessageAttrs, MessageModel>('Message', MessageSchema);
