import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { type InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as commentsApi from '@/api/comments.api';
import { qk } from '@/api/queryKeys';
import type { ApiError, Paginated, PostDTO } from '@/api/types';
import { Avatar, Spinner } from '@/components/primitives';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { useDrafts } from '@/stores/draft.store';
import { formatRelative } from '@/lib/formatDate';
import { MarkdownBody } from './MarkdownBody';
import s from './InlineComments.module.css';

interface Props {
  postId: string;
  open: boolean;
  indented?: boolean;
}

const COMMENT_AUTOSAVE_MS = 600;

export function InlineComments({ postId, open, indented = true }: Props) {
  const { t } = useTranslation();
  const me = useSession((st) => st.user);
  const language = useUI((st) => st.language);
  const qc = useQueryClient();
  const getDraft = useDrafts((st) => st.getDraft);
  const setDraftStore = useDrafts((st) => st.setDraft);
  const clearDraft = useDrafts((st) => st.clearDraft);
  const draftKey = `comment.${postId}`;
  const [text, setText] = useState<string>(() => getDraft(draftKey)?.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!text.trim()) {
      clearDraft(draftKey);
      return;
    }
    const h = window.setTimeout(() => setDraftStore(draftKey, text), COMMENT_AUTOSAVE_MS);
    return () => window.clearTimeout(h);
  }, [text, draftKey, setDraftStore, clearDraft]);

  const comments = useInfiniteQuery({
    queryKey: qk.posts.comments(postId, language),
    queryFn: ({ pageParam }) =>
      commentsApi.listForPost(postId, { cursor: pageParam, limit: 20, lang: language }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  });

  const submit = useMutation({
    mutationFn: () => commentsApi.create(postId, { text }),
    onSuccess: () => {
      setText('');
      clearDraft(draftKey);
      qc.invalidateQueries({ queryKey: qk.posts.comments(postId, language) });
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

  const items = useMemo(() => comments.data?.pages.flatMap((p) => p.items) ?? [], [comments.data]);

  return (
    <div className={clsx(s.panel, indented && s.panelIndented, open && s.open)} aria-hidden={!open}>
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
