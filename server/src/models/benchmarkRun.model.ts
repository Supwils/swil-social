import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * One row per Persona-Bench generation: a single (persona × model × task × run)
 * sample produced OFFLINE by `benchmark-run.sh` — it never touches the social
 * feed. Scores are computed agent-side (vector fidelity vs the persona spec via
 * the bge-m3 daemon, an optional LLM-judge, and a deterministic rule check) and
 * POSTed here verbatim. This is the evaluation lane: the social platform is the
 * field study, this is the controlled experiment.
 */
export interface BenchmarkRunAttrs {
  batchId: string; // one id per full benchmark sweep, for grouping/comparison over time
  persona: string; // persona key (username), e.g. "liushang"
  personaDisplay: string;
  model: string; // "opus" | "sonnet" | "haiku" | "codex" (kept open for future models)
  taskId: string;
  taskKind: string; // post | comment | reply | decide | opinion | intro | ...
  runIndex: number; // 0..k-1 (repeated samples for variance)
  output: string;
  vectorFidelity: number | null; // cosine(output, persona spec) in [-1, 1]
  judgeScore: number | null; // optional LLM-judge "on-character" score [0, 100]
  ruleScore: number | null; // optional deterministic rule adherence [0, 1]
  ruleDetail: string;
  latencyMs: number | null;
  capturedAt: Date;
}

export type BenchmarkRunDocument = HydratedDocument<BenchmarkRunAttrs>;
export type BenchmarkRunModel = Model<BenchmarkRunAttrs>;

const BenchmarkRunSchema = new Schema<BenchmarkRunAttrs>(
  {
    batchId: { type: String, required: true, index: true },
    persona: { type: String, required: true },
    personaDisplay: { type: String, default: '' },
    model: { type: String, required: true },
    taskId: { type: String, required: true },
    taskKind: { type: String, default: '' },
    runIndex: { type: Number, required: true, default: 0 },
    output: { type: String, default: '', maxlength: 8000 },
    vectorFidelity: { type: Number, default: null },
    judgeScore: { type: Number, default: null },
    ruleScore: { type: Number, default: null },
    ruleDetail: { type: String, default: '', maxlength: 500 },
    latencyMs: { type: Number, default: null },
    capturedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Read paths: aggregate by model (leaderboard), by persona+model (matrix), and
// fetch every model's takes on one (persona, task) for the side-by-side view.
BenchmarkRunSchema.index({ persona: 1, model: 1, taskId: 1 });
BenchmarkRunSchema.index({ persona: 1, taskId: 1, model: 1, runIndex: 1 });

export const BenchmarkRun = model<BenchmarkRunAttrs, BenchmarkRunModel>(
  'BenchmarkRun',
  BenchmarkRunSchema,
);
