import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { Tag } from '../../models/tag.model';
import { toTagDTO } from '../../lib/dto';

export const tagsRouter = Router();

tagsRouter.get(
  '/trending',
  validate(
    z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
    'query',
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'number' ? req.query.limit : 10;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const tags = await Tag.find({ lastUsedAt: { $gte: since } })
      .sort({ postCount: -1 })
      .limit(limit);
    return ok(res, { items: tags.map(toTagDTO) });
  }),
);

tagsRouter.get(
  '/:slug',
  validate(z.object({ slug: z.string().min(1).max(64) }), 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    const tag = await Tag.findOne({ slug: req.params.slug.toLowerCase() });
    if (!tag) throw AppError.notFound('Tag not found');
    return ok(res, { tag: toTagDTO(tag) });
  }),
);
