import { Heart, ChatCircle, ArrowsClockwise, BookmarkSimple } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { PostDTO } from '@/api/types';
import s from './PostCard.module.css';

interface Props {
  post: PostDTO;
  showEcho: boolean;        // false when post is itself an echo (no nesting)
  showBookmark: boolean;    // false when viewer is anonymous
  commentsOpen: boolean;
  likePending: boolean;
  bookmarkPending: boolean;
  onLike: () => void;
  onToggleComments: () => void;
  onEcho: () => void;
  onBookmark: () => void;
}

export function PostCardActions({
  post,
  showEcho,
  showBookmark,
  commentsOpen,
  likePending,
  bookmarkPending,
  onLike,
  onToggleComments,
  onEcho,
  onBookmark,
}: Props) {
  const { t } = useTranslation();
  return (
    <footer className={s.actions}>
      <button
        type="button"
        className={clsx(s.actionBtn, post.likedByMe && s.likedBtn)}
        onClick={onLike}
        disabled={likePending}
        aria-pressed={post.likedByMe}
        aria-label={post.likedByMe ? 'Unlike' : 'Like'}
      >
        <Heart size={16} weight={post.likedByMe ? 'fill' : 'regular'} aria-hidden />
        <span>{post.likeCount}</span>
      </button>
      <button
        type="button"
        className={clsx(s.actionBtn, commentsOpen && s.activeBtn)}
        onClick={onToggleComments}
        aria-expanded={commentsOpen}
        aria-label="Toggle comments"
      >
        <ChatCircle size={16} weight={commentsOpen ? 'fill' : 'regular'} aria-hidden />
        <span>{post.commentCount}</span>
      </button>
      {showEcho && (
        <button
          type="button"
          className={s.actionBtn}
          onClick={onEcho}
          aria-label={t('post.echo')}
        >
          <ArrowsClockwise size={16} weight="regular" aria-hidden />
          {post.echoCount > 0 && <span>{post.echoCount}</span>}
        </button>
      )}
      {showBookmark && (
        <button
          type="button"
          className={clsx(s.actionBtn, post.bookmarkedByMe && s.bookmarkedBtn)}
          onClick={onBookmark}
          disabled={bookmarkPending}
          aria-pressed={post.bookmarkedByMe}
          aria-label={post.bookmarkedByMe ? t('post.unbookmark') : t('post.bookmark')}
        >
          <BookmarkSimple size={16} weight={post.bookmarkedByMe ? 'fill' : 'regular'} aria-hidden />
        </button>
      )}
    </footer>
  );
}
