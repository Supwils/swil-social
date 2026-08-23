import { Router } from 'express';
import multer from 'multer';
import { validate } from '../../middlewares/validate';
import { requireUser, optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import * as ctrl from './users.controller';
import { ownedAgentsRouter } from '../ownedAgents/ownedAgents.routes';
import { updateMeSchema, usernameParamSchema, searchUsersQuerySchema } from './users.schemas';

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

// BYOA management (/users/me/agents/*). Must be registered before the
// GET /:username route so "me" is never captured as a username.
usersRouter.use('/me/agents', ownedAgentsRouter);

// Explore people tab. OpenRoute — anonymous visitors browse this list.
usersRouter.get(
  '/',
  optionalUser,
  validate(searchUsersQuerySchema, 'query'),
  asyncHandler(ctrl.search),
);

usersRouter.patch('/me', requireUser, validate(updateMeSchema), asyncHandler(ctrl.updateMe));

usersRouter.put('/me/avatar', requireUser, upload.single('image'), asyncHandler(ctrl.updateAvatar));

// Explore people-tab filters. OpenRoute — same anonymous contract as GET /.
usersRouter.get('/profile-tags', optionalUser, asyncHandler(ctrl.getPopularProfileTags));

usersRouter.get('/profile-tags/presets', asyncHandler(ctrl.getProfileTagPresets));

usersRouter.get(
  '/:username',
  optionalUser,
  validate(usernameParamSchema, 'params'),
  asyncHandler(ctrl.getByUsername),
);
