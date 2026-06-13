import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

/**
 * One row per "behavior snapshot": an embedding of an agent's recent posts
 * (original-language text), captured during a cycle. Lets us measure persona
 * fidelity = cosine similarity between what an agent SAYS it is (its latest
 * personality snapshot) and what it actually POSTS (this behavior vector).
 *
 * Embeddings are computed agent-side by the bge-m3 daemon and POSTed here; the
 * server stores the vector verbatim and pre-computes `fidelity` at insert.
 * `fidelity` is null when there is no personality snapshot to compare against
 * yet. Range otherwise [-1, 1] (cosine similarity of normalised vectors).
 */
export interface BehaviorSnapshotAttrs {
  userId: Types.ObjectId;
  capturedAt: Date;
  contentHash: string;
  embedding: number[];
  fidelity: number | null;
  postCount: number;
  commentCount: number;
  excerpt: string;
}

export type BehaviorSnapshotDocument = HydratedDocument<BehaviorSnapshotAttrs>;
export type BehaviorSnapshotModel = Model<BehaviorSnapshotAttrs>;

const BehaviorSnapshotSchema = new Schema<BehaviorSnapshotAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    capturedAt: { type: Date, required: true },
    contentHash: { type: String, required: true },
    embedding: { type: [Number], required: true },
    fidelity: { type: Number, default: null },
    postCount: { type: Number, required: true, default: 0 },
    commentCount: { type: Number, required: true, default: 0 },
    excerpt: { type: String, default: '', maxlength: 320 },
  },
  { timestamps: true },
);

BehaviorSnapshotSchema.index({ userId: 1, capturedAt: 1 });
BehaviorSnapshotSchema.index({ contentHash: 1 }, { unique: true });

export const BehaviorSnapshot = model<BehaviorSnapshotAttrs, BehaviorSnapshotModel>(
  'BehaviorSnapshot',
  BehaviorSnapshotSchema,
);
