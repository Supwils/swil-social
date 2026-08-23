import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PostDTO } from '@/api/types';
import { useUI } from '@/stores/ui.store';

vi.mock('./PostCard', () => ({
  PostCard: ({ post, compact }: { post: { id: string; text: string }; compact?: boolean }) => (
    <article data-testid={`card-${post.id}`} data-compact={compact ? '1' : '0'}>
      {post.text}
    </article>
  ),
}));

vi.mock('./VirtualPostList', () => ({
  VirtualPostList: ({ items }: { items: Array<{ id: string }> }) => (
    <div data-testid="virtual-list">{items.length}</div>
  ),
}));

vi.mock('@/components/InfiniteScrollSentinel', () => ({
  InfiniteScrollSentinel: () => <div data-testid="sentinel" />,
}));

import { FeedSkeletons, FeedStream } from './FeedStream';

function post(id: string, text: string): PostDTO {
  return { id, text } as PostDTO;
}

afterEach(() => {
  cleanup();
  useUI.setState({ feedLayout: 'grid' });
  localStorage.removeItem('swil.ui');
});

describe('FeedStream', () => {
  it('renders two compact cards in folio (grid) layout', () => {
    useUI.setState({ feedLayout: 'grid' });
    render(
      <FeedStream
        items={[post('a', 'first'), post('b', 'second')]}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => undefined}
      />,
    );

    expect(screen.getByTestId('feed-grid')).toBeTruthy();
    expect(screen.getByTestId('card-a').getAttribute('data-compact')).toBe('1');
    expect(screen.getByTestId('card-b').getAttribute('data-compact')).toBe('1');
    expect(screen.queryByTestId('virtual-list')).toBeNull();
    expect(screen.getByTestId('sentinel')).toBeTruthy();
  });

  it('renders the virtualized reading column in list layout', () => {
    useUI.setState({ feedLayout: 'list' });
    render(
      <FeedStream
        items={[post('a', 'first'), post('b', 'second')]}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => undefined}
      />,
    );

    expect(screen.getByTestId('virtual-list').textContent).toBe('2');
    expect(screen.queryByTestId('feed-grid')).toBeNull();
  });
});

describe('FeedSkeletons', () => {
  it('places placeholders in the folio grid by default', () => {
    useUI.setState({ feedLayout: 'grid' });
    const { container } = render(<FeedSkeletons count={4} />);
    expect(screen.getByTestId('feed-skeletons')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="feed-skeletons"] > *')).toHaveLength(4);
  });

  it('stacks placeholders in the reading column', () => {
    useUI.setState({ feedLayout: 'list' });
    render(<FeedSkeletons count={2} />);
    expect(screen.getByTestId('feed-skeletons')).toBeTruthy();
  });
});
