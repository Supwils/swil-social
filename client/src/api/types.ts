/**
 * DTO types mirroring server response shapes.
 * Source of truth: server/src/lib/dto.ts + docs/03-api-reference.md.
 *
 * This is the only place on the client that knows the wire shape. Keep it in
 * sync manually — when the server DTO changes, grep here and update.
 */

export type Visibility = 'public' | 'followers' | 'private';

export interface UserDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  bio: string;
  headline: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  location: string | null;
  website: string | null;
  profileTags: string[];
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: string;
  // Self-only
  email?: string;
  emailVerified?: boolean;
  preferences?: {
    theme: 'system' | 'light' | 'dark';
    language: 'en' | 'zh';
    emailNotifications: boolean;
    pushNotifications: boolean;
  };
}

export interface UserLiteDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  profileTags: string[];
  isAgent: boolean;
}

export interface PostImage {
  url: string;
  width: number;
  height: number;
  blurhash?: string;
}

export interface PostVideo {
  url: string;
  width: number;
  height: number;
  durationSec?: number;
}

export interface PostDTO {
  id: string;
  author: UserLiteDTO;
  text: string;
  images: PostImage[];
  video: PostVideo | null;
  tags: Array<{ slug: string; display: string }>;
  mentions: Array<{ username: string; displayName: string }>;
  visibility: Visibility;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentDTO {
  id: string;
  postId: string;
  parentId: string | null;
  author: UserLiteDTO;
  text: string;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface TagDTO {
  slug: string;
  display: string;
  postCount: number;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/* ---------- notifications + messages ---------- */

export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'follow'
  | 'mention'
  | 'message';

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  actor: UserLiteDTO;
  post?: { id: string; textPreview: string };
  comment?: { id: string; textPreview: string };
  message?: { id: string; conversationId: string };
  read: boolean;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  sender: UserLiteDTO;
  text: string;
  readBy: string[];
  createdAt: string;
}

export interface ConversationDTO {
  id: string;
  participants: UserLiteDTO[];
  lastMessage: MessageDTO | null;
  unread: boolean;
  updatedAt: string;
}

/** Response envelope helper — server wraps all success payloads in `{ data }` */
export interface ApiEnvelope<T> {
  data: T;
  meta?: { requestId?: string };
}

export interface ApiError {
  code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'NETWORK'
    | 'UNKNOWN';
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
}
