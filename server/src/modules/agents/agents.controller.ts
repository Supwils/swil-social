import type { Request, Response } from 'express';
import { ok } from '../../lib/respond';
import { AppError } from '../../lib/errors';
import * as svc from './agents.service';
import type {
  AgentEventIngestInput,
  BehaviorSnapshotIngestInput,
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
