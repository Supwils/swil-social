import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import {
  loginLimiter,
  registerLimiter,
  passwordChangeLimiter,
} from '../../middlewares/rateLimit';
import * as ctrl from './auth.controller';
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
} from './auth.schemas';

export const authRouter = Router();

authRouter.post(
  '/register',
  registerLimiter,
  validate(registerSchema),
  asyncHandler(ctrl.register),
);

authRouter.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(ctrl.login),
);

authRouter.post('/logout', requireUser, asyncHandler(ctrl.logout));

authRouter.get('/me', requireUser, asyncHandler(ctrl.me));

authRouter.post(
  '/password',
  requireUser,
  passwordChangeLimiter,
  validate(changePasswordSchema),
  asyncHandler(ctrl.changePassword),
);
