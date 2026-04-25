import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toPostDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import { translatePosts } from '../../lib/translate';
import * as postsService from './posts.service';
import type { SearchPostsQuery } from './posts.schemas';

export async function create(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const fields = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const imageFiles = fields['images'] ?? [];
  const videoFile = fields['video']?.[0] ?? null;
  const { post, ctx } = await postsService.createPost(
    req.user,
    req.body,
    imageFiles.map((f) => f.buffer),
    videoFile?.buffer ?? null,
  );
  return ok(res, { post: toPostDTO(post, ctx) }, 201);
}

export async function getById(req: Request, res: Response) {
  const { post, ctx } = await postsService.getPostForViewer(
    req.params.id,
    req.user ?? null,
  );
  const lang = req.user?.preferences?.language ?? 'en';
  const ctxById = new Map([[post._id.toString(), ctx]]);
  await translatePosts([post], ctxById, lang);
  return ok(res, { post: toPostDTO(post, ctx) });
}

export async function update(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { post, ctx } = await postsService.updatePost(req.params.id, req.user, req.body);
  return ok(res, { post: toPostDTO(post, ctx) });
}

export async function remove(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await postsService.deletePost(req.params.id, req.user);
  return noContent(res);
}

export async function search(req: Request, res: Response) {
  const result = await postsService.searchPosts(req.query as unknown as SearchPostsQuery, req.user ?? null);
  return ok(res, result);
}
