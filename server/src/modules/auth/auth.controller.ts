import type { Request, Response } from 'express';
import { ok, noContent } from '../../lib/respond';
import { toUserDTO } from '../../lib/dto';
import * as authService from './auth.service';
import { AppError } from '../../lib/errors';

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

export async function register(req: Request, res: Response) {
  const user = await authService.register(req.body);
  await regenerateSession(req);
  req.session.userId = user.id;
  await saveSession(req);
  return ok(res, { user: toUserDTO(user, { self: true }) }, 201);
}

export async function login(req: Request, res: Response) {
  const user = await authService.authenticate(req.body);
  await regenerateSession(req);
  req.session.userId = user.id;
  await saveSession(req);
  return ok(res, { user: toUserDTO(user, { self: true }) });
}

export async function logout(req: Request, res: Response) {
  await destroySession(req);
  res.clearCookie('sid');
  return noContent(res);
}

export async function me(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  return ok(res, { user: toUserDTO(req.user, { self: true }) });
}

export async function changePassword(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user, currentPassword, newPassword);
  const currentSid = req.sessionID;
  await authService.destroyOtherSessions(req.user.id, currentSid);
  await regenerateSession(req);
  req.session.userId = req.user.id;
  await saveSession(req);
  return noContent(res);
}
