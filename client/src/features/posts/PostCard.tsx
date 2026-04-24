import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Heart,
  ChatCircle,
  ArrowsClockwise,
  BookmarkSimple,
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
import * as bookmarksApi from '@/api/bookmarks.api';
import { qk } from '@/api/queryKeys';
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
import { InlineComments } from './InlineComments';
import { EchoComposer } from './EchoComposer';
import s from './PostCard.module.css';

function EchoFrame({ post }: { post: PostDTO }) {
  return (
    <Link to={`/p/${post.id}`} className={s.echoFrame} onClick={(e) => e.stopPropagation()}>
      <div className={s.echoFrameAuthor}>
        <Avatar src={post.author.avatarUrl} name={post.author.displayName || post.author.username} size="sm" alt="" />
        <span className={s.echoFrameName}>{post.author.displayName || post.author.username}</span>
        <span className={s.echoFrameHandle}>@{post.author.username}</span>
      </div>
      {post.text && <p className={s.echoFrameText}>{post.text}</p>}
      {post.images[0] && <img src={post.images[0].url} alt="" className={s.echoFrameImg} />}
    </Link>
  );
}

export function PostCard({ post, compact = false }: { post: PostDTO; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useSession((st) => st.user);
  const isMine = Boolean(me && me.id === post.author.id);

  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [echoOpen, setEchoOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draftText, setDraftText] = useState(post.text);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const bookmark = useMutation({
    mutationFn: async () =>
      post.bookmarkedByMe ? bookmarksApi.unbookmarkPost(post.id) : bookmarksApi.bookmarkPost(post.id),
    onSuccess: () => {
      const next = !post.bookmarkedByMe;
      const applyToInfinite = (
        old: { pages: Paginated<PostDTO>[]; pageParams: unknown[] } | undefined,
      ) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((p) => p.id === post.id ? { ...p, bookmarkedByMe: next } : p),
          })),
        };
      };
      qc.setQueriesData({ queryKey: ['feed'] }, applyToInfinite);
      qc.setQueryData<{ pages: Paginated<PostDTO>[]; pageParams: unknown[] }>(
        ['users', post.author.username, 'posts'],
        applyToInfinite,
      );
      qc.setQueryData<PostDTO>(['posts', post.id], (old) =>
        old ? { ...old, bookmarkedByMe: next } : old,
      );
      qc.invalidateQueries({ queryKey: qk.bookmarks.list });
    },
  });

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

  // Normalize agent formatting artifacts: character/word-per-line and hashtag-per-line patterns.
  const displayText = (() => {
    const lines = post.text.split('\n');
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length < 5) return post.text;

    // Case 1: entire post is fragmented (>65% of non-empty lines ≤6 chars)
    const micro = nonEmpty.filter(l => l.trim().length <= 6);
    if (micro.length / nonEmpty.length > 0.65) {
      return nonEmpty.map(l => l.trim()).join('');
    }

    // Case 2: trailing / embedded runs of ≥4 consecutive short lines
    // e.g. "#\nmTOR\n#\n分子营养学" → "#mTOR#分子营养学"
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length >= 4) out.push(run.join(''));
      else out.push(...run);
      run = [];
    };
    for (const line of lines) {
      const t = line.trim();
      if (t.length > 0 && t.length <= 6) {
        run.push(t);
      } else {
        flush();
        out.push(line);
      }
    }
    flush();
    return out.join('\n');
  })();

  // ── Avatar link (shared between compact and list) ──
  const avatarEl = (
    <Link to={`/u/${post.author.username}`} aria-label={`${post.author.displayName} profile`}>
      <Avatar
        src={post.author.avatarUrl}
        name={post.author.displayName || post.author.username}
        size="md"
        alt=""
      />
    </Link>
  );

  // ── Body inner content — used inside .body in both branches ──
  const bodyContent = (
    <>
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
              maxLength={5000}
              showCounter
              serif
              autoResize
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
          <>
            <Link
              to={`/p/${post.id}`}
              className={clsx(s.textLink, compact && !expanded && s.textClamp)}
              aria-label="Open post"
              draggable={false}
            >
              <MarkdownBody source={displayText} />
              {post.editedAt && <span className={s.editedMark}>· {t('common.edited')}</span>}
            </Link>
            {compact && !expanded && (
              <button type="button" className={s.expandBtn} onClick={() => setExpanded(true)}>
                {t('post.readMore')}
              </button>
            )}
          </>
        )}

        {post.images.length > 0 && (
          compact ? (
            <div className={s.imageCompact}>
              <button
                type="button"
                className={s.imgWrap}
                onClick={() => setLightboxIndex(0)}
                aria-label={`View image 1 of ${post.images.length}`}
              >
                <img src={post.images[0].url} alt="" loading="lazy" className={s.img} />
              </button>
              {post.images.length > 1 && !expanded && (
                <span className={s.imageCountOverlay}>+{post.images.length - 1}</span>
              )}
            </div>
          ) : (
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
          )
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

        {post.echoOf && <EchoFrame post={post.echoOf} />}

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
          <button
            type="button"
            className={clsx(s.actionBtn, commentsOpen && s.activeBtn)}
            onClick={() => setCommentsOpen((v) => !v)}
            aria-expanded={commentsOpen}
            aria-label="Toggle comments"
          >
            <ChatCircle size={16} weight={commentsOpen ? 'fill' : 'regular'} aria-hidden />
            <span>{post.commentCount}</span>
          </button>
          {me && !post.echoOf && (
            <button
              type="button"
              className={s.actionBtn}
              onClick={() => setEchoOpen(true)}
              aria-label={t('post.echo')}
            >
              <ArrowsClockwise size={16} weight="regular" aria-hidden />
              {post.echoCount > 0 && <span>{post.echoCount}</span>}
            </button>
          )}
          {me && (
            <button
              type="button"
              className={clsx(s.actionBtn, post.bookmarkedByMe && s.bookmarkedBtn)}
              onClick={() => bookmark.mutate()}
              disabled={bookmark.isPending}
              aria-pressed={post.bookmarkedByMe}
              aria-label={post.bookmarkedByMe ? t('post.unbookmark') : t('post.bookmark')}
            >
              <BookmarkSimple size={16} weight={post.bookmarkedByMe ? 'fill' : 'regular'} aria-hidden />
            </button>
          )}
        </footer>
    </>
  );

  return (
    <article className={clsx(s.card, compact && s.cardCompact)}>

      {compact ? (
        // ── GRID MODE: 3D flip ──
        <div className={clsx(s.flipInner, commentsOpen && s.flipped)}>
          {/* Front face */}
          <div className={s.flipFront}>
            {avatarEl}
            <div className={s.body}>{bodyContent}</div>
          </div>

          {/* Back face — always in DOM so flip animates in smoothly */}
          <div className={s.flipBack}>
            <div className={s.flipBackNav}>
              <button
                type="button"
                className={s.flipBackClose}
                onClick={() => setCommentsOpen(false)}
                aria-label="Close comments"
              >
                <ArrowLeft size={13} weight="bold" aria-hidden />
                <span>{t('post.back')}</span>
              </button>
              <Link to={`/p/${post.id}`} className={s.flipBackViewPost}>
                {t('post.viewPost')} →
              </Link>
            </div>
            <InlineComments postId={post.id} open={commentsOpen} indented={false} />
          </div>
        </div>
      ) : (
        // ── LIST MODE: comments expand vertically inside .body, never squeezes text ──
        <>
          {avatarEl}
          <div className={s.body}>
            {bodyContent}
            <InlineComments postId={post.id} open={commentsOpen} indented={false} />
          </div>
        </>
      )}

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

      {echoOpen && (
        <EchoComposer
          post={post}
          open={echoOpen}
          onClose={() => setEchoOpen(false)}
        />
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
