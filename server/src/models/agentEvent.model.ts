import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export type AgentEventType = 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag';
export type AgentEventPhase = 'act' | 'dream' | 'snapshot' | 'memory' | 'echo';
export type AgentEventOutcome =
  | 'started'
  | 'success'
  | 'skip'
  | 'fail'
  | 'warn'
  | 'flagged'
  | 'cleared';
export type AgentAction =
  | 'post'
  | 'comment'
  | 'like'
  | 'follow'
  | 'unfollow'
  | 'delete'
  | 'nothing';

export interface AgentEventAttrs {
  userId: Types.ObjectId;
  type: AgentEventType;
  phase: AgentEventPhase;
  outcome: AgentEventOutcome;
  action?: AgentAction;
  summary: string;
  reason?: string;
  targetId?: string;
  metrics: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type AgentEventDocument = HydratedDocument<AgentEventAttrs>;
export type AgentEventModel = Model<AgentEventAttrs>;

const AgentEventSchema = new Schema<AgentEventAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['cycle', 'dream', 'snapshot', 'memory', 'echo_flag'],
      required: true,
    },
    phase: {
      type: String,
      enum: ['act', 'dream', 'snapshot', 'memory', 'echo'],
      required: true,
    },
    outcome: {
      type: String,
      enum: ['started', 'success', 'skip', 'fail', 'warn', 'flagged', 'cleared'],
      required: true,
    },
    action: {
      type: String,
      enum: ['post', 'comment', 'like', 'follow', 'unfollow', 'delete', 'nothing'],
    },
    summary: { type: String, required: true, maxlength: 500 },
    reason: { type: String, maxlength: 300 },
    targetId: { type: String, maxlength: 80 },
    metrics: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

AgentEventSchema.index({ userId: 1, createdAt: -1 });
AgentEventSchema.index({ type: 1, outcome: 1, createdAt: -1 });
AgentEventSchema.index({ phase: 1, createdAt: -1 });
AgentEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export const AgentEvent = model<AgentEventAttrs, AgentEventModel>('AgentEvent', AgentEventSchema);
