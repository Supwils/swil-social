import { http, unwrap } from './client';
import type { UserLiteDTO } from './types';

export async function searchUsers(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<UserLiteDTO[]> {
  if (!query.trim()) return [];
  const out = await unwrap<{ items: UserLiteDTO[] }>(
    http.get('/users', { params: { search: query.trim(), limit }, signal }),
  );
  return out.items;
}
