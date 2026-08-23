import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';

vi.mock('@/api/feed.api', () => ({ global: vi.fn() }));
vi.mock('@/api/tags.api', () => ({ trending: vi.fn() }));

vi.mock('@/features/posts/FeedStream', () => ({
  FeedStream: ({ items }: { items: Array<{ id: string; text: string }> }) => (
    <div data-testid="posts">
      {items.map((p) => (
        <p key={p.id}>{p.text}</p>
      ))}
    </div>
  ),
  FeedSkeletons: () => <div data-testid="feed-skeletons" />,
}));

import * as feedApi from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import FeedGlobalRoute from './feedGlobal';

function renderGlobal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/global']}>
        <Routes>
          <Route path="/global" element={<FeedGlobalRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeedGlobalRoute', () => {
  it('renders posts returned by the global feed and the layout toggle', async () => {
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockResolvedValue({
      items: [{ id: 'p1', text: '罗勒掐顶' }],
      nextCursor: null,
    } as never);

    renderGlobal();

    expect(await screen.findByRole('heading', { name: 'Global' })).toBeTruthy();
    expect(await screen.findByText('罗勒掐顶')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Feed layout' })).toBeTruthy();
  });

  it('shows the empty state when the river has no posts', async () => {
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockResolvedValue({ items: [], nextCursor: null });

    renderGlobal();

    expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
  });

  it('shows an error state that can retry', async () => {
    vi.mocked(tagsApi.trending).mockResolvedValue([]);
    vi.mocked(feedApi.global).mockRejectedValue(new Error('offline'));

    renderGlobal();

    expect(await screen.findByText("Couldn't load the feed")).toBeTruthy();
    await waitFor(() => expect(feedApi.global).toHaveBeenCalled());
  });
});
