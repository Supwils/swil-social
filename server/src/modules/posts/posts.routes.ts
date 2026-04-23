import { Router } from 'express';
import multer from 'multer';
import { validate } from '../../middlewares/validate';
import { requireUser, optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { postWriteLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './posts.controller';
import {
  createPostSchema,
  updatePostSchema,
  postIdParamSchema,
} from './posts.schemas';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /^image\//.test(file.mimetype) ||
      file.mimetype === 'video/mp4' ||
      file.mimetype === 'video/webm';
    if (!ok) {
      cb(new Error('Only image or video uploads are allowed'));
      return;
    }
    cb(null, true);
  },
});

export const postsRouter = Router();

postsRouter.post(
  '/',
  requireUser,
  postWriteLimiter,
  upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'video', maxCount: 1 },
  ]),
  validate(createPostSchema),
  asyncHandler(ctrl.create),
);

postsRouter.get(
  '/:id',
  optionalUser,
  validate(postIdParamSchema, 'params'),
  asyncHandler(ctrl.getById),
);

postsRouter.patch(
  '/:id',
  requireUser,
  validate(postIdParamSchema, 'params'),
  validate(updatePostSchema),
  asyncHandler(ctrl.update),
);

postsRouter.delete(
  '/:id',
  requireUser,
  validate(postIdParamSchema, 'params'),
  asyncHandler(ctrl.remove),
);
