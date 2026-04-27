import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as feedApi from '@/api/feed.api';
import * as tagsApi from '@/api/tags.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { EmptyState, PostCardSkeleton } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { useUI } from '@/stores/ui.store';
import s from './feedTag.module.css';

export default function FeedTagRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  const language = useUI((st) => st.language);
  const { t } = useTranslation();

  const feedQ = useInfiniteQuery({
    queryKey: qk.feed.byTag(slug, language),
    queryFn: ({ pageParam }) => feedApi.byTag(slug, { cursor: pageParam, limit: 20, lang: language }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(slug),
  });

  const tagQ = useQuery({
    queryKey: qk.tags.bySlug(slug),
    queryFn: () => tagsApi.getBySlug(slug),
    enabled: Boolean(slug),
    staleTime: 5 * 60 * 1000,
  });

  const items = feedQ.data?.pages.flatMap((p) => p.items) ?? [];
  const tag = tagQ.data;
  const hasMeta = Boolean(tag?.description || tag?.coverImage);
  const isArchived = tag?.status === 'archived';

  return (
    <div className={s.page}>
      {hasMeta ? (
        <header className={s.richHeader}>
          {tag?.coverImage && <div className={s.cover} style={{ backgroundImage: `url(${tag.coverImage})` }} />}
          <div className={s.headerBody}>
            <h1>#{tag?.display ?? slug}</h1>
            {tag?.description && <p className={s.description}>{tag.description}</p>}
            {tag?.postCount != null && (
              <span className={s.postCount}>
                {tag.postCount.toLocaleString()} {t('explore.topicsPostCount')}
              </span>
            )}
            {isArchived && <span className={s.archivedBadge}>{t('explore.topicArchived')}</span>}
          </div>
        </header>
      ) : (
        <header className={s.simpleHeader}>
          <h1>#{tag?.display ?? slug}</h1>
        </header>
      )}

      {feedQ.isLoading && (
        <>
          <PostCardSkeleton />
          <PostCardSkeleton />
        </>
      )}

      {feedQ.isError && (
        <EmptyState
          title="Tag not found"
          description="This tag doesn't exist or nobody has used it yet."
        />
      )}

      {feedQ.isSuccess && items.length === 0 && (
        <EmptyState
          title="Quiet here."
          description={`No recent posts on #${slug}.`}
        />
      )}

      {items.map((post) => <PostCard key={post.id} post={post} />)}

      <InfiniteScrollSentinel
        hasNextPage={feedQ.hasNextPage}
        isFetching={feedQ.isFetchingNextPage}
        onLoadMore={() => feedQ.fetchNextPage()}
      />
    </div>
  );
}
