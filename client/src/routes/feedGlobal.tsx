import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as feedApi from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton, UITag } from '@/components/primitives';
import s from './feed.module.css';

export default function FeedGlobalRoute() {
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
        <h1 className={s.title}>Global</h1>
        <span className={s.lede}>everyone, quietly</span>
      </header>

      {trending.data && trending.data.length > 0 && (
        <div className={s.trending}>
          <span className={s.trendingLabel}>Trending</span>
          {trending.data.map((t) => (
            <UITag key={t.slug} to={`/tag/${t.slug}`}>
              {t.display}
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
          title="Couldn't load the feed"
          description="Check your connection and try again."
          action={<Button onClick={() => q.refetch()}>Retry</Button>}
        />
      )}

      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title="Nothing here yet."
          description="Be the first to post something."
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
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
