import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';

vi.mock('@/api/agents', () => ({
  getAgentOverview: vi.fn(),
  getInteractionGraph: vi.fn(),
  listLabAgents: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/features/lab/RuntimeHealth', () => ({ RuntimeHealth: () => null }));
vi.mock('@/features/lab/PopulationHealth', () => ({ PopulationHealth: () => null }));
vi.mock('@/features/lab/DistributionPanel', () => ({ DistributionPanel: () => null }));
vi.mock('@/features/lab/BenchmarkView', () => ({ BenchmarkView: () => <div>bench-panel</div> }));
vi.mock('@/features/lab/CrossSpeciesPanel', () => ({ CrossSpeciesPanel: () => null }));
vi.mock('@/features/lab/GraphView', () => ({
  GraphView: () => <div>graph-panel</div>,
  AlertsStrip: () => null,
}));
vi.mock('@/features/lab/PopulationInsights', () => ({ PopulationInsights: () => null }));
vi.mock('@/features/lab/HomogenizationPanel', () => ({ HomogenizationPanel: () => null }));
vi.mock('@/features/lab/Overview', () => ({ Overview: () => null }));
vi.mock('@/features/lab/AgentGrid', () => ({ AgentGrid: () => <div data-testid="agent-grid" /> }));
vi.mock('@/features/lab/AgentDetail', () => ({ AgentDetail: () => null }));

import * as agentsApi from '@/api/agents';
import LabRoute from './lab';

function renderLab(path = '/lab') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <LabRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LabRoute', () => {
  it('renders the lab title, tabs, and the roster count from the wire', async () => {
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([
      { username: 'liushang' },
      { username: 'qiusai' },
    ] as never);
    vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({} as never);
    vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({ nodes: [], edges: [] } as never);

    renderLab();

    expect(await screen.findByRole('heading', { name: 'Agent Lab' })).toBeTruthy();
    expect(await screen.findByText(/Watching 2 AI/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Who talks to whom' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model bench' })).toBeTruthy();
  });

  it('switches to the benchmark view from the tab', async () => {
    vi.mocked(agentsApi.listLabAgents).mockResolvedValue([]);
    vi.mocked(agentsApi.getAgentOverview).mockResolvedValue({} as never);
    vi.mocked(agentsApi.getInteractionGraph).mockResolvedValue({ nodes: [], edges: [] } as never);

    renderLab();
    await screen.findByRole('heading', { name: 'Agent Lab' });
    fireEvent.click(screen.getByRole('button', { name: 'Model bench' }));
    expect(await screen.findByText('bench-panel')).toBeTruthy();
  });
});
