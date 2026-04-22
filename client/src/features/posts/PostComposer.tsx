import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Image as ImageIcon } from '@phosphor-icons/react';
import * as postsApi from '@/api/posts.api';
import { qk } from '@/api/queryKeys';
import type { ApiError, Visibility } from '@/api/types';
import { Button, Card, Textarea } from '@/components/primitives';
import { useDrafts } from '@/stores/draft.store';
import s from './PostComposer.module.css';

const DRAFT_KEY = 'post.new';
const AUTOSAVE_MS = 600;

export function PostComposer() {
  const getDraft = useDrafts((st) => st.getDraft);
  const setDraft = useDrafts((st) => st.setDraft);
  const clearDraft = useDrafts((st) => st.clearDraft);

  const [text, setText] = useState<string>(() => getDraft(DRAFT_KEY)?.text ?? '');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const qc = useQueryClient();

  // Throttled autosave: text → useDrafts store (persisted)
  useEffect(() => {
    if (!text.trim()) {
      // An empty composer means no draft worth keeping.
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

  const create = useMutation({
    mutationFn: () => postsApi.create({ text, visibility, images: files }),
    onSuccess: () => {
      setText('');
      setFiles([]);
      clearDraft(DRAFT_KEY);
      toast.success('Posted');
      qc.invalidateQueries({ queryKey: qk.feed.following });
      qc.invalidateQueries({ queryKey: qk.feed.global });
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

  return (
    <Card as="section">
      <form onSubmit={onSubmit} className={s.composer}>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something quiet…"
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
        <div className={s.toolbar}>
          <div className={s.toolsLeft}>
            <button
              type="button"
              className={s.iconButton}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach images"
              disabled={files.length >= 4}
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
                Discard
              </Button>
            )}
            <Button
              variant="primary"
              type="submit"
              disabled={create.isPending || !text.trim()}
            >
              {create.isPending ? 'Posting…' : 'Post'}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
