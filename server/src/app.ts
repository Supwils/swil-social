import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { createSessionMiddleware } from './config/session';
import { requestLogger } from './middlewares/requestLogger';
import { globalLimiter } from './middlewares/rateLimit';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { postsRouter } from './modules/posts/posts.routes';
import { postsCommentsRouter, commentsRouter } from './modules/comments/comments.routes';
import { postsLikesRouter, commentsLikesRouter } from './modules/likes/likes.routes';
import { followsRouter } from './modules/follows/follows.routes';
import { tagsRouter } from './modules/tags/tags.routes';
import { feedRouter, userPostsRouter } from './modules/feed/feed.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { conversationsRouter } from './modules/messages/messages.routes';
import { bookmarksRouter, postsBookmarkRouter } from './modules/bookmarks/bookmarks.routes';
import { eventsRouter } from './modules/events/events.routes';
import { isDbHealthy } from './config/db';
import { mountStaticClient } from './middlewares/staticClient';

export interface AppOptions {
  /**
   * Optional session middleware injected from the bootstrapper. Passed in so
   * the same instance can be reused by Socket.io's engine.
   */
  sessionMiddleware?: RequestHandler;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestLogger);

  // CSP: tight allowlist. External hosts we genuinely need are the image CDNs
  // the app displays (Cloudinary for user uploads; Picsum/Dicebear for seed
  // data) and Google Fonts until we self-host. Loosen only when the need is
  // real and documented; never go `'unsafe-inline'` for scripts.
  const selfOnly = ["'self'"];
  const imageSrc = [
    "'self'",
    'data:',
    'blob:',
    'https://res.cloudinary.com',
    'https://picsum.photos',
    'https://fastly.picsum.photos',
    'https://api.dicebear.com',
  ];
  const fontAndStyleHosts = [
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ];
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: selfOnly,
          // Vite's HMR needs 'unsafe-eval' in dev; drop it in prod.
          scriptSrc: env.NODE_ENV === 'production' ? selfOnly : ["'self'", "'unsafe-eval'"],
          // CSS Modules compile to static sheets, but we use some inline
          // Google Fonts CSS link (which becomes a stylesheet request); allow
          // the fonts.googleapis.com host rather than 'unsafe-inline'.
          styleSrc: ["'self'", "'unsafe-inline'", ...fontAndStyleHosts],
          fontSrc: ["'self'", 'data:', ...fontAndStyleHosts],
          imgSrc: imageSrc,
          connectSrc: ["'self'", 'ws:', 'wss:'],
          mediaSrc: ["'self'", 'https://res.cloudinary.com'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: selfOnly,
          formAction: selfOnly,
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      strictTransportSecurity:
        env.NODE_ENV === 'production'
          ? { maxAge: 60 * 60 * 24 * 365, includeSubDomains: true, preload: false }
          : false,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );
  // 100 kb is plenty for JSON payloads. Image uploads go through multer
  // (multipart), not this parser, so tightening this does not affect uploads.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // Strip MongoDB operator keys ($...) from request inputs to prevent
  // query injection. Zod catches most cases, but this is defense-in-depth.
  app.use((req, _res, next) => {
    const strip = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        if (key.startsWith('$') || key.includes('.')) {
          delete (obj as Record<string, unknown>)[key];
        } else {
          strip((obj as Record<string, unknown>)[key]);
        }
      }
    };
    strip(req.body);
    strip(req.query);
    next();
  });
  app.use(cookieParser());
  app.use(opts.sessionMiddleware ?? createSessionMiddleware());

  app.use(globalLimiter);

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      mongo: isDbHealthy() ? 'ok' : 'down',
      version: process.env.npm_package_version ?? 'unknown',
    });
  });

  // v1 API
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/users/:username', followsRouter);
  app.use('/api/v1/users/:username/posts', userPostsRouter);
  app.use('/api/v1/posts', postsRouter);
  app.use('/api/v1/posts/:id/comments', postsCommentsRouter);
  app.use('/api/v1/posts/:id/like', postsLikesRouter);
  app.use('/api/v1/comments', commentsRouter);
  app.use('/api/v1/comments/:id/like', commentsLikesRouter);
  app.use('/api/v1/tags', tagsRouter);
  app.use('/api/v1/feed', feedRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/conversations', conversationsRouter);
  app.use('/api/v1/bookmarks', bookmarksRouter);
  app.use('/api/v1/posts/:id/bookmark', postsBookmarkRouter);
  app.use('/api/v1/events', eventsRouter);

  // In prod (or when SERVE_CLIENT=true), serve the built client from the same
  // origin. Must come AFTER API routes so API 404s aren't swallowed by the
  // SPA fallback, but BEFORE notFoundHandler so the fallback can claim GETs.
  mountStaticClient(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
