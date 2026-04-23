import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Image as ImageIcon,
  FilmStrip,
  TextB,
  TextItalic,
  Code,
  Quotes,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as postsApi from '@/api/posts.api';
import { qk } from '@/api/queryKeys';
import type { ApiError, Visibility } from '@/api/types';
import { Button, Card, Textarea } from '@/components/primitives';
import { useDrafts } from '@/stores/draft.store';
import s from './PostComposer.module.css';

const DRAFT_KEY = 'post.new';
const AUTOSAVE_MS = 600;

type FormatSpec = { prefix: string; suffix: string; defaultText: string };

function insertFormat(
  el: HTMLTextAreaElement,
  spec: FormatSpec,
  onValueChange: (v: string) => void,
) {
  const { prefix, suffix, defaultText } = spec;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const selected = el.value.slice(start, end);
  const insert = selected || defaultText;
  const next =
    el.value.slice(0, start) + prefix + insert + suffix + el.value.slice(end);
  onValueChange(next);
  requestAnimationFrame(() => {
    el.focus();
    const newStart = start + prefix.length;
    const newEnd = newStart + insert.length;
    el.setSelectionRange(newStart, newEnd);
  });
}

function insertQuote(
  el: HTMLTextAreaElement,
  onValueChange: (v: string) => void,
) {
  const start = el.selectionStart;
  const lineStart = el.value.lastIndexOf('\n', start - 1) + 1;
  const linePrefix = el.value.slice(lineStart, lineStart + 2);
  const already = linePrefix === '> ';
  const next = already
    ? el.value.slice(0, lineStart) + el.value.slice(lineStart + 2)
    : el.value.slice(0, lineStart) + '> ' + el.value.slice(lineStart);
  onValueChange(next);
  requestAnimationFrame(() => {
    el.focus();
    const offset = already ? -2 : 2;
    el.setSelectionRange(start + offset, start + offset);
  });
}

interface PostComposerProps {
  onSuccess?: () => void;
  bare?: boolean;
}

export function PostComposer({ onSuccess, bare }: PostComposerProps = {}) {
  const { t } = useTranslation();
  const getDraft = useDrafts((st) => st.getDraft);
  const setDraft = useDrafts((st) => st.setDraft);
  const clearDraft = useDrafts((st) => st.clearDraft);

  const [text, setText] = useState<string>(() => getDraft(DRAFT_KEY)?.text ?? '');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [files, setFiles] = useState<File[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!text.trim()) {
      clearDraft(DRAFT_KEY);
      return;
    }
    const h = window.setTimeout(() => setDraft(DRAFT_KEY, text), AUTOSAVE_MS);
    return () => window.clearTimeout(h);
  }, [text, setDraft, clearDraft]);

  const previews = useMemo(
    () => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    [files],
  );

  const videoPreviewUrl = useMemo(
    () => (videoFile ? URL.createObjectURL(videoFile) : null),
    [videoFile],
  );

  const create = useMutation({
    mutationFn: () => postsApi.create({ text, visibility, images: files, video: videoFile }),
    onSuccess: () => {
      setText('');
      setFiles([]);
      setVideoFile(null);
      clearDraft(DRAFT_KEY);
      toast.success(t('post.post'));
      qc.invalidateQueries({ queryKey: qk.feed.following });
      qc.invalidateQueries({ queryKey: qk.feed.global });
      onSuccess?.();
    },
    onError: (err) => {
      toast.error((err as unknown as ApiError).message ?? 'Post failed');
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    create.mutate();
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const discardDraft = () => {
    setText('');
    clearDraft(DRAFT_KEY);
  };

  const hasDraft = Boolean(getDraft(DRAFT_KEY)?.text);

  const form = (
      <form onSubmit={onSubmit} className={s.composer}>
        <div className={s.formatBar}>
          <button
            type="button"
            className={s.fmtBtn}
            title="Bold"
            aria-label="Bold"
            onClick={() =>
              textareaRef.current &&
              insertFormat(textareaRef.current, { prefix: '**', suffix: '**', defaultText: 'bold text' }, setText)
            }
          >
            <TextB size={14} weight="bold" aria-hidden />
          </button>
          <button
            type="button"
            className={s.fmtBtn}
            title="Italic"
            aria-label="Italic"
            onClick={() =>
              textareaRef.current &&
              insertFormat(textareaRef.current, { prefix: '*', suffix: '*', defaultText: 'italic text' }, setText)
            }
          >
            <TextItalic size={14} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={s.fmtBtn}
            title="Inline code"
            aria-label="Inline code"
            onClick={() =>
              textareaRef.current &&
              insertFormat(textareaRef.current, { prefix: '`', suffix: '`', defaultText: 'code' }, setText)
            }
          >
            <Code size={14} weight="regular" aria-hidden />
          </button>
          <button
            type="button"
            className={s.fmtBtn}
            title="Blockquote"
            aria-label="Blockquote"
            onClick={() =>
              textareaRef.current && insertQuote(textareaRef.current, setText)
            }
          >
            <Quotes size={14} weight="regular" aria-hidden />
          </button>
        </div>

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('post.placeholder')}
          rows={3}
          maxLength={5000}
          showCounter
          serif
          aria-label="Post text"
        />

        {previews.length > 0 && (
          <div className={s.previews}>
            {previews.map((p, idx) => (
              <div key={p.url} className={s.previewItem}>
                <img src={p.url} alt="" className={s.previewImg} />
                <button
                  type="button"
                  className={s.previewRemove}
                  onClick={() => removeFile(idx)}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {videoPreviewUrl && (
          <div className={s.videoPreview}>
            <video
              src={videoPreviewUrl}
              muted
              controls
              className={s.videoPreviewEl}
            />
            <button
              type="button"
              className={s.previewRemove}
              onClick={() => setVideoFile(null)}
              aria-label="Remove video"
            >
              ×
            </button>
          </div>
        )}

        <div className={s.toolbar}>
          <div className={s.toolsLeft}>
            <button
              type="button"
              className={s.iconButton}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach images"
              disabled={files.length >= 4 || videoFile !== null}
            >
              <ImageIcon size={20} weight="regular" aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className={s.hiddenInput}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                setFiles((prev) => [...prev, ...picked].slice(0, 4));
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className={s.iconButton}
              onClick={() => videoRef.current?.click()}
              aria-label="Attach video"
              disabled={files.length > 0 || videoFile !== null}
            >
              <FilmStrip size={20} weight="regular" aria-hidden />
            </button>
            <input
              ref={videoRef}
              type="file"
              accept="video/mp4,video/webm"
              className={s.hiddenInput}
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                if (picked) setVideoFile(picked);
                e.target.value = '';
              }}
            />
            <select
              className={s.visibilitySelect}
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
              aria-label="Visibility"
            >
              <option value="public">Public</option>
              <option value="followers">Followers</option>
              <option value="private">Private</option>
            </select>
          </div>
          <div className={s.toolsRight}>
            {hasDraft && text.trim() && (
              <Button variant="ghost" size="sm" type="button" onClick={discardDraft}>
                {t('post.discard')}
              </Button>
            )}
            <Button
              variant="primary"
              type="submit"
              disabled={create.isPending || !text.trim()}
            >
              {create.isPending ? t('post.posting') : t('post.post')}
            </Button>
          </div>
        </div>
      </form>
  );

  return bare ? form : <Card as="section">{form}</Card>;
}
