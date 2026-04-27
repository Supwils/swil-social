import { Router } from 'express';
import { z } from 'zod';
import { Event } from '../../models/event.model';
import { optionalUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import { ok } from '../../lib/respond';
import { logger } from '../../lib/logger';

/**
 * Lightweight analytics ingest. Accepts a batch (1–50) of client-side events
 * and inserts them with the resolved user (if any) and the requester IP.
 *
 * Best-effort: failures are logged but never surface to the client — analytics
 * loss must never break a session.
 */

const eventSchema = z.object({
  type: z.string().trim().min(1).max(50),
  sessionId: z.string().trim().min(1).max(100),
  context: z.record(z.unknown()).optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

export const eventsRouter = Router();

eventsRouter.post(
  '/',
  optionalUser,
  validate(batchSchema, 'body'),
  asyncHandler(async (req, res) => {
    const { events } = req.body as z.infer<typeof batchSchema>;
    const userId = req.user?._id ?? null;
    const ip = req.ip;

    try {
      await Event.insertMany(
        events.map((e) => ({
          type: e.type,
          userId,
          sessionId: e.sessionId,
          context: e.context ?? {},
          ip,
        })),
        { ordered: false },
      );
    } catch (err) {
      // Non-fatal — analytics writes never break the request
      logger.warn({ err, count: events.length }, 'event ingest partial failure');
    }
    return ok(res, { received: events.length });
  }),
);
