import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import * as svc from './bookmarks.service';

export async function bookmarkPost(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const result = await svc.bookmark(req.user, req.params.id);
  return ok(res, result, 201);
}

export async function unbookmarkPost(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await svc.unbookmark(req.user, req.params.id);
  return noContent(res);
}

export async function list(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const cursor = req.query.cursor as string | undefined;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const result = await svc.listBookmarks(req.user, cursor, limit);
  return ok(res, result);
}
