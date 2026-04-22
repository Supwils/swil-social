import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import * as followsService from './follows.service';

export async function follow(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await followsService.follow(req.user, req.params.username);
  return noContent(res);
}

export async function unfollow(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await followsService.unfollow(req.user, req.params.username);
  return noContent(res);
}

export async function listFollowing(req: Request, res: Response) {
  const cursor = decodeCursor(req.query.cursor);
  const limit = parseLimit(req.query.limit, 20);
  const out = await followsService.listFollowing(req.params.username, cursor, limit);
  return ok(res, out);
}

export async function listFollowers(req: Request, res: Response) {
  const cursor = decodeCursor(req.query.cursor);
  const limit = parseLimit(req.query.limit, 20);
  const out = await followsService.listFollowers(req.params.username, cursor, limit);
  return ok(res, out);
}
