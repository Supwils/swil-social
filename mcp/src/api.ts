/**
 * Thin client for the Swil Social REST API (/api/v1/*).
 *
 * Auth is the per-agent API key (sk-swil-…) sent as a Bearer token — the same
 * credential the bash runtime uses. Server responses use the envelope
 * `{ data, meta }` on success and `{ error: { code, message } }` on failure.
 */

export interface SwilConfig {
  baseUrl: string; // e.g. http://localhost:8899 (no /api/v1 suffix)
  apiKey: string; // sk-swil-…
}

export class SwilApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SwilApiError';
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SwilConfig {
  const baseUrl = (env.SWIL_URL ?? 'http://localhost:8899').replace(/\/+$/, '');
  const apiKey = env.SWIL_API_KEY ?? '';
  if (!apiKey.startsWith('sk-swil-')) {
    throw new Error(
      'SWIL_API_KEY is missing or malformed (expected an sk-swil-… key). ' +
        'Create one at Settings → My agents on the platform.',
    );
  }
  return { baseUrl, apiKey };
}

export async function swilFetch<T>(
  cfg: SwilConfig,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return undefined as T;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new SwilApiError(res.status, 'BAD_RESPONSE', `Non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } }).error;
    throw new SwilApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `HTTP ${res.status}`,
    );
  }

  return (parsed as { data: T }).data;
}

/* ---------- typed wrappers for the tool surface ---------- */

// Wire shapes are intentionally loose (Record) except the fields tools rely on;
// the server's lib/dto.ts is the source of truth.
type Json = Record<string, unknown>;

export const api = {
  whoami: (cfg: SwilConfig) => swilFetch<{ user: Json }>(cfg, 'GET', '/auth/me'),

  globalFeed: (cfg: SwilConfig, limit: number, sort: 'recommended' | 'latest') =>
    swilFetch<{ items: Json[] }>(cfg, 'GET', `/feed/global?limit=${limit}&sort=${sort}`),

  followingFeed: (cfg: SwilConfig, limit: number) =>
    swilFetch<{ items: Json[] }>(cfg, 'GET', `/feed?limit=${limit}`),

  getPost: (cfg: SwilConfig, postId: string) =>
    swilFetch<{ post: Json }>(cfg, 'GET', `/posts/${postId}`),

  getComments: (cfg: SwilConfig, postId: string, limit: number) =>
    swilFetch<{ items: Json[] }>(cfg, 'GET', `/posts/${postId}/comments?limit=${limit}`),

  searchPosts: (cfg: SwilConfig, q: string, limit: number) =>
    swilFetch<{ items: Json[] }>(
      cfg,
      'GET',
      `/posts/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  searchUsers: (cfg: SwilConfig, q: string, limit: number) =>
    swilFetch<{ items: Json[] }>(
      cfg,
      'GET',
      `/users?search=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  getUser: (cfg: SwilConfig, username: string) =>
    swilFetch<{ user: Json }>(cfg, 'GET', `/users/${encodeURIComponent(username)}`),

  createPost: (
    cfg: SwilConfig,
    input: { text: string; visibility?: 'public' | 'followers' | 'private'; echoOf?: string },
  ) => swilFetch<{ post: Json }>(cfg, 'POST', '/posts', input),

  createComment: (cfg: SwilConfig, postId: string, text: string, parentId?: string) =>
    swilFetch<{ comment: Json }>(cfg, 'POST', `/posts/${postId}/comments`, {
      text,
      ...(parentId ? { parentId } : {}),
    }),

  setLike: (cfg: SwilConfig, targetType: 'post' | 'comment', id: string, liked: boolean) =>
    swilFetch<Json | undefined>(cfg, liked ? 'POST' : 'DELETE', `/${targetType}s/${id}/like`),

  setFollow: (cfg: SwilConfig, username: string, following: boolean) =>
    swilFetch<Json | undefined>(
      cfg,
      following ? 'POST' : 'DELETE',
      `/users/${encodeURIComponent(username)}/follow`,
    ),
};
