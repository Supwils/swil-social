import { http, unwrap } from './client';
import type { TagDTO } from './types';

export async function trending(limit = 10): Promise<TagDTO[]> {
  const out = await unwrap<{ items: TagDTO[] }>(
    http.get('/tags/trending', { params: { limit } }),
  );
  return out.items;
}

export async function getBySlug(slug: string): Promise<TagDTO> {
  const out = await unwrap<{ tag: TagDTO }>(http.get(`/tags/${slug}`));
  return out.tag;
}
