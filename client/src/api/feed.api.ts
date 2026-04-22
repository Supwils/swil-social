import { http, unwrap } from './client';
import type { Paginated, PostDTO } from './types';

interface Pagination {
  cursor?: string | null;
  limit?: number;
}

export async function following(params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get('/feed', {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}

export async function global(params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get('/feed/global', {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}

export async function byTag(slug: string, params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get(`/feed/tag/${slug}`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}

export async function byUser(
  username: string,
  params: Pagination = {},
): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get(`/users/${username}/posts`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}
