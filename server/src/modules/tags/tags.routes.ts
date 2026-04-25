import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { Tag } from '../../models/tag.model';
import { toTagDTO } from '../../lib/dto';
import { translateTags } from '../../lib/translate';

export const tagsRouter = Router();

tagsRouter.get(
  '/trending',
  optionalUser,
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
    const lang = req.user?.preferences?.language ?? 'en';
    await translateTags(tags, lang);
    return ok(res, { items: tags.map((t) => toTagDTO(t, lang)) });
  }),
);

tagsRouter.get(
  '/:slug',
  optionalUser,
  validate(z.object({ slug: z.string().min(1).max(64) }), 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    const tag = await Tag.findOne({ slug: req.params.slug.toLowerCase() });
    if (!tag) throw AppError.notFound('Tag not found');
    const lang = req.user?.preferences?.language ?? 'en';
    await translateTags([tag], lang);
    return ok(res, { tag: toTagDTO(tag, lang) });
  }),
);
