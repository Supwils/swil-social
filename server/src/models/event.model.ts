import { Schema, model, Types, type HydratedDocument } from 'mongoose';

/**
 * Lightweight analytics event store.
 *
 * Each event is timestamped and tied (optionally) to a user. Events are
 * intentionally schemaless inside `context` — client decides the shape per
 * type. TTL drops events after 90 days; for longer-term analytics, ETL into
 * a warehouse (or aggregate into rollup collections) before expiry.
 */
export interface EventAttrs {
  type: string;
  userId?: Types.ObjectId | null;
  sessionId: string;
  context: Record<string, unknown>;
  ip?: string;
}

const EventSchema = new Schema<EventAttrs>(
  {
    type: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sessionId: { type: String, required: true },
    context: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String },
  },
  { timestamps: true },
);

EventSchema.index({ type: 1, createdAt: -1 });
EventSchema.index({ userId: 1, createdAt: -1 });
EventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export type EventDocument = HydratedDocument<EventAttrs>;
export const Event = model<EventAttrs>('Event', EventSchema);
