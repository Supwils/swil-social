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
  limits: { fileSize: 5 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) {
      cb(new Error('Only image uploads are allowed'));
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
  upload.array('images', 4),
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
