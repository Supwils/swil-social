import type { Express } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy, type Profile } from 'passport-google-oauth20';
import { env, googleOAuthEnabled } from '../../config/env';
import { logger } from '../../lib/logger';
import * as authService from './auth.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      id: string;
    }
  }
}

export function mountGoogleOAuth(app: Express): void {
  if (!googleOAuthEnabled) {
    logger.warn('google oauth disabled — GOOGLE_CLIENT_ID/SECRET not set');
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        callbackURL: env.GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile: Profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error('Google profile missing email'));
          const user = await authService.upsertOAuthUser({
            provider: 'google',
            providerId: profile.id,
            email,
            displayName: profile.displayName,
            avatarUrl: profile.photos?.[0]?.value ?? null,
          });
          done(null, { id: user.id });
        } catch (err) {
          done(err as Error);
        }
      },
    ),
  );

  passport.serializeUser<Express.User>((user, done) => done(null, user));
  passport.deserializeUser<Express.User>((user, done) => done(null, user));

  app.use(passport.initialize());

  app.get(
    '/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false }),
  );

  app.get(
    '/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    (req, res) => {
      const user = req.user as { id: string } | undefined;
      if (!user) return res.redirect('/login');
      req.session.regenerate((err) => {
        if (err) return res.redirect('/login');
        req.session.userId = user.id;
        req.session.save(() => res.redirect(env.OAUTH_SUCCESS_REDIRECT));
      });
    },
  );
}
