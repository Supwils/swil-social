import type { Request, Response } from 'express';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import * as likesService from './likes.service';
import type { LikeTarget } from '../../models/like.model';

function makeLike(targetType: LikeTarget) {
  return async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const out = await likesService.like(req.user, targetType, req.params.id);
    return ok(res, out);
  };
}

function makeUnlike(targetType: LikeTarget) {
  return async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const out = await likesService.unlike(req.user, targetType, req.params.id);
    return ok(res, out);
  };
}

export const likePost = makeLike('post');
export const unlikePost = makeUnlike('post');
export const likeComment = makeLike('comment');
export const unlikeComment = makeUnlike('comment');
