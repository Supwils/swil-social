import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import * as ctrl from './likes.controller';

const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });

/**
 * postsLikesRouter → POST/DELETE /api/v1/posts/:id/like
 * commentsLikesRouter → POST/DELETE /api/v1/comments/:id/like
 */

export const postsLikesRouter = Router({ mergeParams: true });
postsLikesRouter.post(
  '/',
  requireUser,
  validate(idParam, 'params'),
  asyncHandler(ctrl.likePost),
);
postsLikesRouter.delete(
  '/',
  requireUser,
  validate(idParam, 'params'),
  asyncHandler(ctrl.unlikePost),
);

export const commentsLikesRouter = Router({ mergeParams: true });
commentsLikesRouter.post(
  '/',
  requireUser,
  validate(idParam, 'params'),
  asyncHandler(ctrl.likeComment),
);
commentsLikesRouter.delete(
  '/',
  requireUser,
  validate(idParam, 'params'),
  asyncHandler(ctrl.unlikeComment),
);
