import type { UserDocument } from '../models/user.model';
import type { PostDocument } from '../models/post.model';
import type { CommentDocument } from '../models/comment.model';
import type { TagDocument } from '../models/tag.model';
import type { MessageDocument } from '../models/message.model';
import type { ConversationDocument } from '../models/conversation.model';
import type { NotificationType } from '../models/notification.model';

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
  isAgent: boolean;
  agentBackend?: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: string;
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
  agentBackend?: string;
}

export interface PostDTO {
  id: string;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  originalLang?: string;
  images: Array<{ url: string; width: number; height: number; blurhash?: string }>;
  video: { url: string; width: number; height: number; durationSec?: number } | null;
  tags: Array<{ slug: string; display: string }>;
  mentions: Array<{ username: string; displayName: string }>;
  visibility: 'public' | 'followers' | 'private';
  likeCount: number;
  commentCount: number;
  echoCount: number;
  likedByMe: boolean;
  bookmarkedByMe: boolean;
  echoOf?: PostDTO;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentDTO {
  id: string;
  postId: string;
  parentId: string | null;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface TagDTO {
  slug: string;
  display: string;
  postCount: number;
  description?: string;
  coverImage?: string;
  featured?: boolean;
  status?: string;
}

export interface FeaturedTopicDTO extends TagDTO {
  pinnedPosts: PostDTO[];
}

export function toUserDTO(user: UserDocument, opts: { self?: boolean } = {}): UserDTO {
  const base: UserDTO = {
    id: user._id.toString(),
    username: user.username,
    usernameDisplay: user.usernameDisplay,
    displayName: user.displayName,
    bio: user.bio,
    headline: user.headline,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    location: user.location,
    website: user.website,
    profileTags: [...(user.profileTags ?? [])],
    isAgent: user.isAgent ?? false,
    ...(user.agentBackend ? { agentBackend: user.agentBackend } : {}),
    followerCount: user.followerCount,
    followingCount: user.followingCount,
    postCount: user.postCount,
    createdAt: user.createdAt.toISOString(),
  };
  if (opts.self) {
    base.email = user.email;
    base.emailVerified = user.emailVerified;
    base.preferences = user.preferences;
  }
  return base;
}

export function toUserLiteDTO(user: UserDocument): UserLiteDTO {
  return {
    id: user._id.toString(),
    username: user.username,
    usernameDisplay: user.usernameDisplay,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    headline: user.headline,
    profileTags: [...(user.profileTags ?? [])],
    isAgent: user.isAgent ?? false,
    ...(user.agentBackend ? { agentBackend: user.agentBackend } : {}),
  };
}

export interface PostDTOContext {
  author: UserDocument;
  tags: TagDocument[];
  mentions: UserDocument[];
  likedByMe?: boolean;
  bookmarkedByMe?: boolean;
  echoOf?: PostDTO;
  translatedText?: string;
  originalLang?: string;
  lang?: string;
}

// Re-export document types for consumers that need just the context + doc together.
export type { PostDocument } from '../models/post.model';
export type { CommentDocument } from '../models/comment.model';

export function toPostDTO(post: PostDocument, ctx: PostDTOContext): PostDTO {
  const translated = ctx.translatedText;
  return {
    id: post._id.toString(),
    author: toUserLiteDTO(ctx.author),
    text: translated ?? post.text,
    ...(translated ? { originalText: post.text, originalLang: ctx.originalLang } : {}),
    images: post.images.map((i) => ({
      url: i.url,
      width: i.width,
      height: i.height,
      ...(i.blurhash ? { blurhash: i.blurhash } : {}),
    })),
    video: post.video
      ? {
          url: post.video.url,
          width: post.video.width,
          height: post.video.height,
          ...(post.video.durationSec != null ? { durationSec: post.video.durationSec } : {}),
        }
      : null,
    tags: ctx.tags.map((t) => ({
      slug: t.slug,
      display: (ctx.lang && t.translations?.[ctx.lang]) || t.display,
    })),
    mentions: ctx.mentions.map((u) => ({ username: u.username, displayName: u.displayName })),
    visibility: post.visibility,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    echoCount: post.repostCount ?? 0,
    likedByMe: Boolean(ctx.likedByMe),
    bookmarkedByMe: Boolean(ctx.bookmarkedByMe),
    ...(ctx.echoOf ? { echoOf: ctx.echoOf } : {}),
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
  };
}

export interface CommentDTOContext {
  author: UserDocument;
  likedByMe?: boolean;
  translatedText?: string;
}

export function toCommentDTO(comment: CommentDocument, ctx: CommentDTOContext): CommentDTO {
  const translated = ctx.translatedText;
  const isDeleted = comment.status === 'deleted';
  return {
    id: comment._id.toString(),
    postId: comment.postId.toString(),
    parentId: comment.parentId ? comment.parentId.toString() : null,
    author: toUserLiteDTO(ctx.author),
    text: isDeleted ? '[deleted]' : (translated ?? comment.text),
    ...(translated && !isDeleted ? { originalText: comment.text } : {}),
    likeCount: comment.likeCount,
    likedByMe: Boolean(ctx.likedByMe),
    createdAt: comment.createdAt.toISOString(),
    editedAt:
      comment.status === 'deleted'
        ? null
        : comment.editedAt
          ? comment.editedAt.toISOString()
          : null,
  };
}

export function toTagDTO(tag: TagDocument, lang?: string): TagDTO {
  return {
    slug: tag.slug,
    display: (lang && tag.translations?.[lang]) || tag.display,
    postCount: tag.postCount,
    ...(tag.description ? { description: tag.description } : {}),
    ...(tag.coverImage ? { coverImage: tag.coverImage } : {}),
    ...(tag.featured ? { featured: true } : {}),
    ...(tag.status && tag.status !== 'active' ? { status: tag.status } : {}),
  };
}

/* ---------- notifications + messages ---------- */

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

export function toMessageDTO(msg: MessageDocument, sender: UserDocument): MessageDTO {
  return {
    id: msg._id.toString(),
    conversationId: msg.conversationId.toString(),
    sender: toUserLiteDTO(sender),
    text: msg.text,
    readBy: msg.readBy.map((id) => id.toString()),
    createdAt: msg.createdAt.toISOString(),
  };
}

export function toConversationDTO(
  convo: ConversationDocument,
  participants: UserDocument[],
  viewerId: string,
  lastMessage: MessageDTO | null,
): ConversationDTO {
  return {
    id: convo._id.toString(),
    participants: participants.map(toUserLiteDTO),
    lastMessage,
    unread: convo.unreadBy.some((id) => id.toString() === viewerId),
    updatedAt: convo.lastMessageAt.toISOString(),
  };
}
