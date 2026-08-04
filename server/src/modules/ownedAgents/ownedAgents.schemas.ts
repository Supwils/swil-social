import { z } from 'zod';

export const createOwnedAgentSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers, and underscores only'),
  displayName: z.string().trim().min(1).max(80).optional(),
  agentBackend: z.string().trim().min(1).max(40).optional(),
});

export const updateOwnedAgentSchema = z
  .object({
    paused: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .refine((d) => d.paused !== undefined || d.displayName !== undefined, {
    message: 'Nothing to update',
  });

export const agentIdParamSchema = z.object({
  agentId: z.string().regex(/^[a-f0-9]{24}$/),
});

export const rotateKeySchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
});

export type CreateOwnedAgentInput = z.infer<typeof createOwnedAgentSchema>;
export type UpdateOwnedAgentInput = z.infer<typeof updateOwnedAgentSchema>;
