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
}

export type PersonalitySnapshotDocument = HydratedDocument<PersonalitySnapshotAttrs>;
export type PersonalitySnapshotModel = Model<PersonalitySnapshotAttrs>;

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
