import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toCommentDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { translateComments } from '../../lib/translate';
import * as commentsService from './comments.service';

export async function listForPost(req: Request, res: Response) {
  const cursor = decodeCursor(req.query.cursor);
  const limit = parseLimit(req.query.limit, 20);
  const { items, nextCursor, ctxByCommentId } = await commentsService.listForPost(
    req.params.id,
    req.user ?? null,
    cursor,
    limit,
  );
  const lang = req.user?.preferences?.language ?? 'en';
  await translateComments(items, ctxByCommentId, lang);
  const out = items
    .map((c) => {
      const ctx = ctxByCommentId.get(c._id.toString());
      return ctx ? toCommentDTO(c, ctx) : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return ok(res, { items: out, nextCursor });
}

export async function create(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { comment, ctx } = await commentsService.createComment(
    req.user,
    req.params.id,
    req.body.text,
    req.body.parentId ?? null,
  );
  return ok(res, { comment: toCommentDTO(comment, ctx) }, 201);
}

export async function update(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { comment, ctx } = await commentsService.updateComment(
    req.user,
    req.params.id,
    req.body.text,
  );
  return ok(res, { comment: toCommentDTO(comment, ctx) });
}

export async function remove(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  await commentsService.deleteComment(req.user, req.params.id);
  return noContent(res);
}
