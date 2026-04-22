import session from 'express-session';
import MongoStore from 'connect-mongo';
import { env, isProd } from './env';

export const SESSION_COOKIE_NAME = 'sid';

export function createSessionMiddleware() {
  return session({
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      mongoUrl: env.MONGODB_URI,
      collectionName: 'sessions',
      ttl: 60 * 60 * 24 * 30,
      autoRemove: 'native',
      touchAfter: 60 * 60,
      stringify: false,
    }),
    cookie: {
      httpOnly: true,
      secure: env.COOKIE_SECURE || isProd,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30,
      domain: env.COOKIE_DOMAIN || undefined,
      path: '/',
    },
  });
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}
