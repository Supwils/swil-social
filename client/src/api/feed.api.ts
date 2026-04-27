import { http, unwrap } from './client';
import type { Paginated, PostDTO, ExploreSummaryDTO } from './types';

interface Pagination {
  cursor?: string | null;
  limit?: number;
  lang?: string;
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
      params: { cursor: params.cursor ?? undefined, limit: params.limit, lang: params.lang },
    }),
  );
}

export async function byTag(slug: string, params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get(`/feed/tag/${slug}`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit, lang: params.lang },
    }),
  );
}

export async function getExploreSummary(): Promise<ExploreSummaryDTO> {
  return unwrap<ExploreSummaryDTO>(http.get('/feed/explore-summary'));
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
