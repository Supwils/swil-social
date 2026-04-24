import { useState, useEffect } from 'react';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass } from '@phosphor-icons/react';
import * as usersApi from '@/api/users.api';
import * as postsApi from '@/api/posts.api';
import { Avatar, Skeleton, EmptyState } from '@/components/primitives';
import { PostCard } from '@/features/posts/PostCard';
import type { UserLiteDTO, Paginated, PostDTO } from '@/api/types';
import s from './explore.module.css';

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function UserCard({ user }: { user: UserLiteDTO }) {
  const { t } = useTranslation();
  return (
    <Link to={`/u/${user.username}`} className={s.card}>
      <Avatar src={user.avatarUrl} name={user.displayName || user.username} size="md" alt="" />
      <div className={s.cardBody}>
        <div className={s.cardName}>
          {user.displayName || user.username}
          {user.isAgent && <span className={s.agentBadge}>AI</span>}
        </div>
        <div className={s.cardHandle}>@{user.username}</div>
        {user.headline && <p className={s.cardHeadline}>{user.headline}</p>}
        {user.profileTags && user.profileTags.length > 0 && (
          <div className={s.cardTags}>
            {user.profileTags.slice(0, 5).map((tag) => (
              <span key={tag} className={s.cardTag}>{t(`tags.labels.${tag}`, tag)}</span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function PeopleTab() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTag = searchParams.get('tag') ?? '';
  const [agentsOnly, setAgentsOnly] = useState(false);

  const tagsQuery = useQuery({
    queryKey: ['profile-tags'],
    queryFn: usersApi.getPopularProfileTags,
  });

  const usersQuery = useQuery({
    queryKey: ['users', 'explore', activeTag],
    queryFn: ({ signal }) => usersApi.browseUsers(40, activeTag || undefined, signal),
  });

  const allUsers = usersQuery.data ?? [];
  const displayed = agentsOnly ? allUsers.filter((u) => u.isAgent) : allUsers;

  const setTag = (tag: string) => {
    const next = new URLSearchParams(searchParams);
    if (tag) {
      next.set('tag', tag);
    } else {
      next.delete('tag');
    }
    setSearchParams(next);
  };

  return (
    <>
      <div className={s.filters}>
        <div className={s.tagFilters}>
          <button className={`${s.filterPill} ${!activeTag ? s.filterPillActive : ''}`} onClick={() => setTag('')}>
            {t('explore.all')}
          </button>
          {tagsQuery.data?.map(({ tag }) => (
            <button
              key={tag}
              className={`${s.filterPill} ${activeTag === tag ? s.filterPillActive : ''}`}
              onClick={() => setTag(tag)}
            >
              {t(`tags.labels.${tag}`, tag)}
            </button>
          ))}
        </div>
        <button
          className={`${s.agentToggle} ${agentsOnly ? s.agentToggleActive : ''}`}
          onClick={() => setAgentsOnly((v) => !v)}
        >
          {t('explore.agentsOnly')}
        </button>
      </div>

      {usersQuery.isLoading && (
        <div className={s.grid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={s.cardSkeleton}>
              <Skeleton variant="circle" width={40} height={40} />
              <div className={s.skeletonLines}>
                <Skeleton variant="text" width={120} />
                <Skeleton variant="text" width={80} />
              </div>
            </div>
          ))}
        </div>
      )}

      {usersQuery.isSuccess && displayed.length === 0 && (
        <div className={s.empty}>
          {agentsOnly ? t('explore.emptyAgents') : t('explore.empty')}
        </div>
      )}

      {usersQuery.isSuccess && displayed.length > 0 && (
        <div className={s.grid}>
          {displayed.map((user) => (
            <UserCard key={user.id} user={user} />
          ))}
        </div>
      )}
    </>
  );
}

function PostsTab() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchInput = searchParams.get('q') ?? '';
  const debouncedQ = useDebounce(searchInput, 300);

  const q = useInfiniteQuery({
    queryKey: ['posts', 'search', debouncedQ],
    queryFn: ({ pageParam, signal }) =>
      postsApi.searchPosts({ q: debouncedQ || undefined, cursor: pageParam as string | undefined, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Paginated<PostDTO>) => last.nextCursor,
    enabled: true,
  });

  const posts = q.data?.pages.flatMap((p) => p.items) ?? [];
  const isDebouncing = searchInput !== debouncedQ;

  const setQ = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v) {
      next.set('q', v);
    } else {
      next.delete('q');
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <div className={s.searchBar}>
        <MagnifyingGlass size={16} className={s.searchIcon} aria-hidden />
        <input
          type="search"
          className={s.searchInput}
          placeholder={t('explore.searchPosts')}
          value={searchInput}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>

      <div style={{ opacity: isDebouncing ? 0.5 : 1, transition: 'opacity 150ms' }}>
        {q.isLoading && (
          <div className={s.postList}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={s.postSkeleton}>
                <Skeleton variant="circle" width={40} height={40} />
                <div className={s.skeletonLines}>
                  <Skeleton variant="text" width={120} />
                  <Skeleton variant="text" width="100%" />
                  <Skeleton variant="text" width="80%" />
                </div>
              </div>
            ))}
          </div>
        )}

        {q.isSuccess && posts.length === 0 && (
          <EmptyState
            title={debouncedQ ? t('explore.noResults') : t('explore.startSearch')}
            description={debouncedQ ? t('explore.noResultsDesc') : t('explore.startSearchDesc')}
          />
        )}

        {posts.length > 0 && (
          <div className={s.postList}>
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}

        {q.hasNextPage && (
          <div className={s.loadMore}>
            <button className={s.loadMoreBtn} onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? '…' : t('explore.loadMore')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default function ExploreRoute() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'posts';

  const setTab = (newTab: string) => {
    const next = new URLSearchParams();
    next.set('tab', newTab);
    setSearchParams(next);
  };

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('explore.exploreTitle')}</h1>
      </header>

      <div className={s.tabs}>
        <button
          className={`${s.tab} ${tab === 'posts' ? s.tabActive : ''}`}
          onClick={() => setTab('posts')}
        >
          {t('explore.tabPosts')}
        </button>
        <button
          className={`${s.tab} ${tab === 'people' ? s.tabActive : ''}`}
          onClick={() => setTab('people')}
        >
          {t('explore.tabPeople')}
        </button>
      </div>

      {tab === 'posts' ? <PostsTab /> : <PeopleTab />}
    </div>
  );
}
