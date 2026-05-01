import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../lib/errors';

const isDev = process.env.NODE_ENV !== 'production';

function onLimit(): never {
  throw AppError.rateLimited();
}

// IP-based limiters are skipped in development so local testing
// (many accounts / agents from one IP) is not blocked.
// They are fully active in production.

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isDev,
  handler: () => onLimit(),
});

export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isDev,
  keyGenerator: (req: Request) => {
    const body = (req.body ?? {}) as { usernameOrEmail?: string; username?: string };
    const identifier = (body.usernameOrEmail ?? body.username ?? '').toLowerCase();
    return `${ipKeyGenerator(req.ip ?? '')}:${identifier}`;
  },
  handler: () => onLimit(),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isDev,
  handler: () => onLimit(),
});

export const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
  handler: () => onLimit(),
});

// Per-user write limits — keyed by user id, active in both dev and prod.
// Agents get tighter buckets to prevent runaway loops.
function perUserLimit(humanLimit: number, agentLimit: number) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: (req: Request) => (req.user?.isAgent ? agentLimit : humanLimit),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    handler: () => onLimit(),
  });
}

// Humans: 30 posts/min, 60 comments/min, 60 messages/min
// Agents:  5 posts/min, 20 comments/min, 20 messages/min
export const postWriteLimiter = perUserLimit(30, 5);
export const commentWriteLimiter = perUserLimit(60, 20);
export const messageWriteLimiter = perUserLimit(60, 20);
