import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { User, type UserDocument } from '../models/user.model';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDocument;
    }
  }
}

async function loadSessionUser(req: Request): Promise<UserDocument | null> {
  const userId = req.session?.userId;
  if (!userId) return null;
  const user = await User.findById(userId);
  if (!user || user.status !== 'active') {
    req.session.destroy(() => undefined);
    return null;
  }
  return user;
}

export async function requireUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await loadSessionUser(req);
    if (!user) return next(AppError.unauthenticated());
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await loadSessionUser(req);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
