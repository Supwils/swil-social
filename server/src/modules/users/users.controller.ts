import type { Request, Response } from 'express';
import { ok } from '../../lib/respond';
import { toUserDTO, toUserLiteDTO } from '../../lib/dto';
import { AppError } from '../../lib/errors';
import * as usersService from './users.service';

export async function getByUsername(req: Request, res: Response) {
  const user = await usersService.findByUsername(req.params.username);
  const self = req.user?.id === user.id;
  return ok(res, { user: toUserDTO(user, { self }) });
}

export async function search(req: Request, res: Response) {
  const { search: query, tag, limit } = req.query as unknown as {
    search?: string;
    tag?: string;
    limit?: number;
  };
  const users = await usersService.searchUsers(query, tag, limit ?? 10);
  return ok(res, { items: users.map(toUserLiteDTO) });
}

export async function getPopularProfileTags(_req: Request, res: Response) {
  const tags = await usersService.getPopularProfileTags();
  return ok(res, { tags });
}

export async function updateMe(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const updated = await usersService.updateMe(req.user, req.body);
  return ok(res, { user: toUserDTO(updated, { self: true }) });
}

export async function updateAvatar(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  if (!req.file) throw AppError.validation('image file required', { image: 'required' });
  const updated = await usersService.updateAvatar(req.user, req.file.buffer);
  return ok(res, { avatarUrl: updated.avatarUrl });
}
