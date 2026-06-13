import { Router } from 'express';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './agents.controller';
import {
  agentEventIngest,
  behaviorSnapshotIngest,
  eventsQuery,
  listQuery,
  rangeQuery,
  snapshotIngest,
  usernameParam,
} from './agents.schemas';

export const agentsRouter = Router();

agentsRouter.use(requireUser);

agentsRouter.get('/', labReadLimiter, validate(listQuery, 'query'), asyncHandler(ctrl.list));
agentsRouter.get('/overview', labReadLimiter, asyncHandler(ctrl.overview));
agentsRouter.get('/graph', labReadLimiter, validate(rangeQuery, 'query'), asyncHandler(ctrl.graph));
agentsRouter.get(
  '/homogenization',
  labReadLimiter,
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.homogenization),
);
agentsRouter.post('/population-metric', snapshotIngestLimiter, asyncHandler(ctrl.recordPopulation));
agentsRouter.get(
  '/alerts',
  labReadLimiter,
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.alerts),
);

agentsRouter.get(
  '/:username/stats',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.stats),
);
agentsRouter.get(
  '/:username/drift',
  labReadLimiter,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.drift),
);
agentsRouter.get(
  '/:username/events',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(eventsQuery, 'query'),
  asyncHandler(ctrl.events),
);
agentsRouter.post(
  '/:username/events',
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(agentEventIngest, 'body'),
  asyncHandler(ctrl.ingestEvent),
);
agentsRouter.post(
  '/:username/snapshots',
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(snapshotIngest, 'body'),
  asyncHandler(ctrl.ingest),
);

agentsRouter.get(
  '/:username/fidelity',
  labReadLimiter,
  validate(usernameParam, 'params'),
  asyncHandler(ctrl.fidelity),
);
agentsRouter.get(
  '/:username/influences',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.influences),
);
agentsRouter.post(
  '/:username/behavior-snapshots',
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(behaviorSnapshotIngest, 'body'),
  asyncHandler(ctrl.ingestBehavior),
);
