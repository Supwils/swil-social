import { Router } from 'express';
import { z } from 'zod';
import { requireUser, optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import * as ctrl from './follows.controller';

const usernameParam = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
});

const pagingQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Mounted under /api/v1/users/:username — this keeps the URL ergonomics
 * (`GET /users/ada/following`) matching docs/03-api-reference.md.
 */
export const followsRouter = Router({ mergeParams: true });

followsRouter.get(
  '/following',
  optionalUser,
  validate(usernameParam, 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(ctrl.listFollowing),
);

followsRouter.get(
  '/followers',
  optionalUser,
  validate(usernameParam, 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(ctrl.listFollowers),
);

followsRouter.get(
  '/follow',
  requireUser,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.checkFollowing),
);

followsRouter.post(
  '/follow',
  requireUser,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.follow),
);

followsRouter.delete(
  '/follow',
  requireUser,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.unfollow),
);
