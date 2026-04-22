import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Heart,
  ChatCircle,
  DotsThree,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react';
import clsx from 'clsx';
import { toast } from 'sonner';
import * as likesApi from '@/api/likes.api';
import * as postsApi from '@/api/posts.api';
import type { PostDTO, Paginated, ApiError } from '@/api/types';
import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  Menu,
  MenuItem,
  Textarea,
  UITag,
} from '@/components/primitives';
import { useSession } from '@/stores/session.store';
import { formatRelative, formatAbsolute } from '@/lib/formatDate';
import { MarkdownBody } from './MarkdownBody';
import s from './PostCard.module.css';

export function PostCard({ post }: { post: PostDTO }) {
  const qc = useQueryClient();
  const me = useSession((st) => st.user);
  const isMine = Boolean(me && me.id === post.author.id);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftText, setDraftText] = useState(post.text);

  const like = useMutation({
    mutationFn: async () =>
      post.likedByMe ? likesApi.unlikePost(post.id) : likesApi.likePost(post.id),
    onSuccess: (result) => {
      const applyToInfinite = (
        old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
      ) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((p) =>
              p.id === post.id
                ? { ...p, likedByMe: result.liked, likeCount: result.likeCount }
                : p,
            ),
          })),
        };
      };
      qc.setQueriesData({ queryKey: ['feed'] }, applyToInfinite);
      qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
        ['users', post.author.username, 'posts'],
        applyToInfinite,
      );
      qc.setQueryData<PostDTO>(['posts', post.id], (old) =>
        old ? { ...old, likedByMe: result.liked, likeCount: result.likeCount } : old,
      );
    },
  });

  const editMutation = useMutation({
    mutationFn: () => postsApi.update(post.id, { text: draftText }),
    onSuccess: (updated) => {
      const applyToInfinite = (
        old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
      ) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((p) => (p.id === post.id ? updated : p)),
          })),
        };
      };
      qc.setQueriesData({ queryKey: ['feed'] }, applyToInfinite);
      qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
        ['users', post.author.username, 'posts'],
        applyToInfinite,
      );
      qc.setQueryData(['posts', post.id], updated);
      setEditing(false);
      toast.success('Post updated');
    },
    onError: (err) => toast.error((err as unknown as ApiError).message ?? 'Edit failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => postsApi.remove(post.id),
    onSuccess: () => {
      const dropInInfinite = (
        old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
      ) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.filter((p) => p.id !== post.id),
          })),
        };
      };
      qc.setQueriesData({ queryKey: ['feed'] }, dropInInfinite);
      qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
        ['users', post.author.username, 'posts'],
        dropInInfinite,
      );
      qc.removeQueries({ queryKey: ['posts', post.id] });
      setDeleting(false);
      toast.success('Post deleted');
    },
    onError: (err) => toast.error((err as unknown as ApiError).message ?? 'Delete failed'),
  });

  const onSubmitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!draftText.trim()) return;
    editMutation.mutate();
  };

  const onlyOne = post.images.length === 1;

  return (
    <article className={s.card}>
      <Link to={`/u/${post.author.username}`} aria-label={`${post.author.displayName} profile`}>
        <Avatar
          src={post.author.avatarUrl}
          name={post.author.displayName || post.author.username}
          size="md"
          alt=""
        />
      </Link>
      <div className={s.body}>
        <header className={s.header}>
          <Link to={`/u/${post.author.username}`} className={s.authorLink}>
            <span className={s.authorName}>
              {post.author.displayName || post.author.username}
            </span>
            <span className={s.authorHandle}>@{post.author.username}</span>
          </Link>
          <div className={s.headerRight}>
            <Link
              to={`/p/${post.id}`}
              className={s.date}
              title={formatAbsolute(post.createdAt)}
            >
              <time dateTime={post.createdAt}>{formatRelative(post.createdAt)}</time>
            </Link>
            {isMine && (
              <Menu
                ariaLabel="Post actions"
                trigger={<DotsThree size={18} weight="bold" aria-hidden />}
              >
                <MenuItem
                  onSelect={() => {
                    setDraftText(post.text);
                    setEditing(true);
                  }}
                >
                  <PencilSimple size={14} aria-hidden /> Edit
                </MenuItem>
                <MenuItem danger onSelect={() => setDeleting(true)}>
                  <Trash size={14} aria-hidden /> Delete
                </MenuItem>
              </Menu>
            )}
          </div>
        </header>

        {editing ? (
          <form onSubmit={onSubmitEdit} className={s.editForm}>
            <Textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              rows={4}
              maxLength={5000}
              showCounter
              serif
              aria-label="Edit post text"
              autoFocus
            />
            <div className={s.editActions}>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={editMutation.isPending || !draftText.trim() || draftText === post.text}
              >
                {editMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        ) : (
          <Link to={`/p/${post.id}`} className={s.textLink} aria-label="Open post">
            <MarkdownBody source={post.text} />
            {post.editedAt && <span className={s.editedMark}>· edited</span>}
          </Link>
        )}

        {post.images.length > 0 && (
          <div className={clsx(s.images, onlyOne && s.imagesOne)}>
            {post.images.map((img) => (
              <div key={img.url} className={s.imgWrap}>
                <img src={img.url} alt="" loading="lazy" className={s.img} />
              </div>
            ))}
          </div>
        )}

        {post.tags.length > 0 && (
          <div className={s.tags}>
            {post.tags.map((t) => (
              <UITag key={t.slug} to={`/tag/${t.slug}`}>
                {t.display}
              </UITag>
            ))}
          </div>
        )}

        <footer className={s.actions}>
          <button
            type="button"
            className={clsx(s.actionBtn, post.likedByMe && s.likedBtn)}
            onClick={() => like.mutate()}
            disabled={like.isPending}
            aria-pressed={post.likedByMe}
            aria-label={post.likedByMe ? 'Unlike' : 'Like'}
          >
            <Heart size={16} weight={post.likedByMe ? 'fill' : 'regular'} aria-hidden />
            <span>{post.likeCount}</span>
          </button>
          <Link to={`/p/${post.id}`} className={s.actionBtn} aria-label="Comments">
            <ChatCircle size={16} weight="regular" aria-hidden />
            <span>{post.commentCount}</span>
          </Link>
        </footer>
      </div>

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this post?"
        description="This cannot be undone. The post will be hidden from your feed and anyone else's."
      >
        <DialogActions>
          <Button variant="ghost" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </article>
  );
}
