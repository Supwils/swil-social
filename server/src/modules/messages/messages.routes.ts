import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middlewares/auth';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { messageWriteLimiter } from '../../middlewares/rateLimit';
import { ok, noContent } from '../../lib/respond';
import { decodeCursor, parseLimit } from '../../lib/pagination';
import { AppError } from '../../lib/errors';
import { User } from '../../models/user.model';
import { toConversationDTO } from '../../lib/dto';
import * as svc from './messages.service';

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const pagingQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const conversationsRouter = Router();

conversationsRouter.get(
  '/',
  requireUser,
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const out = await svc.listForViewer(req.user, cursor, limit);
    return ok(res, out);
  }),
);

conversationsRouter.post(
  '/',
  requireUser,
  validate(z.object({ recipientUsername: z.string().min(3).max(24) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const { conversation, created } = await svc.findOrCreateWith(
      req.user,
      req.body.recipientUsername,
    );
    const others = await User.find({
      _id: { $in: conversation.participantIds },
    });
    const dto = toConversationDTO(conversation, others, req.user.id, null);
    return ok(res, { conversation: dto }, created ? 201 : 200);
  }),
);

conversationsRouter.get(
  '/:id/messages',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 50);
    const out = await svc.listMessages(req.user, req.params.id, cursor, limit);
    return ok(res, out);
  }),
);

conversationsRouter.post(
  '/:id/messages',
  requireUser,
  messageWriteLimiter,
  validate(z.object({ id: oid }), 'params'),
  validate(z.object({ text: z.string().trim().min(1).max(4000) })),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const dto = await svc.send(req.user, req.params.id, req.body.text);
    return ok(res, { message: dto }, 201);
  }),
);

conversationsRouter.post(
  '/:id/read',
  requireUser,
  validate(z.object({ id: oid }), 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    await svc.markRead(req.user, req.params.id);
    return noContent(res);
  }),
);
