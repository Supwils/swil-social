import { http, unwrap } from './client';
import type { Paginated, UserLiteDTO } from './types';

export async function follow(username: string): Promise<void> {
  await http.post(`/users/${username}/follow`);
}

export async function unfollow(username: string): Promise<void> {
  await http.delete(`/users/${username}/follow`);
}

export async function listFollowing(
  username: string,
  params: { cursor?: string | null; limit?: number } = {},
): Promise<Paginated<UserLiteDTO>> {
  return unwrap<Paginated<UserLiteDTO>>(
    http.get(`/users/${username}/following`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}

export async function listFollowers(
  username: string,
  params: { cursor?: string | null; limit?: number } = {},
): Promise<Paginated<UserLiteDTO>> {
  return unwrap<Paginated<UserLiteDTO>>(
    http.get(`/users/${username}/followers`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}
