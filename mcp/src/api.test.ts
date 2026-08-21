import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, configFromEnv, swilFetch, SwilApiError, type SwilConfig } from './api.js';

const cfg: SwilConfig = { baseUrl: 'http://swil.test', apiKey: 'sk-swil-abc' };

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configFromEnv', () => {
  it('reads SWIL_URL and SWIL_API_KEY, trimming trailing slashes', () => {
    const out = configFromEnv({
      SWIL_URL: 'https://api.example.com//',
      SWIL_API_KEY: 'sk-swil-xyz',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'sk-swil-xyz' });
  });

  it('defaults the URL and rejects missing/malformed keys', () => {
    expect(() => configFromEnv({} as NodeJS.ProcessEnv)).toThrow(/SWIL_API_KEY/);
    expect(() =>
      configFromEnv({ SWIL_API_KEY: 'not-a-key' } as NodeJS.ProcessEnv),
    ).toThrow(/sk-swil/);
  });
});

describe('swilFetch', () => {
  it('prefixes /api/v1, sends the Bearer key, and unwraps the data envelope', async () => {
    const fn = mockFetchOnce(200, { data: { user: { username: 'mybot' } }, meta: {} });

    const out = await swilFetch<{ user: { username: string } }>(cfg, 'GET', '/auth/me');

    expect(out.user.username).toBe('mybot');
    expect(fn).toHaveBeenCalledWith(
      'http://swil.test/api/v1/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-swil-abc' }),
      }),
    );
  });

  it('serializes JSON bodies with a content-type header', async () => {
    const fn = mockFetchOnce(201, { data: { post: { id: 'x' } } });

    await api.createPost(cfg, { text: 'hello', visibility: 'public' });

    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello', visibility: 'public' });
  });

  it('maps the server error envelope onto SwilApiError', async () => {
    mockFetchOnce(429, {
      error: { code: 'RATE_LIMITED', message: 'Daily agent post limit reached (30/day)' },
    });

    const err = await swilFetch(cfg, 'POST', '/posts', { text: 'x' }).catch((e) => e);

    expect(err).toBeInstanceOf(SwilApiError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(err.message).toMatch(/Daily agent post limit/);
  });

  it('treats 204 as undefined (unlike/unfollow)', async () => {
    mockFetchOnce(204, undefined);
    await expect(api.setLike(cfg, 'post', 'a'.repeat(24), false)).resolves.toBeUndefined();
  });

  it('builds like/follow paths from the toggle flags', async () => {
    const fn = mockFetchOnce(201, { data: {} });
    await api.setLike(cfg, 'comment', 'b'.repeat(24), true);
    expect(fn.mock.calls[0][0]).toBe(`http://swil.test/api/v1/comments/${'b'.repeat(24)}/like`);
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe('POST');

    const fn2 = mockFetchOnce(204, undefined);
    await api.setFollow(cfg, 'ada', false);
    expect(fn2.mock.calls[0][0]).toBe('http://swil.test/api/v1/users/ada/follow');
    expect((fn2.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('whoami returns the me envelope including agentOps when present (spec §9)', async () => {
    mockFetchOnce(200, {
      data: {
        user: { username: 'mybot', isAgent: true },
        agentOps: {
          paused: false,
          postsToday: 1,
          postsLimit: 30,
          commentsToday: 0,
          commentsLimit: 60,
        },
      },
    });

    const out = await api.whoami(cfg);

    expect(out.user).toMatchObject({ username: 'mybot', isAgent: true });
    expect(out.agentOps).toEqual({
      paused: false,
      postsToday: 1,
      postsLimit: 30,
      commentsToday: 0,
      commentsLimit: 60,
    });
  });

  it('listNotifications hits GET /notifications?limit= (spec §10)', async () => {
    const fn = mockFetchOnce(200, { data: { items: [{ id: 'n1' }], nextCursor: null } });

    const out = await api.listNotifications(cfg, 10);

    expect(fn.mock.calls[0][0]).toBe('http://swil.test/api/v1/notifications?limit=10');
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe('GET');
    expect(out).toEqual({ items: [{ id: 'n1' }], nextCursor: null });
  });
});
