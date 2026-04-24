import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import * as ctrl from './bookmarks.controller';

const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });

export const bookmarksRouter = Router();
bookmarksRouter.get('/', requireUser, asyncHandler(ctrl.list));

export const postsBookmarkRouter = Router({ mergeParams: true });
postsBookmarkRouter.post('/', requireUser, validate(idParam, 'params'), asyncHandler(ctrl.bookmarkPost));
postsBookmarkRouter.delete('/', requireUser, validate(idParam, 'params'), asyncHandler(ctrl.unbookmarkPost));
