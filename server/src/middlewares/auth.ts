import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { AppError } from '../lib/errors';
import { db } from '../db/client';
import { users, apiKeys } from '../db/schema';
import type { UserRow } from '../lib/dto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

async function loadSessionUser(req: Request): Promise<UserRow | null> {
  const userId = req.session?.userId;
  if (!userId) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== 'active') {
    req.session.destroy(() => undefined);
    return null;
  }
  return user;
}

async function loadApiKeyUser(req: Request): Promise<UserRow | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const raw = auth.slice(7).trim();
  if (!raw.startsWith('sk-swil-')) return null;

  const keyHash = createHash('sha256').update(raw).digest('hex');
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  if (!apiKey) return null;

  const [user] = await db.select().from(users).where(eq(users.id, apiKey.userId)).limit(1);
  if (!user || user.status !== 'active') return null;

  // Update lastUsedAt without blocking the request.
  void (async () => {
    try {
      await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, apiKey.id));
    } catch {
      /* fire-and-forget */
    }
  })();
  return user;
}

async function resolveUser(req: Request): Promise<UserRow | null> {
  // API Key takes precedence so agents don't need cookies at all
  const fromKey = await loadApiKeyUser(req);
  if (fromKey) return fromKey;
  return loadSessionUser(req);
}

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
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
