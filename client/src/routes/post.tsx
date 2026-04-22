import { type FormEvent, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from '@phosphor-icons/react';
import * as postsApi from '@/api/posts.api';
import * as commentsApi from '@/api/comments.api';
import { qk } from '@/api/queryKeys';
import { PostCard } from '@/features/posts/PostCard';
import { useSession } from '@/stores/session.store';
import type { ApiError } from '@/api/types';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Skeleton,
  Textarea,
} from '@/components/primitives';
import { MarkdownBody } from '@/features/posts/MarkdownBody';
import { formatRelative } from '@/lib/formatDate';
import s from './post.module.css';

export default function PostRoute() {
  const { id = '' } = useParams<{ id: string }>();
  const me = useSession((st) => st.user);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [commentText, setCommentText] = useState('');

  const post = useQuery({
    queryKey: qk.posts.byId(id),
    queryFn: () => postsApi.getById(id),
    enabled: Boolean(id),
  });

  const comments = useInfiniteQuery({
    queryKey: qk.posts.comments(id),
    queryFn: ({ pageParam }) =>
      commentsApi.listForPost(id, { cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(id),
  });

  const submit = useMutation({
    mutationFn: () => commentsApi.create(id, { text: commentText }),
    onSuccess: () => {
      setCommentText('');
      toast.success('Comment posted');
      qc.invalidateQueries({ queryKey: qk.posts.comments(id) });
      qc.invalidateQueries({ queryKey: qk.posts.byId(id) });
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    submit.mutate();
  };

  if (post.isLoading) {
    return (
      <div className={s.page}>
        <Skeleton variant="text-lg" width={240} />
        <Skeleton variant="text" width="100%" />
        <Skeleton variant="text" width="92%" />
      </div>
    );
  }
  if (post.isError || !post.data) {
    return (
      <EmptyState
        title="Post not found"
        description="This post may have been removed or is private."
        action={<Button onClick={() => nav('/feed')}>Back to feed</Button>}
      />
    );
  }

  const items = comments.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <Link to="/feed" className={s.backLink}>
        <ArrowLeft size={14} weight="regular" aria-hidden /> Back
      </Link>

      <PostCard post={post.data} />

      <h2 className={s.commentsHeader}>
        {post.data.commentCount > 0
          ? `${post.data.commentCount} comment${post.data.commentCount === 1 ? '' : 's'}`
          : 'No comments yet'}
      </h2>

      {me ? (
        <Card>
          <form onSubmit={onSubmit} className={s.composeCard}>
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
              maxLength={2000}
              showCounter
              aria-label="Your comment"
            />
            <div className={s.composeActions}>
              <Button
                variant="primary"
                type="submit"
                disabled={submit.isPending || !commentText.trim()}
              >
                {submit.isPending ? 'Posting…' : 'Post comment'}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Card>
          <p className={s.signInPrompt}>
            <Link to="/login">Sign in</Link> to join the conversation.
          </p>
        </Card>
      )}

      {items.map((c) => (
        <article key={c.id} className={s.comment}>
          <Avatar
            src={c.author.avatarUrl}
            name={c.author.displayName || c.author.username}
            size="sm"
            alt=""
          />
          <div className={s.commentBody}>
            <header className={s.commentHeader}>
              <Link to={`/u/${c.author.username}`} className={s.commentAuthor}>
                {c.author.displayName || c.author.username}
              </Link>
              <span className={s.commentHandle}>@{c.author.username}</span>
              <time dateTime={c.createdAt} className={s.commentDate}>
                {formatRelative(c.createdAt)}
              </time>
            </header>
            <div className={s.commentText}>
              <MarkdownBody source={c.text} compact />
            </div>
          </div>
        </article>
      ))}

      {comments.hasNextPage && (
        <Button variant="ghost" onClick={() => comments.fetchNextPage()}>
          Load more comments
        </Button>
      )}
    </div>
  );
}
