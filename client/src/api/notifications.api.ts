import { http, unwrap } from './client';
import type { NotificationDTO, Paginated } from './types';

export async function list(
  params: { cursor?: string | null; limit?: number; unreadOnly?: boolean } = {},
): Promise<Paginated<NotificationDTO>> {
  return unwrap<Paginated<NotificationDTO>>(
    http.get('/notifications', {
      params: {
        cursor: params.cursor ?? undefined,
        limit: params.limit,
        unreadOnly: params.unreadOnly ? 'true' : undefined,
      },
    }),
  );
}

export async function unreadCount(): Promise<number> {
  const out = await unwrap<{ count: number }>(http.get('/notifications/unread-count'));
  return out.count;
}

export async function markRead(input: { ids?: string[]; all?: boolean }): Promise<void> {
  await http.post('/notifications/read', input.all ? { all: true } : { ids: input.ids ?? [] });
}

export async function clearAll(): Promise<void> {
  await http.delete('/notifications');
}
