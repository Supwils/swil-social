import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import * as notificationsApi from '@/api/notifications.api';
import { qk } from '@/api/queryKeys';
import { useRealtime } from '@/stores/realtime.store';
import { formatRelative } from '@/lib/formatDate';
import { Avatar, Button, EmptyState } from '@/components/primitives';
import type { NotificationDTO } from '@/api/types';
import s from './notifications.module.css';

export default function NotificationsRoute() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setUnread = useRealtime((st) => st.setUnreadNotifications);

  const q = useInfiniteQuery({
    queryKey: qk.notifications.list,
    queryFn: ({ pageParam }) =>
      notificationsApi.list({ cursor: pageParam, limit: 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const markAll = useMutation({
    mutationFn: () => notificationsApi.markRead({ all: true }),
    onSuccess: () => {
      setUnread(0);
      qc.invalidateQueries({ queryKey: qk.notifications.list });
    },
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  useEffect(() => {
    if (items.some((n) => !n.read)) {
      notificationsApi
        .markRead({ all: true })
        .then(() => {
          setUnread(0);
          qc.invalidateQueries({ queryKey: qk.notifications.list });
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('notifications.title')}</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => markAll.mutate()}
          disabled={markAll.isPending || !items.some((n) => !n.read)}
        >
          {t('notifications.markAllRead')}
        </Button>
      </header>

      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title={t('notifications.empty')}
          description={t('notifications.emptyDesc')}
        />
      )}

      {items.map((n) => (
        <NotificationRow key={n.id} n={n} />
      ))}

      {q.hasNextPage && (
        <div className={s.empty}>
          <Button variant="ghost" onClick={() => q.fetchNextPage()}>
            {t('notifications.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

function NotificationRow({ n }: { n: NotificationDTO }) {
  const { t } = useTranslation();
  const actorName = n.actor.displayName || n.actor.username;
  const href = linkFor(n);
  const verb = verbFor(n, t);

  const content = (
    <div className={s.body}>
      <div className={s.text}>
        <Link to={`/u/${n.actor.username}`} className={s.strong}>
          {actorName}
        </Link>{' '}
        {verb}
      </div>
      {(n.post?.textPreview || n.comment?.textPreview) && (
        <div className={s.preview}>
          "{n.comment?.textPreview ?? n.post?.textPreview}"
        </div>
      )}
    </div>
  );

  const row = (
    <article className={clsx(s.item, !n.read && s.itemUnread)}>
      <Link to={`/u/${n.actor.username}`} aria-label={actorName}>
        <Avatar
          src={n.actor.avatarUrl}
          name={actorName}
          size="md"
          alt=""
        />
      </Link>
      {content}
      <time className={s.date} dateTime={n.createdAt}>
        {formatRelative(n.createdAt)}
      </time>
    </article>
  );

  return href ? <Link to={href}>{row}</Link> : row;
}

function verbFor(n: NotificationDTO, t: (key: string) => string): string {
  switch (n.type) {
    case 'like':
      return n.comment ? t('notifications.likedComment') : t('notifications.likedPost');
    case 'comment':
      return t('notifications.commentedOn');
    case 'reply':
      return t('notifications.replied');
    case 'follow':
      return t('notifications.followed');
    case 'mention':
      return t('notifications.mentioned');
    case 'message':
      return t('notifications.messagedYou');
  }
}

function linkFor(n: NotificationDTO): string | null {
  if (n.type === 'follow') return `/u/${n.actor.username}`;
  if (n.type === 'message' && n.message) return `/messages/${n.message.conversationId}`;
  if (n.post) return `/p/${n.post.id}`;
  return null;
}
