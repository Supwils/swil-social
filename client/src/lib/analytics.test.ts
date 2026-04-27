import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the HTTP client — analytics.ts imports `http` from '@/api/client'
vi.mock('@/api/client', () => ({
  http: { post: vi.fn().mockResolvedValue({ data: { received: 0 } }) },
}));

import { http } from '@/api/client';

// Re-import analytics so the module re-runs each test with fresh module state
async function loadAnalytics() {
  vi.resetModules();
  return import('./analytics');
}

describe('analytics.track', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    (http.post as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers events and flushes after 5 seconds', async () => {
    const { track } = await loadAnalytics();

    track('post_view', { postId: 'a' });
    track('post_view', { postId: 'b' });

    // Should not have flushed yet
    expect(http.post).not.toHaveBeenCalled();

    // Advance just past the 5s flush window
    await vi.advanceTimersByTimeAsync(5_000);

    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, body] = (http.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/events');
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe('post_view');
    expect(body.events[0].context).toEqual({ postId: 'a' });
  });

  it('flushes immediately when buffer hits MAX_BUFFER (25)', async () => {
    const { track } = await loadAnalytics();

    for (let i = 0; i < 25; i++) {
      track('search_query', { q: `${i}` });
    }
    // Synchronous buffer.length === 25 triggers flush; need a microtask flush
    await Promise.resolve();
    expect(http.post).toHaveBeenCalledTimes(1);
    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1] as { events: unknown[] };
    expect(body.events).toHaveLength(25);
  });

  it('reuses the same sessionId across calls in one tab', async () => {
    const { track } = await loadAnalytics();

    track('a');
    track('b');
    await vi.advanceTimersByTimeAsync(5_000);

    const body = (http.post as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      events: { sessionId: string }[];
    };
    expect(body.events[0].sessionId).toBe(body.events[1].sessionId);
    expect(body.events[0].sessionId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
  });

  it('persists sessionId to sessionStorage', async () => {
    const { track } = await loadAnalytics();
    track('x');
    expect(sessionStorage.getItem('swil.analytics.sid')).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
  });

  it('swallows network errors silently — analytics never breaks the app', async () => {
    (http.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    const { track } = await loadAnalytics();

    track('a');
    // Should not throw when the timer fires the failed flush
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.post).toHaveBeenCalledTimes(1);
    // Subsequent flushes still succeed — failure didn't poison the pipeline
    track('b');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.post).toHaveBeenCalledTimes(2);
  });
});
