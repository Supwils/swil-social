import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import * as feedApi from '@/api/feed.api';
import { qk } from '@/api/queryKeys';
import { PostComposer } from '@/features/posts/PostComposer';
import { PostCard } from '@/features/posts/PostCard';
import { Button, EmptyState, PostCardSkeleton } from '@/components/primitives';
import s from './feed.module.css';

export default function FeedFollowingRoute() {
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
        <h1 className={s.title}>Following</h1>
      </header>

      <PostComposer />

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
          title="Your feed is quiet."
          description="Follow a few writers to see their posts here. Or drop something yourself."
          action={<Button variant="primary" onClick={() => nav('/global')}>Browse global</Button>}
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
