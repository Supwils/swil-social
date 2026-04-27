import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Rows, SquaresFour } from '@phosphor-icons/react';
import clsx from 'clsx';
import * as feedApi from '@/api/feed.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton } from '@/components/primitives';
import { useUI } from '@/stores/ui.store';
import { useRealtime } from '@/stores/realtime.store';
import s from './feed.module.css';

export default function FeedFollowingRoute() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const feedLayout = useUI((st) => st.feedLayout);
  const setFeedLayout = useUI((st) => st.setFeedLayout);
  const language = useUI((st) => st.language);
  const newCount = useRealtime((st) => st.newFeedPostCount);
  const resetNewFeed = useRealtime((st) => st.resetNewFeedPostCount);

  const handleLoadNew = () => {
    resetNewFeed();
    void qc.invalidateQueries({ queryKey: qk.feed.following(language) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const q = useInfiniteQuery({
    queryKey: qk.feed.following(language),
    queryFn: ({ pageParam }) => feedApi.following({ cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const isGrid = feedLayout === 'grid';

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('feed.following.title')}</h1>
        <div className={s.viewToggle}>
          <button
            type="button"
            className={clsx(s.viewToggleBtn, !isGrid && s.viewToggleBtnActive)}
            onClick={() => setFeedLayout('list')}
            aria-label="List view"
            aria-pressed={!isGrid}
          >
            <Rows size={15} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={clsx(s.viewToggleBtn, isGrid && s.viewToggleBtnActive)}
            onClick={() => setFeedLayout('grid')}
            aria-label="Grid view"
            aria-pressed={isGrid}
          >
            <SquaresFour size={15} weight="regular" aria-hidden />
          </button>
        </div>
      </header>

      {newCount > 0 && (
        <button type="button" className={s.newPostsBanner} onClick={handleLoadNew}>
          ↑ {newCount} 条新帖，点击查看
        </button>
      )}

      <div className={isGrid ? s.postGrid : s.postList}>
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

        {items.map((post) => <PostCard key={post.id} post={post} compact={isGrid} />)}
      </div>

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
