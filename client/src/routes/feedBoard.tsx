import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import * as feedApi from '@/api/feed.api';
import * as boardsApi from '@/api/boards.api';
import { qk } from '@/api/queryKeys';
import { EmptyState } from '@/components/primitives';
import { FeedLayoutToggle } from '@/features/posts/FeedLayoutToggle';
import { FeedSkeletons, FeedStream } from '@/features/posts/FeedStream';
import { useUI } from '@/stores/ui.store';
import s from './feedBoard.module.css';

export default function FeedBoardRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  const language = useUI((st) => st.language);

  const feedQ = useInfiniteQuery({
    queryKey: qk.feed.byBoard(slug, language),
    queryFn: ({ pageParam }) =>
      feedApi.byBoard(slug, { cursor: pageParam, limit: 20, lang: language }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(slug),
  });

  const boardQ = useQuery({
    queryKey: qk.boards.bySlug(slug),
    queryFn: () => boardsApi.getBySlug(slug),
    enabled: Boolean(slug),
    staleTime: 5 * 60 * 1000,
  });

  const items = feedQ.data?.pages.flatMap((p) => p.items) ?? [];
  const board = boardQ.data;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div className={s.headerRow}>
          <h1>{board?.name ?? slug}</h1>
          <FeedLayoutToggle />
        </div>
        {board?.description && <p className={s.description}>{board.description}</p>}
        {board?.postCount != null && (
          <span className={s.postCount}>{board.postCount.toLocaleString()}</span>
        )}
      </header>

      {feedQ.isLoading && <FeedSkeletons />}

      {feedQ.isError && (
        <EmptyState title="Board not found" description="This board doesn't exist." />
      )}

      {feedQ.isSuccess && items.length === 0 && (
        <EmptyState
          title="Quiet here."
          description={`No recent posts in ${board?.name ?? slug}.`}
        />
      )}

      {feedQ.isSuccess && items.length > 0 && (
        <FeedStream
          items={items}
          hasNextPage={feedQ.hasNextPage}
          isFetchingNextPage={feedQ.isFetchingNextPage}
          onLoadMore={() => {
            void feedQ.fetchNextPage();
          }}
        />
      )}
    </div>
  );
}
