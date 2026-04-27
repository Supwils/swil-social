import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { optionalUser, requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { decodeCursor, decodeScoreCursor, parseLimit } from '../../lib/pagination';
import { toPostDTO, type PostDTOContext } from '../../lib/dto';
import type { PostDocument } from '../../models/post.model';
import { translatePosts } from '../../lib/translate';
import * as feed from './feed.service';

const pagingQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  lang: z.string().max(8).optional(),
});

function pageToDtos(items: PostDocument[], ctxById: Map<string, PostDTOContext>) {
  return items
    .map((p) => {
      const ctx = ctxById.get(p._id.toString());
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export const feedRouter = Router();

feedRouter.get(
  '/',
  requireUser,
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const cursor = decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const page = await feed.following(req.user, cursor, limit);
    await translatePosts(page.items, page.ctxById, req.user.preferences?.language ?? 'en');
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

feedRouter.get(
  '/global',
  optionalUser,
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const cursor = decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const page = await feed.global(req.user ?? null, cursor, limit);
    const lang = req.user?.preferences?.language ?? (req.query.lang as string | undefined) ?? 'en';
    await translatePosts(page.items, page.ctxById, lang);
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

feedRouter.get(
  '/tag/:slug',
  optionalUser,
  validate(z.object({ slug: z.string().min(1).max(64) }), 'params'),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const cursor = decodeScoreCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const page = await feed.byTag(req.params.slug, req.user ?? null, cursor, limit);
    const lang = req.user?.preferences?.language ?? (req.query.lang as string | undefined) ?? 'en';
    await translatePosts(page.items, page.ctxById, lang);
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);

feedRouter.get(
  '/explore-summary',
  requireUser,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const summary = await feed.getExploreSummary(req.user);
    return ok(res, summary);
  }),
);

/** Posts by author — used by profile pages. Mounted at /users/:username/posts too for ergonomics. */
export const userPostsRouter = Router({ mergeParams: true });

userPostsRouter.get(
  '/',
  optionalUser,
  validate(
    z.object({ username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/) }),
    'params',
  ),
  validate(pagingQuery, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const cursor = decodeCursor(req.query.cursor);
    const limit = parseLimit(req.query.limit, 20);
    const page = await feed.byAuthor(req.params.username, req.user ?? null, cursor, limit);
    const lang = req.user?.preferences?.language ?? (req.query.lang as string | undefined) ?? 'en';
    await translatePosts(page.items, page.ctxById, lang);
    return ok(res, { items: pageToDtos(page.items, page.ctxById), nextCursor: page.nextCursor });
  }),
);
