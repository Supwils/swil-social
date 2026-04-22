import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../lib/errors';

function onLimit(): never {
  throw AppError.rateLimited();
}

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: () => onLimit(),
});

export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const body = (req.body ?? {}) as { usernameOrEmail?: string; username?: string };
    const identifier = (body.usernameOrEmail ?? body.username ?? '').toLowerCase();
    return `${req.ip}:${identifier}`;
  },
  handler: () => onLimit(),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: () => onLimit(),
});

export const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: () => onLimit(),
});

/**
 * Per-user write limits. Keyed by user id, so these cover both direct-API
 * submission and any future path. Tuned to feel safe for normal use and
 * catch runaway scripts:
 *   - posts:      30 / minute per user
 *   - comments:   60 / minute per user
 *   - messages:   60 / minute per user
 */
function perUserLimit(limit: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
    handler: () => onLimit(),
  });
}

export const postWriteLimiter = perUserLimit(30);
export const commentWriteLimiter = perUserLimit(60);
export const messageWriteLimiter = perUserLimit(60);
