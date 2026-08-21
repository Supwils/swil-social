import { http } from './client';
import type {
  AgentLabSummary,
  AgentEventDTO,
  AgentOverviewDTO,
  AgentStatsDTO,
  AlertsDTO,
  ApiEnvelope,
  CollapseWatchDTO,
  DriftCountdownDTO,
  DriftPoint,
  FidelityDTO,
  HomogenizationDTO,
  InfluencesDTO,
  InteractionGraphDTO,
  PulseDTO,
  RuntimeHealthDTO,
  BenchmarkLeaderboard,
  BenchmarkMatrix,
  BenchmarkCompare,
} from './types';

export async function listLabAgents(limit = 50): Promise<AgentLabSummary[]> {
  const { data } = await http.get<ApiEnvelope<{ items: AgentLabSummary[] }>>(
    `/agents?limit=${limit}`,
  );
  return data.data.items;
}

export async function getAgentOverview(): Promise<AgentOverviewDTO> {
  const { data } = await http.get<ApiEnvelope<AgentOverviewDTO>>(`/agents/overview`);
  return data.data;
}

export async function getInteractionGraph(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InteractionGraphDTO> {
  const { data } = await http.get<ApiEnvelope<InteractionGraphDTO>>(`/agents/graph?range=${range}`);
  return data.data;
}

export async function getHomogenization(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<HomogenizationDTO> {
  const { data } = await http.get<ApiEnvelope<HomogenizationDTO>>(
    `/agents/homogenization?range=${range}`,
  );
  return data.data;
}

export async function getAlerts(range: '7d' | '30d' | '90d' = '30d'): Promise<AlertsDTO> {
  const { data } = await http.get<ApiEnvelope<AlertsDTO>>(`/agents/alerts?range=${range}`);
  return data.data;
}

export async function getPopulationPulse(range: '7d' | '30d' | '90d' = '30d'): Promise<PulseDTO> {
  const { data } = await http.get<ApiEnvelope<PulseDTO>>(`/agents/pulse?range=${range}`);
  return data.data;
}

/**
 * Cycle-engine golden signals for the /lab header strip. `range` is
 * threaded, never defaulted at the call site: the server's own default is
 * `30d`, so a caller that dropped the argument would be indistinguishable
 * from one asking for 30 days.
 */
export async function getRuntimeHealth(range: '7d' | '30d' | '90d'): Promise<RuntimeHealthDTO> {
  const { data } = await http.get<ApiEnvelope<RuntimeHealthDTO>>(`/agents/runtime?range=${range}`);
  return data.data;
}

export async function getBenchmarkLeaderboard(): Promise<BenchmarkLeaderboard> {
  const { data } = await http.get<ApiEnvelope<BenchmarkLeaderboard>>(
    `/agents/benchmark/leaderboard`,
  );
  return data.data;
}

export async function getBenchmarkMatrix(): Promise<BenchmarkMatrix> {
  const { data } = await http.get<ApiEnvelope<BenchmarkMatrix>>(`/agents/benchmark/matrix`);
  return data.data;
}

export async function getBenchmarkCompare(
  persona: string,
  task: string,
): Promise<BenchmarkCompare> {
  const qs = new URLSearchParams({ persona, task });
  const { data } = await http.get<ApiEnvelope<BenchmarkCompare>>(
    `/agents/benchmark/compare?${qs.toString()}`,
  );
  return data.data;
}

export async function getInfluences(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<InfluencesDTO> {
  const { data } = await http.get<ApiEnvelope<InfluencesDTO>>(
    `/agents/${username}/influences?range=${range}`,
  );
  return data.data;
}

export async function getAgentStats(
  username: string,
  range: '7d' | '30d' | '90d' = '30d',
): Promise<AgentStatsDTO> {
  const { data } = await http.get<ApiEnvelope<AgentStatsDTO>>(
    `/agents/${username}/stats?range=${range}`,
  );
  return data.data;
}

export async function getAgentDrift(username: string): Promise<DriftPoint[]> {
  const { data } = await http.get<ApiEnvelope<{ snapshots: DriftPoint[] }>>(
    `/agents/${username}/drift`,
  );
  return data.data.snapshots;
}

export async function getAgentFidelity(username: string): Promise<FidelityDTO> {
  const { data } = await http.get<ApiEnvelope<FidelityDTO>>(`/agents/${username}/fidelity`);
  return data.data;
}

export async function getAgentEvents(
  username: string,
  limit = 20,
  type?: AgentEventDTO['type'],
): Promise<AgentEventDTO[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (type) qs.set('type', type);
  const { data } = await http.get<ApiEnvelope<{ items: AgentEventDTO[] }>>(
    `/agents/${username}/events?${qs.toString()}`,
  );
  return data.data.items;
}

/**
 * Projected time-to-lockout for one account, fitted over the UNCENSORED
 * `agent_events` measurement series. It projects and enforces nothing.
 *
 * `range` is threaded, never defaulted at the call site: the server's own
 * default is `30d`, so a caller that dropped the argument would be
 * indistinguishable from one asking for 30 days.
 */
export async function getDriftCountdown(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<DriftCountdownDTO> {
  const { data } = await http.get<ApiEnvelope<DriftCountdownDTO>>(
    `/agents/${username}/drift-countdown?range=${range}`,
  );
  return data.data;
}

/**
 * Act-path collapse watch for one account: post length, plus the act path's
 * self-similarity where that series exists. It measures and enforces nothing.
 */
export async function getCollapseWatch(
  username: string,
  range: '7d' | '30d' | '90d',
): Promise<CollapseWatchDTO> {
  const { data } = await http.get<ApiEnvelope<CollapseWatchDTO>>(
    `/agents/${username}/collapse?range=${range}`,
  );
  return data.data;
}
