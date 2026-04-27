import clsx from 'clsx';
import type { PostDTO } from '@/api/types';
import s from './PostCard.module.css';

interface Props {
  images: PostDTO['images'];
  compact: boolean;
  expanded: boolean;
  onOpen: (index: number) => void;
}

export function PostCardImages({ images, compact, expanded, onOpen }: Props) {
  if (images.length === 0) return null;

  const galleryClass = (s as Record<string, string>)[`images${images.length}`] ?? s.images1;

  if (compact) {
    return (
      <div className={s.imageCompact}>
        <button
          type="button"
          className={s.imgWrap}
          onClick={() => onOpen(0)}
          aria-label={`View image 1 of ${images.length}`}
        >
          <img src={images[0].url} alt="" loading="lazy" className={s.img} />
        </button>
        {images.length > 1 && !expanded && (
          <span className={s.imageCountOverlay}>+{images.length - 1}</span>
        )}
      </div>
    );
  }

  return (
    <div className={clsx(s.images, galleryClass)}>
      {images.map((img, idx) => (
        <button
          key={img.url}
          type="button"
          className={s.imgWrap}
          onClick={() => onOpen(idx)}
          aria-label={`View image ${idx + 1} of ${images.length}`}
        >
          <img src={img.url} alt="" loading="lazy" className={s.img} />
        </button>
      ))}
    </div>
  );
}
