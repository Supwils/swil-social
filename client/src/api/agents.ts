import { http } from './client';
import type {
  AgentLabSummary,
  AgentEventDTO,
  AgentOverviewDTO,
  AgentStatsDTO,
  ApiEnvelope,
  DriftPoint,
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
