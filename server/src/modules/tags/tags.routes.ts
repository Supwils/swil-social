import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { optionalUser, requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import { Tag } from '../../models/tag.model';
import { toTagDTO } from '../../lib/dto';
import { translateTags } from '../../lib/translate';

const patchTagSchema = z.object({
  description: z.string().trim().max(500).optional(),
  coverImage: z.string().url().max(512).optional().or(z.literal('')),
  featured: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
  pinnedPostIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(3).optional(),
  aliasSlugs: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const tagsRouter = Router();

const tagSearchSchema = z.object({
  q: z.string().trim().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

tagsRouter.get(
  '/search',
  optionalUser,
  validate(tagSearchSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const q = (req.query.q as string).toLowerCase();
    const limit = typeof req.query.limit === 'number' ? req.query.limit : 8;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tags = await Tag.find({
      slug: { $regex: new RegExp(`^${escaped}`) },
      isAlias: { $ne: true },
      postCount: { $gt: 0 },
    })
      .sort({ postCount: -1 })
      .limit(limit)
      .lean();
    const lang = req.user?.preferences?.language ?? 'en';
    return ok(res, { items: (tags as unknown as import('../../models/tag.model').TagDocument[]).map((t) => toTagDTO(t, lang)) });
  }),
);

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
    const tags = await Tag.find({ lastUsedAt: { $gte: since }, isAlias: { $ne: true } })
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

tagsRouter.patch(
  '/:slug',
  requireUser,
  validate(z.object({ slug: z.string().min(1).max(64) }), 'params'),
  validate(patchTagSchema, 'body'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw AppError.unauthenticated();
    const adminUsername = process.env.ADMIN_USERNAME;
    if (!adminUsername || req.user.username !== adminUsername) throw AppError.forbidden();

    const tag = await Tag.findOne({ slug: req.params.slug.toLowerCase() });
    if (!tag) throw AppError.notFound('Tag not found');

    const { description, coverImage, featured, status, pinnedPostIds, aliasSlugs } = req.body as z.infer<typeof patchTagSchema>;
    if (description !== undefined) tag.description = description;
    if (coverImage !== undefined) tag.coverImage = coverImage;
    if (featured !== undefined) tag.featured = featured;
    if (status !== undefined) tag.status = status;
    if (pinnedPostIds !== undefined) {
      const { Types } = await import('mongoose');
      tag.pinnedPostIds = pinnedPostIds.map((id) => new Types.ObjectId(id));
    }
    if (aliasSlugs !== undefined) {
      const aliasTags = await Tag.find({ slug: { $in: aliasSlugs.map((s) => s.toLowerCase()) } });
      tag.aliasIds = aliasTags.map((t) => t._id);
      await Tag.updateMany(
        { _id: { $in: aliasTags.map((t) => t._id) } },
        { $set: { isAlias: true } },
      );
    }

    await tag.save();
    return ok(res, { tag: toTagDTO(tag) });
  }),
);
