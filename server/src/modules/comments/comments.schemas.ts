import { z } from 'zod';

const oid = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

export const createCommentSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  parentId: oid.nullable().optional(),
});

export const updateCommentSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const commentIdParamSchema = z.object({ id: oid });
export const postIdParamSchema = z.object({ id: oid });

export const listCommentsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
