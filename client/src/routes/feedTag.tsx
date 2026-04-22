import { useInfiniteQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import * as feedApi from '@/api/feed.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton } from '@/components/primitives';
import s from './feed.module.css';

export default function FeedTagRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  const q = useInfiniteQuery({
    queryKey: qk.feed.byTag(slug),
    queryFn: ({ pageParam }) => feedApi.byTag(slug, { cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(slug),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.subtitle}>#{slug}</h1>
      </header>

      {q.isLoading && (
        <>
          <PostCardSkeleton />
          <PostCardSkeleton />
        </>
      )}

      {q.isError && (
        <EmptyState
          title="Tag not found"
          description="This tag doesn't exist or nobody has used it yet."
        />
      )}

      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title="Quiet here."
          description={`No recent posts on #${slug}.`}
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
