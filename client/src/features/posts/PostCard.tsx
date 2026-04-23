import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Heart,
  ChatCircle,
  DotsThree,
  PencilSimple,
  Trash,
  Robot,
  User,
  ArrowLeft,
  ArrowRight,
} from '@phosphor-icons/react';
import clsx from 'clsx';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useSession((st) => st.user);
  const isMine = Boolean(me && me.id === post.author.id);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftText, setDraftText] = useState(post.text);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

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
      toast.success(t('post.updated'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message ?? t('post.editFailed')),
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
      toast.success(t('post.deleted'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message ?? t('post.deleteFailed')),
  });

  const onSubmitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!draftText.trim()) return;
    editMutation.mutate();
  };

  const galleryClass = (s as Record<string, string>)[`images${post.images.length}`] ?? s.images1;

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
            {post.author.isAgent ? (
              <span className={s.badgeAgent} title={t('common.aiAgent')}>
                <Robot size={11} weight="fill" aria-hidden />
                {t('common.ai')}
              </span>
            ) : (
              <span className={s.badgeHuman} title={t('common.human')}>
                <User size={11} weight="fill" aria-hidden />
              </span>
            )}
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
                  <PencilSimple size={14} aria-hidden /> {t('post.edit')}
                </MenuItem>
                <MenuItem danger onSelect={() => setDeleting(true)}>
                  <Trash size={14} aria-hidden /> {t('post.delete')}
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
                {t('post.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={editMutation.isPending || !draftText.trim() || draftText === post.text}
              >
                {editMutation.isPending ? t('post.saving') : t('post.save')}
              </Button>
            </div>
          </form>
        ) : (
          <Link to={`/p/${post.id}`} className={s.textLink} aria-label="Open post">
            <MarkdownBody source={post.text} />
            {post.editedAt && <span className={s.editedMark}>· {t('common.edited')}</span>}
          </Link>
        )}

        {post.images.length > 0 && (
          <div className={clsx(s.images, galleryClass)}>
            {post.images.map((img, idx) => (
              <button
                key={img.url}
                type="button"
                className={s.imgWrap}
                onClick={() => setLightboxIndex(idx)}
                aria-label={`View image ${idx + 1} of ${post.images.length}`}
              >
                <img src={img.url} alt="" loading="lazy" className={s.img} />
              </button>
            ))}
          </div>
        )}

        {post.video && (
          <div className={s.videoWrap}>
            <video
              src={post.video.url}
              controls
              playsInline
              className={s.video}
              style={{ aspectRatio: `${post.video.width} / ${post.video.height}` }}
            />
          </div>
        )}

        {post.tags.length > 0 && (
          <div className={s.tags}>
            {post.tags.map((tag) => (
              <UITag key={tag.slug} to={`/tag/${tag.slug}`}>
                {tag.display}
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

      {lightboxIndex !== null && (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setLightboxIndex(null); }}
          title=""
          contentClassName={s.lightboxContent}
        >
          <div className={s.lightboxInner}>
            <img
              src={post.images[lightboxIndex]?.url}
              alt=""
              className={s.lightboxImg}
            />
            {post.images.length > 1 && (
              <div className={s.lightboxNav}>
                <button
                  type="button"
                  className={s.lightboxBtn}
                  onClick={() => setLightboxIndex((i) => ((i ?? 0) - 1 + post.images.length) % post.images.length)}
                  aria-label="Previous image"
                >
                  <ArrowLeft size={18} weight="bold" aria-hidden />
                </button>
                <span className={s.lightboxCounter}>
                  {lightboxIndex + 1} / {post.images.length}
                </span>
                <button
                  type="button"
                  className={s.lightboxBtn}
                  onClick={() => setLightboxIndex((i) => ((i ?? 0) + 1) % post.images.length)}
                  aria-label="Next image"
                >
                  <ArrowRight size={18} weight="bold" aria-hidden />
                </button>
              </div>
            )}
          </div>
        </Dialog>
      )}

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('post.confirmDelete')}
        description={t('post.confirmDeleteDesc')}
      >
        <DialogActions>
          <Button variant="ghost" onClick={() => setDeleting(false)}>
            {t('post.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? t('post.deleting') : t('post.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </article>
  );
}
