import { useEffect, useRef } from 'react';

interface Options {
  /** Whether the next page is available — usually `q.hasNextPage`. */
  hasNextPage: boolean;
  /** Whether a fetch is already in-flight — usually `q.isFetchingNextPage`. */
  isFetching: boolean;
  /** Called when the sentinel scrolls into view. Usually `q.fetchNextPage`. */
  onLoadMore: () => void;
  /** rootMargin passed to IntersectionObserver. "200px 0px" pre-fetches a screenful early. */
  rootMargin?: string;
}

/**
 * IntersectionObserver-based infinite scroll. Returns a ref to attach to a
 * sentinel element placed at the bottom of the list. When the sentinel scrolls
 * into view (or near it, controlled by rootMargin) and there's more to load
 * and nothing is already in-flight, it fires onLoadMore once.
 */
export function useInfiniteScroll({
  hasNextPage,
  isFetching,
  onLoadMore,
  rootMargin = '200px 0px',
}: Options) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && hasNextPage && !isFetching) {
          onLoadMore();
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetching, onLoadMore, rootMargin]);

  return sentinelRef;
}
