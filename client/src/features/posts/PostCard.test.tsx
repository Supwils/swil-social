import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import '@/i18n';
import type { PostDTO, UserLiteDTO } from '@/api/types';

vi.mock('@/api/likes.api', () => ({ likePost: vi.fn(), unlikePost: vi.fn() }));
vi.mock('@/api/posts.api', () => ({ update: vi.fn(), remove: vi.fn() }));
vi.mock('@/api/bookmarks.api', () => ({ bookmarkPost: vi.fn(), unbookmarkPost: vi.fn() }));

import { PostCard } from './PostCard';

function author(over: Partial<UserLiteDTO> = {}): UserLiteDTO {
  return {
    id: 'u-qiusai',
    username: 'qiusai',
    usernameDisplay: 'qiusai',
    displayName: '球赛',
    avatarUrl: null,
    headline: '',
    profileTags: [],
    isAgent: true,
    ...over,
  };
}

function post(over: Partial<PostDTO> = {}): PostDTO {
  return {
    id: 'p-basil',
    author: author(),
    text: '罗勒掐顶之后侧芽会更快。',
    images: [],
    video: null,
    tags: [{ slug: 'garden', display: 'garden' }],
    mentions: [],
    visibility: 'public',
    likeCount: 3,
    commentCount: 1,
    echoCount: 0,
    likedByMe: false,
    bookmarkedByMe: false,
    createdAt: '2026-08-20T08:00:00.000Z',
    editedAt: null,
    ...over,
  };
}

function renderCard(node: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('PostCard', () => {
  it('renders the author, body, and agent badge', () => {
    renderCard(<PostCard post={post()} />);

    expect(screen.getByText('球赛')).toBeTruthy();
    expect(screen.getByText('罗勒掐顶之后侧芽会更快。')).toBeTruthy();
    expect(screen.getByText('AI')).toBeTruthy();
    expect(screen.getByText('garden')).toBeTruthy();
  });

  it('offers read-more on compact cards and not on the reading-column card', () => {
    const { unmount } = renderCard(<PostCard post={post()} compact />);
    expect(screen.getByRole('button', { name: 'Read more' })).toBeTruthy();
    unmount();

    renderCard(<PostCard post={post()} />);
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
  });

  it('does not show the AI badge for a non-agent author', () => {
    renderCard(
      <PostCard post={post({ author: author({ isAgent: false, displayName: '绿窗' }) })} />,
    );

    expect(screen.getByText('绿窗')).toBeTruthy();
    expect(screen.queryByText('AI')).toBeNull();
  });

  it('shows the original text, not the translation, when toggled', () => {
    renderCard(
      <PostCard
        post={post({
          text: 'the basil pinch',
          originalText: '罗勒掐顶原文',
          originalLang: 'zh',
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /original/i }));
    expect(screen.getByText('罗勒掐顶原文')).toBeTruthy();
    expect(screen.queryByText('the basil pinch')).toBeNull();
  });

  it('does not nest a hashtag link inside another anchor', () => {
    const { container } = renderCard(
      <PostCard post={post({ text: 'pinch the basil #garden' })} compact />,
    );
    const inline = container.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    expect(inline?.parentElement?.closest('a')).toBeNull();
  });

  it('navigates to the post when the body is clicked', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<PostCard post={post()} compact />} />
            <Route path="/p/:id" element={<div>opened</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('罗勒掐顶之后侧芽会更快。'));
    expect(screen.getByText('opened')).toBeTruthy();
  });

  it('follows a hashtag instead of opening the post', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={<PostCard post={post({ text: 'pinch the basil #garden' })} compact />}
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
            <Route path="/tag/:slug" element={<div>opened-tag</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const inline = document.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    fireEvent.click(inline!);
    expect(screen.getByText('opened-tag')).toBeTruthy();
    expect(screen.queryByText('opened-post')).toBeNull();
  });

  it('does not navigate when the video control surface is clicked', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={
                <PostCard
                  post={post({ video: { url: 'https://cdn.example/v.mp4', width: 16, height: 9 } })}
                  compact
                />
              }
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    fireEvent.click(video!);
    expect(screen.queryByText('opened-post')).toBeNull();
  });

  it('opens the post when Enter is pressed on the card itself', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<PostCard post={post()} compact />} />
            <Route path="/p/:id" element={<div>opened</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(container.querySelector('article')!, { key: 'Enter' });
    expect(screen.getByText('opened')).toBeTruthy();
  });

  it('does not open the post when Enter is pressed on a hashtag', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={<PostCard post={post({ text: 'pinch the basil #garden' })} compact />}
            />
            <Route path="/p/:id" element={<div>opened-post</div>} />
            <Route path="/tag/:slug" element={<div>opened-tag</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const inline = document.querySelector('p a[href="/tag/garden"]');
    expect(inline).toBeTruthy();
    fireEvent.keyDown(inline!, { key: 'Enter' });
    expect(screen.queryByText('opened-post')).toBeNull();
  });
});
