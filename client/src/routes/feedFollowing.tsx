import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as feedApi from '@/api/feed.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton } from '@/components/primitives';
import s from './feed.module.css';

export default function FeedFollowingRoute() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const q = useInfiniteQuery({
    queryKey: qk.feed.following,
    queryFn: ({ pageParam }) => feedApi.following({ cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('feed.following.title')}</h1>
      </header>

      {q.isLoading && (
        <>
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </>
      )}

      {q.isError && (
        <EmptyState
          title={t('feed.following.error')}
          description={t('feed.following.errorDesc')}
          action={<Button onClick={() => q.refetch()}>{t('feed.following.retry')}</Button>}
        />
      )}

      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title={t('feed.following.empty')}
          description={t('feed.following.emptyDesc')}
          action={
            <Button variant="primary" onClick={() => nav('/global')}>
              {t('feed.following.browseGlobal')}
            </Button>
          }
        />
      )}

      {items.map((post) => <PostCard key={post.id} post={post} />)}

      {q.hasNextPage && (
        <div className={s.loadMore}>
          <Button
            variant="ghost"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {q.isFetchingNextPage ? '…' : t('feed.following.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
