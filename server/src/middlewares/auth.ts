import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { User, type UserDocument } from '../models/user.model';
import { ApiKey } from '../models/apiKey.model';

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

async function loadApiKeyUser(req: Request): Promise<UserDocument | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const raw = auth.slice(7).trim();
  if (!raw.startsWith('sk-swil-')) return null;

  const keyHash = createHash('sha256').update(raw).digest('hex');
  const apiKey = await ApiKey.findOne({ keyHash });
  if (!apiKey) return null;

  const user = await User.findById(apiKey.userId);
  if (!user || user.status !== 'active') return null;

  // Update lastUsedAt without blocking the request
  ApiKey.updateOne({ _id: apiKey._id }, { lastUsedAt: new Date() }).catch(() => undefined);
  return user;
}

async function resolveUser(req: Request): Promise<UserDocument | null> {
  // API Key takes precedence so agents don't need cookies at all
  const fromKey = await loadApiKeyUser(req);
  if (fromKey) return fromKey;
  return loadSessionUser(req);
}

export async function requireUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await resolveUser(req);
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
    const user = await resolveUser(req);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
