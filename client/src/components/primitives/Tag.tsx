import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import s from './Tag.module.css';

export interface TagProps {
  to?: string;
  className?: string;
  children: ReactNode;
}

export function Tag({ to, className, children }: TagProps) {
  const body = (
    <>
      <span className={s.hash}>#</span>
      {children}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={clsx(s.tag, className)}>
        {body}
      </Link>
    );
  }
  return <span className={clsx(s.tag, className)}>{body}</span>;
}
