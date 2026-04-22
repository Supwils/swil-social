import clsx from 'clsx';
import s from './Avatar.module.css';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  src?: string | null;
  alt?: string;
  name?: string;
  size?: AvatarSize;
  className?: string;
}

export function Avatar({ src, alt, name, size = 'md', className }: AvatarProps) {
  const initial = name ? name.trim().charAt(0).toUpperCase() : '·';
  return (
    <span className={clsx(s.avatar, s[size], className)} aria-hidden={!alt}>
      {src ? (
        <img src={src} alt={alt ?? ''} className={s.img} loading="lazy" />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );
}
