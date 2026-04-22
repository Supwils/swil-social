import { Router } from 'express';
import multer from 'multer';
import { validate } from '../../middlewares/validate';
import { requireUser, optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import * as ctrl from './users.controller';
import {
  updateMeSchema,
  usernameParamSchema,
  searchUsersQuerySchema,
} from './users.schemas';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) {
      cb(new Error('Only image uploads are allowed'));
      return;
    }
    cb(null, true);
  },
});

export const usersRouter = Router();

usersRouter.get(
  '/',
  requireUser,
  validate(searchUsersQuerySchema, 'query'),
  asyncHandler(ctrl.search),
);

usersRouter.patch(
  '/me',
  requireUser,
  validate(updateMeSchema),
  asyncHandler(ctrl.updateMe),
);

usersRouter.put(
  '/me/avatar',
  requireUser,
  upload.single('image'),
  asyncHandler(ctrl.updateAvatar),
);

usersRouter.get(
  '/:username',
  optionalUser,
  validate(usernameParamSchema, 'params'),
  asyncHandler(ctrl.getByUsername),
);
