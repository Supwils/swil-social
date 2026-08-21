import type { Request, Response } from 'express';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import * as svc from './agents.service';
import type {
  AgentEventIngestInput,
  BehaviorSnapshotIngestInput,
  BenchmarkRunIngestInput,
  SnapshotIngestInput,
} from './agents.schemas';

export async function list(req: Request, res: Response) {
  const limit = (req.query as { limit?: number }).limit ?? 50;
  const items = await svc.listAgents(limit);
  return ok(res, { items });
}

export async function stats(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getAgentStats(req.params.username, range);
  return ok(res, out);
}

export async function drift(req: Request, res: Response) {
  const snapshots = await svc.getDrift(req.params.username);
  return ok(res, { snapshots });
}

/**
 * Projected time-to-lockout for one account. A READ over the uncensored
 * `agent_events` measurement series — it computes a date and blocks nothing.
 */
export async function driftCountdown(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getDriftCountdown(req.params.username, range);
  return ok(res, out);
}

/**
 * Act-path collapse watch for one account. A READ over post lengths and the
 * act path's `maxSim` samples — it measures and blocks nothing.
 *
 * `range` is turned into an explicit window HERE, because the service takes a
 * window rather than a range: the fit moves by more than an order of magnitude
 * with the window (see `agents.collapse.ts`), so an analytical caller has to be
 * able to state the one it means. The HTTP surface keeps the same 7d/30d/90d
 * vocabulary as every other lab read.
 */
export async function collapse(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getCollapseWatch(
    req.params.username,
    svc.collapseWindow(range, new Date()),
  );
  return ok(res, out);
}

export async function overview(_req: Request, res: Response) {
  const out = await svc.getOverview();
  return ok(res, out);
}

export async function graph(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getInteractionGraph(range);
  return ok(res, out);
}

export async function homogenization(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getHomogenization(range);
  return ok(res, out);
}

export async function recordPopulation(_req: Request, res: Response) {
  const out = await svc.recordPopulationMetric();
  return ok(res, out, 201);
}

export async function pulse(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getPulse(range);
  return ok(res, out);
}

export async function alerts(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getAlerts(range);
  return ok(res, out);
}

export async function influences(req: Request, res: Response) {
  const range = ((req.query as { range?: '7d' | '30d' | '90d' }).range ?? '30d') as
    | '7d'
    | '30d'
    | '90d';
  const out = await svc.getInfluences(req.params.username, range);
  return ok(res, out);
}

export async function events(req: Request, res: Response) {
  const query = req.query as {
    limit?: number;
    type?: 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag';
  };
  const items = await svc.getAgentEvents(req.params.username, query.limit ?? 20, query.type);
  return ok(res, { items });
}

export async function ingestEvent(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const input = req.body as AgentEventIngestInput;
  const event = await svc.ingestAgentEvent(req.params.username, req.user, input);
  return ok(res, { event }, 201);
}

export async function ingest(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const input = req.body as SnapshotIngestInput;
  const out = await svc.ingestSnapshot(req.params.username, req.user, input);
  return ok(res, out, 201);
}

export async function fidelity(req: Request, res: Response) {
  const out = await svc.getFidelity(req.params.username);
  return ok(res, out);
}

export async function ingestBehavior(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const input = req.body as BehaviorSnapshotIngestInput;
  const out = await svc.ingestBehaviorSnapshot(req.params.username, req.user, input);
  return ok(res, out, 201);
}

export async function benchmarkIngest(req: Request, res: Response) {
  if (!req.user) throw AppError.unauthenticated();
  const input = req.body as BenchmarkRunIngestInput;
  const out = await svc.ingestBenchmarkRun(input);
  return ok(res, out, 201);
}

export async function benchmarkLeaderboard(_req: Request, res: Response) {
  const out = await svc.getBenchmarkLeaderboard();
  return ok(res, out);
}

export async function benchmarkMatrix(_req: Request, res: Response) {
  const out = await svc.getBenchmarkMatrix();
  return ok(res, out);
}

export async function benchmarkCompare(req: Request, res: Response) {
  const { persona, task } = req.query as { persona: string; task: string };
  const out = await svc.getBenchmarkCompare(persona, task);
  return ok(res, out);
}
