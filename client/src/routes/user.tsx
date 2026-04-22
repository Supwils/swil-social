import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import * as usersApi from '@/api/users.api';
import * as feedApi from '@/api/feed.api';
import * as followsApi from '@/api/follows.api';
import { qk } from '@/api/queryKeys';
import { useSession } from '@/stores/session.store';
import { PostCard } from '@/features/posts/PostCard';
import type { UserDTO, ApiError } from '@/api/types';
import {
  Avatar,
  Button,
  EmptyState,
  PostCardSkeleton,
  Skeleton,
} from '@/components/primitives';
import s from './user.module.css';

export default function UserRoute() {
  const { username = '' } = useParams<{ username: string }>();
  const me = useSession((st) => st.user);
  const qc = useQueryClient();

  const user = useQuery({
    queryKey: qk.users.byUsername(username),
    queryFn: () => usersApi.getByUsername(username),
    enabled: Boolean(username),
  });

  const posts = useInfiniteQuery({
    queryKey: qk.users.posts(username),
    queryFn: ({ pageParam }) => feedApi.byUser(username, { cursor: pageParam, limit: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(username),
  });

  const isSelf = Boolean(me && user.data && me.id === user.data.id);

  const follow = useMutation({
    mutationFn: () => followsApi.follow(username),
    onSuccess: () => {
      qc.setQueryData<UserDTO>(qk.users.byUsername(username), (old) =>
        old ? { ...old, followerCount: old.followerCount + 1 } : old,
      );
      toast.success(`Following @${username}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const unfollow = useMutation({
    mutationFn: () => followsApi.unfollow(username),
    onSuccess: () => {
      qc.setQueryData<UserDTO>(qk.users.byUsername(username), (old) =>
        old ? { ...old, followerCount: Math.max(0, old.followerCount - 1) } : old,
      );
      toast.success(`Unfollowed @${username}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  if (user.isLoading) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <Skeleton variant="circle" width={96} height={96} />
          <Skeleton variant="text-lg" width={180} />
          <Skeleton variant="text" width={120} />
        </div>
      </div>
    );
  }

  if (user.isError || !user.data) {
    return (
      <EmptyState
        title="User not found"
        description={`No one on swil goes by @${username} yet.`}
      />
    );
  }

  const u = user.data;
  const items = posts.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.header}>
        <Avatar src={u.avatarUrl} name={u.displayName || u.username} size="xl" alt="" />
        <div>
          <h1 className={s.name}>{u.displayName || u.username}</h1>
          <div className={s.handle}>@{u.username}</div>
        </div>
        {u.headline && <p className={s.headline}>{u.headline}</p>}
        {u.bio && <p className={s.bio}>{u.bio}</p>}
        <div className={s.meta}>
          <span><strong>{u.postCount}</strong> posts</span>
          <span><strong>{u.followerCount}</strong> followers</span>
          <span><strong>{u.followingCount}</strong> following</span>
        </div>
        {!isSelf && me && (
          <div className={s.actions}>
            <Button
              variant="primary"
              onClick={() => follow.mutate()}
              disabled={follow.isPending}
            >
              Follow
            </Button>
            <Button
              variant="subtle"
              onClick={() => unfollow.mutate()}
              disabled={unfollow.isPending}
            >
              Unfollow
            </Button>
          </div>
        )}
      </header>

      <h2 className={s.sectionTitle}>Posts</h2>

      {posts.isLoading && (
        <>
          <PostCardSkeleton />
          <PostCardSkeleton />
        </>
      )}

      {posts.isSuccess && items.length === 0 && (
        <EmptyState title="No posts yet." description="Nothing to see here — yet." />
      )}

      {items.map((post) => <PostCard key={post.id} post={post} />)}

      {posts.hasNextPage && (
        <div className={s.loadMore}>
          <Button variant="ghost" onClick={() => posts.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
