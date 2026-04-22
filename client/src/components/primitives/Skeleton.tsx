import clsx from 'clsx';
import s from './Skeleton.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  variant?: 'text' | 'text-lg' | 'circle' | 'block';
  className?: string;
}

export function Skeleton({
  width,
  height,
  variant = 'block',
  className,
}: SkeletonProps) {
  const sizes: Record<string, string | number | undefined> = {};
  if (width !== undefined) sizes.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) sizes.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <span
      className={clsx(
        s.skeleton,
        variant === 'text' && s.text,
        variant === 'text-lg' && s.textLg,
        variant === 'circle' && s.circle,
        className,
      )}
      style={sizes as Record<string, string | number>}
      aria-hidden="true"
    />
  );
}

export function PostCardSkeleton() {
  return <div className={clsx(s.skeleton, s.postCard)} aria-label="Loading post" />;
}
