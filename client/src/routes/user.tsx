import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as usersApi from '@/api/users.api';
import * as feedApi from '@/api/feed.api';
import * as followsApi from '@/api/follows.api';
import * as messagesApi from '@/api/messages.api';
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

// Deterministic positions so the same tag always lands in the same spot
const STICKER_POSITIONS = [
  { x: '2%',  y: '8%',  rot: -8  },
  { x: '72%', y: '12%', rot:  7  },
  { x: '0%',  y: '36%', rot:  13 },
  { x: '75%', y: '40%', rot: -5  },
  { x: '4%',  y: '62%', rot: -12 },
  { x: '70%', y: '65%', rot:  9  },
  { x: '1%',  y: '82%', rot:  5  },
  { x: '73%', y: '80%', rot: -9  },
  { x: '7%',  y: '22%', rot:  10 },
  { x: '68%', y: '50%', rot: -4  },
];

// Soft, muted pastels — cohesive with the warm off-white design
const STICKER_COLORS = [
  { bg: 'rgba(154, 189, 138, 0.25)', border: 'rgba(120, 162, 104, 0.38)' },
  { bg: 'rgba(200, 155, 155, 0.25)', border: 'rgba(170, 118, 118, 0.38)' },
  { bg: 'rgba(150, 148, 200, 0.25)', border: 'rgba(115, 112, 170, 0.38)' },
  { bg: 'rgba(200, 175, 118, 0.25)', border: 'rgba(170, 145, 86, 0.38)'  },
  { bg: 'rgba(118, 165, 200, 0.25)', border: 'rgba(86, 132, 170, 0.38)'  },
  { bg: 'rgba(118, 192, 175, 0.25)', border: 'rgba(86, 162, 145, 0.38)'  },
  { bg: 'rgba(200, 188, 118, 0.25)', border: 'rgba(170, 158, 86, 0.38)'  },
  { bg: 'rgba(178, 138, 200, 0.25)', border: 'rgba(148, 104, 170, 0.38)' },
];

function TagWallpaper({ tags }: { tags: string[] }) {
  return (
    <div className={s.tagWallpaper} aria-hidden>
      {tags.map((tag, i) => {
        const pos = STICKER_POSITIONS[i % STICKER_POSITIONS.length];
        const col = STICKER_COLORS[i % STICKER_COLORS.length];
        return (
          <span
            key={tag}
            className={s.stickerTag}
            style={{
              left: pos.x,
              top: pos.y,
              transform: `rotate(${pos.rot}deg)`,
              background: col.bg,
              border: `1px solid ${col.border}`,
            }}
          >
            {tag}
          </span>
        );
      })}
    </div>
  );
}

export default function UserRoute() {
  const { t } = useTranslation();
  const { username = '' } = useParams<{ username: string }>();
  const me = useSession((st) => st.user);
  const qc = useQueryClient();
  const nav = useNavigate();

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

  const followStatus = useQuery({
    queryKey: qk.users.followStatus(username),
    queryFn: () => followsApi.checkFollowing(username),
    enabled: Boolean(me && !isSelf && user.data),
    staleTime: 30_000,
  });
  const isFollowingUser = followStatus.data ?? false;

  const message = useMutation({
    mutationFn: () => messagesApi.findOrCreate(username),
    onSuccess: (convo) => nav(`/messages/${convo.id}`),
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const follow = useMutation({
    mutationFn: () => followsApi.follow(username),
    onSuccess: () => {
      qc.setQueryData<UserDTO>(qk.users.byUsername(username), (old) =>
        old ? { ...old, followerCount: old.followerCount + 1 } : old,
      );
      qc.setQueryData(qk.users.followStatus(username), true);
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
      qc.setQueryData(qk.users.followStatus(username), false);
      toast.success(`Unfollowed @${username}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  if (user.isLoading) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.headerContent}>
            <Skeleton variant="circle" width={96} height={96} />
            <Skeleton variant="text-lg" width={180} />
            <Skeleton variant="text" width={120} />
          </div>
        </div>
      </div>
    );
  }

  if (user.isError || !user.data) {
    return (
      <EmptyState
        title={t('profile.notFound')}
        description={t('profile.notFoundDesc', { username })}
      />
    );
  }

  const u = user.data;
  const hasTags = u.profileTags && u.profileTags.length > 0;
  const items = posts.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.header}>
        {hasTags && <TagWallpaper tags={u.profileTags!} />}

        <div className={s.headerContent}>
          <Avatar src={u.avatarUrl} name={u.displayName || u.username} size="xl" alt="" />
          <div>
            <h1 className={s.name}>{u.displayName || u.username}</h1>
            <div className={s.handle}>@{u.username}</div>
          </div>
          {u.headline && <p className={s.headline}>{u.headline}</p>}
          {u.bio && <p className={s.bio}>{u.bio}</p>}
          {hasTags && (
            <div className={s.profileTagsRow}>
              {u.profileTags!.map((tag) => (
                <Link
                  key={tag}
                  to={`/explore/people?tag=${encodeURIComponent(tag)}`}
                  className={s.profileTag}
                >
                  {tag}
                </Link>
              ))}
            </div>
          )}
          <div className={s.meta}>
            <span><strong>{u.postCount}</strong> {t('profile.posts')}</span>
            <span><strong>{u.followerCount}</strong> followers</span>
            <span><strong>{u.followingCount}</strong> following</span>
          </div>
          {!isSelf && me && (
            <div className={s.actions}>
              {isFollowingUser ? (
                <Button
                  variant="subtle"
                  onClick={() => unfollow.mutate()}
                  disabled={unfollow.isPending || followStatus.isLoading}
                >
                  {t('profile.unfollow')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => follow.mutate()}
                  disabled={follow.isPending || followStatus.isLoading}
                >
                  {t('profile.follow')}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => message.mutate()}
                disabled={message.isPending}
              >
                {t('profile.message')}
              </Button>
            </div>
          )}
        </div>
      </header>

      <h2 className={s.sectionTitle}>{t('profile.posts')}</h2>

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
            {t('profile.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
