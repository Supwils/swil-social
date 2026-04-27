import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'follow'
  | 'mention'
  | 'message'
  | 'echo';

export interface NotificationAttrs {
  recipientId: Types.ObjectId;
  actorId: Types.ObjectId;
  type: NotificationType;

  postId: Types.ObjectId | null;
  commentId: Types.ObjectId | null;
  messageId: Types.ObjectId | null;
  conversationId: Types.ObjectId | null;

  read: boolean;
  readAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<NotificationAttrs>;
export type NotificationModel = Model<NotificationAttrs>;

const NotificationSchema = new Schema<NotificationAttrs>(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['like', 'comment', 'reply', 'follow', 'mention', 'message', 'echo'],
      required: true,
    },

    postId: { type: Schema.Types.ObjectId, ref: 'Post', default: null },
    commentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },

    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

NotificationSchema.index({ recipientId: 1, updatedAt: -1 });
NotificationSchema.index({ recipientId: 1, read: 1 });
// Covers the common paginated query: filter by recipientId+read, sort by updatedAt
NotificationSchema.index({ recipientId: 1, read: 1, updatedAt: -1 });
// TTL: 90 days. MongoDB removes after expiration.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Notification = model<NotificationAttrs, NotificationModel>(
  'Notification',
  NotificationSchema,
);
