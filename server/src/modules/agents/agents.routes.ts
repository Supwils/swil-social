import { Router } from 'express';
import { optionalUser, requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import { labReadLimiter, snapshotIngestLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './agents.controller';
import {
  agentEventIngest,
  behaviorSnapshotIngest,
  benchmarkCompareQuery,
  benchmarkRunIngest,
  eventsQuery,
  listQuery,
  rangeQuery,
  snapshotIngest,
  usernameParam,
} from './agents.schemas';

export const agentsRouter = Router();

// The observation lab is the point of this project, so its READS are public —
// a drift trajectory nobody can open without an account is not a result, it is
// a private log. Every GET below is aggregate, already-published data.
//
// INGEST stays authenticated: each POST carries `requireUser` explicitly rather
// than relying on a blanket router guard, so adding a new write route cannot
// silently inherit public access. The ingest controllers additionally re-check
// `req.user` themselves — belt and braces, since this is the boundary where a
// mistake would let anyone forge personality snapshots.
agentsRouter.use(optionalUser);

agentsRouter.get('/', labReadLimiter, validate(listQuery, 'query'), asyncHandler(ctrl.list));
agentsRouter.get('/overview', labReadLimiter, asyncHandler(ctrl.overview));
agentsRouter.get('/graph', labReadLimiter, validate(rangeQuery, 'query'), asyncHandler(ctrl.graph));
agentsRouter.get(
  '/homogenization',
  labReadLimiter,
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.homogenization),
);
agentsRouter.post(
  '/population-metric',
  requireUser,
  snapshotIngestLimiter,
  asyncHandler(ctrl.recordPopulation),
);
agentsRouter.get('/pulse', labReadLimiter, validate(rangeQuery, 'query'), asyncHandler(ctrl.pulse));
agentsRouter.get(
  '/runtime',
  labReadLimiter,
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.runtime),
);
agentsRouter.get(
  '/alerts',
  labReadLimiter,
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.alerts),
);

// Persona Bench (model-comparison eval lane). Registered before the
// `/:username/*` routes so these literal paths are matched first.
agentsRouter.post(
  '/benchmark/runs',
  requireUser,
  snapshotIngestLimiter,
  validate(benchmarkRunIngest, 'body'),
  asyncHandler(ctrl.benchmarkIngest),
);
agentsRouter.get('/benchmark/leaderboard', labReadLimiter, asyncHandler(ctrl.benchmarkLeaderboard));
agentsRouter.get('/benchmark/matrix', labReadLimiter, asyncHandler(ctrl.benchmarkMatrix));
agentsRouter.get(
  '/benchmark/compare',
  labReadLimiter,
  validate(benchmarkCompareQuery, 'query'),
  asyncHandler(ctrl.benchmarkCompare),
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
// Order relative to `/:username/drift` above is irrelevant: Express matches
// whole path segments, so `/x/drift-countdown` can never fall into the
// `/x/drift` handler. It sits here to read next to its neighbour.
agentsRouter.get(
  '/:username/drift-countdown',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.driftCountdown),
);
agentsRouter.get(
  '/:username/collapse',
  labReadLimiter,
  validate(usernameParam, 'params'),
  validate(rangeQuery, 'query'),
  asyncHandler(ctrl.collapse),
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
  requireUser,
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(agentEventIngest, 'body'),
  asyncHandler(ctrl.ingestEvent),
);
agentsRouter.post(
  '/:username/snapshots',
  requireUser,
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
  requireUser,
  snapshotIngestLimiter,
  validate(usernameParam, 'params'),
  validate(behaviorSnapshotIngest, 'body'),
  asyncHandler(ctrl.ingestBehavior),
);
