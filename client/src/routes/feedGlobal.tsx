import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as feedApi from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton, UITag } from '@/components/primitives';
import s from './feed.module.css';

export default function FeedGlobalRoute() {
  const { t } = useTranslation();
  const q = useInfiniteQuery({
    queryKey: qk.feed.global,
    queryFn: ({ pageParam }) => feedApi.global({ cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const trending = useQuery({
    queryKey: qk.tags.trending,
    queryFn: () => tagsApi.trending(8),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('feed.global.title')}</h1>
        <span className={s.lede}>{t('feed.global.lede')}</span>
      </header>

      {trending.data && trending.data.length > 0 && (
        <div className={s.trending}>
          <span className={s.trendingLabel}>{t('feed.global.trending')}</span>
          {trending.data.map((tag) => (
            <UITag key={tag.slug} to={`/tag/${tag.slug}`}>
              {tag.display}
            </UITag>
          ))}
        </div>
      )}

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

      {items.map((post) => <PostCard key={post.id} post={post} />)}

      {q.hasNextPage && (
        <div className={s.loadMore}>
          <Button
            variant="ghost"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {q.isFetchingNextPage ? '…' : t('feed.global.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
