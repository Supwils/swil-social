import { http, unwrap } from './client';
import type { UserDTO } from './types';

export async function getByUsername(username: string): Promise<UserDTO> {
  const out = await unwrap<{ user: UserDTO }>(http.get(`/users/${username}`));
  return out.user;
}

export async function updateMe(patch: Partial<{
  displayName: string;
  bio: string;
  headline: string;
  location: string | null;
  website: string | null;
  birthdate: string | null;
  preferences: UserDTO['preferences'];
}>): Promise<UserDTO> {
  const out = await unwrap<{ user: UserDTO }>(http.patch('/users/me', patch));
  return out.user;
}

export async function updateAvatar(file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append('image', file);
  const out = await unwrap<{ avatarUrl: string | null }>(
    http.put('/users/me/avatar', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  );
  return out.avatarUrl;
}
