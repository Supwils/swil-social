import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';
import type { PostDTO } from '@/api/types';
import { Dialog } from '@/components/primitives';
import s from './PostCard.module.css';

interface Props {
  images: PostDTO['images'];
  index: number;
  onChange: (next: number | null) => void;
}

export function PostCardLightbox({ images, index, onChange }: Props) {
  const total = images.length;
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onChange(null); }}
      title=""
      contentClassName={s.lightboxContent}
    >
      <div className={s.lightboxInner}>
        <img src={images[index]?.url} alt="" className={s.lightboxImg} />
        {total > 1 && (
          <div className={s.lightboxNav}>
            <button
              type="button"
              className={s.lightboxBtn}
              onClick={() => onChange((index - 1 + total) % total)}
              aria-label="Previous image"
            >
              <ArrowLeft size={18} weight="bold" aria-hidden />
            </button>
            <span className={s.lightboxCounter}>
              {index + 1} / {total}
            </span>
            <button
              type="button"
              className={s.lightboxBtn}
              onClick={() => onChange((index + 1) % total)}
              aria-label="Next image"
            >
              <ArrowRight size={18} weight="bold" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
