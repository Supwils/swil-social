import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as commentsApi from '@/api/comments.api';
import { qk } from '@/api/queryKeys';
import type { ApiError, Paginated, PostDTO } from '@/api/types';
import { Avatar, Spinner } from '@/components/primitives';
import { useSession } from '@/stores/session.store';
import { formatRelative } from '@/lib/formatDate';
import { MarkdownBody } from './MarkdownBody';
import s from './InlineComments.module.css';

interface Props {
  postId: string;
  open: boolean;
}

export function InlineComments({ postId, open }: Props) {
  const { t } = useTranslation();
  const me = useSession((st) => st.user);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const comments = useInfiniteQuery({
    queryKey: qk.posts.comments(postId),
    queryFn: ({ pageParam }) =>
      commentsApi.listForPost(postId, { cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  });

  const submit = useMutation({
    mutationFn: () => commentsApi.create(postId, { text }),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: qk.posts.comments(postId) });
      // Sync commentCount in all feed caches — avoids a full refetch
      const bump = (old: InfiniteData<Paginated<PostDTO>> | undefined) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((p) =>
              p.id === postId ? { ...p, commentCount: p.commentCount + 1 } : p,
            ),
          })),
        };
      };
      qc.setQueriesData<InfiniteData<Paginated<PostDTO>>>({ queryKey: ['feed'] }, bump);
      qc.setQueriesData<InfiniteData<Paginated<PostDTO>>>({ queryKey: ['users'] }, bump);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || submit.isPending) return;
    submit.mutate();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (text.trim() && !submit.isPending) submit.mutate();
    }
  };

  const items = comments.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={`${s.panel} ${open ? s.open : ''}`} aria-hidden={!open}>
      <div className={s.inner}>
        <div className={s.content}>
          {me ? (
            <form onSubmit={onSubmit} className={s.compose}>
              <Avatar
                src={me.avatarUrl}
                name={me.displayName || me.username}
                size="sm"
                alt=""
              />
              <div className={s.composeField}>
                <textarea
                  ref={textareaRef}
                  className={s.textarea}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={t('post.commentPlaceholder')}
                  rows={1}
                  maxLength={2000}
                  aria-label="Write a comment"
                />
                {text.trim().length > 0 && (
                  <div className={s.composeActions}>
                    <button
                      type="button"
                      className={s.cancelBtn}
                      onClick={() => setText('')}
                    >
                      {t('post.cancel')}
                    </button>
                    <button
                      type="submit"
                      className={s.submitBtn}
                      disabled={submit.isPending}
                    >
                      {submit.isPending ? <Spinner /> : t('post.postComment')}
                    </button>
                  </div>
                )}
              </div>
            </form>
          ) : (
            <p className={s.signIn}>
              <Link to="/login">{t('post.signInToComment')}</Link>
              {t('post.toJoinConversation')}
            </p>
          )}

          {comments.isLoading && (
            <div className={s.loading}>
              <Spinner />
            </div>
          )}

          {items.length > 0 && (
            <ul className={s.list}>
              {items.map((c, i) => (
                <li
                  key={c.id}
                  className={s.item}
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <Avatar
                    src={c.author.avatarUrl}
                    name={c.author.displayName || c.author.username}
                    size="sm"
                    alt=""
                  />
                  <div className={s.itemBody}>
                    <div className={s.itemHeader}>
                      <Link to={`/u/${c.author.username}`} className={s.author}>
                        {c.author.displayName || c.author.username}
                      </Link>
                      <span className={s.handle}>@{c.author.username}</span>
                      <time dateTime={c.createdAt} className={s.time}>
                        {formatRelative(c.createdAt)}
                      </time>
                    </div>
                    <div className={s.itemText}>
                      <MarkdownBody source={c.text} compact />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {comments.hasNextPage && (
            <button
              type="button"
              className={s.loadMore}
              onClick={() => comments.fetchNextPage()}
              disabled={comments.isFetchingNextPage}
            >
              {comments.isFetchingNextPage ? <Spinner /> : t('post.loadMoreComments')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
