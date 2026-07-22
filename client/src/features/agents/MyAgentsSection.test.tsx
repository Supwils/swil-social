import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

// Mock the API layer — the component under test only cares about the contract.
vi.mock('@/api/myAgents.api', () => ({
  listMyAgents: vi.fn(),
  createMyAgent: vi.fn(),
  updateMyAgent: vi.fn(),
  rotateMyAgentKey: vi.fn(),
}));

import * as myAgentsApi from '@/api/myAgents.api';
import type { OwnedAgentDTO } from '@/api/types';
import { MyAgentsSection } from './MyAgentsSection';

const agent: OwnedAgentDTO = {
  id: '665f00000000000000000001',
  username: 'mybot',
  usernameDisplay: 'mybot',
  displayName: 'My Bot',
  agentBackend: 'claude',
  paused: false,
  postCount: 4,
  createdAt: '2026-07-20T00:00:00.000Z',
  lastActiveAt: null,
};

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MyAgentsSection />
    </QueryClientProvider>,
  );
}

describe('MyAgentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  // vitest runs with globals:false, so Testing Library cannot auto-register
  // its afterEach cleanup — without this, DOM accumulates across tests.
  afterEach(cleanup);

  it('renders the owned agents returned by the API', async () => {
    vi.mocked(myAgentsApi.listMyAgents).mockResolvedValue([agent]);

    renderSection();

    expect(await screen.findByText('@mybot')).toBeTruthy();
    expect(screen.getByText('My Bot')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('shows the empty state when there are no agents', async () => {
    vi.mocked(myAgentsApi.listMyAgents).mockResolvedValue([]);

    renderSection();

    expect(await screen.findByText("You haven't created any agents yet.")).toBeTruthy();
  });

  it('creates an agent and reveals the one-time key in a dialog', async () => {
    vi.mocked(myAgentsApi.listMyAgents).mockResolvedValue([]);
    vi.mocked(myAgentsApi.createMyAgent).mockResolvedValue({
      agent,
      key: 'sk-swil-deadbeef',
      warning: 'Store this key securely — it will not be shown again',
    });

    renderSection();
    await screen.findByText("You haven't created any agents yet.");

    fireEvent.change(screen.getByLabelText('Agent username'), { target: { value: 'mybot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    expect(await screen.findByText('sk-swil-deadbeef')).toBeTruthy();
    expect(vi.mocked(myAgentsApi.createMyAgent)).toHaveBeenCalledWith({
      username: 'mybot',
      displayName: undefined,
      agentBackend: 'claude',
    });
  });

  it('toggles pause through the API', async () => {
    // First fetch: running agent; after the mutation invalidates, the refetch
    // returns the paused state (mirrors the server).
    vi.mocked(myAgentsApi.listMyAgents)
      .mockResolvedValueOnce([agent])
      .mockResolvedValue([{ ...agent, paused: true }]);
    vi.mocked(myAgentsApi.updateMyAgent).mockResolvedValue({ ...agent, paused: true });

    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(vi.mocked(myAgentsApi.updateMyAgent)).toHaveBeenCalledWith(agent.id, { paused: true });
  });
});
