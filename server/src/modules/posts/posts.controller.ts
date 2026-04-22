import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toPostDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import * as postsService from './posts.service';

export async function create(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const files = (req.files ?? []) as Express.Multer.File[];
  const { post, ctx } = await postsService.createPost(
    req.user,
    req.body,
    files.map((f) => f.buffer),
  );
  return ok(res, { post: toPostDTO(post, ctx) }, 201);
}

export async function getById(req: Request, res: Response) {
  const { post, ctx } = await postsService.getPostForViewer(
    req.params.id,
    req.user ?? null,
  );
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
