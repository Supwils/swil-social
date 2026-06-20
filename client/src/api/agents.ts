import { http } from './client';
import type {
  AgentLabSummary,
  AgentEventDTO,
  AgentOverviewDTO,
  AgentStatsDTO,
  AlertsDTO,
  ApiEnvelope,
  DriftPoint,
  FidelityDTO,
  HomogenizationDTO,
  InfluencesDTO,
  InteractionGraphDTO,
  PulseDTO,
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

export async function getPopulationPulse(
  range: '7d' | '30d' | '90d' = '30d',
): Promise<PulseDTO> {
  const { data } = await http.get<ApiEnvelope<PulseDTO>>(`/agents/pulse?range=${range}`);
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
