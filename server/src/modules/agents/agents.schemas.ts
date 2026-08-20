import { z } from 'zod';

export const usernameParam = z.object({
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
});

export const rangeQuery = z.object({
  range: z.enum(['7d', '30d', '90d']).optional().default('30d'),
});

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  type: z
    .enum(['cycle', 'dream', 'snapshot', 'memory', 'echo_flag', 'rule_check', 'anomaly'])
    .optional(),
});

export const aspectDriftIngest = z.object({
  mode: z.enum(['shadow', 'aspect']),
  promptVersion: z.number().int().nonnegative(),
  // cosine sims of normalized bge-m3 vectors, in [-1, 1]
  values: z.number().min(-1).max(1),
  style: z.number().min(-1).max(1),
  topic: z.number().min(-1).max(1),
  breached: z.array(z.enum(['values', 'style', 'topic'])).default([]),
});

export const snapshotIngest = z.object({
  contentHash: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/i, 'contentHash must be hex sha256'),
  embedding: z.array(z.number().finite()).min(64).max(4096),
  snapshotType: z.enum(['anchor', 'dream']).default('dream'),
  capturedAt: z.coerce.date().optional(),
  archivePath: z.string().max(300),
  excerpt: z.string().max(320).optional().default(''),
  diffNarrative: z.string().max(2000).optional(),
  aspectDrift: aspectDriftIngest.optional(),
});

export const agentEventIngest = z.object({
  type: z.enum(['cycle', 'dream', 'snapshot', 'memory', 'echo_flag', 'rule_check', 'anomaly']),
  phase: z.enum(['act', 'dream', 'snapshot', 'memory', 'echo', 'rule', 'anomaly']),
  outcome: z.enum(['started', 'success', 'skip', 'fail', 'warn', 'flagged', 'cleared']),
  action: z
    .enum(['post', 'comment', 'like', 'follow', 'unfollow', 'delete', 'dm', 'echo', 'nothing'])
    .optional(),
  summary: z.string().trim().min(1).max(500),
  reason: z.string().trim().max(300).optional(),
  targetId: z.string().trim().max(80).optional(),
  // When the thing being recorded happened, if that is not "now". The column
  // it overrides is `created_at` (agent_events has no `captured_at`), which is
  // also the column every /lab read orders and filters by -- so an event about
  // a past moment has to carry that moment or it lands beside the wrong part
  // of the series it exists to annotate. Named `occurredAt` and NOT
  // `capturedAt` on purpose: the other three ingest DTOs' `capturedAt` maps to
  // a real `captured_at` column, and reusing the name for a different column
  // is what sends a reader to the wrong one.
  occurredAt: z.coerce.date().optional(),
  metrics: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .default({}),
});

export const behaviorSnapshotIngest = z.object({
  contentHash: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/i, 'contentHash must be hex sha256'),
  embedding: z.array(z.number().finite()).min(64).max(4096),
  capturedAt: z.coerce.date().optional(),
  postCount: z.coerce.number().int().min(0).optional().default(0),
  commentCount: z.coerce.number().int().min(0).optional().default(0),
  excerpt: z.string().max(320).optional().default(''),
});

export const benchmarkRunIngest = z.object({
  batchId: z.string().trim().min(1).max(80),
  persona: z
    .string()
    .min(2)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
  personaDisplay: z.string().max(80).optional().default(''),
  model: z.string().trim().min(1).max(40),
  taskId: z.string().trim().min(1).max(60),
  taskKind: z.string().trim().max(40).optional().default(''),
  runIndex: z.coerce.number().int().min(0).max(64).optional().default(0),
  output: z.string().max(8000).optional().default(''),
  vectorFidelity: z.number().min(-1).max(1).nullable().optional().default(null),
  judgeScore: z.number().min(0).max(100).nullable().optional().default(null),
  ruleScore: z.number().min(0).max(1).nullable().optional().default(null),
  ruleDetail: z.string().max(500).optional().default(''),
  latencyMs: z.coerce.number().int().min(0).nullable().optional().default(null),
  capturedAt: z.coerce.date().optional(),
});

export const benchmarkCompareQuery = z.object({
  persona: z
    .string()
    .min(2)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/),
  task: z.string().trim().min(1).max(60),
});

export type SnapshotIngestInput = z.infer<typeof snapshotIngest>;
export type BehaviorSnapshotIngestInput = z.infer<typeof behaviorSnapshotIngest>;
export type AgentEventIngestInput = z.infer<typeof agentEventIngest>;
export type BenchmarkRunIngestInput = z.infer<typeof benchmarkRunIngest>;
