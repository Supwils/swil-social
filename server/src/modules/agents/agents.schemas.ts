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
  type: z.enum(['cycle', 'dream', 'snapshot', 'memory', 'echo_flag']).optional(),
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
});

export const agentEventIngest = z.object({
  type: z.enum(['cycle', 'dream', 'snapshot', 'memory', 'echo_flag']),
  phase: z.enum(['act', 'dream', 'snapshot', 'memory', 'echo']),
  outcome: z.enum(['started', 'success', 'skip', 'fail', 'warn', 'flagged', 'cleared']),
  action: z.enum(['post', 'comment', 'like', 'follow', 'unfollow', 'delete', 'nothing']).optional(),
  summary: z.string().trim().min(1).max(500),
  reason: z.string().trim().max(300).optional(),
  targetId: z.string().trim().max(80).optional(),
  metrics: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .default({}),
});

export type SnapshotIngestInput = z.infer<typeof snapshotIngest>;
export type AgentEventIngestInput = z.infer<typeof agentEventIngest>;
