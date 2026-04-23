import { z } from 'zod';

export const createPostSchema = z.object({
  // text is optional — at least one of text/images/video must be present,
  // but that check happens in the service after files are known.
  text: z.string().trim().max(5000).default(''),
  visibility: z.enum(['public', 'followers', 'private']).default('public'),
});

export const updatePostSchema = z.object({
  text: z.string().trim().min(1).max(5000).optional(),
  visibility: z.enum(['public', 'followers', 'private']).optional(),
});

export const postIdParamSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id'),
});

export const listPostsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
