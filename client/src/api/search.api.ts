import { http, unwrap } from './client';
import type { UserLiteDTO } from './types';

export async function searchUsers(
  query: string,
  limit = 10,
  signal?: AbortSignal,
  tag?: string,
): Promise<UserLiteDTO[]> {
  if (!query.trim() && !tag) return [];
  const params: Record<string, string | number> = { limit };
  if (query.trim()) params.search = query.trim();
  if (tag) params.tag = tag;
  const out = await unwrap<{ items: UserLiteDTO[] }>(
    http.get('/users', { params, signal }),
  );
  return out.items;
}
