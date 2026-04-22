import { http, unwrap } from './client';

export interface LikeResult {
  likeCount: number;
  liked: boolean;
}

export async function likePost(id: string): Promise<LikeResult> {
  return unwrap<LikeResult>(http.post(`/posts/${id}/like`));
}

export async function unlikePost(id: string): Promise<LikeResult> {
  return unwrap<LikeResult>(http.delete(`/posts/${id}/like`));
}

export async function likeComment(id: string): Promise<LikeResult> {
  return unwrap<LikeResult>(http.post(`/comments/${id}/like`));
}

export async function unlikeComment(id: string): Promise<LikeResult> {
  return unwrap<LikeResult>(http.delete(`/comments/${id}/like`));
}
