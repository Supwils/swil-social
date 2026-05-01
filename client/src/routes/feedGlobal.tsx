import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Rows, SquaresFour } from '@phosphor-icons/react';
import clsx from 'clsx';
import * as feedApi from '@/api/feed.api';
import type { FeedSort } from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton, UITag } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { useUI } from '@/stores/ui.store';
import s from './feed.module.css';

export default function FeedGlobalRoute() {
  const { t } = useTranslation();
  const feedLayout = useUI((st) => st.feedLayout);
  const setFeedLayout = useUI((st) => st.setFeedLayout);
  const language = useUI((st) => st.language);
  const [sort, setSort] = useState<FeedSort>('recommended');
  const q = useInfiniteQuery({
    queryKey: qk.feed.global(language, sort),
    queryFn: ({ pageParam }) => feedApi.global({ cursor: pageParam, limit: 20, lang: language, sort }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const trending = useQuery({
    queryKey: qk.tags.trending,
    queryFn: () => tagsApi.trending(8),
  });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const isGrid = feedLayout === 'grid';

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <div>
          <h1 className={s.title}>{t('feed.global.title')}</h1>
          <span className={s.lede}>{t('feed.global.lede')}</span>
        </div>
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

      {trending.data && trending.data.length > 0 && (
        <div className={s.trending}>
          <span className={s.trendingLabel}>{t('feed.global.trending')}</span>
          {trending.data.map((tag) => (
            <UITag key={tag.slug} to={`/tag/${tag.slug}`}>
              {tag.display}
            </UITag>
          ))}
          <div className={s.sortTabs} style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className={clsx(s.sortTab, sort === 'recommended' && s.sortTabActive)}
              onClick={() => setSort('recommended')}
            >
              {t('feed.sort.recommended')}
            </button>
            <button
              type="button"
              className={clsx(s.sortTab, sort === 'latest' && s.sortTabActive)}
              onClick={() => setSort('latest')}
            >
              {t('feed.sort.latest')}
            </button>
          </div>
        </div>
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
            title={t('feed.global.error')}
            description={t('feed.global.errorDesc')}
            action={<Button onClick={() => q.refetch()}>{t('feed.global.retry')}</Button>}
          />
        )}

        {q.isSuccess && items.length === 0 && (
          <EmptyState
            title={t('feed.global.empty')}
            description={t('feed.global.emptyDesc')}
          />
        )}

        {items.map((post) => <PostCard key={post.id} post={post} compact={isGrid} />)}
      </div>

      <InfiniteScrollSentinel
        hasNextPage={q.hasNextPage}
        isFetching={q.isFetchingNextPage}
        onLoadMore={() => q.fetchNextPage()}
      />
    </div>
  );
}
