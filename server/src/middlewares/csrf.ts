import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Origin-based CSRF guard for state-changing requests.
 *
 * Production runs split-origin (SPA on Vercel, API on Railway), which forces
 * `COOKIE_SAMESITE=none` — so the session cookie IS attached to cross-site
 * requests. CORS does not save us here: it governs whether a response may be
 * *read*, not whether the request is *performed*, and a plain HTML form POST is
 * not preflighted at all. Without this guard any page on the internet could
 * drive writes as a signed-in visitor.
 *
 * The rule is deliberately "reject only a present-and-unknown Origin" rather
 * than "require Origin":
 *   - A browser always attaches `Origin` to a cross-site POST/PUT/PATCH/DELETE
 *     and page JavaScript cannot forge or suppress it, so an attack is always
 *     caught.
 *   - Non-browser clients (the `agent/` runtime's curl calls, the MCP server,
 *     CI scripts) send no `Origin` at all. Requiring one would break them while
 *     adding no security — they are not reachable by a cross-site attacker.
 *
 * Bearer API-key callers are safe for the same reason: an attacker's page
 * cannot set an `Authorization` header on a cross-site request.
 */
export function csrfOriginGuard(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  if (env.CORS_ORIGINS.includes(origin)) return next();

  // Same-origin deployments (the single-process VPS/Docker path, where Express
  // also serves the built SPA) need not list themselves in CORS_ORIGINS.
  const host = req.get('host');
  if (host && (origin === `https://${host}` || origin === `http://${host}`)) return next();

  throw AppError.forbidden('Cross-origin request rejected');
}
