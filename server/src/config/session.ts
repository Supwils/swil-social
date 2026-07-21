import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { env, isProd } from './env';
import { pool } from '../db/client';

export const SESSION_COOKIE_NAME = 'sid';

const PgStore = connectPgSimple(session);

export function createSessionMiddleware() {
  return session({
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new PgStore({
      pool,
      tableName: 'session',
      createTableIfMissing: false,
      ttl: 60 * 60 * 24 * 30,
      pruneSessionInterval: 60 * 60,
    }),
    cookie: {
      httpOnly: true,
      secure: env.COOKIE_SECURE || isProd,
      sameSite: env.COOKIE_SAMESITE,
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
