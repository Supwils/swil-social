import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

/**
 * One row per personality.md snapshot taken at dream time (and historical
 * backfill from personality.archive.md). Embeddings are computed by the local
 * bge-m3 daemon (see agent/scripts/embedder/) and stored verbatim so we can
 * recompute distances against newer anchors later without re-embedding.
 *
 * driftFromAnchor / driftFromPrev are stored as cosine *distance* (1 - cos sim),
 * so larger = more drift, range [0, 2]. Pre-computed at insert because the
 * client charts read them by the thousand.
 */
export type SnapshotType = 'anchor' | 'dream';

export type DriftAspect = 'values' | 'style' | 'topic';

/**
 * Per-aspect drift decomposition (see docs/superpowers/specs/2026-07-02-…).
 * Each field is a cosine *similarity* in [-1, 1] (higher = closer to the anchor's
 * distilled aspect card) — NOT a distance, unlike driftFromAnchor/driftFromPrev.
 * `mode` records which regime produced the row; `breached` lists aspects whose
 * sim fell below their threshold (empty when all held).
 */
export interface AspectDriftAttrs {
  mode: 'shadow' | 'aspect';
  promptVersion: number;
  values: number;
  style: number;
  topic: number;
  breached: DriftAspect[];
}

export interface PersonalitySnapshotAttrs {
  userId: Types.ObjectId;
  capturedAt: Date;
  contentHash: string;
  embedding: number[];
  snapshotType: SnapshotType;
  archivePath: string;
  driftFromAnchor: number;
  driftFromPrev: number;
  excerpt: string; // first ~280 chars of personality.md for quick UI rendering
  diffNarrative?: string; // LLM "what changed" summary vs the previous version (Feature 5)
  aspectDrift?: AspectDriftAttrs; // per-aspect drift; absent on pre-2026-07 snapshots
}

export type PersonalitySnapshotDocument = HydratedDocument<PersonalitySnapshotAttrs>;
export type PersonalitySnapshotModel = Model<PersonalitySnapshotAttrs>;

const AspectDriftSchema = new Schema<AspectDriftAttrs>(
  {
    mode: { type: String, enum: ['shadow', 'aspect'], required: true },
    promptVersion: { type: Number, required: true },
    values: { type: Number, required: true },
    style: { type: Number, required: true },
    topic: { type: Number, required: true },
    breached: { type: [String], enum: ['values', 'style', 'topic'], default: [] },
  },
  { _id: false },
);

const PersonalitySnapshotSchema = new Schema<PersonalitySnapshotAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    capturedAt: { type: Date, required: true },
    contentHash: { type: String, required: true },
    embedding: { type: [Number], required: true },
    snapshotType: {
      type: String,
      enum: ['anchor', 'dream'],
      required: true,
      default: 'dream',
    },
    archivePath: { type: String, required: true },
    driftFromAnchor: { type: Number, required: true, default: 0 },
    driftFromPrev: { type: Number, required: true, default: 0 },
    excerpt: { type: String, default: '', maxlength: 320 },
    diffNarrative: { type: String, maxlength: 2000 },
    aspectDrift: { type: AspectDriftSchema, required: false },
  },
  { timestamps: true },
);

PersonalitySnapshotSchema.index({ userId: 1, capturedAt: 1 });
PersonalitySnapshotSchema.index({ contentHash: 1 }, { unique: true });
PersonalitySnapshotSchema.index({ snapshotType: 1, userId: 1 });

export const PersonalitySnapshot = model<PersonalitySnapshotAttrs, PersonalitySnapshotModel>(
  'PersonalitySnapshot',
  PersonalitySnapshotSchema,
);
