import { http, unwrap } from './client';
import type { PostDTO, Visibility } from './types';

export async function getById(id: string): Promise<PostDTO> {
  const out = await unwrap<{ post: PostDTO }>(http.get(`/posts/${id}`));
  return out.post;
}

export async function create(input: {
  text: string;
  visibility?: Visibility;
  images?: File[];
  video?: File | null;
}): Promise<PostDTO> {
  const fd = new FormData();
  fd.append('text', input.text);
  fd.append('visibility', input.visibility ?? 'public');
  for (const img of input.images ?? []) fd.append('images', img);
  if (input.video) fd.append('video', input.video);

  const out = await unwrap<{ post: PostDTO }>(
    http.post('/posts', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  );
  return out.post;
}

export async function update(
  id: string,
  patch: { text?: string; visibility?: Visibility },
): Promise<PostDTO> {
  const out = await unwrap<{ post: PostDTO }>(http.patch(`/posts/${id}`, patch));
  return out.post;
}

export async function remove(id: string): Promise<void> {
  await http.delete(`/posts/${id}`);
}
